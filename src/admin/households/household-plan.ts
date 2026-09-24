import { TRIAL_PERIOD_KEY } from '../../agent/ai-usage-counters.service';
import type { AgentEnv } from '../../config/agent-env';
import {
  purchaseIdentityHashForUser,
  subscriptionScopeId,
  trialScopeId,
} from '../../config/purchase-identity';
import {
  billingPeriodKey,
  pickBestSubscription,
  type SubscriptionCandidate,
} from '../../config/subscription-lifetime';
import { productLimits } from '../../config/subscription-products';
import type { HouseholdPlan, Pool } from '../contract';
import { isAdminProductId } from '../subscriptions/admin-products';

/**
 * Plan i pula gospodarstwa w panelu — ta sama arytmetyka, co
 * `AiUsageCountersService.resolvePlan`, tylko dla WIELU domów naraz.
 *
 * DLACZEGO NIE `resolvePlan` W PĘTLI. To dwa zapytania na dom (dom z
 * domownikami, subskrypcje po haszach), czyli przy liście 1000 domów dwa
 * tysiące zapytań na jedno otwarcie ekranu. Tu te same dane idą paczką (jedno
 * zapytanie o subskrypcje wszystkich domowników, jedno o liczniki), a każdy
 * krok woła TE SAME funkcje domeny: `pickBestSubscription`, `billingPeriodKey`,
 * `productLimits`, `trialScopeId`, `subscriptionScopeId`. Rozjazd z asystentem
 * wymagałby więc zmiany kolejności kroków, a tę pilnuje e2e, który porównuje
 * wynik z `resolvePlan` na żywej bazie (`test/admin-households.e2e-spec.ts`).
 *
 * Kolejność jak w `resolvePlan`: `AI_TIER_OVERRIDE=PRO` → nadanie operatora
 * (`tierOverride = PRO`) → żywa subskrypcja któregoś domownika → próba.
 */

/** Domownik — tyle, ile trzeba do hasza tożsamości i do wyboru puli próbnej. */
export type PlanMember = {
  userId: string;
  role: string;
  joinedAt: Date;
  identityHash: string | null;
  appleSub: string | null;
  googleId: string | null;
  authProvider: string;
};

export type PlanHousehold = {
  id: string;
  tierOverride: string | null;
  members: readonly PlanMember[];
};

export type PlanEnv = Pick<
  AgentEnv,
  | 'tierOverride'
  | 'messagesPerMonth'
  | 'plansPerMonth'
  | 'trialMessages'
  | 'trialPlans'
>;

/**
 * Miesiąc kalendarzowy z `AiUsageCountersService` (`monthKey`,
 * `monthResetsAt`) — podawany z zewnątrz, żeby okres nadania i
 * `AI_TIER_OVERRIDE` liczył się DOKŁADNIE tą funkcją, której używa kwota.
 */
export type PlanCalendar = { monthKey: string; monthResetsAt: string };

export type PoolScope = { scopeId: string; periodKey: string };

export type PlanResolution = {
  plan: HouseholdPlan;
  /**
   * Zakresy licznika do odczytu. Plan PRO ma jeden. Próba ma po jednym na
   * domownika (pula próbna należy do OSOBY, nie do domu), w kolejności
   * pierwszeństwa: właściciel, potem najstarsze członkostwo.
   */
  scopes: PoolScope[];
  limits: { messages: number; plans: number };
  resetsAt: string | null;
};

export type UsageKind = 'messages' | 'plans';
export type UsageLookup = (scope: PoolScope, kind: UsageKind) => number;

/** Hasz tożsamości domownika — liczony, nie tylko czytany (jak w `resolvePlan`). */
export function memberIdentityHash(member: PlanMember): string | null {
  return member.identityHash ?? purchaseIdentityHashForUser(member);
}

/** Właściciel pierwszy, potem najstarsze członkostwo; id rozstrzyga remis. */
export function byMemberPreference(a: PlanMember, b: PlanMember): number {
  const owner = Number(b.role === 'OWNER') - Number(a.role === 'OWNER');
  if (owner !== 0) return owner;
  const joined = a.joinedAt.getTime() - b.joinedAt.getTime();
  if (joined !== 0) return joined;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

export function resolveHouseholdPlan(
  household: PlanHousehold,
  subscriptionsByHash: ReadonlyMap<string, readonly SubscriptionCandidate[]>,
  env: PlanEnv,
  calendar: PlanCalendar,
  now: Date,
): PlanResolution {
  const fallback = {
    messagesPerMonth: env.messagesPerMonth,
    plansPerMonth: env.plansPerMonth,
  };

  // `AI_TIER_OVERRIDE=PRO` i nadanie operatora dają tę samą pulę: zakres
  // domu, miesiąc kalendarzowy, limity z env. Kontrakt ma na to jeden rodzaj
  // planu — „PRO bez subskrypcji".
  if (env.tierOverride === 'PRO' || household.tierOverride === 'PRO') {
    const limits = productLimits(undefined, fallback);
    return {
      plan: { kind: 'override' },
      scopes: [{ scopeId: household.id, periodKey: calendar.monthKey }],
      limits: {
        messages: limits.messagesPerMonth,
        plans: limits.plansPerMonth,
      },
      resetsAt: calendar.monthResetsAt,
    };
  }

  const seen = new Set<string>();
  const candidates: SubscriptionCandidate[] = [];
  for (const member of household.members) {
    const hash = memberIdentityHash(member);
    if (!hash) continue;
    for (const candidate of subscriptionsByHash.get(hash) ?? []) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      candidates.push(candidate);
    }
  }
  const winner = pickBestSubscription(candidates, now);
  if (winner) {
    const limits = productLimits(winner.productId, fallback);
    const period = billingPeriodKey(winner);
    return {
      // Nieznany SKU (sprzedany w App Store przed deployem serwera) dostaje w
      // domenie limity z env — tak jak nadanie. Kontrakt nie ma dla niego
      // `productId`, a front wywraca się na nieznanym, więc pokazujemy go jako
      // „PRO bez produktu", zamiast zmyślać plan.
      plan: isAdminProductId(winner.productId)
        ? { kind: 'subscription', productId: winner.productId }
        : { kind: 'override' },
      scopes: [
        {
          scopeId: subscriptionScopeId(winner.id),
          periodKey: period ?? calendar.monthKey,
        },
      ],
      // MIGAWKA WYGRYWA Z CENNIKIEM — `Math.max`, jak w `proPlan`.
      limits: {
        messages: Math.max(
          limits.messagesPerMonth,
          winner.messagesLimitSnapshot ?? 0,
        ),
        plans: Math.max(limits.plansPerMonth, winner.plansLimitSnapshot ?? 0),
      },
      resetsAt:
        period && winner.expiresAt
          ? winner.expiresAt.toISOString()
          : calendar.monthResetsAt,
    };
  }

  const ordered = [...household.members].sort(byMemberPreference);
  return {
    plan: { kind: 'trial' },
    scopes: ordered.map((member) => ({
      scopeId: trialScopeId(memberIdentityHash(member), member.userId),
      periodKey: TRIAL_PERIOD_KEY,
    })),
    limits: { messages: env.trialMessages, plans: env.trialPlans },
    resetsAt: null,
  };
}

/**
 * Pula do pokazania. Dla PRO to jedyny zakres. Dla próby — zakres domownika,
 * który zużył z niej NAJWIĘCEJ (wiadomości, potem zapisy planu; remis →
 * kolejność pierwszeństwa). Dom na próbie nie ma jednej puli: każdy domownik
 * ma swoje pięć wiadomości, a pytanie z panelu brzmi „czy ktoś tu dobija do
 * ściany próby" — pula właściciela pokazywałaby 0/5 obok domownika z 5/5.
 *
 * Dom bez domowników (sierota przed sprzątaniem) nie ma czyjej puli pokazać:
 * pusty zakres i zera.
 */
export function poolOf(resolution: PlanResolution, used: UsageLookup): Pool {
  const [first, ...rest] = resolution.scopes;
  if (!first) {
    return {
      scopeId: '',
      messages: { used: 0, limit: resolution.limits.messages },
      plans: { used: 0, limit: resolution.limits.plans },
      resetsAt: resolution.resetsAt,
    };
  }
  let best = first;
  let bestMessages = used(first, 'messages');
  let bestPlans = used(first, 'plans');
  for (const scope of rest) {
    const messages = used(scope, 'messages');
    const plans = used(scope, 'plans');
    if (
      messages > bestMessages ||
      (messages === bestMessages && plans > bestPlans)
    ) {
      best = scope;
      bestMessages = messages;
      bestPlans = plans;
    }
  }
  return {
    scopeId: best.scopeId,
    messages: { used: bestMessages, limit: resolution.limits.messages },
    plans: { used: bestPlans, limit: resolution.limits.plans },
    resetsAt: resolution.resetsAt,
  };
}

/** Klucz licznika w mapie odczytu: zakres, okres i rodzaj naraz. */
export function counterKey(
  scopeId: string,
  periodKey: string,
  kind: string,
): string {
  return `${scopeId}\u0000${periodKey}\u0000${kind}`;
}
