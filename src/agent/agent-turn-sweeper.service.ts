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
  orphanCandidatesWhere,
  orphanErrorCode,
  orphanReason,
} from './agent-turn-liveness';
import { AgentTurnRunner } from './agent-turn.runner';
import { AgentUsageLedger } from './agent-usage-ledger.service';

/** Co ile sprzątamy — tyle samo, ile trwa próg „bez znaku życia". */
export const TURN_SWEEP_INTERVAL_MS = 60_000;

/** Ile tur najwyżej na jeden przebieg — przebieg nie może zablokować puli. */
const SWEEP_BATCH = 100;

/**
 * Sprzątanie tur osieroconych przez pad procesu (deploy, OOM).
 *
 * Do 26.09.2026 taką turę zamykał wyłącznie ktoś, kto o nią zapytał:
 * odpytanie (`expireIfStale`) albo nowa wiadomość w TEJ rozmowie. Tura,
 * o którą nikt już nie pytał, wisiała jako RUNNING — zajmowała miejsce
 * w semaforze domu i nie oddawała wiadomości. Teraz zamykamy ją sami: raz
 * przy starcie (to jest „recovery po restarcie") i co minutę.
 *
 * Tury prowadzone przez TEN proces pomijamy, o ile nie minął ich czas
 * (`orphanReason` z `inProcess`). Kod: bez znaku życia — `AI_PROVIDER_ERROR`,
 * po czasie — `AI_TIMEOUT`; koszt zostaje (jest w księdze), wiadomość wraca
 * tylko za turę bez kosztu. Jedna instancja na Railwayu, więc zwykły
 * `setInterval` z `unref`, jak podgrzewanie cache.
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
    const candidates = await this.prisma.agentTurn.findMany({
      where: orphanCandidatesWhere(turnTimeoutMs, now),
      select: {
        id: true,
        startedAt: true,
        updatedAt: true,
        conversation: { select: { householdId: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: SWEEP_BATCH,
    });
    let closed = 0;
    for (const turn of candidates) {
      const reason = orphanReason(
        turn,
        turnTimeoutMs,
        this.runner.isRunning(turn.id),
        now,
      );
      if (!reason) continue;
      const done = await this.prisma.$transaction((tx) =>
        this.ledger.closeTurn(tx, {
          turnId: turn.id,
          errorCode: orphanErrorCode(reason),
          fallbackScopeId: turn.conversation.householdId,
        }),
      );
      if (!done) continue;
      closed += 1;
      this.metrics.recordTurnFinished(
        reason === 'timeout' ? 'timeout' : 'failed',
      );
    }
    if (closed > 0) {
      this.logger.warn(`domknięto ${closed} osieroconych tur asystenta`);
    }
    return closed;
  }

  private async sweepQuietly(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      // Sprzątanie jest siatką bezpieczeństwa: jego błąd nie może niczego
      // wywrócić — następny przebieg za minutę.
      this.logger.warn(
        `sprzątanie osieroconych tur nie wyszło (${
          error instanceof Error ? error.message : 'nieznany błąd'
        })`,
      );
    }
  }
}
