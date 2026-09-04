import { PrismaService } from '../prisma/prisma.service';
import { AgentConversationsService } from './agent-conversations.service';
import { AgentUsageService } from './agent-usage.service';
import { AiUsageCountersService } from './ai-usage-counters.service';

const USER = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const HOUSEHOLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-02T12:00:00.000Z');
const IDENTITY = 'b'.repeat(64);

/** Subskrypcja domownika — tyle pól, ile czyta `resolvePlan`. */
const subscriptionRow = (expiresAt: Date) => ({
  id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  provider: 'APPLE',
  productId: 'app.scoffie.pro.solo.monthly',
  status: 'ACTIVE',
  expiresAt,
  graceExpiresAt: null,
  neverExpires: false,
  revokedAt: null,
  messagesLimitSnapshot: 30,
  plansLimitSnapshot: 8,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
});

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
  let prisma: {
    household: { findUnique: jest.Mock };
    subscription: { findMany: jest.Mock; findUnique: jest.Mock };
    membership: { findFirst: jest.Mock };
  } & Record<string, unknown>;

  /** Dom z jednym domownikiem o znanym haszu tożsamości. */
  const householdWith = (tierOverride: string | null) => ({
    tierOverride,
    memberships: [{ userId: USER, user: { identityHash: IDENTITY } }],
  });

  beforeEach(() => {
    process.env.AI_LIMIT_MESSAGES_PER_MONTH = '30';
    process.env.AI_LIMIT_PLANS_PER_MONTH = '6';
    conversations = {
      ensureMembership: jest.fn().mockResolvedValue(undefined),
    };
    prisma = {
      household: {
        findUnique: jest.fn().mockResolvedValue(householdWith(null)),
      },
      subscription: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ identityHash: IDENTITY }),
      },
      // Płatnik: ten sam hasz tożsamości, co domownik z `householdWith`.
      membership: {
        findFirst: jest.fn().mockResolvedValue({
          user: { id: USER, displayName: 'Rafał' },
        }),
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
    // Ten test opisuje KSZTAŁT odpowiedzi na planie płatnym, więc plan musi być
    // ustawiony JAWNIE. Wcześniej brał się z domyślnego `AI_TIER_OVERRIDE=PRO`
    // — a to właśnie ta domyślność była luką: skasowanie zmiennej w Railway
    // dawało PRO wszystkim.
    process.env.AI_TIER_OVERRIDE = 'PRO';
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
      product: null,
      // Nadanie z env nie ma subskrypcji, więc nie ma też płatnika.
      payerName: null,
      isPayer: false,
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

  it('nadanie operatora i żywa subskrypcja domownika dają PRO; wygasła — próbę', async () => {
    process.env.AI_TIER_OVERRIDE = 'off';
    prisma.household.findUnique.mockResolvedValue(householdWith('PRO'));
    expect((await service.usage(USER, HOUSEHOLD, NOW)).source).toBe('GRANTED');

    prisma.household.findUnique.mockResolvedValue(householdWith(null));
    prisma.subscription.findMany.mockResolvedValue([
      subscriptionRow(new Date('2026-10-15T00:00:00.000Z')),
    ]);
    expect((await service.usage(USER, HOUSEHOLD, NOW)).source).toBe(
      'SUBSCRIPTION',
    );

    prisma.subscription.findMany.mockResolvedValue([
      subscriptionRow(new Date('2026-08-01T00:00:00.000Z')),
    ]);
    expect((await service.usage(USER, HOUSEHOLD, NOW)).tier).toBe('TRIAL');
  });

  it('liczniki czyta z zakresu UMOWY, nie z gospodarstwa', async () => {
    // Kwota schodzi z `sub:<id>`. Czytanie po `householdId` pokazywałoby
    // zero zużycia każdemu, kto ma wykupiony plan.
    process.env.AI_TIER_OVERRIDE = 'off';
    prisma.household.findUnique.mockResolvedValue(householdWith(null));
    prisma.subscription.findMany.mockResolvedValue([
      subscriptionRow(new Date('2026-10-15T00:00:00.000Z')),
    ]);
    const read = jest.spyOn(counters, 'read');
    await service.usage(USER, HOUSEHOLD, NOW);
    expect(read).toHaveBeenCalledWith(
      'sub:ffffffff-ffff-4fff-8fff-ffffffffffff',
      '2026-09',
      'messages',
    );
    read.mockRestore();
  });

  it('płacący widzi siebie jako płatnika, domownik widzi jego imię', async () => {
    process.env.AI_TIER_OVERRIDE = 'off';
    prisma.household.findUnique.mockResolvedValue(householdWith(null));
    prisma.subscription.findMany.mockResolvedValue([
      subscriptionRow(new Date('2026-10-15T00:00:00.000Z')),
    ]);
    prisma.membership.findFirst.mockResolvedValue({
      user: { id: 'u-platnik', displayName: 'Ania' },
    });
    const asMember = await service.usage(USER, HOUSEHOLD, NOW);
    expect(asMember.payerName).toBe('Ania');
    // Domownik NIE dostaje zarządzania subskrypcją — to nie jego umowa.
    expect(asMember.isPayer).toBe(false);

    prisma.membership.findFirst.mockResolvedValue({
      user: { id: USER, displayName: 'Rafał' },
    });
    const asPayer = await service.usage(USER, HOUSEHOLD, NOW);
    expect(asPayer.isPayer).toBe(true);
  });

  it('subskrypcja WSPÓŁDOMOWNIKA odblokowuje asystenta pytającemu', async () => {
    // Odpowiedź na pytanie „user ma Solo i zaprasza domownika": pyta ktoś
    // inny niż płatnik, a plan i tak wychodzi PRO ze wspólną pulą.
    process.env.AI_TIER_OVERRIDE = 'off';
    prisma.household.findUnique.mockResolvedValue({
      tierOverride: null,
      memberships: [
        { userId: USER, user: { identityHash: null } },
        { userId: 'u-platnik', user: { identityHash: IDENTITY } },
      ],
    });
    prisma.subscription.findMany.mockResolvedValue([
      subscriptionRow(new Date('2026-10-15T00:00:00.000Z')),
    ]);
    const view = await service.usage(USER, HOUSEHOLD, NOW);
    expect(view.source).toBe('SUBSCRIPTION');
    expect(view.messages.limit).toBe(30);
  });
});
