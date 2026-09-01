import { Prisma } from '@prisma/client';
import { AgentEnv } from '../config/agent-env';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentTurnRunner, RunTurnInput } from './agent-turn.runner';
import { AiUsageCountersService } from './ai-usage-counters.service';
import {
  AgentProvider,
  AgentProviderError,
  AgentProviderResult,
} from './providers/agent-provider';
import { AgentProviderResolver } from './providers/agent-provider.resolver';
import { AgentPromptService } from './agent-prompt.service';
import { AgentToolExecutor } from './tools/agent-tool-executor';
import { UpstreamBreaker } from './upstream-breaker';

const HOUSEHOLD = 'a00f55ec-8500-4b44-85e6-561bfba4dbad';
const USER = 'd4999c6e-ad7a-4810-b57e-9131ff1cea1b';
const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const TURN = '44444444-4444-4444-8444-444444444444';

const ENV: AgentEnv = {
  enabled: true,
  provider: 'stub',
  model: 'claude-sonnet-5',
  apiKeyPresent: false,
  effort: 'medium',
  turnTimeoutMs: 90_000,
  messagesPerMonth: 200,
  plansPerMonth: 30,
  globalDailyBudgetUsd: null,
  stubDelayMs: 0,
  cardsMode: 'off',
  proposalTtlMs: 72 * 60 * 60 * 1000,
  proposalUndoWindowMs: 60 * 60 * 1000,
};

const RESULT: AgentProviderResult = {
  text: 'gotowe',
  stopReason: 'end_turn',
  apiCalls: 1,
  usage: {
    inputTokens: 100,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    outputTokens: 50,
    costMicroUsd: 4200,
  },
};

describe('AgentTurnRunner', () => {
  const tx = {
    agentTurn: { updateMany: jest.fn() },
    agentMessage: { create: jest.fn() },
    aiUsage: { create: jest.fn() },
    agentConversation: { update: jest.fn() },
    // Propozycja z tej tury; `null` = model niczego nie zaproponował,
    // czyli zwykła odpowiedź tekstowa.
    agentProposal: { findFirst: jest.fn(), update: jest.fn() },
  };
  const prisma = {
    agentMessage: { findMany: jest.fn() },
    agentTurn: { updateMany: jest.fn() },
    aiUsage: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const counters = { add: jest.fn(), dayKey: jest.fn() };
  const run = jest.fn();
  const provider: AgentProvider = { name: 'stub', run };
  const resolver = { resolve: () => provider };
  const prompts = {
    build: jest.fn().mockResolvedValue({
      system: [{ type: 'text', text: 'instrukcje' }],
      catalogIndex: {},
      catalogVersion: 'abc',
    }),
  };
  const toolExecutor = { execute: jest.fn() };

  let breaker: UpstreamBreaker;
  let metrics: AgentMetricsService;
  let runner: AgentTurnRunner;

  const input = (overrides: Partial<RunTurnInput> = {}): RunTurnInput => ({
    turnId: TURN,
    conversationId: CONVERSATION,
    userId: USER,
    householdId: HOUSEHOLD,
    periodKey: '2026-08',
    env: ENV,
    requestId: 'req-1',
    dates: {
      weekStart: '2026-08-31',
      clientToday: '2026-09-02',
      timeZone: 'Europe/Warsaw',
    },
    proposalMode: false,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.agentMessage.findMany.mockResolvedValue([
      { role: 'ASSISTANT', text: 'poprzednia' },
      { role: 'USER', text: 'pytanie' },
    ]);
    prisma.$transaction.mockImplementation(
      async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx),
    );
    prisma.agentTurn.updateMany.mockResolvedValue({ count: 1 });
    tx.agentProposal.findFirst.mockResolvedValue(null);
    tx.agentTurn.updateMany.mockResolvedValue({ count: 1 });
    tx.agentMessage.create.mockResolvedValue({
      id: 'msg',
      createdAt: new Date('2026-08-31T10:00:05.000Z'),
    });
    counters.dayKey.mockReturnValue('2026-08-31');
    run.mockResolvedValue(RESULT);

    breaker = new UpstreamBreaker();
    metrics = new AgentMetricsService();
    runner = new AgentTurnRunner(
      prisma as unknown as PrismaService,
      resolver as unknown as AgentProviderResolver,
      prompts as unknown as AgentPromptService,
      toolExecutor as unknown as AgentToolExecutor,
      counters as unknown as AiUsageCountersService,
      breaker,
      metrics,
    );
  });

  describe('tura udana', () => {
    it('domyka turę, dopisuje odpowiedź, księgę użycia i koszt do budżetu', async () => {
      await runner.run(input());

      expect(tx.agentTurn.updateMany).toHaveBeenCalledWith({
        where: { id: TURN, status: 'RUNNING' },
        data: expect.objectContaining({
          status: 'DONE',
          inputTokens: 100,
          outputTokens: 50,
          costMicroUsd: 4200,
        }),
      });
      expect(tx.agentMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ role: 'ASSISTANT', text: 'gotowe' }),
      });
      expect(tx.aiUsage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          turnId: TURN,
          householdId: HOUSEHOLD,
          cacheReadTokens: 5,
          stopReason: 'end_turn',
        }),
      });
      expect(counters.add).toHaveBeenCalledWith(
        tx,
        'global',
        '2026-08-31',
        'costMicroUsd',
        4200,
      );

      const snapshot = metrics.snapshot();
      expect(snapshot.turns.done).toBe(1);
      expect(snapshot.usage.providerCalls).toBe(1);
      expect(snapshot.usage.costMicroUsd).toBe(4200);
    });

    it('historia idzie do modelu chronologicznie', async () => {
      await runner.run(input());
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-5',
          messages: [
            { role: 'USER', text: 'pytanie' },
            { role: 'ASSISTANT', text: 'poprzednia' },
          ],
        }),
      );
    });

    it('tura domknięta wcześniej (count = 0) nie dostaje drugiej odpowiedzi', async () => {
      tx.agentTurn.updateMany.mockResolvedValue({ count: 0 });
      await runner.run(input());
      expect(tx.agentMessage.create).not.toHaveBeenCalled();
      expect(metrics.snapshot().turns.done).toBe(0);
    });

    it('kasuje historię bezpiecznika', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      await runner.run(input());
      expect(breaker.recordFailure()).toBe(false);
    });
  });

  describe('tura nieudana', () => {
    it('błąd retryable: kwota wraca i liczy się do bezpiecznika', async () => {
      run.mockRejectedValue(new AgentProviderError('503 od dostawcy', true));
      await runner.run(input());

      expect(prisma.agentTurn.updateMany).toHaveBeenCalledWith({
        where: { id: TURN, status: 'RUNNING' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'AI_PROVIDER_ERROR',
        }),
      });
      expect(counters.add).toHaveBeenCalledWith(
        prisma,
        HOUSEHOLD,
        '2026-08',
        'messages',
        -1,
      );
      expect(metrics.snapshot().upstream.total).toBe(1);
      expect(metrics.snapshot().turns.failed).toBe(1);
    });

    it('tura spalona po kilku rundach trafia do KSIĘGI, nie tylko na turę', async () => {
      // `AiUsage` to surowiec do kalibracji kosztów („jeden wiersz na żądanie
      // do dostawcy"). Bez wiersza dla porażki księga pokazywałaby wyłącznie
      // tury udane — czyli rachunek systematycznie niższy od prawdziwego.
      run.mockRejectedValue(
        new AgentProviderError('503 po czterech rundach', true, 503, {
          inputTokens: 18_000,
          cacheReadTokens: 16_000,
          cacheWriteTokens: 0,
          outputTokens: 900,
          costMicroUsd: 41_000,
        }),
      );
      await runner.run(input());

      expect(prisma.aiUsage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          turnId: TURN,
          stopReason: 'AI_PROVIDER_ERROR',
          inputTokens: 18_000,
          cacheReadTokens: 16_000,
          outputTokens: 900,
          costMicroUsd: 41_000,
        }),
      });
      // …i ten sam koszt musi obciążyć budżet dobowy.
      expect(counters.add).toHaveBeenCalledWith(
        prisma,
        'global',
        expect.any(String),
        'costMicroUsd',
        41_000,
      );
    });

    it('błąd bez zużycia nie dopisuje pustego wiersza do księgi', async () => {
      run.mockRejectedValue(
        new AgentProviderError('padło przed pierwszym wywołaniem', true),
      );
      await runner.run(input());
      expect(prisma.aiUsage.create).not.toHaveBeenCalled();
    });

    it('błąd nie-retryable: bez zwrotu kwoty i bez bezpiecznika', async () => {
      run.mockRejectedValue(new AgentProviderError('zły prompt', false));
      await runner.run(input());
      expect(counters.add).not.toHaveBeenCalled();
      expect(metrics.snapshot().upstream.total).toBe(0);
    });

    it('piąty błąd retryable otwiera bezpiecznik', async () => {
      run.mockRejectedValue(new AgentProviderError('503', true));
      for (let i = 0; i < 5; i += 1) await runner.run(input());
      expect(breaker.isOpen()).toBe(true);
      expect(metrics.snapshot().upstream.breakerOpened).toBe(1);
    });

    it('timeout: AI_TIMEOUT, zwrot kwoty, bezpiecznik nietknięty', async () => {
      run.mockImplementation(
        (request: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () =>
              reject(new AgentProviderError('przerwane', true)),
            );
          }),
      );

      await runner.run(input({ env: { ...ENV, turnTimeoutMs: 10 } }));

      expect(prisma.agentTurn.updateMany).toHaveBeenCalledWith({
        where: { id: TURN, status: 'RUNNING' },
        data: expect.objectContaining({ errorCode: 'AI_TIMEOUT' }),
      });
      expect(counters.add).toHaveBeenCalledWith(
        prisma,
        HOUSEHOLD,
        '2026-08',
        'messages',
        -1,
      );
      // Nasz timeout to nie awaria dostawcy.
      expect(metrics.snapshot().upstream.total).toBe(0);
      expect(metrics.snapshot().turns.timeout).toBe(1);
    });

    it('nieoczekiwany błąd (nie od dostawcy) daje INTERNAL_ERROR ze zwrotem', async () => {
      run.mockRejectedValue(new TypeError('coś pękło w kodzie'));
      await runner.run(input());
      expect(prisma.agentTurn.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ errorCode: 'INTERNAL_ERROR' }),
        }),
      );
      expect(counters.add).toHaveBeenCalled();
    });
  });

  describe('run nigdy nie rzuca', () => {
    it('rozmowa skasowana w trakcie tury (P2025)', async () => {
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('brak', {
          code: 'P2025',
          clientVersion: '6',
        }),
      );
      await expect(runner.run(input())).resolves.toBeUndefined();
      expect(metrics.snapshot().turns.done).toBe(0);
    });

    it('awaria bazy przy domykaniu nieudanej tury', async () => {
      run.mockRejectedValue(new AgentProviderError('503', true));
      prisma.agentTurn.updateMany.mockRejectedValue(new Error('baza padła'));
      await expect(runner.run(input())).resolves.toBeUndefined();
    });

    it('awaria bazy przy czytaniu historii', async () => {
      prisma.agentMessage.findMany.mockRejectedValue(new Error('baza padła'));
      await expect(runner.run(input())).resolves.toBeUndefined();
      expect(metrics.snapshot().turns.failed).toBe(1);
    });
  });
});
