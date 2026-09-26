import { Prisma } from '@prisma/client';
import { AgentEnv } from '../config/agent-env';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ABORT_REASON_CLOSED,
  ABORT_REASON_SHUTDOWN,
  AgentTurnRunner,
  RunTurnInput,
} from './agent-turn.runner';
import { AgentUsageLedger } from './agent-usage-ledger.service';
import {
  AgentProvider,
  AgentProviderError,
  AgentProviderRequest,
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
  effortTools: 'low',
  householdMonthlyCostUsd: null,
  householdDailyCostUsd: null,
  turnTimeoutMs: 90_000,
  messagesPerMonth: 200,
  plansPerMonth: 30,
  trialMessages: 5,
  trialPlans: 1,
  tierOverride: 'PRO',
  maxConcurrentTurnsPerHousehold: 2,
  globalDailyBudgetUsd: null,
  stubDelayMs: 0,
  cardsMode: 'off',
  proposalTtlMs: 72 * 60 * 60 * 1000,
  proposalUndoWindowMs: 60 * 60 * 1000,
  allowedUsers: [],
  consentRequired: false,
  conversationRetentionDays: 90,
  maxTurnCostUsd: 1,
  toolsModel: null,
  catalogMode: 'search',
  cacheWarmHours: 0,
  turnCostReserveUsd: 0.25,
  shutdownGraceMs: 8_000,
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
    aiUsage: { create: jest.fn(), createMany: jest.fn() },
    agentConversation: { update: jest.fn() },
    // Propozycja z tej tury; `null` = model niczego nie zaproponował,
    // czyli zwykła odpowiedź tekstowa.
    agentProposal: { findFirst: jest.fn(), update: jest.fn() },
  };
  const prisma = {
    agentMessage: { findMany: jest.fn() },
    agentTurn: { updateMany: jest.fn() },
    aiUsage: { create: jest.fn(), createMany: jest.fn() },
    $transaction: jest.fn(),
  };
  // Księga per wywołanie: koszt, liczniki sufitów i zwrot kwoty żyją w niej
  // (`agent-usage-ledger.service.spec.ts`); runner tylko ją woła.
  const ledger = {
    record: jest.fn(),
    refundIfFree: jest.fn(),
  };
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
    // Zakres kwoty to NIE jest gospodarstwo — przy subskrypcji to `sub:<id>`.
    // Test trzyma tu wartość różną od `householdId` właśnie po to, żeby zwrot
    // wysłany „do domu” od razu się wywalił.
    quotaScopeId: `sub:${HOUSEHOLD}`,
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
    ledger.record.mockResolvedValue({ budgetExceeded: false });
    ledger.refundIfFree.mockResolvedValue(true);
    run.mockResolvedValue(RESULT);

    breaker = new UpstreamBreaker();
    metrics = new AgentMetricsService();
    runner = new AgentTurnRunner(
      prisma as unknown as PrismaService,
      resolver as unknown as AgentProviderResolver,
      prompts as unknown as AgentPromptService,
      toolExecutor as unknown as AgentToolExecutor,
      ledger as unknown as AgentUsageLedger,
      breaker,
      metrics,
      { notify: jest.fn().mockResolvedValue(false) } as never,
    );
  });

  describe('tura udana', () => {
    it('domyka turę, dopisuje odpowiedź i księgę użycia', async () => {
      await runner.run(input());

      const closing = tx.agentTurn.updateMany.mock.calls[0] as [
        { where: unknown; data: Record<string, unknown> },
      ];
      expect(closing[0].where).toEqual({ id: TURN, status: 'RUNNING' });
      expect(closing[0].data).toMatchObject({ status: 'DONE' });
      // Tokenów i kosztu domknięcie NIE nadpisuje — dopisuje je księga.
      expect(closing[0].data).not.toHaveProperty('costMicroUsd');
      expect(closing[0].data).not.toHaveProperty('inputTokens');
      expect(tx.agentMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ role: 'ASSISTANT', text: 'gotowe' }),
      });
      // Dostawca bez `onUsage` (ta atrapa): jeden zbiorczy wiersz zastępczy,
      // PRZED domknięciem, z tożsamością tury.
      expect(ledger.record).toHaveBeenCalledTimes(1);
      expect(ledger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          turnId: TURN,
          householdId: HOUSEHOLD,
          userId: USER,
          provider: 'stub',
        }),
        expect.objectContaining({
          callIndex: 0,
          stopReason: 'end_turn',
          usage: expect.objectContaining({
            cacheReadTokens: 5,
            costMicroUsd: 4200,
          }),
        }),
      );
      expect(tx.aiUsage.createMany).not.toHaveBeenCalled();

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
      // ZWROT WRACA TAM, SKĄD KWOTA ZESZŁA. Nie do gospodarstwa — do zakresu
      // z chwili pobrania (`sub:<id>` przy subskrypcji, `trial:<hasz>` na
      // próbie). Warunek „za darmo" sprawdza baza w `refundIfFree`.
      expect(ledger.refundIfFree).toHaveBeenCalledWith(
        tx,
        TURN,
        `sub:${HOUSEHOLD}`,
      );
      expect(metrics.snapshot().upstream.total).toBe(1);
      expect(metrics.snapshot().turns.failed).toBe(1);
    });

    it('tura spalona po kilku rundach trafia do KSIĘGI, nie tylko na turę', async () => {
      // `AiUsage` to surowiec do kalibracji kosztów. Bez wiersza dla porażki
      // księga pokazywałaby wyłącznie tury udane — czyli rachunek
      // systematycznie niższy od prawdziwego (i ślepe sufity kosztu).
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

      expect(ledger.record).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: TURN }),
        expect.objectContaining({
          callIndex: 0,
          stopReason: 'AI_PROVIDER_ERROR',
          usage: {
            inputTokens: 18_000,
            cacheReadTokens: 16_000,
            cacheWriteTokens: 0,
            outputTokens: 900,
            costMicroUsd: 41_000,
          },
        }),
      );
      // Pieniądze wydane — wiadomość nie wraca.
      expect(ledger.refundIfFree).not.toHaveBeenCalled();
    });

    it('błąd bez zużycia nie dopisuje pustego wiersza do księgi', async () => {
      run.mockRejectedValue(
        new AgentProviderError('padło przed pierwszym wywołaniem', true),
      );
      await runner.run(input());
      expect(ledger.record).not.toHaveBeenCalled();
    });

    it('błąd nie-retryable: bez zwrotu kwoty i bez bezpiecznika', async () => {
      run.mockRejectedValue(new AgentProviderError('zły prompt', false));
      await runner.run(input());
      expect(ledger.refundIfFree).not.toHaveBeenCalled();
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
      expect(ledger.refundIfFree).toHaveBeenCalledWith(
        tx,
        TURN,
        `sub:${HOUSEHOLD}`,
      );
      // Nasz timeout to nie awaria dostawcy.
      expect(metrics.snapshot().upstream.total).toBe(0);
      expect(metrics.snapshot().turns.timeout).toBe(1);
    });

    // AUDYT 12.09.2026 (P0.2). Zwrot bezwarunkowy przy timeoucie i ponawialnym
    // błędzie dostawcy dawał licznik, który oscylował i nigdy nie dobijał do
    // limitu: konto z pulą próbną pięciu wiadomości mogło wysyłać drogie tury
    // bez końca, bo każda oddawała wiadomość, a rachunek u dostawcy rósł.
    it('timeout PO wydaniu pieniędzy NIE oddaje wiadomości', async () => {
      run.mockImplementation(
        (request: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () =>
              reject(
                new AgentProviderError('przerwane', true, undefined, {
                  inputTokens: 30_000,
                  outputTokens: 900,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  costMicroUsd: 620_000,
                }),
              ),
            );
          }),
      );

      await runner.run(input({ env: { ...ENV, turnTimeoutMs: 10 } }));

      expect(ledger.refundIfFree).not.toHaveBeenCalled();
      // Pieniądze i tak muszą trafić do księgi (a z nią do liczników
      // sufitów) — inaczej sufity nie widziałyby wydatku nieudanej tury.
      expect(ledger.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          usage: expect.objectContaining({ costMicroUsd: 620_000 }),
        }),
      );
    });

    it('ponawialny błąd dostawcy PO wydaniu pieniędzy NIE oddaje wiadomości', async () => {
      run.mockRejectedValue(
        new AgentProviderError('529 overloaded', true, 529, {
          inputTokens: 12_000,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicroUsd: 90_000,
        }),
      );

      await runner.run(input());

      expect(ledger.refundIfFree).not.toHaveBeenCalled();
    });

    it('nieoczekiwany błąd (nie od dostawcy) daje INTERNAL_ERROR ze zwrotem', async () => {
      run.mockRejectedValue(new TypeError('coś pękło w kodzie'));
      await runner.run(input());
      expect(prisma.agentTurn.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ errorCode: 'INTERNAL_ERROR' }),
        }),
      );
      expect(ledger.refundIfFree).toHaveBeenCalled();
    });
  });

  /**
   * Księga per wywołanie (workstream, Etap 1): dostawca melduje KAŻDE
   * wywołanie przez `onUsage`, runner przekazuje je do `AgentUsageLedger`
   * i nie pisze już kosztu przy domknięciu.
   */
  describe('księga per wywołanie', () => {
    const call = (callIndex: number, costMicroUsd: number) => ({
      callIndex,
      model: 'claude-sonnet-5',
      effort: 'medium' as const,
      usage: {
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
        costMicroUsd,
      },
      stopReason: 'tool_use',
      latencyMs: 1200,
    });

    it('wywołania z dostawcy idą do księgi, bez zapisu zastępczego', async () => {
      run.mockImplementation(async (request: AgentProviderRequest) => {
        await request.onUsage?.(call(0, 300));
        await request.onUsage?.(call(1, 200));
        return RESULT;
      });
      await runner.run(input());

      expect(ledger.record).toHaveBeenCalledTimes(2);
      expect(ledger.record).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ turnId: TURN }),
        expect.objectContaining({ callIndex: 0 }),
      );
      expect(ledger.record).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({ callIndex: 1 }),
      );
    });

    it('werdykt budżetu z księgi wraca do dostawcy', async () => {
      ledger.record.mockResolvedValue({ budgetExceeded: true });
      let verdict: unknown;
      run.mockImplementation(async (request: AgentProviderRequest) => {
        verdict = await request.onUsage?.(call(0, 300));
        return RESULT;
      });
      await runner.run(input());
      expect(verdict).toEqual({ budgetExceeded: true });
    });

    it('zapis, który padł, jest ponawiany przed domknięciem tury', async () => {
      ledger.record
        .mockRejectedValueOnce(new Error('baza chwilowo padła'))
        .mockResolvedValue({ budgetExceeded: false });
      let verdict: unknown;
      run.mockImplementation(async (request: AgentProviderRequest) => {
        verdict = await request.onUsage?.(call(0, 300));
        return RESULT;
      });
      await runner.run(input());

      // Błąd księgi nie przerywa tury i nie zatrzymuje dostawcy.
      expect(verdict).toEqual({ budgetExceeded: false });
      expect(ledger.record).toHaveBeenCalledTimes(2);
      expect(ledger.record).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ callIndex: 0 }),
      );
      expect(metrics.snapshot().turns.done).toBe(1);
    });

    it('koszt poza księgą (zapis padł dwa razy) i tak blokuje zwrot', async () => {
      ledger.record.mockRejectedValue(new Error('baza leży'));
      run.mockImplementation(async (request: AgentProviderRequest) => {
        await request.onUsage?.(call(0, 300));
        throw new AgentProviderError('503 w drugiej rundzie', true);
      });
      await runner.run(input());
      expect(ledger.refundIfFree).not.toHaveBeenCalled();
    });

    it.each(['cost_ceiling', 'budget_ceiling'])(
      'tura DONE ucięta sufitem (%s) bez kosztu oddaje wiadomość',
      async (stopReason) => {
        run.mockResolvedValue({
          ...RESULT,
          stopReason,
          usage: { ...RESULT.usage, costMicroUsd: 0 },
        });
        await runner.run(input());
        expect(ledger.refundIfFree).toHaveBeenCalledWith(
          tx,
          TURN,
          `sub:${HOUSEHOLD}`,
        );
      },
    );

    it('zwykła tura DONE wiadomości nie oddaje', async () => {
      await runner.run(input());
      expect(ledger.refundIfFree).not.toHaveBeenCalled();
    });
  });

  describe('znak życia i zamykanie procesu', () => {
    const hanging = () => {
      let seen: AbortSignal | undefined;
      run.mockImplementation(
        (request: AgentProviderRequest) =>
          new Promise((_resolve, reject) => {
            seen = request.signal;
            request.signal.addEventListener('abort', () =>
              reject(new AgentProviderError('przerwane', true)),
            );
          }),
      );
      return () => seen;
    };

    afterEach(() => {
      jest.useRealTimers();
      delete process.env.AI_SHUTDOWN_GRACE_MS;
    });

    it('odświeża updatedAt co 15 s, a turę domkniętą z zewnątrz przerywa', async () => {
      jest.useFakeTimers();
      const signal = hanging();
      const running = runner.run(input());
      await jest.advanceTimersByTimeAsync(0);

      // Pierwsze uderzenie: tura żyje.
      await jest.advanceTimersByTimeAsync(15_000);
      expect(prisma.agentTurn.updateMany).toHaveBeenCalledWith({
        where: { id: TURN, status: 'RUNNING' },
        data: { updatedAt: expect.any(Date) },
      });
      expect(signal()?.aborted).toBe(false);

      // Drugie: turę domknął już ktoś inny — dalsze rundy to strata pieniędzy.
      prisma.agentTurn.updateMany.mockResolvedValue({ count: 0 });
      await jest.advanceTimersByTimeAsync(15_000);
      await running;
      expect(signal()?.reason).toBe(ABORT_REASON_CLOSED);
      expect(ledger.refundIfFree).not.toHaveBeenCalled();
    });

    it('SIGTERM: nowe tury odmawiane, wiszące przerwane po łasce jako AI_PROVIDER_ERROR bez bezpiecznika', async () => {
      process.env.AI_SHUTDOWN_GRACE_MS = '30';
      const signal = hanging();
      const running = runner.run(input());
      await new Promise((resolve) => setImmediate(resolve));
      expect(runner.isRunning(TURN)).toBe(true);

      await runner.beforeApplicationShutdown();
      await running;

      expect(runner.isDraining()).toBe(true);
      expect(signal()?.reason).toBe(ABORT_REASON_SHUTDOWN);
      expect(prisma.agentTurn.updateMany).toHaveBeenCalledWith({
        where: { id: TURN, status: 'RUNNING' },
        data: expect.objectContaining({ errorCode: 'AI_PROVIDER_ERROR' }),
      });
      expect(ledger.refundIfFree).toHaveBeenCalled();
      expect(metrics.snapshot().upstream.total).toBe(0);
      expect(runner.isRunning(TURN)).toBe(false);
    });

    it('SIGTERM bez tur w biegu kończy się od razu', async () => {
      await expect(runner.beforeApplicationShutdown()).resolves.toBeUndefined();
      expect(runner.isDraining()).toBe(true);
    });
  });

  /**
   * `AiUsage.apiCalls` w zapisie ZASTĘPCZYM — dla dostawcy, który nie melduje
   * wywołań przez `onUsage`. Wiersz to wtedy faza albo cała tura, więc musi
   * powiedzieć, ile żądań się na niego złożyło.
   */
  describe('księga: zapis zastępczy i apiCalls', () => {
    it('wariant bez faz zapisuje apiCalls całej tury', async () => {
      run.mockResolvedValue({ ...RESULT, apiCalls: 7 });
      await runner.run(input());

      expect(ledger.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ callIndex: 0, apiCalls: 7 }),
      );
    });

    it('każda faza zapisuje SWOJE apiCalls, pod kolejnym callIndex', async () => {
      run.mockResolvedValue({
        ...RESULT,
        apiCalls: 9,
        phases: [
          {
            model: 'claude-haiku-4-5',
            effort: 'low',
            apiCalls: 3,
            usage: {
              inputTokens: 10,
              cacheReadTokens: 1,
              cacheWriteTokens: 0,
              outputTokens: 5,
              costMicroUsd: 100,
            },
          },
          {
            model: 'claude-sonnet-5',
            effort: 'medium',
            apiCalls: 6,
            usage: {
              inputTokens: 90,
              cacheReadTokens: 4,
              cacheWriteTokens: 2,
              outputTokens: 45,
              costMicroUsd: 4100,
            },
          },
        ],
      });
      await runner.run(input());

      expect(ledger.record).toHaveBeenCalledTimes(2);
      expect(ledger.record).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.objectContaining({
          callIndex: 0,
          model: 'claude-haiku-4-5',
          apiCalls: 3,
        }),
      );
      expect(ledger.record).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({
          callIndex: 1,
          model: 'claude-sonnet-5',
          apiCalls: 6,
        }),
      );
    });

    it('nieudana tura księguje żądania, które zdążyły pójść', async () => {
      run.mockRejectedValue(
        new AgentProviderError(
          '503 po czterech rundach',
          true,
          503,
          {
            inputTokens: 18_000,
            cacheReadTokens: 16_000,
            cacheWriteTokens: 0,
            outputTokens: 900,
            costMicroUsd: 41_000,
          },
          4,
        ),
      );
      await runner.run(input());

      expect(ledger.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ apiCalls: 4 }),
      );
    });

    it('brak pomiaru zapisuje NULL, a nie zero — „nie wiadomo" to nie „zero żądań"', async () => {
      run.mockRejectedValue(
        new AgentProviderError('503 bez licznika', true, 503, {
          inputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 10,
          costMicroUsd: 500,
        }),
      );
      await runner.run(input());

      expect(ledger.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ apiCalls: null }),
      );
    });

    it('wiersz zastępczy niesie model startowy i wysiłek tury', async () => {
      run.mockResolvedValue({ ...RESULT, apiCalls: 3 });
      await runner.run(input());

      expect(ledger.record).toHaveBeenCalledWith(
        {
          turnId: TURN,
          userId: USER,
          householdId: HOUSEHOLD,
          provider: 'stub',
          env: ENV,
        },
        {
          callIndex: 0,
          model: 'claude-sonnet-5',
          effort: 'medium',
          usage: RESULT.usage,
          stopReason: 'end_turn',
          latencyMs: null,
          apiCalls: 3,
        },
      );
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
