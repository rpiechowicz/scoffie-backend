import { Prisma } from '@prisma/client';
import { purchaseIdentityHashForUser } from '../../config/purchase-identity';
import {
  subscriptionAlive,
  type SubscriptionCandidate,
} from '../../config/subscription-lifetime';

/**
 * Plan gospodarstwa dla WIELU domów naraz — ta sama kolejność co
 * `AiUsageCountersService.resolvePlan` (`AI_TIER_OVERRIDE` → nadanie operatora
 * → żywa subskrypcja któregoś z domowników → próba), ale bez zapytania na
 * dom: subskrypcje czytamy raz, a plan rozstrzyga wspólny
 * `decideHouseholdPlan` (`../common/plan-decision`), ten sam co na liście
 * domów. Lista tysiąca osób nie może oznaczać tysiąca zapytań.
 */

/** Pola konta, z których liczy się hasz tożsamości zakupowej. */
export type IdentityFields = {
  identityHash: string | null;
  appleSub: string | null;
  googleId: string | null;
  authProvider: string;
};

export const IDENTITY_SELECT = {
  identityHash: true,
  appleSub: true,
  googleId: true,
  authProvider: true,
} as const satisfies Prisma.UserSelect;

/** Subskrypcja ACTIVE / GRACE z polami potrzebnymi domenie do rozstrzygnięcia. */
export type LiveSubscription = SubscriptionCandidate & {
  identityHash: string;
  purchaserUserId: string | null;
};

export const LIVE_SUBSCRIPTION_SELECT = {
  id: true,
  provider: true,
  productId: true,
  status: true,
  expiresAt: true,
  graceExpiresAt: true,
  neverExpires: true,
  revokedAt: true,
  messagesLimitSnapshot: true,
  plansLimitSnapshot: true,
  createdAt: true,
  environment: true,
  operatorHoldAt: true,
  identityHash: true,
  purchaserUserId: true,
} as const satisfies Prisma.SubscriptionSelect;

/**
 * Wszystkie subskrypcje ze statusem ACTIVE / GRACE — ten sam zbiór
 * kandydatów, który `resolvePlan` bierze dla jednego domu, tylko raz dla
 * wszystkich. Żywotność (daty, środowisko, blokada) rozstrzyga potem
 * `subscriptionAlive`, nie zapytanie.
 */
export function loadLiveSubscriptions(
  tx: Prisma.TransactionClient,
): Promise<LiveSubscription[]> {
  return tx.subscription.findMany({
    where: { status: { in: ['ACTIVE', 'GRACE'] } },
    select: LIVE_SUBSCRIPTION_SELECT,
  });
}

/**
 * Hasz liczony, a nie tylko czytany — dokładnie jak w `resolvePlan`: między
 * zakupem a najbliższym logowaniem kolumna bywa pusta, a płatnik ze świeżą
 * subskrypcją nie może wtedy wyglądać na próbę.
 */
export function identityHashOf(user: IdentityFields): string | null {
  return user.identityHash ?? purchaseIdentityHashForUser(user);
}

/** Kto płaci: `purchaserUserId` subskrypcji, która daje dostęp TERAZ. */
export function payingUserIds(
  subscriptions: readonly LiveSubscription[],
  now: Date,
): Set<string> {
  const paying = new Set<string>();
  for (const subscription of subscriptions) {
    if (subscription.purchaserUserId && subscriptionAlive(subscription, now)) {
      paying.add(subscription.purchaserUserId);
    }
  }
  return paying;
}

export function indexByIdentity(
  subscriptions: readonly LiveSubscription[],
): Map<string, LiveSubscription[]> {
  const index = new Map<string, LiveSubscription[]>();
  for (const subscription of subscriptions) {
    const list = index.get(subscription.identityHash) ?? [];
    list.push(subscription);
    index.set(subscription.identityHash, list);
  }
  return index;
}
