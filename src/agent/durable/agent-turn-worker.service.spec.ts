import { AgentConfigService } from '../agent-config.service';
import { AgentTurnRunner } from '../agent-turn.runner';
import { AgentMetricsService } from '../../observability/agent-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AgentTurnQueue, ClaimedTurn } from './agent-turn-queue.service';
import { AgentTurnWorker } from './agent-turn-worker.service';

const TURN = '44444444-4444-4444-8444-444444444444';
const CLAIM: ClaimedTurn = {
  turnId: TURN,
  leaseToken: '55555555-5555-4555-8555-555555555555',
  attempt: 1,
  previousOwner: null,
};

/**
 * Worker tur (Etap 5) — okno między przejęciem w bazie a startem runnera
 * (noc 26/27.09, N3). Runner jest PRAWDZIWY (mapa tur, `draining`,
 * `beforeApplicationShutdown`); podmieniony jest tylko jego `run`.
 */
describe('AgentTurnWorker', () => {
  const prisma = {
    agentTurn: {
      findUnique: jest.fn().mockResolvedValue({
        id: TURN,
        conversationId: 'c',
        userId: 'u',
        requestId: 'r',
        quotaPeriodKey: '2026-09',
        quotaScopeId: 'h',
        execution: {
          dates: {
            weekStart: '2026-09-21',
            clientToday: '2026-09-27',
            timeZone: 'Europe/Warsaw',
          },
          proposalMode: true,
        },
        deadlineAt: new Date(Date.now() + 60_000),
        conversation: { householdId: 'h' },
      }),
    },
  };
  const queue = { claim: jest.fn(), release: jest.fn() };
  const config = { read: jest.fn().mockReturnValue({}) };
  let runner: AgentTurnRunner;
  let worker: AgentTurnWorker;
  let runSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    queue.release.mockResolvedValue(true);
    runner = new AgentTurnRunner(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new AgentMetricsService(),
      {} as never,
    );
    runSpy = jest.spyOn(runner, 'run').mockResolvedValue(undefined);
    worker = new AgentTurnWorker(
      prisma as unknown as PrismaService,
      queue as unknown as AgentTurnQueue,
      runner,
      config as unknown as AgentConfigService,
      new AgentMetricsService(),
    );
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('przejęta tura startuje pod lease z bazy', async () => {
    queue.claim.mockResolvedValue([CLAIM]);
    await worker.poll();
    await flush();
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: TURN,
        lease: expect.objectContaining({
          token: CLAIM.leaseToken,
          attempt: 1,
        }),
      }),
    );
    expect(queue.release).not.toHaveBeenCalled();
  });

  it('SIGTERM w trakcie zapytania przejmującego: tura wraca do kolejki, nie startuje w gasnącym procesie', async () => {
    let answer!: (claims: ClaimedTurn[]) => void;
    queue.claim.mockReturnValue(
      new Promise<ClaimedTurn[]>((resolve) => (answer = resolve)),
    );
    const polling = worker.poll();
    await flush();
    expect(queue.claim).toHaveBeenCalledTimes(1);

    // SIGTERM przychodzi, zanim baza oddała wynik przejęcia: w procesie nie
    // ma jeszcze żadnej tury, więc zamykanie kończy się od razu.
    await runner.beforeApplicationShutdown();
    expect(runner.isDraining()).toBe(true);

    answer([CLAIM]);
    await polling;
    await flush();

    // Tura przejęta PO rozpoczęciu zamykania nie może wystartować (proces
    // zaraz zniknie i trzymałby lease do wygaśnięcia) — lease oddany od razu.
    expect(runSpy).not.toHaveBeenCalled();
    expect(queue.release).toHaveBeenCalledWith(TURN, CLAIM.leaseToken);
    expect(runner.isRunning(TURN)).toBe(false);
  });
});
