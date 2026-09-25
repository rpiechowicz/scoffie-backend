import {
  pickBestSubscription,
  type SubscriptionCandidate,
} from '../../config/subscription-lifetime';
import type { HouseholdPlan, ProductId } from '../contract';
import { isAdminProductId } from '../subscriptions/admin-products';

/**
 * JEDYNE rozstrzygnięcie planu gospodarstwa w panelu. Wcześniej były dwa
 * (lista osób i lista domów) i tylko jedno sprawdzało SKU — nieznany produkt
 * na liście osób szedł na drut jako `productId`, a front robi
 * `PRODUCTS[productId].name` bez zabezpieczenia i ekran się wywracał.
 *
 * Kolejność jak w `AiUsageCountersService.resolvePlan`: `AI_TIER_OVERRIDE=PRO`
 * → nadanie operatora (`tierOverride = PRO`) → żywa subskrypcja któregoś
 * domownika (`pickBestSubscription`) → próba.
 */

export type PlanDecision = {
  plan: HouseholdPlan;
  /**
   * Subskrypcja, która daje dostęp — także przy nieznanym SKU (plan jest
   * wtedy `override`, ale pula i okres nadal liczą się od niej). `null` przy
   * nadaniu i próbie.
   */
  winner: SubscriptionCandidate | null;
};

export function decideHouseholdPlan(
  household: {
    tierOverride: string | null;
    /** Hasze tożsamości domowników (liczone, nie tylko czytane z kolumny). */
    memberHashes: Iterable<string | null>;
  },
  subscriptionsByHash: ReadonlyMap<string, readonly SubscriptionCandidate[]>,
  now: Date,
  envTierOverride: 'PRO' | null,
): PlanDecision {
  // `AI_TIER_OVERRIDE=PRO` i nadanie operatora dają tę samą pulę, a kontrakt
  // ma na to jeden rodzaj planu — „PRO bez subskrypcji".
  if (envTierOverride === 'PRO' || household.tierOverride === 'PRO') {
    return { plan: { kind: 'override' }, winner: null };
  }
  const seen = new Set<string>();
  const candidates: SubscriptionCandidate[] = [];
  for (const hash of household.memberHashes) {
    if (!hash) continue;
    for (const candidate of subscriptionsByHash.get(hash) ?? []) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      candidates.push(candidate);
    }
  }
  const winner = pickBestSubscription(candidates, now);
  if (!winner) return { plan: { kind: 'trial' }, winner: null };
  return { plan: subscriptionPlan(winner.productId), winner };
}

/**
 * Plan z subskrypcji. Nieznany SKU (sprzedany w App Store przed deployem
 * serwera) dostaje w domenie limity z env — tak jak nadanie. Kontrakt nie ma
 * dla niego `productId`, więc pokazujemy go jako „PRO bez produktu", zamiast
 * zmyślać plan albo wywracać front.
 */
export function subscriptionPlan(productId: string): HouseholdPlan {
  return isAdminProductId(productId)
    ? { kind: 'subscription', productId }
    : { kind: 'override' };
}

/** `productId` do kontraktu albo `null`, gdy panel go nie zna. */
export function knownProductId(productId: string): ProductId | null {
  return isAdminProductId(productId) ? productId : null;
}
