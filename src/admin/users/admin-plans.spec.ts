import { purchaseIdentityHashForUser } from '../../config/purchase-identity';
import {
  identityHashOf,
  indexByIdentity,
  payingUserIds,
  type IdentityFields,
  type LiveSubscription,
} from './admin-plans';
import { decideHouseholdPlan } from '../common/plan-decision';

/** Lista osób woła wspólny resolver z haszami liczonymi przez `identityHashOf`. */
const resolveHouseholdPlan = (
  household: { tierOverride: string | null; members: IdentityFields[] },
  index: ReadonlyMap<string, readonly LiveSubscription[]>,
  now: Date,
  envTierOverride: 'PRO' | null,
) =>
  decideHouseholdPlan(
    {
      tierOverride: household.tierOverride,
      memberHashes: household.members.map(identityHashOf),
    },
    index,
    now,
    envTierOverride,
  ).plan;

const NOW = new Date('2026-09-24T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const member = (appleSub: string, stored = true): IdentityFields => ({
  identityHash: stored
    ? purchaseIdentityHashForUser({ authProvider: 'APPLE', appleSub })
    : null,
  appleSub,
  googleId: null,
  authProvider: 'APPLE',
});

const subscription = (
  id: string,
  owner: IdentityFields,
  patch: Partial<LiveSubscription> = {},
): LiveSubscription => ({
  id,
  provider: 'APPLE',
  productId: 'app.scoffie.pro.solo.monthly',
  status: 'ACTIVE',
  expiresAt: new Date(NOW.getTime() + 10 * DAY),
  graceExpiresAt: null,
  neverExpires: false,
  revokedAt: null,
  messagesLimitSnapshot: null,
  plansLimitSnapshot: null,
  createdAt: new Date(NOW.getTime() - 30 * DAY),
  environment: 'Production',
  operatorHoldAt: null,
  identityHash: identityHashOf(owner) as string,
  purchaserUserId: `user-${id}`,
  ...patch,
});

describe('plan gospodarstwa w paczce (jak resolvePlan)', () => {
  const saved = {
    APPLE_ENVIRONMENT: process.env.APPLE_ENVIRONMENT,
    APPLE_ACCEPT_SANDBOX: process.env.APPLE_ACCEPT_SANDBOX,
  };
  beforeAll(() => {
    process.env.APPLE_ENVIRONMENT = 'Production';
    delete process.env.APPLE_ACCEPT_SANDBOX;
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const anna = member('anna');
  const kuba = member('kuba');

  it('bez subskrypcji i nadania — próba', () => {
    expect(
      resolveHouseholdPlan(
        { tierOverride: null, members: [anna, kuba] },
        new Map(),
        NOW,
        null,
      ),
    ).toEqual({ kind: 'trial' });
  });

  it('subskrypcja domownika daje plan całemu domowi', () => {
    const index = indexByIdentity([subscription('s1', kuba)]);
    expect(
      resolveHouseholdPlan(
        { tierOverride: null, members: [anna, kuba] },
        index,
        NOW,
        null,
      ),
    ).toEqual({
      kind: 'subscription',
      productId: 'app.scoffie.pro.solo.monthly',
    });
  });

  it('wygrywa wyższy limit, a martwa Rodzina nie zasłania żywego Solo', () => {
    const index = indexByIdentity([
      subscription('solo', anna),
      subscription('rodzina', kuba, {
        productId: 'app.scoffie.pro.family.monthly',
      }),
    ]);
    expect(
      resolveHouseholdPlan(
        { tierOverride: null, members: [anna, kuba] },
        index,
        NOW,
        null,
      ),
    ).toEqual({
      kind: 'subscription',
      productId: 'app.scoffie.pro.family.monthly',
    });

    const refunded = indexByIdentity([
      subscription('solo', anna),
      subscription('rodzina', kuba, {
        productId: 'app.scoffie.pro.family.monthly',
        revokedAt: new Date(NOW.getTime() - DAY),
      }),
    ]);
    expect(
      resolveHouseholdPlan(
        { tierOverride: null, members: [anna, kuba] },
        refunded,
        NOW,
        null,
      ),
    ).toEqual({
      kind: 'subscription',
      productId: 'app.scoffie.pro.solo.monthly',
    });
  });

  it('nadanie operatora i AI_TIER_OVERRIDE mają pierwszeństwo przed subskrypcją', () => {
    const index = indexByIdentity([subscription('s1', anna)]);
    expect(
      resolveHouseholdPlan(
        { tierOverride: 'PRO', members: [anna] },
        index,
        NOW,
        null,
      ),
    ).toEqual({ kind: 'override' });
    expect(
      resolveHouseholdPlan(
        { tierOverride: null, members: [anna] },
        index,
        NOW,
        'PRO',
      ),
    ).toEqual({ kind: 'override' });
    // TRIAL w kolumnie nie wymusza próby — `resolvePlan` patrzy tylko na PRO.
    expect(
      resolveHouseholdPlan(
        { tierOverride: 'TRIAL', members: [anna] },
        index,
        NOW,
        null,
      ).kind,
    ).toBe('subscription');
  });

  it('hasz liczony z appleSub, gdy kolumna jeszcze pusta (płatnik przed logowaniem)', () => {
    const fresh = member('ola', false);
    const index = indexByIdentity([subscription('s1', member('ola'))]);
    expect(identityHashOf(fresh)).toBe(identityHashOf(member('ola')));
    expect(
      resolveHouseholdPlan(
        { tierOverride: null, members: [fresh] },
        index,
        NOW,
        null,
      ).kind,
    ).toBe('subscription');
  });

  it('sandbox na produkcji nie daje planu ani nie robi z kogoś płacącego', () => {
    const sandbox = subscription('s1', anna, { environment: 'Sandbox' });
    expect(
      resolveHouseholdPlan(
        { tierOverride: null, members: [anna] },
        indexByIdentity([sandbox]),
        NOW,
        null,
      ),
    ).toEqual({ kind: 'trial' });
    expect(payingUserIds([sandbox], NOW).size).toBe(0);
  });

  it('nieznany SKU nie idzie na drut jako productId — plan „PRO bez produktu"', () => {
    const index = indexByIdentity([
      subscription('nowy', anna, { productId: 'app.scoffie.pro.yearly' }),
    ]);
    expect(
      resolveHouseholdPlan(
        { tierOverride: null, members: [anna] },
        index,
        NOW,
        null,
      ),
    ).toEqual({ kind: 'override' });
  });

  it('płacący = kupujący żywej subskrypcji', () => {
    const paying = payingUserIds(
      [
        subscription('a', anna),
        subscription('b', kuba, {
          expiresAt: new Date(NOW.getTime() - DAY),
        }),
        subscription('c', kuba, { purchaserUserId: null }),
      ],
      NOW,
    );
    expect([...paying]).toEqual(['user-a']);
  });
});
