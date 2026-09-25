import { AiUsageCountersService } from '../../agent/ai-usage-counters.service';
import { readAgentEnv } from '../../config/agent-env';
import { purchaseIdentityHash } from '../../config/purchase-identity';
import type { SubscriptionCandidate } from '../../config/subscription-lifetime';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  byMemberPreference,
  poolOf,
  resolveHouseholdPlan,
  type PlanCalendar,
  type PlanHousehold,
  type PlanMember,
  type PoolScope,
} from './household-plan';

/**
 * Plan i pula w panelu MUSZĄ mówić to samo, co asystent. Najmocniejszy test
 * to porównanie z samym `AiUsageCountersService.resolvePlan` na tych samych
 * danych — panel liczy paczką, asystent dom po domu, a wynik ma się zgadzać
 * co do zakresu, okresu, limitów i daty odnowienia.
 */

const NOW = new Date('2026-09-24T12:00:00.000Z');
const HOUSE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER_HASH = 'd'.repeat(64);
const MEMBER_HASH = 'e'.repeat(64);

const member = (over: Partial<PlanMember> = {}): PlanMember => ({
  userId: OWNER,
  role: 'OWNER',
  joinedAt: new Date('2026-08-01T00:00:00.000Z'),
  identityHash: OWNER_HASH,
  appleSub: null,
  googleId: null,
  authProvider: 'APPLE',
  ...over,
});

const sub = (
  over: Partial<SubscriptionCandidate> = {},
): SubscriptionCandidate => ({
  id: 'sub-1',
  provider: 'APPLE',
  productId: 'app.scoffie.pro.solo.monthly',
  status: 'ACTIVE',
  expiresAt: new Date('2026-10-15T08:00:00.000Z'),
  graceExpiresAt: null,
  neverExpires: false,
  revokedAt: null,
  messagesLimitSnapshot: 30,
  plansLimitSnapshot: 8,
  createdAt: new Date('2026-09-15T08:00:00.000Z'),
  environment: 'Production',
  operatorHoldAt: null,
  ...over,
});

describe('resolveHouseholdPlan / poolOf', () => {
  const originals = { ...process.env };
  const counters = new AiUsageCountersService({} as PrismaService);
  const calendar = (): PlanCalendar => ({
    monthKey: counters.monthKey(NOW),
    monthResetsAt: counters.monthResetsAt(NOW).toISOString(),
  });

  beforeEach(() => {
    process.env.AI_TIER_OVERRIDE = 'off';
    process.env.AI_TRIAL_MESSAGES = '5';
    process.env.AI_TRIAL_PLANS = '1';
    process.env.APPLE_ENVIRONMENT = 'Production';
    process.env.APPLE_ACCEPT_SANDBOX = 'false';
    delete process.env.AI_LIMIT_MESSAGES_PER_MONTH;
    delete process.env.AI_LIMIT_PLANS_PER_MONTH;
  });

  afterEach(() => {
    process.env = { ...originals };
  });

  const resolve = (
    household: PlanHousehold,
    subs: SubscriptionCandidate[] = [],
    byHash?: Map<string, SubscriptionCandidate[]>,
  ) =>
    resolveHouseholdPlan(
      household,
      byHash ?? new Map([[OWNER_HASH, subs]]),
      readAgentEnv(),
      calendar(),
      NOW,
    );

  it('nadanie operatora bije żywą subskrypcję — zakres domu, miesiąc, limity z env', () => {
    const plan = resolve(
      { id: HOUSE, tierOverride: 'PRO', members: [member()] },
      [sub({ productId: 'app.scoffie.pro.family.monthly' })],
    );
    expect(plan.plan).toEqual({ kind: 'override' });
    expect(plan.scopes).toEqual([{ scopeId: HOUSE, periodKey: '2026-09' }]);
    expect(plan.limits).toEqual({ messages: 30, plans: 8 });
    expect(plan.resetsAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('AI_TIER_OVERRIDE=PRO daje to samo, co nadanie — także bez domowników', () => {
    process.env.AI_TIER_OVERRIDE = 'PRO';
    const plan = resolve({ id: HOUSE, tierOverride: null, members: [] });
    expect(plan.plan).toEqual({ kind: 'override' });
    expect(plan.scopes[0].scopeId).toBe(HOUSE);
  });

  it('TRIAL w kolumnie domu nie wymusza próby — liczy się jak brak nadania (jak w resolvePlan)', () => {
    const plan = resolve(
      { id: HOUSE, tierOverride: 'TRIAL', members: [member()] },
      [sub()],
    );
    expect(plan.plan).toEqual({
      kind: 'subscription',
      productId: 'app.scoffie.pro.solo.monthly',
    });
  });

  it('subskrypcja: zakres umowy, okres do odnowienia, migawka wygrywa z cennikiem', () => {
    const plan = resolve(
      { id: HOUSE, tierOverride: null, members: [member()] },
      [sub({ messagesLimitSnapshot: 45, plansLimitSnapshot: 3 })],
    );
    expect(plan.scopes).toEqual([
      { scopeId: 'sub:sub-1', periodKey: 'okres:2026-10-15' },
    ]);
    expect(plan.limits).toEqual({ messages: 45, plans: 8 });
    expect(plan.resetsAt).toBe('2026-10-15T08:00:00.000Z');
  });

  it('nieznany SKU nie udaje produktu z kontraktu — „PRO bez produktu", limity z env', () => {
    const plan = resolve(
      { id: HOUSE, tierOverride: null, members: [member()] },
      [
        sub({
          productId: 'app.scoffie.pro.nowy.monthly',
          messagesLimitSnapshot: null,
          plansLimitSnapshot: null,
        }),
      ],
    );
    expect(plan.plan).toEqual({ kind: 'override' });
    expect(plan.scopes[0].scopeId).toBe('sub:sub-1');
    expect(plan.limits).toEqual({ messages: 30, plans: 8 });
  });

  it('Sandbox na produkcji i blokada operatora nie dają PRO — dom schodzi na próbę', () => {
    const sandbox = resolve(
      { id: HOUSE, tierOverride: null, members: [member()] },
      [sub({ environment: 'Sandbox' })],
    );
    expect(sandbox.plan).toEqual({ kind: 'trial' });
    const held = resolve(
      { id: HOUSE, tierOverride: null, members: [member()] },
      [sub({ operatorHoldAt: new Date('2026-09-20T00:00:00.000Z') })],
    );
    expect(held.plan).toEqual({ kind: 'trial' });
  });

  it('próba: po zakresie na domownika, właściciel pierwszy; bez hasza zakres na id konta', () => {
    const plan = resolve({
      id: HOUSE,
      tierOverride: null,
      members: [
        member({
          userId: MEMBER,
          role: 'MEMBER',
          identityHash: null,
          authProvider: 'DEV',
          joinedAt: new Date('2026-07-01T00:00:00.000Z'),
        }),
        member(),
      ],
    });
    expect(plan.plan).toEqual({ kind: 'trial' });
    expect(plan.scopes).toEqual([
      { scopeId: `trial:${OWNER_HASH}`, periodKey: 'trial' },
      { scopeId: `trial:user:${MEMBER}`, periodKey: 'trial' },
    ]);
    expect(plan.limits).toEqual({ messages: 5, plans: 1 });
    expect(plan.resetsAt).toBeNull();
  });

  it('hasz liczony z appleSub, gdy kolumna jest pusta — jak w resolvePlan', () => {
    const hash = purchaseIdentityHash('APPLE', 'apple-sub-x');
    const plan = resolve(
      {
        id: HOUSE,
        tierOverride: null,
        members: [member({ identityHash: null, appleSub: 'apple-sub-x' })],
      },
      [],
      new Map([[hash!, [sub()]]]),
    );
    expect(plan.plan.kind).toBe('subscription');
  });

  it('pula próby: pokazuje domownika, który zużył NAJWIĘCEJ; remis → właściciel', () => {
    const plan = resolve({
      id: HOUSE,
      tierOverride: null,
      members: [
        member(),
        member({ userId: MEMBER, role: 'MEMBER', identityHash: MEMBER_HASH }),
      ],
    });
    const usage: Record<string, { messages: number; plans: number }> = {
      [`trial:${OWNER_HASH}`]: { messages: 1, plans: 1 },
      [`trial:${MEMBER_HASH}`]: { messages: 4, plans: 0 },
    };
    const lookup = (scope: PoolScope, kind: 'messages' | 'plans') =>
      usage[scope.scopeId]?.[kind] ?? 0;
    expect(poolOf(plan, lookup)).toEqual({
      scopeId: `trial:${MEMBER_HASH}`,
      messages: { used: 4, limit: 5 },
      plans: { used: 0, limit: 1 },
      resetsAt: null,
    });
    expect(poolOf(plan, () => 0).scopeId).toBe(`trial:${OWNER_HASH}`);
    // Remis w wiadomościach rozstrzygają zapisy planu.
    usage[`trial:${OWNER_HASH}`] = { messages: 4, plans: 1 };
    expect(poolOf(plan, lookup).scopeId).toBe(`trial:${OWNER_HASH}`);
  });

  it('dom bez domowników: pusta pula z limitami próby', () => {
    const plan = resolve({ id: HOUSE, tierOverride: null, members: [] });
    expect(poolOf(plan, () => 7)).toEqual({
      scopeId: '',
      messages: { used: 0, limit: 5 },
      plans: { used: 0, limit: 1 },
      resetsAt: null,
    });
  });

  it('kolejność domowników: właściciel, potem najstarsze członkostwo', () => {
    const list = [
      member({ userId: 'z', role: 'MEMBER', joinedAt: new Date('2026-01-02') }),
      member({ userId: 'y', role: 'MEMBER', joinedAt: new Date('2026-01-01') }),
      member({ userId: 'x', role: 'OWNER', joinedAt: new Date('2026-03-01') }),
    ].sort(byMemberPreference);
    expect(list.map((m) => m.userId)).toEqual(['x', 'y', 'z']);
  });

  describe('PARYTET z AiUsageCountersService.resolvePlan', () => {
    type Scenario = {
      name: string;
      tierOverride: string | null;
      members: PlanMember[];
      subs: (SubscriptionCandidate & { identityHash: string })[];
      env?: Record<string, string>;
    };
    const scenarios: Scenario[] = [
      {
        name: 'nadanie',
        tierOverride: 'PRO',
        members: [member()],
        subs: [{ ...sub(), identityHash: OWNER_HASH }],
      },
      {
        name: 'AI_TIER_OVERRIDE',
        tierOverride: null,
        members: [member()],
        subs: [],
        env: { AI_TIER_OVERRIDE: 'PRO', AI_LIMIT_MESSAGES_PER_MONTH: '99' },
      },
      {
        name: 'subskrypcja domownika (nie właściciela) z migawką',
        tierOverride: null,
        members: [
          member(),
          member({ userId: MEMBER, role: 'MEMBER', identityHash: MEMBER_HASH }),
        ],
        subs: [
          {
            ...sub({
              id: 'duet',
              productId: 'app.scoffie.pro.duet.monthly',
              messagesLimitSnapshot: 60,
            }),
            identityHash: MEMBER_HASH,
          },
        ],
      },
      {
        name: 'łaska płatnicza (odnowienie w przeszłości)',
        tierOverride: null,
        members: [member()],
        subs: [
          {
            ...sub({
              status: 'GRACE',
              expiresAt: new Date('2026-09-20T00:00:00.000Z'),
              graceExpiresAt: new Date('2026-09-30T00:00:00.000Z'),
            }),
            identityHash: OWNER_HASH,
          },
        ],
      },
      {
        name: 'nadanie ręczne bezterminowe (miesiąc kalendarzowy)',
        tierOverride: null,
        members: [member()],
        subs: [
          {
            ...sub({
              provider: 'MANUAL',
              environment: null,
              expiresAt: null,
              neverExpires: true,
            }),
            identityHash: OWNER_HASH,
          },
        ],
      },
      {
        name: 'dwie żywe — wygrywa wyższy limit',
        tierOverride: null,
        members: [
          member(),
          member({ userId: MEMBER, role: 'MEMBER', identityHash: MEMBER_HASH }),
        ],
        subs: [
          { ...sub({ id: 'solo' }), identityHash: OWNER_HASH },
          {
            ...sub({
              id: 'rodzina',
              productId: 'app.scoffie.pro.family.monthly',
              messagesLimitSnapshot: 75,
            }),
            identityHash: MEMBER_HASH,
          },
        ],
      },
      {
        name: 'próba dwóch osób (jedna bez hasza)',
        tierOverride: null,
        members: [
          member(),
          member({
            userId: MEMBER,
            role: 'MEMBER',
            identityHash: null,
            authProvider: 'DEV',
          }),
        ],
        subs: [
          {
            ...sub({ status: 'EXPIRED' }),
            identityHash: OWNER_HASH,
          },
        ],
      },
    ];

    it.each(scenarios.map((s) => [s.name, s] as const))(
      '%s',
      async (_name, scenario) => {
        Object.assign(process.env, scenario.env ?? {});
        const prisma = {
          household: {
            findUnique: jest.fn().mockResolvedValue({
              tierOverride: scenario.tierOverride,
              memberships: scenario.members.map((m) => ({
                userId: m.userId,
                user: {
                  identityHash: m.identityHash,
                  appleSub: m.appleSub,
                  googleId: m.googleId,
                  authProvider: m.authProvider,
                },
              })),
            }),
          },
          subscription: {
            findMany: jest.fn(
              ({
                where,
              }: {
                where: {
                  identityHash: { in: string[] };
                  status: { in: string[] };
                };
              }) =>
                Promise.resolve(
                  scenario.subs.filter(
                    (s) =>
                      where.identityHash.in.includes(s.identityHash) &&
                      where.status.in.includes(s.status),
                  ),
                ),
            ),
          },
        };
        const domain = new AiUsageCountersService(
          prisma as unknown as PrismaService,
        );
        const byHash = new Map<string, SubscriptionCandidate[]>();
        for (const s of scenario.subs) {
          if (s.status !== 'ACTIVE' && s.status !== 'GRACE') continue;
          byHash.set(s.identityHash, [
            ...(byHash.get(s.identityHash) ?? []),
            s,
          ]);
        }
        const panel = resolveHouseholdPlan(
          {
            id: HOUSE,
            tierOverride: scenario.tierOverride,
            members: scenario.members,
          },
          byHash,
          readAgentEnv(),
          calendar(),
          NOW,
        );

        const ordered = [...scenario.members].sort(byMemberPreference);
        for (const [index, actor] of ordered.entries()) {
          const plan = await domain.resolvePlan(
            HOUSE,
            { userId: actor.userId },
            NOW,
          );
          const scope =
            panel.plan.kind === 'trial' ? panel.scopes[index] : panel.scopes[0];
          expect(scope).toEqual({
            scopeId: plan.quotaScopeId,
            periodKey: plan.periodKey,
          });
          expect(panel.limits).toEqual({
            messages: plan.messagesLimit,
            plans: plan.plansLimit,
          });
          expect(panel.resetsAt).toBe(plan.resetsAt);
          expect(panel.plan.kind).toBe(
            plan.source === 'TRIAL'
              ? 'trial'
              : plan.source === 'SUBSCRIPTION'
                ? 'subscription'
                : 'override',
          );
        }
      },
    );
  });
});
