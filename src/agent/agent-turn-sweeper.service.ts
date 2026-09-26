import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { readAgentEnv } from '../config/agent-env';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  closeCandidatesWhere,
  TURN_FAILURE_DETAIL,
  TURN_LIVENESS_SELECT,
  turnCloseVerdict,
} from './agent-turn-liveness';
import { AgentTurnRunner } from './agent-turn.runner';
import { AgentUsageLedger } from './agent-usage-ledger.service';
import { AgentTurnQueue } from './durable/agent-turn-queue.service';
import { readTurnLeaseConfig } from './durable/turn-lease-config';

/** Co ile sprzątamy — tyle samo, ile trwa próg „bez znaku życia" starej tury. */
export const TURN_SWEEP_INTERVAL_MS = 60_000;

/** Ile tur najwyżej na jeden przebieg — przebieg nie może zablokować puli. */
const SWEEP_BATCH = 100;

/**
 * Sprzątanie tur, których NIKT już nie dokończy (raz przy starcie i co
 * minutę).
 *
 * Od Etapu 5 (trwałe wykonywanie) tura z wygasłym lease NIE jest martwa —
 * jest do przejęcia i przejmuje ją `AgentTurnWorker`. Sprzątanie domyka
 * wyłącznie (`turnCloseVerdict`):
 * - tury po terminie całej tury — `AI_TIMEOUT`;
 * - tury sprzed Etapu 5 (bez zapisanego wejścia) bez znaku życia od minuty —
 *   `AI_PROVIDER_ERROR`, jak dawniej;
 * - tury bez żywego lease z trwałym „Stop" — `AI_CANCELLED`;
 * - tury bez żywego lease, które wyczerpały próby — `AI_PROVIDER_ERROR`
 *   z `failureDetail = AI_TURN_ATTEMPTS_EXHAUSTED`.
 * Koszt zostaje (jest w księdze), wiadomość wraca tylko za turę bez kosztu.
 * Przy okazji odświeża stan kolejki w metrykach.
 */
@Injectable()
export class AgentTurnSweeper
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AgentTurnSweeper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: AgentTurnRunner,
    private readonly ledger: AgentUsageLedger,
    private readonly metrics: AgentMetricsService,
    private readonly queue: AgentTurnQueue,
  ) {}

  onApplicationBootstrap(): void {
    void this.sweepQuietly();
    this.timer = setInterval(
      () => void this.sweepQuietly(),
      TURN_SWEEP_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Jeden przebieg; oddaje liczbę domkniętych tur. Publiczne dla testów. */
  async sweep(now: number = Date.now()): Promise<number> {
    const { turnTimeoutMs } = readAgentEnv();
    const { maxAttempts } = readTurnLeaseConfig();
    const candidates = await this.prisma.agentTurn.findMany({
      where: closeCandidatesWhere(turnTimeoutMs, maxAttempts, now),
      select: {
        id: true,
        ...TURN_LIVENESS_SELECT,
        conversation: { select: { householdId: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: SWEEP_BATCH,
    });
    let closed = 0;
    for (const turn of candidates) {
      const verdict = turnCloseVerdict(turn, {
        turnTimeoutMs,
        maxAttempts,
        inProcess: this.runner.isRunning(turn.id),
        now,
      });
      if (!verdict) continue;
      const done = await this.prisma.$transaction((tx) =>
        this.ledger.closeTurn(tx, {
          turnId: turn.id,
          errorCode: verdict.errorCode,
          failureDetail: verdict.detail,
          fallbackScopeId: turn.conversation.householdId,
          // Poza terminem tury: domykamy także turę z żywym lease (worker
          // się zaciął). Inaczej — tylko bez żywego lease.
          onlyIfUnleased: verdict.detail !== TURN_FAILURE_DETAIL.deadline,
        }),
      );
      if (!done) continue;
      closed += 1;
      this.metrics.recordTurnFinished(verdict.outcome);
      if (verdict.detail === TURN_FAILURE_DETAIL.cancelRequested) {
        this.metrics.recordJobCancelled();
      } else if (verdict.detail !== TURN_FAILURE_DETAIL.deadline) {
        this.metrics.recordJobFailed(verdict.detail);
      }
      this.logger.warn(
        `turn ${turn.id}: domknięta przez sprzątanie (${verdict.errorCode}, ${verdict.detail}, próba ${turn.attempt})`,
      );
    }
    await this.refreshGauges(maxAttempts);
    return closed;
  }

  private async refreshGauges(maxAttempts: number): Promise<void> {
    try {
      const gauges = await this.queue.gauges(maxAttempts);
      this.metrics.recordJobGauges({
        ...gauges,
        running: this.runner.runningCount(),
      });
    } catch {
      // Metryki to udogodnienie — następny przebieg za minutę.
    }
  }

  private async sweepQuietly(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      // Sprzątanie jest siatką bezpieczeństwa: jego błąd nie może niczego
      // wywrócić — następny przebieg za minutę.
      this.logger.warn(
        `sprzątanie tur nie wyszło (${
          error instanceof Error ? error.message : 'nieznany błąd'
        })`,
      );
    }
  }
}
