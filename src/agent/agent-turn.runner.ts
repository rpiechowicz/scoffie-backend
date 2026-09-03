import { Injectable, Logger, Optional } from '@nestjs/common';
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
  /** Kogo dotyczy pytanie; puste = całe gospodarstwo. */
  scopeUserIds?: string[];
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
    // Karta bez skutków ubocznych (pytanie, zestawienie) żyje w pamięci tury.
    // Propozycje idą przez bazę, bo muszą przeżyć pad procesu — ta nie ma
    // czego przeżywać: bez domkniętej tury nie powstaje żadna wiadomość.
    let pendingCard: AgentCard | null = null;

    try {
      const messages = await this.loadHistory(input.conversationId);
      // Trasa tury (faza CHAT → faza PLANNER) — czysta funkcja konfiguracji,
      // liczona raz, przed pierwszym wywołaniem modelu.
      const route = resolveRoute(input.env);
      const prompt = await this.prompts.build(
        input.userId,
        input.householdId,
        input.dates,
        input.proposalMode,
        input.scopeUserIds ?? [],
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
            scopeUserIds: input.scopeUserIds ?? [],
            collectCard: (card) => {
              pendingCard = card;
            },
          });
        },
        signal: controller.signal,
        maxTurnCostUsd: input.env.maxTurnCostUsd,
      });
      await this.finishDone(
        input,
        result,
        Date.now() - startedAt,
        pendingCard,
        prompt.usedContext,
      );
      this.breaker.recordSuccess();
    } catch (error) {
      await this.finishFailed(
        input,
        error,
        Date.now() - startedAt,
        controller.signal.aborted,
        controller.signal.reason === ABORT_REASON_CANCELLED,
      );
    } finally {
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
   */
  private usageRows(
    input: RunTurnInput,
    params: {
      phases?: AgentPhaseUsage[];
      fallbackModel: string;
      fallbackEffort: string;
      usage: AgentProviderUsage;
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
    }));
  }

  private async recordFailedUsage(
    input: RunTurnInput,
    spent: AgentProviderUsage,
    verdict: FailureVerdict,
    durationMs: number,
    phases?: AgentPhaseUsage[],
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
            text: result.text,
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
            stopReason: result.stopReason,
            durationMs,
          }),
        });
        await tx.agentConversation.update({
          where: { id: input.conversationId },
          data: { lastMessageAt: message.createdAt },
        });
        // Budżet dobowy liczy się na całą instalację, nie per gospodarstwo —
        // to bezpiecznik na rachunek, nie kwota użytkownika.
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

      // „Stop" po tym, jak model już policzył tokeny, nie może być darmowy:
      // wyślij → poczekaj 80 s → Stop → kwota wraca, a rachunek u dostawcy
      // zostaje. Przerwanie bez kosztu (zanim dostawca odpowiedział) wraca.
      const refund =
        verdict.refund &&
        !(
          verdict.errorCode === 'AI_CANCELLED' &&
          spent !== undefined &&
          spent !== null &&
          spent.costMicroUsd > 0
        );
      if (refund) {
        await this.counters.add(
          this.prisma,
          input.householdId,
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
