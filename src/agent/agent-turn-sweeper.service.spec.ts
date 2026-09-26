import { TURN_TIMEOUT_GRACE_MS } from '../config/agent-env';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { TURN_ORPHAN_AFTER_MS } from './agent-turn-liveness';
import { AgentTurnSweeper } from './agent-turn-sweeper.service';
import { AgentTurnRunner } from './agent-turn.runner';
import { AgentUsageLedger } from './agent-usage-ledger.service';
import { AgentTurnQueue } from './durable/agent-turn-queue.service';

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
  const runner = {
    isRunning: jest.fn(),
    runningCount: jest.fn().mockReturnValue(0),
  };
  const ledger = { closeTurn: jest.fn() };
  const queue = {
    gauges: jest.fn().mockResolvedValue({ ready: 2, claimed: 1 }),
  };
  let metrics: AgentMetricsService;
  let sweeper: AgentTurnSweeper;
  const originalTimeout = process.env.AI_TURN_TIMEOUT_MS;
  const originalAttempts = process.env.AI_TURN_MAX_ATTEMPTS;

  /** Tura sprzed Etapu 5: bez terminu i lease. */
  const legacy = (id: string, startedAgoMs: number, silentForMs: number) => ({
    id,
    startedAt: new Date(NOW - startedAgoMs),
    updatedAt: new Date(NOW - silentForMs),
    deadlineAt: null,
    attempt: 0,
    leaseExpiresAt: null,
    cancelRequestedAt: null,
    conversation: { householdId: HOUSEHOLD },
  });

  /** Tura z trwałym wykonaniem (Etap 5). */
  const durable = (
    id: string,
    overrides: Partial<{
      deadlineInMs: number;
      attempt: number;
      leaseInMs: number | null;
      cancelled: boolean;
    }> = {},
  ) => ({
    id,
    startedAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW - 45_000),
    deadlineAt: new Date(NOW + (overrides.deadlineInMs ?? 180_000)),
    attempt: overrides.attempt ?? 1,
    leaseExpiresAt:
      overrides.leaseInMs === null
        ? null
        : new Date(NOW + (overrides.leaseInMs ?? -5_000)),
    cancelRequestedAt: overrides.cancelled ? new Date(NOW - 1_000) : null,
    conversation: { householdId: HOUSEHOLD },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AI_TURN_TIMEOUT_MS;
    delete process.env.AI_TURN_MAX_ATTEMPTS;
    runner.isRunning.mockReturnValue(false);
    ledger.closeTurn.mockResolvedValue(true);
    metrics = new AgentMetricsService();
    sweeper = new AgentTurnSweeper(
      prisma as unknown as PrismaService,
      runner as unknown as AgentTurnRunner,
      ledger as unknown as AgentUsageLedger,
      metrics,
      queue as unknown as AgentTurnQueue,
    );
  });

  afterAll(() => {
    if (originalTimeout === undefined) delete process.env.AI_TURN_TIMEOUT_MS;
    else process.env.AI_TURN_TIMEOUT_MS = originalTimeout;
    if (originalAttempts === undefined) delete process.env.AI_TURN_MAX_ATTEMPTS;
    else process.env.AI_TURN_MAX_ATTEMPTS = originalAttempts;
  });

  it('stara tura bez znaku życia → AI_PROVIDER_ERROR, po czasie → AI_TIMEOUT', async () => {
    prisma.agentTurn.findMany.mockResolvedValue([
      legacy('after-restart', 90_000, TURN_ORPHAN_AFTER_MS + 1),
      legacy('too-long', TIMEOUT_MS + TURN_TIMEOUT_GRACE_MS + 1, 1_000),
    ]);

    await expect(sweeper.sweep(NOW)).resolves.toBe(2);

    expect(ledger.closeTurn).toHaveBeenCalledWith(tx, {
      turnId: 'after-restart',
      errorCode: 'AI_PROVIDER_ERROR',
      failureDetail: 'AI_TURN_LEGACY_ORPHAN',
      fallbackScopeId: HOUSEHOLD,
      onlyIfUnleased: true,
    });
    expect(ledger.closeTurn).toHaveBeenCalledWith(tx, {
      turnId: 'too-long',
      errorCode: 'AI_TIMEOUT',
      failureDetail: 'AI_TURN_DEADLINE',
      fallbackScopeId: HOUSEHOLD,
      // Po terminie domykamy nawet turę z żywym lease (zacięty worker).
      onlyIfUnleased: false,
    });
    expect(metrics.snapshot().turns.failed).toBe(1);
    expect(metrics.snapshot().turns.timeout).toBe(1);
  });

  it('tura z wygasłym lease PRZED terminem jest do przejęcia — sprzątanie jej NIE domyka', async () => {
    prisma.agentTurn.findMany.mockResolvedValue([
      durable('reclaimable', { leaseInMs: -20_000, attempt: 1 }),
      durable('never-claimed', { leaseInMs: null, attempt: 0 }),
    ]);
    await expect(sweeper.sweep(NOW)).resolves.toBe(0);
    expect(ledger.closeTurn).not.toHaveBeenCalled();
  });

  it('po terminie całej tury: AI_TIMEOUT, bez kolejnej próby (Etap 5, §5.11)', async () => {
    prisma.agentTurn.findMany.mockResolvedValue([
      durable('late', {
        deadlineInMs: -(TURN_TIMEOUT_GRACE_MS + 1),
        attempt: 1,
      }),
    ]);
    await expect(sweeper.sweep(NOW)).resolves.toBe(1);
    expect(ledger.closeTurn).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ turnId: 'late', errorCode: 'AI_TIMEOUT' }),
    );
  });

  it('wyczerpane próby: kontrolowany FAILED z dokładnym powodem', async () => {
    process.env.AI_TURN_MAX_ATTEMPTS = '3';
    prisma.agentTurn.findMany.mockResolvedValue([
      durable('exhausted', { attempt: 3, leaseInMs: -1_000 }),
    ]);
    await expect(sweeper.sweep(NOW)).resolves.toBe(1);
    expect(ledger.closeTurn).toHaveBeenCalledWith(tx, {
      turnId: 'exhausted',
      // Kontrakt z telefonem bez zmian; dokładny powód w `failureDetail`.
      errorCode: 'AI_PROVIDER_ERROR',
      failureDetail: 'AI_TURN_ATTEMPTS_EXHAUSTED',
      fallbackScopeId: HOUSEHOLD,
      onlyIfUnleased: true,
    });
    expect(metrics.snapshot().jobs.failed).toBe(1);
  });

  it('ostatnia próba w biegu (żywy lease) żyje, choć attempt = limit', async () => {
    process.env.AI_TURN_MAX_ATTEMPTS = '3';
    prisma.agentTurn.findMany.mockResolvedValue([
      durable('last-try', { attempt: 3, leaseInMs: 20_000 }),
    ]);
    await expect(sweeper.sweep(NOW)).resolves.toBe(0);
  });

  it('trwały „Stop" bez żywego lease → AI_CANCELLED; z żywym — czeka na workera', async () => {
    prisma.agentTurn.findMany.mockResolvedValue([
      durable('stopped', { cancelled: true, leaseInMs: -1_000 }),
      durable('stopping', { cancelled: true, leaseInMs: 20_000 }),
    ]);
    await expect(sweeper.sweep(NOW)).resolves.toBe(1);
    expect(ledger.closeTurn).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        turnId: 'stopped',
        errorCode: 'AI_CANCELLED',
        failureDetail: 'AI_TURN_CANCEL_REQUESTED',
      }),
    );
    expect(metrics.snapshot().jobs.cancelled).toBe(1);
  });

  it('cichej starej tury prowadzonej przez TEN proces nie rusza, dopóki nie minie jej czas', async () => {
    runner.isRunning.mockReturnValue(true);
    prisma.agentTurn.findMany.mockResolvedValue([
      legacy('busy', 90_000, TURN_ORPHAN_AFTER_MS + 1),
    ]);
    await expect(sweeper.sweep(NOW)).resolves.toBe(0);
    expect(ledger.closeTurn).not.toHaveBeenCalled();
  });

  it('tura, którą ktoś właśnie domknął (count = 0), nie liczy się do metryk', async () => {
    ledger.closeTurn.mockResolvedValue(false);
    prisma.agentTurn.findMany.mockResolvedValue([
      legacy('raced', 90_000, TURN_ORPHAN_AFTER_MS + 1),
    ]);
    await expect(sweeper.sweep(NOW)).resolves.toBe(0);
    expect(metrics.snapshot().turns.failed).toBe(0);
  });

  it('odświeża stan kolejki w metrykach', async () => {
    prisma.agentTurn.findMany.mockResolvedValue([]);
    runner.runningCount.mockReturnValue(4);
    await sweeper.sweep(NOW);
    expect(metrics.snapshot().jobs).toMatchObject({
      ready: 2,
      claimed: 1,
      running: 4,
    });
  });

  it('pyta bazę o kandydatów partiami', async () => {
    prisma.agentTurn.findMany.mockResolvedValue([]);
    await sweeper.sweep(NOW);
    expect(prisma.agentTurn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'RUNNING' }),
        take: 100,
      }),
    );
  });
});
