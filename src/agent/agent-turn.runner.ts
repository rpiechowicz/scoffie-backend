import { Injectable, Logger, Optional } from '@nestjs/common';
import { stripClickableLinks } from './answer-links';
import { Prisma } from '@prisma/client';
import { AgentEnv } from '../config/agent-env';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { OpsAlertService } from '../observability/ops-alert.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AiUsageCountersService,
  GLOBAL_SCOPE,
} from './ai-usage-counters.service';
import {
  AgentPhaseUsage,
  AgentProviderError,
  AgentProviderMessage,
  AgentProviderResult,
  AgentProviderUsage,
} from './providers/agent-provider';
import { resolveRoute } from './agent-route';
import { AgentProviderResolver } from './providers/agent-provider.resolver';
import {
  AgentProgressStep,
  appendProgress,
  progressStep,
  READ_STEP_TOOL,
  REASON_STEP_TOOL,
  settledProgress,
  WRITE_STEP_TOOL,
  THINK_STEP_TOOL,
} from './agent-progress';
import { AgentPromptService, TurnDates } from './agent-prompt.service';
import { AgentCard } from './cards/agent-cards';
import { NotificationsService } from '../notifications/notifications.service';
import { AgentToolExecutor } from './tools/agent-tool-executor';
import { UpstreamBreaker } from './upstream-breaker';

export type RunTurnInput = {
  turnId: string;
  conversationId: string;
  userId: string;
  householdId: string;
  /** Okres kwoty, z której zeszła ta tura — zwrot musi trafić tam z powrotem. */
  periodKey: string;
  /**
   * Zakres kwoty z CHWILI POBRANIA (`sub:<id>`, `trial:<hasz>` albo UUID domu).
   *
   * Bez tego pola oba zwroty w tym pliku szły na `householdId`, a kwota
   * schodziła z `plan.quotaScopeId` — czyli przy KAŻDEJ subskrypcji i przy
   * KAŻDEJ próbie zwrot lądował w zupełnie innym liczniku. Nieudana tura
   * zabierała wiadomość na zawsze, a licznik domu schodził pod zero i musiał
   * być zaokrąglany. `AgentTurn.quotaScopeId` zapisuje to samo, więc zwroty
   * z innych ścieżek (`cancelTurn`, wygaszanie martwych tur) trafiały dobrze —
   * tylko runner nie dostawał tej wartości wcale.
   */
  quotaScopeId: string;
  env: AgentEnv;
  requestId: string;
  /**
   * Daty z TELEFONU. Serwer żyje w UTC i nie ma prawa liczyć „dziś" ani
   * początku tygodnia — patrz `dto/agent-date.validators.ts`.
   */
  dates: TurnDates;
  /**
   * Czy model proponuje, czy zapisuje sam — wyliczone RAZ przy przyjęciu
   * wiadomości (`AI_CARDS_MODE` + deklaracja klienta) i niesione przez całą
   * turę. Ponowne czytanie env w środku tury groziłoby turą, która zaczyna
   * w jednym trybie, a kończy w drugim: prompt kazałby proponować, a executor
   * przyjmowałby zapisy.
   */
  proposalMode: boolean;
};

/** Ile ostatnich wiadomości rozmowy idzie do modelu jako kontekst. */
export const HISTORY_WINDOW = 40;

/** Powód przerwania podany do `AbortController.abort()` przy „Stop" z telefonu. */
export const ABORT_REASON_CANCELLED = 'cancelled';

type FailureVerdict = {
  errorCode:
    | 'AI_TIMEOUT'
    | 'AI_CANCELLED'
    | 'AI_PROVIDER_ERROR'
    | 'INTERNAL_ERROR';
  outcome: 'timeout' | 'failed';
  /** Czy oddać kwotę — użytkownik nie płaci za to, że coś padło po naszej stronie. */
  refund: boolean;
  /** Czy błąd liczy się do bezpiecznika dostawcy. */
  countsToBreaker: boolean;
};

/**
 * Wykonanie jednej tury: historia → dostawca → odpowiedź, księga użycia i
 * domknięcie tury.
 *
 * Biegnie POZA cyklem żądania (klient dostał już 202 i odpytuje
 * `GET /agent/turns/:id`), więc nikt tu nie złapie wyjątku za nas — `run`
 * nie rzuca NIGDY. Każde wyjście domyka turę: DONE albo FAILED z kodem.
 *
 * Domknięcie jest warunkowe: `updateMany` po `status: 'RUNNING'`. Jeśli turę
 * zdążył już zamknąć leniwy timeout z odczytu (`AgentTurnsService.expireIfStale`),
 * `count === 0` i runner cicho odpuszcza zamiast nadpisywać wynik i dopisywać
 * drugą odpowiedź do rozmowy.
 *
 * W logach nie ma treści wiadomości ani odpowiedzi — tylko `turnId`,
 * `requestId` i kod. Rozmowa z asystentem to prywatne dane gospodarstwa;
 * logi Railway nie są miejscem na listę zakupów ani na cele wagowe.
 */
@Injectable()
export class AgentTurnRunner {
  private readonly logger = new Logger(AgentTurnRunner.name);
  /**
   * Tury biegnące W TYM procesie — po to, żeby „Stop" z telefonu miał co
   * przerwać. Jedna instancja na Railway, więc mapa w pamięci wystarcza;
   * tura z innego procesu (po deployu) nie jest tu i wtedy zamyka ją
   * bezpośrednio `AgentTurnsService.cancelTurn`.
   */
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: AgentProviderResolver,
    private readonly prompts: AgentPromptService,
    private readonly tools: AgentToolExecutor,
    private readonly counters: AiUsageCountersService,
    private readonly breaker: UpstreamBreaker,
    private readonly metrics: AgentMetricsService,
    private readonly alerts: OpsAlertService,
    // Opcjonalnie: testy jednostkowe runnera nie stawiają modułu powiadomień,
    // a push po turze jest udogodnieniem, nie częścią kontraktu tury.
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /**
   * Przerwanie biegnącej tury na życzenie użytkownika. `true` = tura była
   * w tym procesie i dostała sygnał; domknie ją `finishFailed` jako
   * `AI_CANCELLED` z pełną księgą zużycia i zwrotem kwoty.
   */
  cancel(turnId: string): boolean {
    const controller = this.running.get(turnId);
    if (!controller) return false;
    controller.abort(ABORT_REASON_CANCELLED);
    return true;
  }

  async run(input: RunTurnInput): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    this.running.set(input.turnId, controller);
    const timeout = setTimeout(
      () => controller.abort(),
      input.env.turnTimeoutMs,
    );

    const progress: AgentProgressStep[] = [];
    const draft = new DraftPublisher(this.prisma, this.logger, input.turnId);
    // Karta bez skutków ubocznych (pytanie, zestawienie) żyje w pamięci tury.
    // Propozycje idą przez bazę, bo muszą przeżyć pad procesu — ta nie ma
    // czego przeżywać: bez domkniętej tury nie powstaje żadna wiadomość.
    let pendingCard: AgentCard | null = null;

    try {
      // Pierwszy krok od razu: historia i prompt składają się 1–3 s, potem
      // model myśli — bez tego wpisu telefon widział pustą listę kroków
      // i własne „Zastanawiam się…" aż do pierwszego narzędzia.
      await this.publishProgress(input.turnId, progress, READ_STEP_TOOL, {});
      const messages = await this.loadHistory(input.conversationId);
      // Trasa tury (faza CHAT → faza PLANNER) — czysta funkcja konfiguracji,
      // liczona raz, przed pierwszym wywołaniem modelu.
      const route = resolveRoute(input.env);
      const prompt = await this.prompts.build(
        input.userId,
        input.householdId,
        input.dates,
        input.proposalMode,
        route.promptHandoff,
      );
      const provider = this.providers.resolve(input.env);
      const result = await provider.run({
        model: route.model,
        effort: route.effort,
        handoff: route.handoff,
        system: prompt.system,
        messages,
        tools: route.tools,
        // Domknięcie z tożsamością tury: dostawca nie zna ani użytkownika, ani
        // gospodarstwa, więc nie ma jak sięgnąć do bazy z pominięciem bramek.
        executeTool: async (name, toolInput) => {
          await this.publishProgress(input.turnId, progress, name, toolInput);
          return this.tools.execute(name, toolInput, {
            userId: input.userId,
            householdId: input.householdId,
            catalogIndex: prompt.catalogIndex,
            conversationId: input.conversationId,
            turnId: input.turnId,
            proposalMode: input.proposalMode,
            collectCard: (card) => {
              pendingCard = card;
            },
          });
        },
        // Cisza po narzędziach też jest krokiem — patrz `THINK_STEP_TOOL`.
        onThinking: () =>
          this.publishProgress(input.turnId, progress, THINK_STEP_TOOL, {}),
        // Myślenie i pisanie z samego strumienia — to jedyne, co dzieje się
        // w turze bez narzędzi, i jedyne, po czym telefon poznaje, że model
        // żyje przez pierwsze pół minuty.
        onActivity: (activity) =>
          this.publishProgress(
            input.turnId,
            progress,
            activity === 'reasoning' ? REASON_STEP_TOOL : WRITE_STEP_TOOL,
            {},
          ),
        onDraft: (text) => draft.push(text),
        signal: controller.signal,
        maxTurnCostUsd: input.env.maxTurnCostUsd,
      });
      await this.finishDone(
        input,
        result,
        Date.now() - startedAt,
        pendingCard,
        prompt.usedContext,
        progress,
      );
      this.breaker.recordSuccess();
    } catch (error) {
      await this.finishFailed(
        input,
        error,
        Date.now() - startedAt,
        controller.signal.aborted,
        controller.signal.reason === ABORT_REASON_CANCELLED,
        progress,
      );
    } finally {
      draft.stop();
      clearTimeout(timeout);
      this.running.delete(input.turnId);
    }
  }

  /**
   * Push po domknięciu tury — „możesz wyjść, wrócę z odpowiedzią
   * i powiadomieniem". Kanał `plan`: to odpowiedź o planie, więc słucha tego
   * samego przełącznika co zmiany planu. Wysyłka zawsze, bo telefon w tle
   * nie ma innego sposobu, żeby się dowiedzieć; na pierwszym planie iOS
   * i tak nie pokazuje bannera. Błąd wysyłki nie dotyka tury.
   */
  private notifyFinished(
    input: RunTurnInput,
    outcome: { ok: true; text: string } | { ok: false },
  ): void {
    if (!this.notifications) return;
    void this.notifications
      .notifyAssistantTurnFinished({
        userId: input.userId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        ok: outcome.ok,
        preview: outcome.ok ? outcome.text : null,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `turn ${input.turnId}: push po turze nie wyszedł: ${
            error instanceof Error ? error.message : 'nieznany błąd'
          }`,
        );
      });
  }

  /**
   * Dopisuje krok postępu do tury, żeby telefon miał co pokazać w trakcie.
   *
   * Zapis jest warunkowy (`status: 'RUNNING'`) — turę mógł już domknąć leniwy
   * timeout z odczytu i nie wolno jej wskrzeszać dopiskiem. Błąd zapisu jest
   * połykany: postęp to udogodnienie, a nie powód, żeby wywrócić turę, za
   * którą użytkownik już zapłacił kwotą.
   */
  private async publishProgress(
    turnId: string,
    steps: AgentProgressStep[],
    tool: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    // Ziarno z tury: dwie tury opisują tę samą pracę innymi słowami, a jedna
    // tura nigdy nie podmienia tekstu pod ręką użytkownika.
    if (!appendProgress(steps, progressStep(tool, input, new Date(), turnId))) {
      return;
    }
    try {
      await this.prisma.agentTurn.updateMany({
        where: { id: turnId, status: 'RUNNING' },
        data: { progress: steps as unknown as Prisma.InputJsonValue },
      });
    } catch (error) {
      this.logger.warn(
        `nie udało się zapisać postępu tury ${turnId}: ${
          error instanceof Error ? error.message : 'nieznany błąd'
        }`,
      );
    }
  }

  /**
   * Księga użycia dla nieudanej tury.
   *
   * Osobno od `updateMany`, które domyka turę, i po nim: wiersz księgi ma
   * powstać tylko wtedy, gdy to MY domknęliśmy turę (inaczej leniwy timeout
   * i runner dopisaliby dwa wiersze za to samo). Błąd zapisu nie może
   * przesłonić błędu, który tu nas przywiódł — stąd log, nie rzut.
   */
  /**
   * Wiersze księgi `AiUsage` dla tury: jeden na FAZĘ, a gdy dostawca nie
   * rozróżnia faz (stary stub, błąd bez rozbicia) — jeden zbiorczy.
   *
   * Suma kosztu wierszy jest zawsze równa kosztowi tury, bo fazy powstają
   * z tych samych wywołań, które składają się na `usage` — budżet dobowy i
   * metryki liczą dalej z sumy, nie stąd.
   *
   * `apiCalls` idzie do księgi razem z kosztem, bo bez niego wiersz nie mówi,
   * ILE żądań się na niego złożyło — a to jedyna droga do mediany i ogona
   * rund liczonych z PRODUKCJI, nie z benchmarku. Przy fazach bierzemy
   * `phase.apiCalls` (każda faza liczy własne żądania), bez faz —
   * `params.apiCalls`, czyli licznik całej tury. Gdy dostawca nie podał
   * liczby (błąd przed pierwszym żądaniem), zostaje `null`: „nie wiadomo",
   * a nie „zero".
   */
  private usageRows(
    input: RunTurnInput,
    params: {
      phases?: AgentPhaseUsage[];
      fallbackModel: string;
      fallbackEffort: string;
      usage: AgentProviderUsage;
      /** Żądania CAŁEJ tury — używane tylko w wariancie bez faz. */
      apiCalls?: number;
      stopReason: string | null;
      durationMs: number;
    },
  ): Prisma.AiUsageCreateManyInput[] {
    const base = {
      turnId: input.turnId,
      userId: input.userId,
      householdId: input.householdId,
      provider: input.env.provider,
      stopReason: params.stopReason,
      latencyMs: params.durationMs,
    };
    const phases = params.phases ?? [];
    if (phases.length === 0) {
      return [
        {
          ...base,
          model: params.fallbackModel,
          // Bez `effort` księga nie da się skalibrować: ta sama tura na
          // `medium` i na `high` to dwa różne rachunki.
          effort: params.fallbackEffort,
          inputTokens: params.usage.inputTokens,
          cacheReadTokens: params.usage.cacheReadTokens,
          cacheWriteTokens: params.usage.cacheWriteTokens,
          outputTokens: params.usage.outputTokens,
          costMicroUsd: params.usage.costMicroUsd,
          apiCalls: params.apiCalls ?? null,
        },
      ];
    }
    return phases.map((phase) => ({
      ...base,
      model: phase.model,
      effort: phase.effort,
      inputTokens: phase.usage.inputTokens,
      cacheReadTokens: phase.usage.cacheReadTokens,
      cacheWriteTokens: phase.usage.cacheWriteTokens,
      outputTokens: phase.usage.outputTokens,
      costMicroUsd: phase.usage.costMicroUsd,
      apiCalls: phase.apiCalls,
    }));
  }

  private async recordFailedUsage(
    input: RunTurnInput,
    spent: AgentProviderUsage,
    verdict: FailureVerdict,
    durationMs: number,
    phases?: AgentPhaseUsage[],
    apiCalls?: number,
  ): Promise<void> {
    try {
      await this.prisma.aiUsage.createMany({
        data: this.usageRows(input, {
          phases,
          // Bez rozbicia z dostawcy: model STARTOWY tury, nie `AI_MODEL` —
          // tura, która padła jeszcze na tanim modelu, księgowała się dotąd
          // pod planistą, który nigdy jej nie dotknął.
          fallbackModel: resolveRoute(input.env).model,
          fallbackEffort: resolveRoute(input.env).effort,
          usage: spent,
          ...(apiCalls === undefined ? {} : { apiCalls }),
          stopReason: verdict.errorCode,
          durationMs,
        }),
      });
    } catch (error) {
      this.logger.warn(
        `turn ${input.turnId}: nie udało się dopisać księgi nieudanej tury: ${
          error instanceof Error ? error.message : 'nieznany błąd'
        }`,
      );
    }
  }

  private async loadHistory(
    conversationId: string,
  ): Promise<AgentProviderMessage[]> {
    const rows = await this.prisma.agentMessage.findMany({
      // Poprawione pytanie i wszystko, co po nim, znika także z historii dla
      // MODELU. Inaczej model widziałby pytanie, które użytkownik wycofał,
      // i własną odpowiedź na nie — czyli dokładnie to, co poprawka miała
      // usunąć z rozmowy.
      where: { conversationId, hiddenAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HISTORY_WINDOW,
      select: { role: true, text: true },
    });
    return rows
      .reverse()
      .filter((row) => row.role === 'USER' || row.role === 'ASSISTANT')
      .map((row) => ({
        role:
          row.role === 'ASSISTANT' ? ('ASSISTANT' as const) : ('USER' as const),
        text: row.text,
      }));
  }

  private async finishDone(
    input: RunTurnInput,
    result: AgentProviderResult,
    durationMs: number,
    pendingCard: AgentCard | null,
    usedContext: string[] = [],
    progress: readonly AgentProgressStep[] = [],
  ): Promise<void> {
    const { usage } = result;
    let closed = false;

    try {
      closed = await this.prisma.$transaction(async (tx) => {
        const update = await tx.agentTurn.updateMany({
          where: { id: input.turnId, status: 'RUNNING' },
          data: {
            status: 'DONE',
            finishedAt: new Date(),
            // Prawdą jest teraz `AgentMessage`; szkic zostawiony tu myliłby
            // odczyt tury sprzed domknięcia.
            draftText: null,
            // Bez kroków przejściowych („Już się tym zajmuję", „Piszę odpowiedź"):
            // po turze liczą się narzędzia i zapis, nie sygnały życia.
            progress: settledProgress(
              progress,
            ) as unknown as Prisma.InputJsonValue,
            durationMs,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costMicroUsd: usage.costMicroUsd,
          },
        });
        if (update.count === 0) return false;

        // Propozycja z tej tury, jeśli model jakąś ułożył. Nośnikiem jest
        // BAZA, nie pamięć procesu: gdyby proces padł między narzędziem
        // a domknięciem tury, propozycja zostaje bez `messageId`, czyli
        // nieosiągalna — a nie „w połowie żywa".
        const proposal = await tx.agentProposal.findFirst({
          where: { turnId: input.turnId, messageId: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true, kind: true, card: true },
        });

        // Propozycja ma pierwszeństwo przed kartą bez skutków: gdy model
        // zrobił oba, użytkownik ma zobaczyć to, co da się kliknąć.
        const card = proposal
          ? { kind: proposal.kind, payload: proposal.card }
          : pendingCard
            ? { kind: pendingCard.kind, payload: pendingCard }
            : null;

        const message = await tx.agentMessage.create({
          data: {
            conversationId: input.conversationId,
            role: 'ASSISTANT',
            // Karta jest DODATKIEM do tekstu, nigdy zamiennikiem: klient,
            // który jej nie zna, ma dalej pokazać sensowne zdanie.
            kind: card?.kind ?? 'TEXT',
            // Bez klikalnych adresów: iOS renderuje tę treść jako markdown,
            // a odpowiedź modelu potrafi nieść link podsunięty iniekcją
            // z tytułu przepisu (audyt 12.09.2026, P0.8). Etykieta zostaje,
            // adres przestaje być przyciskiem.
            text: stripClickableLinks(result.text),
            ...(card ? { card: card.payload as Prisma.InputJsonValue } : {}),
            ...(usedContext.length > 0
              ? { context: { used: usedContext } as Prisma.InputJsonValue }
              : {}),
            turnId: input.turnId,
          },
        });

        if (proposal) {
          await tx.agentProposal.update({
            where: { id: proposal.id },
            data: { messageId: message.id },
          });
        }
        // Turę uciął NASZ sufit kosztu (`AI_MAX_TURN_COST_USD`), a nie
        // wyczerpane rundy. Wiadomość wraca do puli TYLKO wtedy, gdy tura nic
        // nie kosztowała — przy `cost_ceiling` z definicji kosztowała, więc
        // w praktyce nie wraca.
        //
        // DLACZEGO ZMIANA (12.09.2026): zwrot bezwarunkowy dawał licznik, który
        // oscylował i nigdy nie dobijał do limitu. Konto z pulą próbną pięciu
        // wiadomości mogło wysyłać drogie tury bez końca: każda trafiała
        // w sufit kosztu, każda oddawała wiadomość, a rachunek u dostawcy rósł.
        // Przy `cost_ceiling` użytkownik dostaje skróconą, ale prawdziwą
        // odpowiedź („ostatnie słowo"), więc zapłata jedną wiadomością jest
        // uczciwa. Tura, która nie zdążyła nic wydać, nadal wraca za darmo.
        if (result.stopReason === 'cost_ceiling' && usage.costMicroUsd === 0) {
          await this.counters.add(
            tx,
            input.quotaScopeId,
            input.periodKey,
            'messages',
            -1,
          );
          await tx.agentTurn.updateMany({
            where: { id: input.turnId },
            data: { quotaRefunded: true },
          });
        }

        // Jeden wiersz NA FAZĘ (model + wysiłek), nie na turę: po
        // przekazaniu pałeczki tura ma dwa rachunki po dwóch różnych
        // stawkach, a jeden wiersz zapisywał je oba pod planistą — czyli
        // raport pokazywałby, że tani model niczego nie oszczędza.
        await tx.aiUsage.createMany({
          data: this.usageRows(input, {
            phases: result.phases,
            fallbackModel: result.model ?? input.env.model,
            fallbackEffort: input.env.effort,
            usage,
            apiCalls: result.apiCalls,
            stopReason: result.stopReason,
            durationMs,
          }),
        });
        await tx.agentConversation.update({
          where: { id: input.conversationId },
          data: { lastMessageAt: message.createdAt },
        });
        // Dwa liczniki kosztu: dobowy na CAŁĄ instalację (bezpiecznik na
        // rachunek) i miesięczny NA GOSPODARSTWO (żeby jeden dom w pętli
        // błędów nie wyłączył asystenta wszystkim).
        await this.counters.addHouseholdCost(
          tx,
          input.householdId,
          usage.costMicroUsd,
        );
        await this.counters.add(
          tx,
          GLOBAL_SCOPE,
          this.counters.dayKey(),
          'costMicroUsd',
          usage.costMicroUsd,
        );
        return true;
      });
    } catch (error) {
      // Rozmowa skasowana w trakcie tury (RODO) — P2025 na `update`.
      // Nie ma czego domykać ani komu pokazać; zostaje ślad w logu.
      if (this.isMissingRecord(error)) {
        this.logger.warn(
          `turn ${input.turnId} requestId=${input.requestId}: rekord zniknął w trakcie tury (P2025)`,
        );
        return;
      }
      throw error;
    }

    if (!closed) {
      this.logger.warn(
        `turn ${input.turnId} requestId=${input.requestId}: tura była już domknięta, wynik dostawcy porzucony`,
      );
      return;
    }

    this.metrics.recordTurnFinished('done');
    this.metrics.recordProviderUsage(
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicroUsd: usage.costMicroUsd,
      },
      result.apiCalls,
    );
    this.notifyFinished(input, { ok: true, text: result.text });
  }

  private async finishFailed(
    input: RunTurnInput,
    error: unknown,
    durationMs: number,
    aborted: boolean,
    cancelled = false,
    progress: readonly AgentProgressStep[] = [],
  ): Promise<void> {
    const verdict = this.classify(error, aborted, cancelled);

    try {
      // Zużycie sprzed błędu: tura, która padła po pięciu rundach narzędzi,
      // kosztowała tyle samo co udana. Bez tego księga i budżet dobowy
      // pokazywałyby zero wydanych pieniędzy.
      const spent =
        error instanceof AgentProviderError ? error.usage : undefined;
      const closed = await this.prisma.agentTurn.updateMany({
        where: { id: input.turnId, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          errorCode: verdict.errorCode,
          finishedAt: new Date(),
          durationMs,
          progress: settledProgress(
            progress,
          ) as unknown as Prisma.InputJsonValue,
          ...(spent
            ? {
                inputTokens: spent.inputTokens,
                outputTokens: spent.outputTokens,
                costMicroUsd: spent.costMicroUsd,
              }
            : {}),
        },
      });
      if (closed.count === 0) {
        this.logger.warn(
          `turn ${input.turnId} requestId=${input.requestId}: tura była już domknięta (${verdict.errorCode})`,
        );
        return;
      }

      if (spent && spent.costMicroUsd > 0) {
        // Wiersz w księdze także dla PORAŻKI. `AiUsage` to surowiec do
        // kalibracji modelu kosztów („jeden wiersz na żądanie do dostawcy"),
        // a tura, która padła w piątej rundzie, wysłała ich pięć. Bez tego
        // księga pokazywałaby wyłącznie tury udane — czyli rachunek niższy
        // od prawdziwego, i to systematycznie.
        await this.recordFailedUsage(
          input,
          spent,
          verdict,
          durationMs,
          error instanceof AgentProviderError ? error.phases : undefined,
          error instanceof AgentProviderError ? error.apiCalls : undefined,
        );
        await this.counters.addHouseholdCost(
          this.prisma,
          input.householdId,
          spent.costMicroUsd,
        );
        await this.counters.add(
          this.prisma,
          GLOBAL_SCOPE,
          this.counters.dayKey(),
          'costMicroUsd',
          spent.costMicroUsd,
        );
      }

      if (spent) {
        // Metryki widzą koszt także nieudanych tur — inaczej `/ops/metrics`
        // pokazywał systematycznie mniej niż licznik budżetu.
        this.metrics.recordProviderUsage(
          {
            inputTokens: spent.inputTokens,
            outputTokens: spent.outputTokens,
            costMicroUsd: spent.costMicroUsd,
          },
          error instanceof AgentProviderError && error.apiCalls
            ? error.apiCalls
            : 1,
        );
      }

      // Zwrot wiadomości NALEŻY SIĘ TYLKO ZA TURĘ, KTÓRA NIC NIE KOSZTOWAŁA.
      //
      // Wcześniej ten wyjątek obejmował wyłącznie „Stop" użytkownika
      // (AI_CANCELLED), a timeout i ponawialny błąd dostawcy oddawały
      // wiadomość niezależnie od tego, ile pieniędzy poszło. Skutek: licznik
      // wiadomości oscylował wokół zera, a jedno konto mogło zrobić dowolnie
      // wiele PŁATNYCH tur w granicach pięciowiadomościowej puli próbnej.
      // Reguła jest teraz jedna dla wszystkich powodów porażki i łatwa do
      // wytłumaczenia: nie wydaliśmy Twoich pieniędzy — nie bierzemy
      // wiadomości.
      const spentAnything =
        spent !== undefined && spent !== null && spent.costMicroUsd > 0;
      const refund = verdict.refund && !spentAnything;
      if (refund) {
        await this.counters.add(
          this.prisma,
          input.quotaScopeId,
          input.periodKey,
          'messages',
          -1,
        );
        await this.prisma.agentTurn.updateMany({
          where: { id: input.turnId },
          data: { quotaRefunded: true },
        });
      }
    } catch (closeError) {
      if (this.isMissingRecord(closeError)) {
        this.logger.warn(
          `turn ${input.turnId} requestId=${input.requestId}: rekord zniknął przy domykaniu (P2025)`,
        );
        return;
      }
      // Awaria bazy przy domykaniu tury: leniwy timeout w odczycie i tak
      // zamknie ją jako AI_TIMEOUT — logujemy i nie wywracamy procesu.
      this.logger.error(
        `turn ${input.turnId} requestId=${input.requestId}: nie udało się domknąć tury`,
        closeError instanceof Error ? closeError.stack : undefined,
      );
      return;
    }

    this.metrics.recordTurnFinished(verdict.outcome);
    if (verdict.countsToBreaker) {
      this.metrics.recordUpstreamError();
      if (this.breaker.recordFailure()) {
        this.metrics.recordBreakerOpened();
        this.logger.warn(
          'bezpiecznik dostawcy otwarty — kolejne tury odmawiane jako AI_UPSTREAM_PAUSED',
        );
        void this.alerts.notify(
          'ai-upstream-paused',
          'bezpiecznik dostawcy modelu otwarty (5 błędów 429/5xx w 5 min) — tury odmawiane jako AI_UPSTREAM_PAUSED',
        );
      }
    }

    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `turn ${input.turnId} requestId=${input.requestId} ${verdict.errorCode}: ${reason}`,
    );
    // Po „Stop" nikt nie czeka na push — użytkownik sam przerwał.
    if (verdict.errorCode !== 'AI_CANCELLED') {
      this.notifyFinished(input, { ok: false });
    }
  }

  private classify(
    error: unknown,
    aborted: boolean,
    cancelled: boolean,
  ): FailureVerdict {
    // Przerwanie sprawdzamy PRZED typem błędu: dostawca dostaje `AbortSignal`
    // i zgłosi to po swojemu (u nas `AgentProviderError`), ale przyczyną jest
    // nasz timeout albo „Stop" użytkownika, nie awaria po jego stronie —
    // bezpiecznik ma to zignorować. Kwota wraca w obu przypadkach: za
    // przerwaną turę nikt nie dostał odpowiedzi.
    if (aborted && cancelled) {
      return {
        errorCode: 'AI_CANCELLED',
        outcome: 'failed',
        refund: true,
        countsToBreaker: false,
      };
    }
    if (aborted) {
      return {
        errorCode: 'AI_TIMEOUT',
        outcome: 'timeout',
        refund: true,
        countsToBreaker: false,
      };
    }
    if (error instanceof AgentProviderError) {
      return {
        errorCode: 'AI_PROVIDER_ERROR',
        outcome: 'failed',
        refund: error.retryable,
        countsToBreaker: error.retryable,
      };
    }
    return {
      errorCode: 'INTERNAL_ERROR',
      outcome: 'failed',
      refund: true,
      countsToBreaker: false,
    };
  }

  private isMissingRecord(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    );
  }
}

/**
 * Szkic odpowiedzi do bazy — z dławieniem, bo model oddaje kilkadziesiąt
 * fragmentów na sekundę, a telefon i tak odpytuje co sekundę.
 *
 * Zapis zawsze niesie CAŁY dotychczasowy tekst (nie przyrost), więc zgubiony
 * zapis niczego nie psuje — następny nadpisze. Warunek `status: 'RUNNING'`
 * jak przy postępie: tura domknięta przez timeout nie ma prawa dostać
 * spóźnionego szkicu. Błąd zapisu jest połykany — szkic to udogodnienie.
 */
class DraftPublisher {
  /** Najwyżej jeden zapis na tyle ms; ostatni fragment zawsze dojeżdża. */
  private static readonly intervalMs = 350;
  private pending: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
    private readonly turnId: string,
  ) {}

  push(text: string): void {
    if (this.stopped) return;
    this.pending = text;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, DraftPublisher.intervalMs);
  }

  /** Koniec tury: nic więcej nie zapisujemy, także z zegara w locie. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async flush(): Promise<void> {
    const text = this.pending;
    this.pending = null;
    if (text === null || this.stopped) return;
    try {
      await this.prisma.agentTurn.updateMany({
        where: { id: this.turnId, status: 'RUNNING' },
        data: { draftText: text },
      });
    } catch (error) {
      this.logger.warn(
        `nie udało się zapisać szkicu tury ${this.turnId}: ${
          error instanceof Error ? error.message : 'nieznany błąd'
        }`,
      );
    }
  }
}
