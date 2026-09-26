import { TURN_TIMEOUT_GRACE_MS } from '../config/agent-env';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { TURN_ORPHAN_AFTER_MS } from './agent-turn-liveness';
import { AgentTurnSweeper } from './agent-turn-sweeper.service';
import { AgentTurnRunner } from './agent-turn.runner';
import { AgentUsageLedger } from './agent-usage-ledger.service';

const HOUSEHOLD = 'a00f55ec-8500-4b44-85e6-561bfba4dbad';
const NOW = Date.parse('2026-09-26T12:00:00Z');
/** Domyślny `AI_TURN_TIMEOUT_MS` (4 min). */
const TIMEOUT_MS = 240_000;

describe('AgentTurnSweeper', () => {
  const tx = {};
  const prisma = {
    agentTurn: { findMany: jest.fn() },
    $transaction: jest.fn(async (cb: (client: typeof tx) => Promise<unknown>) =>
      cb(tx),
    ),
  };
  const runner = { isRunning: jest.fn() };
  const ledger = { closeTurn: jest.fn() };
  let metrics: AgentMetricsService;
  let sweeper: AgentTurnSweeper;
  const original = process.env.AI_TURN_TIMEOUT_MS;

  const row = (id: string, startedAgoMs: number, silentForMs: number) => ({
    id,
    startedAt: new Date(NOW - startedAgoMs),
    updatedAt: new Date(NOW - silentForMs),
    conversation: { householdId: HOUSEHOLD },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AI_TURN_TIMEOUT_MS;
    runner.isRunning.mockReturnValue(false);
    ledger.closeTurn.mockResolvedValue(true);
    metrics = new AgentMetricsService();
    sweeper = new AgentTurnSweeper(
      prisma as unknown as PrismaService,
      runner as unknown as AgentTurnRunner,
      ledger as unknown as AgentUsageLedger,
      metrics,
    );
  });

  afterAll(() => {
    if (original === undefined) delete process.env.AI_TURN_TIMEOUT_MS;
    else process.env.AI_TURN_TIMEOUT_MS = original;
  });

  it('domyka osierocone: bez znaku życia → AI_PROVIDER_ERROR, po czasie → AI_TIMEOUT', async () => {
    prisma.agentTurn.findMany.mockResolvedValue([
      row('after-restart', 90_000, TURN_ORPHAN_AFTER_MS + 1),
      row('too-long', TIMEOUT_MS + TURN_TIMEOUT_GRACE_MS + 1, 1_000),
    ]);

    await expect(sweeper.sweep(NOW)).resolves.toBe(2);

    expect(ledger.closeTurn).toHaveBeenCalledWith(tx, {
      turnId: 'after-restart',
      errorCode: 'AI_PROVIDER_ERROR',
      fallbackScopeId: HOUSEHOLD,
    });
    expect(ledger.closeTurn).toHaveBeenCalledWith(tx, {
      turnId: 'too-long',
      errorCode: 'AI_TIMEOUT',
      fallbackScopeId: HOUSEHOLD,
    });
    expect(metrics.snapshot().turns.failed).toBe(1);
    expect(metrics.snapshot().turns.timeout).toBe(1);
  });

  it('cichej tury prowadzonej przez TEN proces nie rusza, dopóki nie minie jej czas', async () => {
    runner.isRunning.mockReturnValue(true);
    prisma.agentTurn.findMany.mockResolvedValue([
      row('busy', 90_000, TURN_ORPHAN_AFTER_MS + 1),
    ]);
    await expect(sweeper.sweep(NOW)).resolves.toBe(0);
    expect(ledger.closeTurn).not.toHaveBeenCalled();
  });

  it('tura, którą ktoś właśnie domknął (count = 0), nie liczy się do metryk', async () => {
    ledger.closeTurn.mockResolvedValue(false);
    prisma.agentTurn.findMany.mockResolvedValue([
      row('raced', 90_000, TURN_ORPHAN_AFTER_MS + 1),
    ]);
    await expect(sweeper.sweep(NOW)).resolves.toBe(0);
    expect(metrics.snapshot().turns.failed).toBe(0);
  });

  it('pyta bazę o kandydatów po indeksie (status, updatedAt), partiami', async () => {
    prisma.agentTurn.findMany.mockResolvedValue([]);
    await sweeper.sweep(NOW);
    expect(prisma.agentTurn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'RUNNING',
          OR: [
            { updatedAt: { lte: new Date(NOW - TURN_ORPHAN_AFTER_MS) } },
            {
              startedAt: {
                lte: new Date(NOW - TIMEOUT_MS - TURN_TIMEOUT_GRACE_MS),
              },
            },
          ],
        },
        take: 100,
      }),
    );
  });
});
