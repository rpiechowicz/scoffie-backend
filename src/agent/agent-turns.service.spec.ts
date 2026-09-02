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
  turnTimeoutMs: 90_000,
  messagesPerMonth: 200,
  plansPerMonth: 30,
  globalDailyBudgetUsd: null,
  stubDelayMs: 0,
  cardsMode: 'off',
  proposalTtlMs: 72 * 60 * 60 * 1000,
  proposalUndoWindowMs: 60 * 60 * 1000,
  allowedUsers: [],
  consentRequired: false,
  conversationRetentionDays: 90,
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
    monthKey: jest.fn(),
    dayKey: jest.fn(),
    read: jest.fn(),
    tryConsume: jest.fn(),
    add: jest.fn(),
    quotaDetails: jest.fn().mockReturnValue(['kind:messages']),
  };
  const runner = { run: jest.fn() };
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
      breaker,
      metrics,
      runner as unknown as AgentTurnRunner,
      { withCardState: (messages: unknown) => messages } as never,
      { notify: jest.fn().mockResolvedValue(false) } as never,
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

    it('budżet niewyczerpany przepuszcza turę', async () => {
      config.assertEnabled.mockReturnValue({
        ...ENV,
        globalDailyBudgetUsd: 1,
      });
      counters.read.mockResolvedValue(999_999);
      await expect(post()).resolves.toMatchObject({ status: 'RUNNING' });
    });

    it('6. zajęta rozmowa: AI_TURN_IN_PROGRESS, kwota nietknięta', async () => {
      tx.agentTurn.count.mockResolvedValue(1);
      expect(await codeOf(post())).toBe('AI_TURN_IN_PROGRESS');
      expect(counters.tryConsume).not.toHaveBeenCalled();
      expect(metrics.snapshot().rejected.inProgress).toBe(1);
    });

    it('martwa tura jest ZAMYKANA i oddaje kwotę, a nie tylko pomijana', async () => {
      // Sedno: samo pominięcie odblokowałoby rozmowę, ale zostawiłoby wiersz
      // RUNNING, którego nikt nie odpyta — a to odpytanie jest jedynym
      // mechanizmem zwrotu kwoty. Zombie znaczyłby trwale spaloną wiadomość.
      const startedAt = new Date(Date.now() - 10 * 60 * 1000);
      tx.agentTurn.findMany.mockResolvedValue([{ id: 'zombie-1', startedAt }]);
      tx.agentTurn.updateMany.mockResolvedValue({ count: 1 });
      tx.agentTurn.count.mockResolvedValue(0);

      await post();

      expect(tx.agentTurn.updateMany).toHaveBeenCalledWith({
        where: { id: 'zombie-1', status: 'RUNNING' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'AI_TIMEOUT',
        }),
      });
      expect(counters.add).toHaveBeenCalledWith(
        tx,
        HOUSEHOLD,
        expect.any(String),
        'messages',
        -1,
      );
      expect(metrics.snapshot().turns.timeout).toBe(1);
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
    it('oddaje 202 i uruchamia runnera z okresem kwoty', async () => {
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
        }),
      });
      expect(runner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          turnId: TURN,
          householdId: HOUSEHOLD,
          periodKey: '2026-08',
          requestId: REQUEST_ID,
        }),
      );
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
      expect(runner.run).not.toHaveBeenCalled();
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
      finishedAt: null,
      conversation: { householdId: HOUSEHOLD },
      ...overrides,
    });

    it('cudza tura to 404, nie 403', async () => {
      prisma.agentTurn.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.getTurn(USER, TURN))).toBe(
        'AI_TURN_NOT_FOUND',
      );
      expect(prisma.agentTurn.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TURN, userId: USER } }),
      );
    });

    it('nie-UUID zatrzymuje się przed Prismą', async () => {
      expect(await codeOf(service.getTurn(USER, 'abc'))).toBe(
        'VALIDATION_ERROR',
      );
      expect(prisma.agentTurn.findFirst).not.toHaveBeenCalled();
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

    it('tura po padzie procesu domykana leniwie jako AI_TIMEOUT ze zwrotem kwoty', async () => {
      const startedAt = new Date(
        Date.now() - (ENV.turnTimeoutMs + TURN_TIMEOUT_GRACE_MS + 1_000),
      );
      counters.monthKey.mockReturnValue('2026-07');
      prisma.agentTurn.findFirst.mockResolvedValue(turnRow({ startedAt }));
      prisma.agentTurn.updateMany.mockResolvedValue({ count: 1 });
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
      expect(prisma.agentTurn.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TURN, status: 'RUNNING' },
        }),
      );
      // Zwrot trafia do okresu, z którego kwota zeszła.
      expect(counters.monthKey).toHaveBeenCalledWith(startedAt);
      expect(counters.add).toHaveBeenCalledWith(
        prisma,
        HOUSEHOLD,
        '2026-07',
        'messages',
        -1,
      );
      expect(metrics.snapshot().turns.timeout).toBe(1);
    });

    it('nie domyka tury, którą runner właśnie zamknął (count = 0)', async () => {
      const startedAt = new Date(
        Date.now() - (ENV.turnTimeoutMs + TURN_TIMEOUT_GRACE_MS + 1_000),
      );
      prisma.agentTurn.findFirst.mockResolvedValue(turnRow({ startedAt }));
      prisma.agentTurn.updateMany.mockResolvedValue({ count: 0 });
      prisma.agentTurn.findUnique.mockResolvedValue(
        turnRow({ status: 'DONE', startedAt, finishedAt: new Date() }),
      );
      prisma.agentMessage.findMany.mockResolvedValue([]);

      const view = await service.getTurn(USER, TURN);
      expect(view.status).toBe('DONE');
      expect(counters.add).not.toHaveBeenCalled();
      expect(metrics.snapshot().turns.timeout).toBe(0);
    });
  });
});
