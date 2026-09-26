import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { stripClickableLinks } from './answer-links';
import { Prisma } from '@prisma/client';
import { AgentEnv, readAgentEnv } from '../config/agent-env';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { OpsAlertService } from '../observability/ops-alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentUsageLedger, LedgerTurn } from './agent-usage-ledger.service';
import { TURN_HEARTBEAT_MS } from './agent-turn-liveness';
import {
  AgentPhaseUsage,
  AgentProviderCall,
  AgentProviderError,
  AgentProviderMessage,
  AgentProviderResult,
  AgentProviderUsage,
  AgentUsageVerdict,
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
import { formatTurnTiming } from './agent-timing';
import {
  AgentPrompt,
  AgentPromptService,
  TurnDates,
} from './agent-prompt.service';
import { historyTexts, planProposalIds } from './history-cards';
import { AgentCard } from './cards/agent-cards';
import { NotificationsService } from '../notifications/notifications.service';
import { AgentToolExecutor } from './tools/agent-tool-executor';
import { createTurnMemo } from './turn-memo';
import { createPlanScope } from './tools/plan-scope';
import { UpstreamBreaker } from './upstream-breaker';
import { emitLive } from '../common/live-events';
import { AgentTurnQueue } from './durable/agent-turn-queue.service';
import { TurnEffects, toStored } from './durable/turn-effects';
import {
  LeaseLostError,
  readTurnLeaseConfig,
} from './durable/turn-lease-config';
import { turnTextFor } from './tools/agent-tool-executor';
import { TOOL_ENDED_TURN } from './providers/anthropic-agent.provider';

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
  /**
   * Lease workera (workstream, Etap 5): fencing token, numer próby i twardy
   * termin tury. Brak = wykonanie poza kolejką (testy jednostkowe) — bez
   * dziennika efektów i bez fencingu, jak przed Etapem 5.
   */
  lease?: TurnLease;
};

export type TurnLease = {
  token: string;
  attempt: number;
  /** Koniec CAŁEJ tury — odzyskana próba dostaje tylko resztę czasu. */
  deadlineAt: Date;
};

/** Klucz wyjścia odpowiedzi asystenta (`AgentMessage.outputKey`). */
export const FINAL_OUTPUT_KEY = 'final';

/** Ile ostatnich wiadomości rozmowy idzie do modelu jako kontekst. */
export const HISTORY_WINDOW = 40;

/** Powód przerwania podany do `AbortController.abort()` przy „Stop" z telefonu. */
export const ABORT_REASON_CANCELLED = 'cancelled';

/**
 * Powód przerwania przy zamykaniu procesu (SIGTERM po deployu), gdy tura nie
 * zdążyła domknąć się sama w `AI_SHUTDOWN_GRACE_MS`.
 */
export const ABORT_REASON_SHUTDOWN = 'shutdown';

/**
 * Powód przerwania, gdy turę domknął już ktoś inny (leniwy timeout z odczytu,
 * sprzątanie osieroconych tur, rozmowa skasowana) — kolejne rundy byłyby
 * pieniędzmi wydanymi na odpowiedź, której nikt nie zobaczy.
 */
export const ABORT_REASON_CLOSED = 'closed';

/**
 * Lease tury przejął inny worker (albo tura została domknięta) — ten proces
 * przerywa pracę i NICZEGO już nie zapisuje (Etap 5). Koszt wywołań, które
 * zdążył zrobić, zostaje w księdze pod kluczami swojej próby.
 */
export const ABORT_REASON_LEASE_LOST = 'lease_lost';

/**
 * Tylko testy: symulacja utraty procesu (SIGKILL) — runner znika bez
 * jednego zapisu, jakby pamięć procesu przestała istnieć.
 */
export const ABORT_REASON_VANISH = 'vanish';

/**
 * Ile ms po przerwaniu tur przy zamykaniu procesu czekamy jeszcze na ich
 * domknięcie (zapis FAILED, zwrot kwoty) — to są zapytania do bazy, nie model.
 */
const SHUTDOWN_CLOSE_MS = 2_000;

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
export class AgentTurnRunner implements BeforeApplicationShutdown {
  private readonly logger = new Logger(AgentTurnRunner.name);
  /**
   * Tury biegnące W TYM procesie — po to, żeby „Stop" z telefonu miał co
   * przerwać. Jedna instancja na Railway, więc mapa w pamięci wystarcza;
   * tura z innego procesu (po deployu) nie jest tu i wtedy zamyka ją
   * bezpośrednio `AgentTurnsService.cancelTurn`.
   */
  private readonly running = new Map<string, AbortController>();
  /**
   * Proces dostał SIGTERM: nowe tury dostają 503 (`isDraining`), biegnące
   * mają `AI_SHUTDOWN_GRACE_MS` na domknięcie się same.
   */
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: AgentProviderResolver,
    private readonly prompts: AgentPromptService,
    private readonly tools: AgentToolExecutor,
    private readonly ledger: AgentUsageLedger,
    private readonly breaker: UpstreamBreaker,
    private readonly metrics: AgentMetricsService,
    private readonly alerts: OpsAlertService,
    // Opcjonalnie: testy jednostkowe runnera nie stawiają modułu powiadomień,
    // a push po turze jest udogodnieniem, nie częścią kontraktu tury.
    @Optional() private readonly notifications?: NotificationsService,
    // Kolejka tur (Etap 5) — lease, odnowienia, zwolnienie. Opcjonalna tylko
    // dla testów jednostkowych, które uruchamiają `run` bez lease.
    @Optional() private readonly queue?: AgentTurnQueue,
  ) {}

  /** Liczba tur w biegu w tym procesie (limit współbieżności workera). */
  runningCount(): number {
    return this.running.size;
  }

  /**
   * TYLKO TESTY: symulacja SIGKILL. Każda tura w biegu przerywa się bez
   * żadnego zapisu (bez domknięcia, bez zwolnienia lease, bez odnowień) —
   * dokładnie to, co zostaje w bazie po nagłej śmierci procesu.
   */
  vanishForTests(): void {
    this.draining = true;
    for (const controller of this.running.values()) {
      controller.abort(ABORT_REASON_VANISH);
    }
  }

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

  /** Czy tę turę prowadzi TEN proces (wtedy żyje, nawet gdy chwilę milczy). */
  isRunning(turnId: string): boolean {
    return this.running.has(turnId);
  }

  /** Proces się zamyka — nowych tur nie przyjmujemy. */
  isDraining(): boolean {
    return this.draining;
  }

  /**
   * Łagodne zamknięcie procesu (SIGTERM po deployu, `app.close()`).
   *
   * Do 26.09.2026 proces gasł w pół tury: wiersz zostawał RUNNING, rozmowa
   * stała zablokowana do `AI_TURN_TIMEOUT_MS`, a koszt, który dostawca już
   * naliczył, ginął. Teraz: przestajemy przyjmować tury, dajemy biegnącym
   * `AI_SHUTDOWN_GRACE_MS` na domknięcie się same, a resztę przerywamy
   * (`AI_PROVIDER_ERROR`, zwrot wiadomości tylko za turę bez kosztu, bez
   * bezpiecznika — to nie awaria dostawcy). Koszt już jest w księdze, bo
   * zapisuje się po każdym wywołaniu. Działa tylko wtedy, gdy platforma daje
   * procesowi czas między SIGTERM a SIGKILL — czego nie domkniemy tutaj,
   * domknie sprzątanie osieroconych tur (`AgentTurnSweeper`) w nowym procesie.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.draining = true;
    if (this.running.size === 0) return;
    const graceMs = readAgentEnv().shutdownGraceMs;
    this.logger.warn(
      `zamykanie procesu: ${this.running.size} tur w biegu, czekam do ${graceMs} ms`,
    );
    await this.waitForIdle(graceMs);
    if (this.running.size === 0) return;
    this.logger.warn(
      `zamykanie procesu: przerywam ${this.running.size} tur — lease wraca do kolejki`,
    );
    for (const controller of this.running.values()) {
      controller.abort(ABORT_REASON_SHUTDOWN);
    }
    await this.waitForIdle(SHUTDOWN_CLOSE_MS);
  }

  private async waitForIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async run(input: RunTurnInput): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    this.running.set(input.turnId, controller);
    const lease = input.lease ?? null;
    const leaseConfig = readTurnLeaseConfig();
    // Termin CAŁEJ tury (Etap 5): odzyskana próba dostaje resztę czasu od
    // `deadlineAt`, a nie świeże `AI_TURN_TIMEOUT_MS` — wygasły lease to nie
    // timeout, ale też nie powód, żeby tura żyła dłużej niż obiecaliśmy.
    const timeout = setTimeout(
      () => controller.abort(),
      lease
        ? Math.max(0, lease.deadlineAt.getTime() - Date.now())
        : input.env.turnTimeoutMs,
    );
    // Znak życia. Z lease: odnowienie co ⅓ ważności — nieudane = tura nie
    // jest już nasza (przerwij, nic nie zapisuj), trwały „Stop" = przerwij.
    // Bez lease (testy, stare wywołania): `updatedAt` co 15 s jak dotąd.
    const liveness = { lastRenewedAt: Date.now() };
    const heartbeat = setInterval(
      () =>
        void (lease
          ? this.renewLease(input, lease, controller, liveness)
          : this.heartbeat(input, controller)),
      lease ? leaseConfig.renewMs : TURN_HEARTBEAT_MS,
    );
    heartbeat.unref?.();
    const turnLedger = new TurnLedger(this.ledger, this.logger, {
      turnId: input.turnId,
      userId: input.userId,
      householdId: input.householdId,
      provider: input.env.provider,
      attempt: lease?.attempt ?? 1,
      env: input.env,
    });

    const progress: AgentProgressStep[] = [];
    const draft = new DraftPublisher(
      this.prisma,
      this.logger,
      input.turnId,
      lease?.token,
    );
    // Dziennik efektów narzędzi tej próby (Etap 5) — tylko pod lease.
    const effects = lease
      ? new TurnEffects(this.prisma, input.turnId, lease.attempt, lease.token)
      : null;
    // Karta bez skutków ubocznych (pytanie, zestawienie) żyje w pamięci tury.
    // Propozycje idą przez bazę, bo muszą przeżyć pad procesu — ta nie ma
    // czego przeżywać: bez domkniętej tury nie powstaje żadna wiadomość.
    let pendingCard: AgentCard | null = null;
    // Zakres planowania CAŁEJ tury — wspólny dla obu faz (rozmowa → planista),
    // więc przekazanie pałeczki nie zeruje budżetu tygodnia.
    const planScope = createPlanScope();
    // Pamięć tury (Etap 3.7): domownicy, zgody i pory czytane raz — prompt,
    // narzędzia i planer tej tury biorą je stąd. Plus rezerwacja jednej karty.
    const memo = createTurnMemo();

    try {
      // Pierwszy krok od razu: historia i prompt składają się 1–3 s, potem
      // model myśli — bez tego wpisu telefon widział pustą listę kroków
      // i własne „Zastanawiam się…" aż do pierwszego narzędzia.
      await this.publishProgress(
        input.turnId,
        progress,
        READ_STEP_TOOL,
        {},
        lease?.token,
      );
      // Odzyskana tura, której poprzednia próba zdążyła postawić kartę
      // kończącą turę (propozycja, wybór, pytanie) ze zdaniem serwera: to jest
      // DOKŁADNIE to, co dostawca by oddał (`tool_ended_turn`), więc domykamy
      // bez ani jednego wywołania modelu — bez kosztu i bez drugiej karty.
      if (lease && lease.attempt > 1) {
        const replay = await this.replayTerminalCard(input.turnId);
        if (replay) {
          await this.finishDone(
            input,
            replay.result,
            Date.now() - startedAt,
            replay.card,
            [],
            progress,
            false,
          );
          return;
        }
      }
      if (lease) await this.leaseCheckpoint(input, lease, controller);
      // Trasa tury (faza CHAT → faza PLANNER) — czysta funkcja konfiguracji,
      // liczona raz, przed pierwszym wywołaniem modelu.
      const route = resolveRoute(input.env);
      // Prompt PRZED historią: indeks katalogu tury i domownicy ze zgodą
      // tłumaczą karty z poprzednich tur na referencje, którymi model mówi.
      const prompt = await this.prompts.build(
        input.userId,
        input.householdId,
        input.dates,
        input.proposalMode,
        route.promptHandoff,
        memo,
      );
      const messages = await this.loadHistory(input.conversationId, prompt);
      const provider = this.providers.resolve(input.env);
      const prepMs = Date.now() - startedAt;
      // „Stop" albo utrata lease w trakcie składania promptu — nie wołamy
      // modelu wcale (dostawca bez opóźnienia nie zajrzałby do sygnału).
      if (controller.signal.aborted) {
        throw new Error('tura przerwana przed wywołaniem modelu');
      }
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
          await this.publishProgress(
            input.turnId,
            progress,
            name,
            toolInput,
            lease?.token,
          );
          return this.tools.execute(name, toolInput, {
            userId: input.userId,
            householdId: input.householdId,
            catalogIndex: prompt.catalogIndex,
            conversationId: input.conversationId,
            turnId: input.turnId,
            proposalMode: input.proposalMode,
            planScope,
            memo,
            dates: {
              weekStart: input.dates.weekStart,
              clientToday: input.dates.clientToday,
            },
            collectCard: (card) => {
              pendingCard = card;
            },
            ...(lease && effects
              ? {
                  durable: {
                    effects,
                    checkpoint: () =>
                      this.leaseCheckpoint(input, lease, controller),
                    onLeaseLost: () => {
                      if (!controller.signal.aborted) {
                        controller.abort(ABORT_REASON_LEASE_LOST);
                      }
                    },
                  },
                }
              : {}),
          });
        },
        // Cisza po narzędziach też jest krokiem — patrz `THINK_STEP_TOOL`.
        // Pod lease to też moment PRZED kolejnym wywołaniem modelu: trwały
        // „Stop" i utrata lease przerywają turę, zanim wydamy na nią więcej.
        onThinking: async () => {
          await this.publishProgress(
            input.turnId,
            progress,
            THINK_STEP_TOOL,
            {},
            lease?.token,
          );
          if (lease) {
            await this.leaseCheckpoint(input, lease, controller).catch(
              () => undefined,
            );
          }
        },
        // Myślenie i pisanie z samego strumienia — to jedyne, co dzieje się
        // w turze bez narzędzi, i jedyne, po czym telefon poznaje, że model
        // żyje przez pierwsze pół minuty.
        onActivity: (activity) =>
          this.publishProgress(
            input.turnId,
            progress,
            activity === 'reasoning' ? REASON_STEP_TOOL : WRITE_STEP_TOOL,
            {},
            lease?.token,
          ),
        onDraft: (text) => draft.push(text),
        // Księga po każdym wywołaniu — patrz `AgentUsageLedger`.
        onUsage: (call) => turnLedger.record(call),
        signal: controller.signal,
        maxTurnCostUsd: input.env.maxTurnCostUsd,
      });
      // Końcówka szkicu dojeżdża, zanim tura przestanie być RUNNING.
      await draft.settle();
      if (result.timings) {
        this.logger.log(
          formatTurnTiming(
            input.turnId,
            Date.now() - startedAt,
            prepMs,
            result.timings,
          ),
        );
      }
      // Księga PRZED domknięciem: telefon czyta zużycie tury razem z DONE.
      await turnLedger.settle({
        usage: result.usage,
        phases: result.phases,
        apiCalls: result.apiCalls,
        model: result.model ?? route.model,
        effort: route.effort,
        stopReason: result.stopReason,
        requireCost: false,
      });
      await this.finishDone(
        input,
        result,
        Date.now() - startedAt,
        pendingCard,
        prompt.usedContext,
        progress,
        turnLedger.spentMicroUsd === 0,
      );
      this.breaker.recordSuccess();
    } catch (error) {
      const abortReason = controller.signal.aborted
        ? (controller.signal.reason as unknown)
        : undefined;
      // Symulowany SIGKILL (testy): proces „nie istnieje" — zero zapisów.
      if (abortReason === ABORT_REASON_VANISH) return;
      // Tura nie jest już nasza (Etap 5): ktoś ją przejął albo domknął.
      // Koszt wywołań tej próby zostaje w księdze (klucze próby), a poza tym
      // NIC — ani szkic, ani domknięcie, ani zwrot kwoty.
      if (abortReason === ABORT_REASON_LEASE_LOST) {
        draft.stop();
        await this.settleLedgerAfterError(
          input,
          turnLedger,
          error,
          'lease_lost',
        );
        this.metrics.recordJobLeaseLost();
        this.logger.warn(
          `turn ${input.turnId} requestId=${input.requestId}: lease utracony w próbie ${lease?.attempt ?? 1} — przerywam bez zapisu`,
        );
        return;
      }
      // Zamykanie procesu pod lease: nie FAILED, tylko oddanie tury do
      // kolejki — nowa instancja przejmie ją od razu (Etap 5, §5.15).
      if (abortReason === ABORT_REASON_SHUTDOWN && lease && this.queue) {
        draft.stop();
        await this.settleLedgerAfterError(input, turnLedger, error, 'shutdown');
        const released = await this.queue
          .release(input.turnId, lease.token)
          .catch(() => false);
        this.logger.warn(
          `turn ${input.turnId} requestId=${input.requestId}: zamykanie procesu — lease ${
            released ? 'oddany' : 'już nie nasz'
          } (próba ${lease.attempt})`,
        );
        return;
      }
      // Także przy błędzie i anulowaniu: szkic to jedyny ślad tego, co model
      // zdążył napisać (warunkowy zapis — tylko póki tura jest RUNNING).
      await draft.settle();
      const verdict = this.classify(
        error,
        controller.signal.aborted,
        controller.signal.reason,
      );
      const spent =
        error instanceof AgentProviderError ? error.usage : undefined;
      if (spent && error instanceof AgentProviderError) {
        const route = resolveRoute(input.env);
        await turnLedger.settle({
          usage: spent,
          phases: error.phases,
          apiCalls: error.apiCalls,
          // Bez rozbicia z dostawcy: model STARTOWY tury, nie `AI_MODEL`.
          model: route.model,
          effort: route.effort,
          stopReason: verdict.errorCode,
          // Porażka bez wydanych pieniędzy nie zostawia pustego wiersza.
          requireCost: true,
        });
      } else {
        await turnLedger.settle();
      }
      await this.finishFailed(
        input,
        error,
        verdict,
        Date.now() - startedAt,
        progress,
        turnLedger.spentMicroUsd > 0,
      );
    } finally {
      draft.stop();
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.running.delete(input.turnId);
    }
  }

  /** Księga po przerwaniu bez domknięcia (utrata lease, zamykanie procesu). */
  private async settleLedgerAfterError(
    input: RunTurnInput,
    turnLedger: TurnLedger,
    error: unknown,
    stopReason: string,
  ): Promise<void> {
    if (error instanceof AgentProviderError && error.usage) {
      const route = resolveRoute(input.env);
      await turnLedger.settle({
        usage: error.usage,
        phases: error.phases,
        apiCalls: error.apiCalls,
        model: route.model,
        effort: route.effort,
        stopReason,
        requireCost: true,
      });
      return;
    }
    await turnLedger.settle();
  }

  /**
   * Odnowienie lease (Etap 5). Nieudane (`held: false`) = turę przejął ktoś
   * inny albo ją domknął — przerywamy. Błąd bazy: próbujemy dalej, ale gdy od
   * ostatniego udanego odnowienia minęła cała ważność lease, inny worker
   * mógł już turę przejąć — przerywamy też, bo nie wiemy, czy wolno pisać.
   */
  private async renewLease(
    input: RunTurnInput,
    lease: TurnLease,
    controller: AbortController,
    liveness: { lastRenewedAt: number },
  ): Promise<void> {
    if (!this.queue || controller.signal.aborted) return;
    const { leaseMs } = readTurnLeaseConfig();
    try {
      const state = await this.queue.renew(input.turnId, lease.token, leaseMs);
      if (!state.held) {
        if (!controller.signal.aborted) {
          controller.abort(ABORT_REASON_LEASE_LOST);
        }
        return;
      }
      liveness.lastRenewedAt = Date.now();
      if (state.cancelRequested && !controller.signal.aborted) {
        controller.abort(ABORT_REASON_CANCELLED);
      }
    } catch (error) {
      this.logger.warn(
        `turn ${input.turnId}: lease nie odnowiony: ${
          error instanceof Error ? error.message : 'nieznany błąd'
        }`,
      );
      if (
        Date.now() - liveness.lastRenewedAt >= leaseMs &&
        !controller.signal.aborted
      ) {
        controller.abort(ABORT_REASON_LEASE_LOST);
      }
    }
  }

  /**
   * Sprawdzenie z bazy przed kosztowną albo zapisującą czynnością (wywołanie
   * modelu, narzędzie z efektem): lease nadal nasz i bez „Stop". Rzuca po
   * ustawieniu przyczyny przerwania — dostawca i tak zobaczy sygnał.
   */
  private async leaseCheckpoint(
    input: RunTurnInput,
    lease: TurnLease,
    controller: AbortController,
  ): Promise<void> {
    if (!this.queue) return;
    const state = await this.queue.check(input.turnId, lease.token);
    if (!state.held) {
      if (!controller.signal.aborted) {
        controller.abort(ABORT_REASON_LEASE_LOST);
      }
      throw new LeaseLostError(input.turnId);
    }
    if (state.cancelRequested) {
      if (!controller.signal.aborted) controller.abort(ABORT_REASON_CANCELLED);
      throw new Error('tura zatrzymana przez użytkownika');
    }
  }

  /**
   * Karta kończąca turę, zapisana w dzienniku przez wcześniejszą próbę,
   * razem ze zdaniem serwera (`turnTextFor`). `null` = nie ma albo karta
   * wymaga słowa modelu (plan PARTIAL) — wtedy próba biegnie normalnie,
   * a narzędzie i tak odda wynik z dziennika.
   */
  private async replayTerminalCard(
    turnId: string,
  ): Promise<{ result: AgentProviderResult; card: AgentCard | null } | null> {
    const row = await this.prisma.agentTurnEffect.findUnique({
      where: { turnId_key: { turnId, key: 'card' } },
    });
    if (!row) return null;
    const stored = toStored(row);
    if (!stored.result.ok) return null;
    const text = turnTextFor(stored.tool, stored.input, stored.result.data);
    if (!text) return null;
    return {
      result: {
        text,
        stopReason: TOOL_ENDED_TURN,
        usage: {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          costMicroUsd: 0,
        },
        apiCalls: 0,
        phases: [],
      },
      card: stored.card,
    };
  }

  /**
   * Znak życia tury. `count === 0` znaczy, że turę domknął już ktoś inny
   * (leniwy timeout, sprzątanie, rozmowa skasowana) — przerywamy ją, zamiast
   * płacić za kolejne rundy odpowiedzi, której nikt nie zobaczy. Błąd bazy
   * jest połykany: brak jednego uderzenia nie zabija tury (próg to minuta).
   */
  private async heartbeat(
    input: RunTurnInput,
    controller: AbortController,
  ): Promise<void> {
    try {
      const alive = await this.prisma.agentTurn.updateMany({
        where: { id: input.turnId, status: 'RUNNING' },
        data: { updatedAt: new Date() },
      });
      if (alive.count === 0 && !controller.signal.aborted) {
        controller.abort(ABORT_REASON_CLOSED);
      }
    } catch (error) {
      this.logger.warn(
        `turn ${input.turnId}: znak życia nie zapisany: ${
          error instanceof Error ? error.message : 'nieznany błąd'
        }`,
      );
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
    /** Fencing (Etap 5): worker bez lease nie nadpisze postępu następcy. */
    leaseToken?: string,
  ): Promise<void> {
    // Ziarno z tury: dwie tury opisują tę samą pracę innymi słowami, a jedna
    // tura nigdy nie podmienia tekstu pod ręką użytkownika.
    if (!appendProgress(steps, progressStep(tool, input, new Date(), turnId))) {
      return;
    }
    try {
      await this.prisma.agentTurn.updateMany({
        where: {
          id: turnId,
          status: 'RUNNING',
          ...(leaseToken ? { leaseToken } : {}),
        },
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
   * Historia rozmowy dla modelu: tekst wiadomości, a przy wiadomości
   * asystenta z kartą — zwięzły dopisek (opcje do wyboru, pozycje i stan
   * propozycji), patrz `history-cards.ts`. Stan propozycji z BAZY, jednym
   * zapytaniem, tylko gdy w oknie jest jakaś karta planu.
   */
  private async loadHistory(
    conversationId: string,
    prompt: Pick<AgentPrompt, 'catalogIndex' | 'visibleUserIds'>,
  ): Promise<AgentProviderMessage[]> {
    const rows = await this.prisma.agentMessage.findMany({
      // Poprawione pytanie i wszystko, co po nim, znika także z historii dla
      // MODELU. Inaczej model widziałby pytanie, które użytkownik wycofał,
      // i własną odpowiedź na nie — czyli dokładnie to, co poprawka miała
      // usunąć z rozmowy.
      where: { conversationId, hiddenAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HISTORY_WINDOW,
      select: { role: true, kind: true, text: true, card: true },
    });
    const chronological = rows
      .reverse()
      .filter((row) => row.role === 'USER' || row.role === 'ASSISTANT');
    const proposalIds = planProposalIds(chronological);
    const proposals =
      proposalIds.length > 0
        ? await this.prisma.agentProposal.findMany({
            where: { id: { in: proposalIds }, conversationId },
            select: { id: true, status: true, expiresAt: true },
          })
        : [];
    const texts = historyTexts(chronological, {
      refByRecipeId: new Map(
        Object.entries(prompt.catalogIndex).map(([ref, id]) => [id, ref]),
      ),
      visibleUserIds: new Set(prompt.visibleUserIds ?? []),
      proposals: new Map(proposals.map((row) => [row.id, row])),
      now: new Date(),
    });
    return chronological.map((row, index) => ({
      role:
        row.role === 'ASSISTANT' ? ('ASSISTANT' as const) : ('USER' as const),
      text: texts[index],
    }));
  }

  private async finishDone(
    input: RunTurnInput,
    result: AgentProviderResult,
    durationMs: number,
    pendingCard: AgentCard | null,
    usedContext: string[] = [],
    progress: readonly AgentProgressStep[] = [],
    /** Czy tura nic nie wydała (wszystkie wywołania za 0 — w pamięci). */
    free = false,
  ): Promise<void> {
    const { usage } = result;
    let closed = false;

    try {
      closed = await this.prisma.$transaction(async (tx) => {
        const update = await tx.agentTurn.updateMany({
          // Fencing (Etap 5): domyka WYŁĄCZNIE właściciel aktualnego lease.
          // Worker, który stracił lease i „odżył", trafia tu w `count === 0`.
          where: {
            id: input.turnId,
            status: 'RUNNING',
            ...(input.lease ? { leaseToken: input.lease.token } : {}),
          },
          data: {
            status: 'DONE',
            leaseExpiresAt: null,
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
            // Tokenów i kosztu NIE nadpisujemy: dopisuje je księga po każdym
            // wywołaniu (`AgentUsageLedger`), także po domknięciu tury.
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
            // Klucz wyjścia (Etap 5): druga odpowiedź tej tury — z odzyskanej
            // próby albo ponowionego domknięcia — trafia w unikat.
            outputKey: FINAL_OUTPUT_KEY,
          },
        });

        if (proposal) {
          await tx.agentProposal.update({
            where: { id: proposal.id },
            data: { messageId: message.id },
          });
        }
        // Turę uciął NASZ sufit kosztu (`AI_MAX_TURN_COST_USD`, sufit domu
        // albo instalacji), a nie wyczerpane rundy. Wiadomość wraca do puli
        // TYLKO wtedy, gdy tura nic nie kosztowała — przy sufitach z definicji
        // kosztowała, więc w praktyce nie wraca. Warunek „za darmo" sprawdza
        // baza (`refundIfFree`), bo koszt dopisuje księga.
        //
        // DLACZEGO ZMIANA (12.09.2026): zwrot bezwarunkowy dawał licznik, który
        // oscylował i nigdy nie dobijał do limitu. Konto z pulą próbną pięciu
        // wiadomości mogło wysyłać drogie tury bez końca: każda trafiała
        // w sufit kosztu, każda oddawała wiadomość, a rachunek u dostawcy rósł.
        // Przy `cost_ceiling` użytkownik dostaje skróconą, ale prawdziwą
        // odpowiedź („ostatnie słowo"), więc zapłata jedną wiadomością jest
        // uczciwa. Tura, która nie zdążyła nic wydać, nadal wraca za darmo.
        if (
          free &&
          (result.stopReason === 'cost_ceiling' ||
            result.stopReason === 'budget_ceiling')
        ) {
          await this.ledger.refundIfFree(tx, input.turnId, input.quotaScopeId);
        }

        await tx.agentConversation.update({
          where: { id: input.conversationId },
          data: { lastMessageAt: message.createdAt },
        });
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
      // Odpowiedź tej tury już jest (klucz `final`) — domknij turę na niej,
      // bez drugiej wiadomości.
      if (this.isFinalOutputConflict(error)) {
        closed = await this.closeOnExistingAnswer(input);
      } else {
        throw error;
      }
    }

    if (!closed) {
      this.logger.warn(
        `turn ${input.turnId} requestId=${input.requestId}: tura była już domknięta, wynik dostawcy porzucony`,
      );
      return;
    }

    this.metrics.recordTurnFinished('done');
    emitLive({ topics: ['assistant', 'dashboard'] });
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

  /**
   * Domknięcie tury, której odpowiedź (`outputKey = final`) już istnieje —
   * np. zapisana przez wcześniejszą próbę, która padła przed zmianą statusu.
   * Status DONE i przypięcie propozycji, bez nowej wiadomości; fencing jak
   * przy zwykłym domknięciu.
   */
  private async closeOnExistingAnswer(input: RunTurnInput): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const update = await tx.agentTurn.updateMany({
        where: {
          id: input.turnId,
          status: 'RUNNING',
          ...(input.lease ? { leaseToken: input.lease.token } : {}),
        },
        data: {
          status: 'DONE',
          leaseExpiresAt: null,
          finishedAt: new Date(),
          draftText: null,
        },
      });
      if (update.count === 0) return false;
      const answer = await tx.agentMessage.findFirst({
        where: { turnId: input.turnId, outputKey: FINAL_OUTPUT_KEY },
        select: { id: true, createdAt: true },
      });
      if (answer) {
        await tx.agentProposal.updateMany({
          where: { turnId: input.turnId, messageId: null },
          data: { messageId: answer.id },
        });
      }
      return true;
    });
  }

  private isFinalOutputConflict(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return false;
    }
    const target = (error.meta as { target?: unknown } | undefined)?.target;
    const fields = Array.isArray(target)
      ? target.map(String)
      : [String(target)];
    return fields.some((field) => field.includes('outputKey'));
  }

  private async finishFailed(
    input: RunTurnInput,
    error: unknown,
    verdict: FailureVerdict,
    durationMs: number,
    progress: readonly AgentProgressStep[] = [],
    /** Czy tura wydała cokolwiek (w pamięci — także gdy zapis księgi padł). */
    spentAnything = false,
  ): Promise<void> {
    try {
      const closed = await this.prisma.agentTurn.updateMany({
        where: {
          id: input.turnId,
          status: 'RUNNING',
          ...(input.lease ? { leaseToken: input.lease.token } : {}),
        },
        data: {
          status: 'FAILED',
          leaseExpiresAt: null,
          errorCode: verdict.errorCode,
          finishedAt: new Date(),
          durationMs,
          progress: settledProgress(
            progress,
          ) as unknown as Prisma.InputJsonValue,
          // Tokeny i koszt dopisała już księga — nie nadpisujemy ich tu.
        },
      });
      if (closed.count === 0) {
        this.logger.warn(
          `turn ${input.turnId} requestId=${input.requestId}: tura była już domknięta (${verdict.errorCode})`,
        );
        return;
      }

      // Zużycie sprzed błędu — metryki widzą koszt także nieudanych tur,
      // inaczej `/ops/metrics` pokazywał systematycznie mniej niż licznik
      // budżetu. Księga i liczniki sufitów mają go już z `onUsage`.
      const spent =
        error instanceof AgentProviderError ? error.usage : undefined;
      if (spent) {
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
      // Reguła jest jedna dla wszystkich powodów porażki i wszystkich ścieżek
      // domknięcia: nie wydaliśmy Twoich pieniędzy — nie bierzemy wiadomości.
      // Sprawdzają ją DWA źródła: pamięć tury (koszt, którego zapis do księgi
      // mógł paść) i baza (`refundIfFree` warunkiem `costMicroUsd: 0`).
      if (verdict.refund && !spentAnything) {
        await this.prisma.$transaction((tx) =>
          this.ledger.refundIfFree(tx, input.turnId, input.quotaScopeId),
        );
      }
    } catch (closeError) {
      if (this.isMissingRecord(closeError)) {
        this.logger.warn(
          `turn ${input.turnId} requestId=${input.requestId}: rekord zniknął przy domykaniu (P2025)`,
        );
        return;
      }
      // Awaria bazy przy domykaniu tury: sprzątanie osieroconych tur i leniwy
      // timeout w odczycie i tak ją zamkną — logujemy i nie wywracamy procesu.
      this.logger.error(
        `turn ${input.turnId} requestId=${input.requestId}: nie udało się domknąć tury`,
        closeError instanceof Error ? closeError.stack : undefined,
      );
      return;
    }

    this.metrics.recordTurnFinished(verdict.outcome);
    emitLive({ topics: ['assistant', 'dashboard'] });
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
    abortReason: unknown,
  ): FailureVerdict {
    // Przerwanie sprawdzamy PRZED typem błędu: dostawca dostaje `AbortSignal`
    // i zgłosi to po swojemu (u nas `AgentProviderError`), ale przyczyną jest
    // nasz timeout, „Stop" użytkownika albo zamykanie procesu, nie awaria po
    // jego stronie — bezpiecznik ma to zignorować. Kwota wraca we wszystkich
    // (o ile tura nic nie kosztowała): za przerwaną turę nikt nie dostał
    // odpowiedzi.
    if (aborted && abortReason === ABORT_REASON_CANCELLED) {
      return {
        errorCode: 'AI_CANCELLED',
        outcome: 'failed',
        refund: true,
        countsToBreaker: false,
      };
    }
    if (aborted && abortReason === ABORT_REASON_SHUTDOWN) {
      return {
        errorCode: 'AI_PROVIDER_ERROR',
        outcome: 'failed',
        refund: true,
        countsToBreaker: false,
      };
    }
    if (aborted) {
      // Nasz zegar albo tura domknięta z zewnątrz (`ABORT_REASON_CLOSED` —
      // wtedy domknięcie i tak znajdzie `count = 0` i nic nie zapisze).
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

/** Podsumowanie tury od dostawcy — surowiec zapisu zastępczego księgi. */
type LedgerSummary = {
  usage: AgentProviderUsage;
  phases?: AgentPhaseUsage[];
  apiCalls?: number;
  model: string;
  effort: AgentProviderCall['effort'];
  stopReason: string | null;
  /** Zapis zastępczy tylko przy niezerowym koszcie (porażka). */
  requireCost: boolean;
};

/**
 * Księga JEDNEJ tury po stronie runnera: przekazuje wywołania do
 * `AgentUsageLedger`, pamięta te, których zapis padł, i ponawia je przy
 * domknięciu (idempotentnie — klucz `(turnId, callIndex)`).
 *
 * Suma kosztu w pamięci jest drugim źródłem prawdy dla zwrotu kwoty: gdy
 * baza odrzuciła zapis dwa razy, księga pokazuje zero, ale pieniądze poszły —
 * i wiadomość nie może wtedy wrócić.
 */
class TurnLedger {
  private reported = 0;
  private spent = 0;
  private settled = false;
  private readonly failed: AgentProviderCall[] = [];

  constructor(
    private readonly ledger: AgentUsageLedger,
    private readonly logger: Logger,
    private readonly turn: LedgerTurn,
  ) {}

  get spentMicroUsd(): number {
    return this.spent;
  }

  async record(call: AgentProviderCall): Promise<AgentUsageVerdict> {
    this.reported += 1;
    this.spent += call.usage.costMicroUsd;
    try {
      return await this.ledger.record(this.turn, call);
    } catch (error) {
      this.failed.push(call);
      this.logger.warn(
        `turn ${this.turn.turnId}: zapis wywołania ${call.callIndex} do księgi nie wyszedł, ponowię przy domknięciu: ${
          error instanceof Error ? error.message : 'nieznany błąd'
        }`,
      );
      return { budgetExceeded: false };
    }
  }

  /**
   * Przed domknięciem tury: zapis zastępczy dla dostawcy, który nie melduje
   * wywołań (jeden wiersz na fazę albo zbiorczy), i ponowienie zapisów,
   * które padły. Raz na turę; nie rzuca.
   */
  async settle(summary?: LedgerSummary): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    if (
      this.reported === 0 &&
      summary &&
      (!summary.requireCost || summary.usage.costMicroUsd > 0)
    ) {
      for (const call of fallbackCalls(summary)) await this.record(call);
    }
    for (const call of this.failed.splice(0)) {
      try {
        await this.ledger.record(this.turn, call);
      } catch (error) {
        this.logger.error(
          `turn ${this.turn.turnId}: wywołanie ${call.callIndex} (${call.usage.costMicroUsd} µ$) poza księgą — zapis padł dwa razy: ${
            error instanceof Error ? error.message : 'nieznany błąd'
          }`,
        );
      }
    }
  }
}

/**
 * Wiersze zastępcze: jeden na FAZĘ (model + wysiłek), a gdy dostawca nie
 * rozróżnia faz — jeden zbiorczy z `apiCalls` całej tury (`null` = „nie
 * wiadomo", nie „zero").
 */
function fallbackCalls(summary: LedgerSummary): AgentProviderCall[] {
  const phases = summary.phases ?? [];
  if (phases.length === 0) {
    return [
      {
        callIndex: 0,
        model: summary.model,
        effort: summary.effort,
        usage: summary.usage,
        stopReason: summary.stopReason,
        latencyMs: null,
        apiCalls: summary.apiCalls ?? null,
      },
    ];
  }
  return phases.map((phase, index) => ({
    callIndex: index,
    model: phase.model,
    effort: phase.effort,
    usage: phase.usage,
    stopReason: summary.stopReason,
    latencyMs: null,
    apiCalls: phase.apiCalls,
  }));
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
export class DraftPublisher {
  /**
   * Najwyżej jeden zapis na sekundę (Etap 4C; było 350 ms). Pierwszy fragment
   * idzie OD RAZU (telefon widzi, że odpowiedź powstaje), kolejne zbierają
   * się w jeden zapis na okno, a `settle()` dopisuje końcówkę przed
   * domknięciem tury. Zapisy biegną po kolei — starszy tekst nigdy nie
   * nadpisze nowszego.
   */
  static readonly intervalMs = 1000;
  private pending: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastFlushAt = 0;
  private writing: Promise<void> = Promise.resolve();
  /** Liczba zapisów — do pomiaru (sonda, testy). */
  writes = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
    private readonly turnId: string,
    /** Fencing (Etap 5): szkic pisze tylko właściciel lease. */
    private readonly leaseToken?: string,
  ) {}

  push(text: string): void {
    if (this.stopped) return;
    this.pending = text;
    if (this.timer) return;
    const wait = this.lastFlushAt + DraftPublisher.intervalMs - Date.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  /** Koniec tury: dopisz to, co czeka, i nic więcej. */
  async settle(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending !== null) this.flush();
    this.stopped = true;
    await this.writing;
  }

  /** Twarde zatrzymanie (sprzątanie w `finally`) — bez dopisywania. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private flush(): void {
    const text = this.pending;
    this.pending = null;
    if (text === null) return;
    this.lastFlushAt = Date.now();
    this.writes += 1;
    this.writing = this.writing.then(() => this.write(text));
  }

  private async write(text: string): Promise<void> {
    try {
      await this.prisma.agentTurn.updateMany({
        where: {
          id: this.turnId,
          status: 'RUNNING',
          ...(this.leaseToken ? { leaseToken: this.leaseToken } : {}),
        },
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
