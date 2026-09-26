import { Prisma } from '@prisma/client';
import { AppException } from '../common/app-exception';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentEnv } from '../config/agent-env';
import { AgentConfigService } from './agent-config.service';
import { AgentConversationsService } from './agent-conversations.service';
import { AgentTurnRunner } from './agent-turn.runner';
import {
  AgentTurnsService,
  TURN_TIMEOUT_GRACE_MS,
} from './agent-turns.service';
import { AiUsageCountersService } from './ai-usage-counters.service';
import { AgentUsageLedger } from './agent-usage-ledger.service';
import { PostMessageDto } from './dto/post-message.dto';
import { UpstreamBreaker } from './upstream-breaker';

const USER = 'd4999c6e-ad7a-4810-b57e-9131ff1cea1b';
const HOUSEHOLD = 'a00f55ec-8500-4b44-85e6-561bfba4dbad';
const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const CLIENT_MESSAGE = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const TURN = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = 'req-1';

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
  plannerPerUserPortions: false,
};

const validDto = (): PostMessageDto => ({
  clientMessageId: CLIENT_MESSAGE,
  text: 'Zaplanuj mi tydzień',
  weekStart: '2026-08-31',
  clientToday: '2026-09-02',
  timeZone: 'Europe/Warsaw',
});

describe('AgentTurnsService', () => {
  const tx = {
    agentTurn: {
      count: jest.fn(),
      create: jest.fn(),
      // Lease ZAMYKA martwe tury, zanim policzy żywe — stąd findMany/updateMany.
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    agentMessage: { create: jest.fn(), update: jest.fn() },
    agentConversation: { update: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    agentMessage: { findUnique: jest.fn(), findMany: jest.fn() },
    agentTurn: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      // Żywe tury instalacji — rezerwacja budżetu globalnego.
      count: jest.fn().mockResolvedValue(0),
    },
    // Bramka członkostwa w `loadOwnedTurn` — domyślnie pytający jest w domu.
    membership: {
      findUnique: jest.fn().mockResolvedValue({ userId: USER }),
    },
    // Dom rozmowy przy leniwym domknięciu osieroconej tury (`getTurn`).
    agentConversation: {
      findUnique: jest.fn().mockResolvedValue({ householdId: HOUSEHOLD }),
    },
    $transaction: jest.fn(),
  };
  const config = {
    assertEnabled: jest.fn(),
    assertUserAllowed: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(),
  };
  const conversations = { loadOwned: jest.fn() };
  const counters = {
    resolvePlan: jest.fn().mockResolvedValue({
      tier: 'PRO',
      source: 'ENV',
      quotaScopeId: HOUSEHOLD,
      periodKey: '2026-08',
      renews: true,
      resetsAt: '2026-10-01T00:00:00.000Z',
      messagesLimit: 200,
      plansLimit: 30,
    }),
    quotaDetailsFor: jest.fn().mockReturnValue(['kind:messages']),
    monthKey: jest.fn(),
    dayKey: jest.fn(),
    dayResetsAt: jest
      .fn()
      .mockReturnValue(new Date('2026-09-01T00:00:00.000Z')),
    read: jest.fn(),
    tryConsume: jest.fn(),
    add: jest.fn(),
    quotaDetails: jest.fn().mockReturnValue(['kind:messages']),
  };
  const runner = {
    run: jest.fn(),
    cancel: jest.fn().mockReturnValue(false),
    isRunning: jest.fn().mockReturnValue(false),
    isDraining: jest.fn().mockReturnValue(false),
  };
  // Worker (Etap 5): przyjęcie tury tylko go szturcha — wykonanie jest jego.
  const worker = { kick: jest.fn() };
  // Domknięcie z zewnątrz i zwrot za darmową turę żyją w księdze
  // (`agent-usage-ledger.service.spec.ts`); tu sprawdzamy, KIEDY je woła.
  const ledger = {
    closeTurn: jest.fn(),
    refundIfFree: jest.fn(),
  };
  let breaker: UpstreamBreaker;
  let metrics: AgentMetricsService;
  let service: AgentTurnsService;

  const build = () => {
    breaker = new UpstreamBreaker();
    metrics = new AgentMetricsService();
    service = new AgentTurnsService(
      prisma as unknown as PrismaService,
      config as unknown as AgentConfigService,
      conversations as unknown as AgentConversationsService,
      counters as unknown as AiUsageCountersService,
      // Mail o wyczerpanej puli — atrapa, bo ten test sprawdza odmowy, nie pocztę.
      { announce: jest.fn().mockResolvedValue(undefined) } as never,
      breaker,
      metrics,
      runner as unknown as AgentTurnRunner,
      { withCardState: (messages: unknown) => messages } as never,
      { notify: jest.fn().mockResolvedValue(false) } as never,
      ledger as unknown as AgentUsageLedger,
      worker as never,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    config.assertEnabled.mockReturnValue(ENV);
    config.read.mockReturnValue(ENV);
    conversations.loadOwned.mockResolvedValue({
      id: CONVERSATION,
      userId: USER,
      householdId: HOUSEHOLD,
      status: 'OPEN',
    });
    counters.monthKey.mockReturnValue('2026-08');
    counters.resolvePlan.mockResolvedValue({
      tier: 'PRO',
      source: 'ENV',
      quotaScopeId: HOUSEHOLD,
      periodKey: '2026-08',
      renews: true,
      resetsAt: '2026-09-01T00:00:00.000Z',
      messagesLimit: 200,
      plansLimit: 30,
    });
    counters.dayKey.mockReturnValue('2026-08-31');
    counters.read.mockResolvedValue(0);
    counters.tryConsume.mockResolvedValue(true);
    prisma.agentMessage.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(
      async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx),
    );
    tx.agentTurn.count.mockResolvedValue(0);
    tx.agentMessage.create.mockResolvedValue({
      id: MESSAGE,
      createdAt: new Date('2026-08-31T10:00:00.000Z'),
    });
    tx.agentTurn.create.mockResolvedValue({ id: TURN });
    prisma.agentTurn.count.mockResolvedValue(0);
    runner.isRunning.mockReturnValue(false);
    runner.isDraining.mockReturnValue(false);
    runner.cancel.mockReturnValue(false);
    ledger.closeTurn.mockResolvedValue(true);
    build();
  });

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      return (error as AppException).code;
    }
  };

  const post = (dto: PostMessageDto = validDto()) =>
    service.postMessage(USER, CONVERSATION, dto, REQUEST_ID);

  describe('postMessage — kolejność odmów', () => {
    it('1. wyłączony asystent: nic nie dotyka bazy', async () => {
      config.assertEnabled.mockImplementation(() => {
        throw new AppException('AI_DISABLED', 'nie', 503);
      });
      expect(await codeOf(post())).toBe('AI_DISABLED');
      expect(conversations.loadOwned).not.toHaveBeenCalled();
    });

    it('2. cudza rozmowa: 404 przed walidacją treści', async () => {
      conversations.loadOwned.mockRejectedValue(
        new AppException('AI_CONVERSATION_NOT_FOUND', 'nie ma', 404),
      );
      expect(await codeOf(post({ ...validDto(), text: '' }))).toBe(
        'AI_CONVERSATION_NOT_FOUND',
      );
    });

    it.each([
      ['pusty tekst', { text: '' }],
      ['tekst ponad 2000 znaków', { text: 'a'.repeat(2001) }],
      ['clientMessageId nie-UUID', { clientMessageId: 'abc' }],
      ['weekStart nie w poniedziałek', { weekStart: '2026-09-01' }],
      ['weekStart nieistniejąca data', { weekStart: '2026-02-31' }],
      ['clientToday nie jest datą', { clientToday: 'jutro' }],
      ['timeZone spoza IANA', { timeZone: 'Europe/Zażółć' }],
    ])('3. walidacja: %s', async (_label, patch) => {
      expect(await codeOf(post({ ...validDto(), ...patch }))).toBe(
        'VALIDATION_ERROR',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('4. idempotencja: to samo clientMessageId oddaje TĘ SAMĄ turę', async () => {
      prisma.agentMessage.findUnique.mockResolvedValue({
        id: MESSAGE,
        turnId: TURN,
      });
      prisma.agentTurn.findUnique.mockResolvedValue({
        id: TURN,
        status: 'DONE',
      });

      await expect(post()).resolves.toEqual({
        turnId: TURN,
        messageId: MESSAGE,
        status: 'DONE',
        requestId: REQUEST_ID,
      });
      // Ponowienie po zerwanej sieci nie może zejść z kwoty ani wpaść na 409.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(counters.tryConsume).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('5. otwarty bezpiecznik: AI_UPSTREAM_PAUSED z retryAfterSeconds', async () => {
      for (let i = 0; i < 5; i += 1) breaker.recordFailure();
      expect(breaker.isOpen()).toBe(true);

      try {
        await post();
        throw new Error('oczekiwano odmowy');
      } catch (error) {
        const exception = error as AppException;
        expect(exception.code).toBe('AI_UPSTREAM_PAUSED');
        expect(exception.getStatus()).toBe(503);
        expect(exception.details?.[0]).toMatch(/^retryAfterSeconds:\d+$/);
      }
      expect(metrics.snapshot().rejected.upstream).toBe(1);
    });

    it('5. budżet dobowy wyczerpany: AI_BUDGET_PAUSED', async () => {
      config.assertEnabled.mockReturnValue({
        ...ENV,
        globalDailyBudgetUsd: 1,
      });
      counters.read.mockResolvedValue(1_000_000);
      expect(await codeOf(post())).toBe('AI_BUDGET_PAUSED');
      expect(metrics.snapshot().rejected.budget).toBe(1);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('zamykany proces (SIGTERM): tura PRZYJĘTA — trwała, wykona ją nowa instancja (Etap 5)', async () => {
      runner.isDraining.mockReturnValue(true);
      await expect(post()).resolves.toMatchObject({ status: 'RUNNING' });
      // Przejęcie rozstrzyga worker (w trakcie zamykania nie przejmuje).
      expect(worker.kick).toHaveBeenCalledWith(TURN);
    });

    it('budżet globalny liczy rezerwację za każdą żywą turę instalacji', async () => {
      config.assertEnabled.mockReturnValue({
        ...ENV,
        globalDailyBudgetUsd: 1,
        turnCostReserveUsd: 0.3,
      });
      // Wydane $0,80 + jedna żywa tura × $0,30 ≥ $1,00.
      counters.read.mockResolvedValue(800_000);
      prisma.agentTurn.count.mockResolvedValue(1);
      expect(await codeOf(post())).toBe('AI_BUDGET_PAUSED');
      expect(prisma.agentTurn.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ status: 'RUNNING' }),
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();

      // Bez żywych tur te same pieniądze mieszczą się pod sufitem.
      prisma.agentTurn.count.mockResolvedValue(0);
      await expect(post()).resolves.toMatchObject({ status: 'RUNNING' });
    });

    it('budżet niewyczerpany przepuszcza turę', async () => {
      config.assertEnabled.mockReturnValue({
        ...ENV,
        globalDailyBudgetUsd: 1,
      });
      counters.read.mockResolvedValue(999_999);
      await expect(post()).resolves.toMatchObject({ status: 'RUNNING' });
    });

    // AUDYT 12.09.2026 (P0.2). Budżet dobowy jest WSPÓLNY dla instalacji,
    // a jedyny hamulec per dom był MIESIĘCZNY i wyższy od niego — więc jeden
    // dom wyczerpywał dobę i wyłączał asystenta wszystkim, także płacącym,
    // nie zbliżywszy się do własnego limitu. Sufit dobowy domu ma odmówić
    // sprawcy PRZED bramką globalną.
    it('sufit dobowy domu odmawia zanim ruszy budżet globalny', async () => {
      config.assertEnabled.mockReturnValue({
        ...ENV,
        householdDailyCostUsd: 1.5,
        globalDailyBudgetUsd: 5,
      });
      // Dom wydał dziś $1,50; instalacja jest daleko od swojego $5.
      counters.read.mockImplementation((scopeId: string, periodKey: string) =>
        Promise.resolve(
          scopeId === HOUSEHOLD && periodKey === '2026-08-31' ? 1_500_000 : 0,
        ),
      );

      expect(await codeOf(post())).toBe('AI_BUDGET_PAUSED');
      expect(metrics.snapshot().rejected.budget).toBe(1);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('sufit dobowy liczy się PER DOM, nie z licznika globalnego', async () => {
      config.assertEnabled.mockReturnValue({
        ...ENV,
        householdDailyCostUsd: 1.5,
        globalDailyBudgetUsd: 5,
      });
      // Instalacja wydała dziś $4,90, ten dom nic — jego tura ma przejść.
      counters.read.mockImplementation((scopeId: string) =>
        Promise.resolve(scopeId === HOUSEHOLD ? 0 : 4_900_000),
      );

      await expect(post()).resolves.toMatchObject({ status: 'RUNNING' });
      expect(counters.read).toHaveBeenCalledWith(
        HOUSEHOLD,
        '2026-08-31',
        'costMicroUsd',
      );
    });

    it('odmowa dobowa mówi, KIEDY limit wraca', async () => {
      config.assertEnabled.mockReturnValue({
        ...ENV,
        householdDailyCostUsd: 1,
      });
      counters.read.mockResolvedValue(1_000_000);
      try {
        await post();
        throw new Error('spodziewana odmowa');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        expect((error as AppException).details).toEqual([
          'resetsAt:2026-09-01T00:00:00.000Z',
        ]);
      }
    });

    it('jawne `off` zdejmuje sufit dobowy domu', async () => {
      config.assertEnabled.mockReturnValue({
        ...ENV,
        householdDailyCostUsd: null,
        globalDailyBudgetUsd: null,
      });
      counters.read.mockResolvedValue(999_000_000);
      await expect(post()).resolves.toMatchObject({ status: 'RUNNING' });
    });

    // AUDYT 12.09.2026 (P0.7). Lease rozmowy i semafor domu to `count()`,
    // a zaraz po nim `create()`. Pod READ COMMITTED dwadzieścia równoległych
    // żądań widzi „zero biegnących" i zakłada dwadzieścia tur. Izolacji nie da
    // się sprawdzić atrapą — sprawdzamy więc, że transakcja O NIĄ PROSI;
    // realny wyścig łapie `test/agent-lease-race.e2e-spec.ts`.
    it('lease tury jedzie w transakcji SERIALIZABLE', async () => {
      await post();
      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: 'Serializable' }),
      );
    });

    it('6. zajęta rozmowa: AI_TURN_IN_PROGRESS, kwota nietknięta', async () => {
      tx.agentTurn.count.mockResolvedValue(1);
      expect(await codeOf(post())).toBe('AI_TURN_IN_PROGRESS');
      expect(counters.tryConsume).not.toHaveBeenCalled();
      expect(metrics.snapshot().rejected.inProgress).toBe(1);
    });

    it('martwa tura jest ZAMYKANA (ze zwrotem za darmową), a nie tylko pomijana', async () => {
      // Sedno: samo pominięcie odblokowałoby rozmowę, ale zostawiłoby wiersz
      // RUNNING, którego nikt nie domknie. Zombie znaczyłby trwale spaloną
      // wiadomość. Zwrot (tylko za turę bez kosztu) robi `closeTurn` w tx.
      const startedAt = new Date(Date.now() - 10 * 60 * 1000);
      tx.agentTurn.findMany.mockResolvedValue([
        { id: 'zombie-1', startedAt, updatedAt: startedAt },
      ]);
      tx.agentTurn.count.mockResolvedValue(0);

      await post();

      expect(ledger.closeTurn).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          turnId: 'zombie-1',
          errorCode: 'AI_TIMEOUT',
          fallbackScopeId: HOUSEHOLD,
        }),
      );
      expect(metrics.snapshot().turns.timeout).toBe(1);
    });

    it('tura bez znaku życia od minuty to pad procesu: AI_PROVIDER_ERROR, bez czekania na timeout', async () => {
      const ago = new Date(Date.now() - 90 * 1000);
      tx.agentTurn.findMany.mockResolvedValue([
        { id: 'orphan-1', startedAt: ago, updatedAt: ago },
      ]);

      await post();

      expect(ledger.closeTurn).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          turnId: 'orphan-1',
          errorCode: 'AI_PROVIDER_ERROR',
          failureDetail: 'AI_TURN_LEGACY_ORPHAN',
          fallbackScopeId: HOUSEHOLD,
        }),
      );
      expect(metrics.snapshot().turns.failed).toBe(1);
    });

    it('tura z trwałym wykonaniem i wygasłym lease NIE jest martwa — blokuje rozmowę, worker ją dokończy', async () => {
      const ago = new Date(Date.now() - 90 * 1000);
      tx.agentTurn.findMany.mockResolvedValue([
        {
          id: 'reclaimable-1',
          startedAt: ago,
          updatedAt: ago,
          deadlineAt: new Date(Date.now() + 120_000),
          attempt: 1,
          leaseExpiresAt: new Date(Date.now() - 30_000),
          cancelRequestedAt: null,
        },
      ]);
      tx.agentTurn.count.mockResolvedValue(1);

      expect(await codeOf(post())).toBe('AI_TURN_IN_PROGRESS');
      expect(ledger.closeTurn).not.toHaveBeenCalled();
    });

    it('cicha tura prowadzona przez TEN proces żyje — nie zamykamy jej', async () => {
      const ago = new Date(Date.now() - 90 * 1000);
      tx.agentTurn.findMany.mockResolvedValue([
        { id: 'busy-1', startedAt: ago, updatedAt: ago },
      ]);
      runner.isRunning.mockReturnValue(true);
      tx.agentTurn.count.mockResolvedValue(1);

      expect(await codeOf(post())).toBe('AI_TURN_IN_PROGRESS');
      expect(ledger.closeTurn).not.toHaveBeenCalled();
    });

    it('sufit dobowy domu z REZERWACJĄ w transakcji: druga równoległa tura dostaje 503', async () => {
      config.assertEnabled.mockReturnValue({
        ...ENV,
        householdDailyCostUsd: 1,
        turnCostReserveUsd: 0.3,
      });
      // Wydane $0,80 < $1 (szybka odmowa przed transakcją przepuszcza),
      // ale w domu biegnie już jedna tura: $0,80 + $0,30 ≥ $1.
      counters.read.mockResolvedValue(800_000);
      tx.agentTurn.count.mockImplementation(
        (args: { where: { conversationId?: string } }) =>
          Promise.resolve(args.where.conversationId ? 0 : 1),
      );

      try {
        await post();
        throw new Error('oczekiwano odmowy');
      } catch (error) {
        const exception = error as AppException;
        expect(exception.code).toBe('AI_BUDGET_PAUSED');
        expect(exception.getStatus()).toBe(503);
        expect(exception.details).toEqual([
          'resetsAt:2026-09-01T00:00:00.000Z',
        ]);
      }
      // Budżet PRZED kwotą: odmowa nie zjada wiadomości.
      expect(counters.tryConsume).not.toHaveBeenCalled();
      expect(counters.read).toHaveBeenCalledWith(
        HOUSEHOLD,
        '2026-08-31',
        'costMicroUsd',
        tx,
      );
    });

    it('sufit domu bez żywych tur przepuszcza te same pieniądze', async () => {
      config.assertEnabled.mockReturnValue({
        ...ENV,
        householdDailyCostUsd: 1,
        turnCostReserveUsd: 0.3,
      });
      counters.read.mockResolvedValue(800_000);
      tx.agentTurn.count.mockResolvedValue(0);
      await expect(post()).resolves.toMatchObject({ status: 'RUNNING' });
    });

    it('semafor domu liczy tylko ŻYWE tury (przed terminem albo ze znakiem życia)', async () => {
      await post();
      expect(tx.agentTurn.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          conversation: { householdId: HOUSEHOLD },
          status: 'RUNNING',
          OR: [
            { deadlineAt: { gt: expect.any(Date) } },
            expect.objectContaining({
              deadlineAt: null,
              updatedAt: { gt: expect.any(Date) },
            }),
          ],
        }),
      });
    });

    it('6. wyczerpana kwota: AI_QUOTA_EXCEEDED (429), tura nie powstaje', async () => {
      counters.tryConsume.mockResolvedValue(false);
      try {
        await post();
        throw new Error('oczekiwano odmowy');
      } catch (error) {
        expect((error as AppException).getStatus()).toBe(429);
        expect((error as AppException).code).toBe('AI_QUOTA_EXCEEDED');
      }
      expect(tx.agentMessage.create).not.toHaveBeenCalled();
      expect(metrics.snapshot().rejected.quota).toBe(1);
    });
  });

  describe('postMessage — przyjęcie tury', () => {
    it('oddaje 202, zapisuje trwałe wejście tury i szturcha workera', async () => {
      await expect(post()).resolves.toEqual({
        turnId: TURN,
        messageId: MESSAGE,
        status: 'RUNNING',
        requestId: REQUEST_ID,
      });

      expect(counters.tryConsume).toHaveBeenCalledWith(
        tx,
        HOUSEHOLD,
        '2026-08',
        'messages',
        200,
      );
      expect(tx.agentTurn.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          conversationId: CONVERSATION,
          userId: USER,
          userMessageId: MESSAGE,
          requestId: REQUEST_ID,
          provider: 'stub',
          model: 'claude-sonnet-5',
          quotaPeriodKey: '2026-08',
          // Wszystko, czego nowy worker potrzebuje po padzie tego procesu.
          execution: {
            dates: {
              weekStart: '2026-08-31',
              clientToday: '2026-09-02',
              timeZone: 'Europe/Warsaw',
            },
            proposalMode: expect.any(Boolean),
          },
          deadlineAt: expect.any(Date),
        }),
      });
      // Wykonanie nie jest już obietnicą w pamięci tego procesu.
      expect(runner.run).not.toHaveBeenCalled();
      expect(worker.kick).toHaveBeenCalledWith(TURN);
      expect(metrics.snapshot().turns.started).toBe(1);
    });

    it('wyścig na clientMessageId (P2002) kończy się idempotentnie, nie konfliktem', async () => {
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '6',
        }),
      );
      prisma.agentMessage.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: MESSAGE, turnId: TURN });
      prisma.agentTurn.findUnique.mockResolvedValue({
        id: TURN,
        status: 'RUNNING',
      });

      await expect(post()).resolves.toMatchObject({ turnId: TURN });
      expect(worker.kick).not.toHaveBeenCalled();
    });
  });

  describe('getTurn', () => {
    const turnRow = (overrides: Record<string, unknown> = {}) => ({
      id: TURN,
      conversationId: CONVERSATION,
      status: 'RUNNING',
      progress: [],
      errorCode: null,
      inputTokens: 10,
      outputTokens: 20,
      costMicroUsd: 300,
      startedAt: new Date(),
      updatedAt: new Date(),
      finishedAt: null,
      conversation: { householdId: HOUSEHOLD },
      ...overrides,
    });

    it('cudza tura to 404, nie 403', async () => {
      prisma.agentTurn.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.getTurn(USER, TURN))).toBe(
        'AI_TURN_NOT_FOUND',
      );
      // Etap 4C: jedno zapytanie — własność i dzisiejsze członkostwo w warunku.
      expect(prisma.agentTurn.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: TURN,
            userId: USER,
            conversation: {
              household: { memberships: { some: { userId: USER } } },
            },
          },
        }),
      );
    });

    it('nie-UUID zatrzymuje się przed Prismą', async () => {
      expect(await codeOf(service.getTurn(USER, 'abc'))).toBe(
        'VALIDATION_ERROR',
      );
      expect(prisma.agentTurn.findFirst).not.toHaveBeenCalled();
    });

    it('własna tura po wyjściu z domu to też 404 — liczy się członkostwo dziś', async () => {
      // Członkostwo jest w samym warunku zapytania (Etap 4C): baza nie oddaje
      // tury domu, z którego pytający wyszedł — dowód na żywej bazie w e2e.
      prisma.agentTurn.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.getTurn(USER, TURN))).toBe(
        'AI_TURN_NOT_FOUND',
      );
      const [[query]] = prisma.agentTurn.findFirst.mock.calls as [
        [{ where: { conversation: unknown } }],
      ];
      expect(query.where.conversation).toEqual({
        household: { memberships: { some: { userId: USER } } },
      });
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
      expect(prisma.agentMessage.findMany).not.toHaveBeenCalled();
    });

    it('DONE dokłada odpowiedź asystenta i zużycie', async () => {
      prisma.agentTurn.findFirst.mockResolvedValue(
        turnRow({
          status: 'DONE',
          finishedAt: new Date('2026-08-31T10:00:05.000Z'),
        }),
      );
      prisma.agentMessage.findMany.mockResolvedValue([
        {
          id: MESSAGE,
          role: 'ASSISTANT',
          kind: 'TEXT',
          text: 'proszę',
          clientMessageId: null,
          turnId: TURN,
          createdAt: new Date('2026-08-31T10:00:05.000Z'),
        },
      ]);

      const view = await service.getTurn(USER, TURN);
      expect(view.status).toBe('DONE');
      expect(view.messages).toHaveLength(1);
      expect(view.usage).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        costMicroUsd: 300,
      });
      expect(view.finishedAt).toBe('2026-08-31T10:00:05.000Z');
    });

    it('RUNNING nie zdradza treści ani zużycia', async () => {
      prisma.agentTurn.findFirst.mockResolvedValue(turnRow());
      const view = await service.getTurn(USER, TURN);
      expect(view.messages).toBeUndefined();
      expect(view.usage).toBeUndefined();
    });

    it('tura po czasie domykana leniwie jako AI_TIMEOUT (zwrot tylko za darmową)', async () => {
      const startedAt = new Date(
        Date.now() - (ENV.turnTimeoutMs + TURN_TIMEOUT_GRACE_MS + 1_000),
      );
      prisma.agentTurn.findFirst.mockResolvedValue(turnRow({ startedAt }));
      prisma.agentTurn.findUnique.mockResolvedValue(
        turnRow({
          status: 'FAILED',
          errorCode: 'AI_TIMEOUT',
          startedAt,
          finishedAt: new Date(),
        }),
      );

      const view = await service.getTurn(USER, TURN);
      expect(view.status).toBe('FAILED');
      expect(view.errorCode).toBe('AI_TIMEOUT');
      // Tura żyje w tym procesie? Po czasie nie ma to znaczenia — i tak ją
      // zamykamy. Koszt zostaje (dopisała go księga), zwrot decyduje baza.
      expect(ledger.closeTurn).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          turnId: TURN,
          errorCode: 'AI_TIMEOUT',
          fallbackScopeId: HOUSEHOLD,
        }),
      );
      expect(metrics.snapshot().turns.timeout).toBe(1);
    });

    it('tura bez znaku życia z innego procesu: AI_PROVIDER_ERROR po minucie', async () => {
      const ago = new Date(Date.now() - 61_000);
      prisma.agentTurn.findFirst.mockResolvedValue(
        turnRow({ startedAt: ago, updatedAt: ago }),
      );
      prisma.agentTurn.findUnique.mockResolvedValue(
        turnRow({ status: 'FAILED', errorCode: 'AI_PROVIDER_ERROR' }),
      );

      const view = await service.getTurn(USER, TURN);
      expect(view.errorCode).toBe('AI_PROVIDER_ERROR');
      expect(ledger.closeTurn).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ errorCode: 'AI_PROVIDER_ERROR' }),
      );
    });

    it('cicha tura z TEGO procesu przed czasem żyje', async () => {
      const ago = new Date(Date.now() - 61_000);
      runner.isRunning.mockReturnValue(true);
      prisma.agentTurn.findFirst.mockResolvedValue(
        turnRow({ startedAt: ago, updatedAt: ago }),
      );
      const view = await service.getTurn(USER, TURN);
      expect(view.status).toBe('RUNNING');
      expect(ledger.closeTurn).not.toHaveBeenCalled();
    });

    it('nie domyka tury, którą runner właśnie zamknął (count = 0)', async () => {
      const startedAt = new Date(
        Date.now() - (ENV.turnTimeoutMs + TURN_TIMEOUT_GRACE_MS + 1_000),
      );
      ledger.closeTurn.mockResolvedValue(false);
      prisma.agentTurn.findFirst.mockResolvedValue(turnRow({ startedAt }));
      prisma.agentTurn.findUnique.mockResolvedValue(
        turnRow({ status: 'DONE', startedAt, finishedAt: new Date() }),
      );
      prisma.agentMessage.findMany.mockResolvedValue([]);

      const view = await service.getTurn(USER, TURN);
      expect(view.status).toBe('DONE');
      expect(metrics.snapshot().turns.timeout).toBe(0);
    });
  });

  describe('cancelTurn', () => {
    it('tura spoza procesu: domknięcie AI_CANCELLED przez księgę (zwrot tylko za darmową)', async () => {
      prisma.agentTurn.findFirst
        .mockResolvedValueOnce({
          id: TURN,
          status: 'RUNNING',
          conversation: { householdId: HOUSEHOLD },
        })
        .mockResolvedValue({
          id: TURN,
          conversationId: CONVERSATION,
          status: 'FAILED',
          errorCode: 'AI_CANCELLED',
          progress: [],
          startedAt: new Date(),
          updatedAt: new Date(),
          finishedAt: new Date(),
          conversation: { householdId: HOUSEHOLD },
        });

      prisma.agentTurn.updateMany.mockResolvedValue({ count: 1 });
      const view = await service.cancelTurn(USER, TURN);
      // „Stop" najpierw TRWALE w bazie (Etap 5), potem sygnał lokalny.
      expect(prisma.agentTurn.updateMany).toHaveBeenCalledWith({
        where: { id: TURN, status: 'RUNNING', cancelRequestedAt: null },
        data: { cancelRequestedAt: expect.any(Date) },
      });
      expect(runner.cancel).toHaveBeenCalledWith(TURN);
      expect(ledger.closeTurn).toHaveBeenCalledWith(tx, {
        turnId: TURN,
        errorCode: 'AI_CANCELLED',
        failureDetail: 'AI_TURN_CANCEL_REQUESTED',
        fallbackScopeId: HOUSEHOLD,
        // Z żywym lease w innym procesie nie domykamy — tamten worker to zrobi.
        onlyIfUnleased: true,
      });
      expect(view.errorCode).toBe('AI_CANCELLED');
      expect(metrics.snapshot().turns.failed).toBe(1);
    });
  });
});
