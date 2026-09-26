import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { AgentConfigService } from '../agent-config.service';
import { AgentTurnRunner } from '../agent-turn.runner';
import { AgentMetricsService } from '../../observability/agent-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentTurnQueue, ClaimedTurn } from './agent-turn-queue.service';
import { parseTurnExecution, readTurnLeaseConfig } from './turn-lease-config';

/**
 * Worker tur asystenta (workstream, Etap 5) — zwykły serwis Nesta w procesie
 * API, bez BullMQ, Redis i osobnego deploymentu.
 *
 * Dwie drogi do tury:
 * - `kick(turnId)` zaraz po przyjęciu wiadomości (202) — tura startuje w tym
 *   procesie bez czekania na odpytywanie, jak przed Etapem 5;
 * - odpytywanie co `AI_TURN_WORKER_POLL_MS` i raz przy starcie — tury bez
 *   żywego lease: przyjęte przez proces, który padł przed startem runnera,
 *   porzucone przez proces zabity w trakcie (lease wygasł) albo oddane przy
 *   łagodnym zamknięciu (lease zwolniony od razu).
 *
 * Poprawność przy dwóch instancjach nie zależy od tego serwisu, tylko od
 * bazy: przejęcie `FOR UPDATE SKIP LOCKED`, fencing token w każdym zapisie
 * i dziennik efektów narzędzi.
 */
@Injectable()
export class AgentTurnWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AgentTurnWorker.name);
  /** Tożsamość tej instancji — `leaseOwner` przejętych tur. */
  readonly id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AgentTurnQueue,
    private readonly runner: AgentTurnRunner,
    private readonly config: AgentConfigService,
    private readonly metrics: AgentMetricsService,
  ) {}

  onApplicationBootstrap(): void {
    const { pollMs } = readTurnLeaseConfig();
    // Od razu przy starcie: tura porzucona przez poprzedni proces nie czeka
    // na pierwsze odpytanie ani na telefon.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), pollMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Worker przestaje przejmować tury (zamykanie procesu, testy). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private canClaim(): boolean {
    return (
      !this.stopped &&
      !this.runner.isDraining() &&
      readTurnLeaseConfig().workerEnabled
    );
  }

  /** Tura przyjęta w tym procesie — przejmij ją od razu. */
  kick(turnId: string): void {
    if (!this.canClaim()) return;
    void this.claimAndRun({ turnId, limit: 1 }).catch((error: unknown) =>
      this.logger.warn(
        `turn ${turnId}: natychmiastowe przejęcie nie wyszło (${
          error instanceof Error ? error.message : 'nieznany błąd'
        }) — przejmie ją odpytywanie`,
      ),
    );
  }

  /** Jeden przebieg odpytywania; oddaje liczbę przejętych tur. Publiczne dla testów. */
  async poll(): Promise<number> {
    if (this.polling || !this.canClaim()) return 0;
    this.polling = true;
    try {
      const { concurrency } = readTurnLeaseConfig();
      const free = concurrency - this.runner.runningCount();
      return await this.claimAndRun({ limit: free });
    } catch (error) {
      this.logger.warn(
        `odpytywanie kolejki tur nie wyszło (${
          error instanceof Error ? error.message : 'nieznany błąd'
        })`,
      );
      return 0;
    } finally {
      this.polling = false;
    }
  }

  private async claimAndRun(filter: {
    turnId?: string;
    limit: number;
  }): Promise<number> {
    if (filter.limit <= 0) return 0;
    const { leaseMs, maxAttempts } = readTurnLeaseConfig();
    const claimed = await this.queue.claim({
      workerId: this.id,
      leaseMs,
      maxAttempts,
      limit: filter.limit,
      turnId: filter.turnId,
    });
    for (const claim of claimed) {
      this.metrics.recordJobClaimed(claim.attempt);
      if (claim.attempt > 1) {
        // „Czy ta tura była odzyskana?" — w bazie `attempt > 1`, tu ślad bez
        // treści: id tury, próba, poprzedni właściciel.
        this.logger.warn(
          `turn ${claim.turnId}: przejęta po utracie procesu (próba ${claim.attempt}/${maxAttempts}, poprzedni właściciel ${claim.previousOwner ?? 'brak'})`,
        );
      }
      void this.execute(claim);
    }
    return claimed.length;
  }

  /**
   * Wejście runnera z BAZY — nie z pamięci procesu, który turę przyjął.
   * Konfiguracja asystenta (model, dostawca, sufity) z chwili wykonania.
   */
  private async execute(claim: ClaimedTurn): Promise<void> {
    try {
      const turn = await this.prisma.agentTurn.findUnique({
        where: { id: claim.turnId },
        select: {
          id: true,
          conversationId: true,
          userId: true,
          requestId: true,
          quotaPeriodKey: true,
          quotaScopeId: true,
          execution: true,
          deadlineAt: true,
          conversation: { select: { householdId: true } },
        },
      });
      const execution = parseTurnExecution(turn?.execution);
      if (!turn || !execution || !turn.deadlineAt) {
        // Rozmowa skasowana między przejęciem a odczytem albo wejście
        // nieczytelne — nie ma czego wykonać; lease wygaśnie sam.
        await this.queue.release(claim.turnId, claim.leaseToken);
        return;
      }
      await this.runner.run({
        turnId: turn.id,
        conversationId: turn.conversationId,
        userId: turn.userId,
        householdId: turn.conversation.householdId,
        periodKey: turn.quotaPeriodKey ?? '',
        quotaScopeId: turn.quotaScopeId ?? turn.conversation.householdId,
        env: this.config.read(),
        requestId: turn.requestId,
        dates: execution.dates,
        proposalMode: execution.proposalMode,
        lease: {
          token: claim.leaseToken,
          attempt: claim.attempt,
          deadlineAt: turn.deadlineAt,
        },
      });
    } catch (error) {
      // `run` nie rzuca; tu tylko odczyt tury. Lease wygaśnie i turę
      // przejmie następne odpytanie (w granicach limitu prób).
      this.logger.error(
        `turn ${claim.turnId}: wykonanie nie wystartowało`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
