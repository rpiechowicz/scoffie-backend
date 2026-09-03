import { PrismaService } from '../prisma/prisma.service';
import { AgentConversationsService } from './agent-conversations.service';
import { AgentUsageService } from './agent-usage.service';
import { AiUsageCountersService } from './ai-usage-counters.service';

const USER = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const HOUSEHOLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-02T12:00:00.000Z');

describe('AiUsageCountersService — reset kwoty', () => {
  const counters = new AiUsageCountersService({} as PrismaService);

  it('monthResetsAt = północ UTC pierwszego dnia następnego miesiąca', () => {
    expect(counters.monthResetsAt(NOW).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    expect(
      counters.monthResetsAt(new Date('2026-12-31T23:59:59Z')).toISOString(),
    ).toBe('2027-01-01T00:00:00.000Z');
  });

  it('quotaDetails niesie rodzaj, limit, zero pozostałych i datę resetu', () => {
    expect(counters.quotaDetails('messages', 30, NOW)).toEqual([
      'kind:messages',
      'limit:30',
      'remaining:0',
      'resetsAt:2026-10-01T00:00:00.000Z',
    ]);
  });
});

describe('AgentUsageService.usage', () => {
  const original = {
    messages: process.env.AI_LIMIT_MESSAGES_PER_MONTH,
    plans: process.env.AI_LIMIT_PLANS_PER_MONTH,
  };
  let conversations: { ensureMembership: jest.Mock };
  let counters: AiUsageCountersService;
  let service: AgentUsageService;
  let prisma: { household: { findUnique: jest.Mock } } & Record<
    string,
    unknown
  >;

  beforeEach(() => {
    process.env.AI_LIMIT_MESSAGES_PER_MONTH = '30';
    process.env.AI_LIMIT_PLANS_PER_MONTH = '6';
    conversations = {
      ensureMembership: jest.fn().mockResolvedValue(undefined),
    };
    prisma = {
      household: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ tierOverride: null, subscription: null }),
      },
      agentTurn: {
        groupBy: jest.fn().mockResolvedValue([
          { userId: 'u-1', _count: { _all: 9 } },
          { userId: 'u-2', _count: { _all: 3 } },
        ]),
      },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'u-1', displayName: 'Ania' }]),
      },
      aiUsageCounter: {
        findUnique: jest.fn().mockImplementation(({ where }: any) => {
          const kind = where.scopeId_periodKey_kind.kind as string;
          return Promise.resolve(
            kind === 'messages'
              ? { value: 12 }
              : kind === 'plans'
                ? { value: 9 }
                : null,
          );
        }),
      },
    };
    counters = new AiUsageCountersService(prisma as unknown as PrismaService);
    service = new AgentUsageService(
      prisma as unknown as PrismaService,
      conversations as unknown as AgentConversationsService,
      counters,
    );
  });

  afterEach(() => {
    delete process.env.AI_TIER_OVERRIDE;
    if (original.messages === undefined)
      delete process.env.AI_LIMIT_MESSAGES_PER_MONTH;
    else process.env.AI_LIMIT_MESSAGES_PER_MONTH = original.messages;
    if (original.plans === undefined)
      delete process.env.AI_LIMIT_PLANS_PER_MONTH;
    else process.env.AI_LIMIT_PLANS_PER_MONTH = original.plans;
  });

  it('oddaje zużycie, limit, resztę (nigdy ujemną) i datę resetu — po sprawdzeniu członkostwa', async () => {
    const view = await service.usage(USER, HOUSEHOLD, NOW);
    expect(conversations.ensureMembership).toHaveBeenCalledWith(
      USER,
      HOUSEHOLD,
    );
    expect(view).toEqual({
      householdId: HOUSEHOLD,
      period: '2026-09',
      resetsAt: '2026-10-01T00:00:00.000Z',
      renews: true,
      tier: 'PRO',
      source: 'ENV',
      messages: { used: 12, limit: 30, remaining: 18 },
      // Rozkład na domowników z domkniętych tur; były domownik bez imienia.
      byUser: [
        { userId: 'u-1', displayName: 'Ania', messages: 9 },
        { userId: 'u-2', displayName: 'Były domownik', messages: 3 },
      ],
      // Zużycie ponad limit (np. po obniżeniu limitu w env) nie daje ujemnej reszty.
      plans: { used: 9, limit: 6, remaining: 0 },
    });
  });

  it('cudze gospodarstwo: błąd członkostwa PRZED odczytem liczników', async () => {
    conversations.ensureMembership.mockRejectedValue(
      new Error('NOT_HOUSEHOLD_MEMBER'),
    );
    await expect(service.usage(USER, HOUSEHOLD, NOW)).rejects.toThrow(
      'NOT_HOUSEHOLD_MEMBER',
    );
  });

  it('bez AI_TIER_OVERRIDE gospodarstwo bez subskrypcji jest na próbie: pula `trial`, bez odnowienia', async () => {
    process.env.AI_TIER_OVERRIDE = '';
    const view = await service.usage(USER, HOUSEHOLD, NOW);
    expect(view).toMatchObject({
      period: 'trial',
      resetsAt: null,
      renews: false,
      tier: 'TRIAL',
      source: 'TRIAL',
      messages: { used: 12, limit: 5, remaining: 0 },
      plans: { used: 9, limit: 1, remaining: 0 },
    });
  });

  it('nadanie operatora i żywa subskrypcja dają PRO; wygasła subskrypcja — próbę', async () => {
    process.env.AI_TIER_OVERRIDE = 'off';
    prisma.household.findUnique.mockResolvedValue({
      tierOverride: 'PRO',
      subscription: null,
    });
    expect((await service.usage(USER, HOUSEHOLD, NOW)).source).toBe('GRANTED');
    prisma.household.findUnique.mockResolvedValue({
      tierOverride: null,
      subscription: {
        status: 'ACTIVE',
        expiresAt: new Date('2026-10-15T00:00:00.000Z'),
      },
    });
    expect((await service.usage(USER, HOUSEHOLD, NOW)).source).toBe(
      'SUBSCRIPTION',
    );
    prisma.household.findUnique.mockResolvedValue({
      tierOverride: null,
      subscription: {
        status: 'ACTIVE',
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    });
    expect((await service.usage(USER, HOUSEHOLD, NOW)).tier).toBe('TRIAL');
  });
});
