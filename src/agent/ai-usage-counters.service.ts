import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readAgentEnv } from '../config/agent-env';
import { PrismaService } from '../prisma/prisma.service';

export type HouseholdPlanTier = 'TRIAL' | 'PRO';
/** Skąd PRO: subskrypcja, nadanie operatora albo `AI_TIER_OVERRIDE`. */
export type HouseholdPlanSource = 'TRIAL' | 'SUBSCRIPTION' | 'GRANTED' | 'ENV';

/**
 * Plan gospodarstwa na TERAZ — wszystko, czego potrzebuje kwota: klucz
 * okresu licznika, limity, czy i kiedy pula wraca. Liczone przy każdym
 * żądaniu, żeby wygaśnięcie subskrypcji działało bez crona.
 */
export type HouseholdPlan = {
  tier: HouseholdPlanTier;
  source: HouseholdPlanSource;
  /** `YYYY-MM` (PRO) albo `trial` (jedna pula bez odnowienia). */
  periodKey: string;
  renews: boolean;
  /** ISO albo `null` (próba się nie odnawia). */
  resetsAt: string | null;
  messagesLimit: number;
  plansLimit: number;
};

/** Klucz okresu puli próbnej — jedna na całe życie gospodarstwa. */
export const TRIAL_PERIOD_KEY = 'trial';

/**
 * Klient Prismy albo klient transakcji — liczniki muszą dać się naliczyć
 * WEWNĄTRZ transakcji, która zakłada turę (inaczej kwota i tura mogłyby się
 * rozjechać przy awarii między zapisami).
 */
export type UsageCounterClient = Prisma.TransactionClient | PrismaService;

/** Rodzaje liczników — jeden wiersz `AiUsageCounter` na (scope, okres, rodzaj). */
export const USAGE_KINDS = ['messages', 'plans', 'costMicroUsd'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** Scope kosztu globalnego (budżet dobowy), rozłączny z UUID gospodarstwa. */
export const GLOBAL_SCOPE = 'global';

/**
 * Liczniki użycia asystenta: kwoty miesięczne per gospodarstwo i dobowy
 * budżet kosztu na całą instalację.
 *
 * Dlaczego licznik, a nie `count()` po `AiUsage`: kwotę trzeba zdjąć NA
 * STARCIE tury, jednym zapisem, który albo się uda, albo nie — inaczej dwa
 * telefony wchodzące równocześnie na ostatnią wiadomość miesiąca oba
 * przeczytają „199 < 200" i oba ruszą. `tryConsume` robi to warunkowym
 * `updateMany(value < limit)`: Postgres podnosi wartość dokładnie raz,
 * a `count === 0` znaczy „limit wyczerpany" bez żadnej blokady.
 *
 * Okresy liczone w UTC. Użytkownik w Warszawie dostaje odnowienie kwoty
 * o 1:00/2:00 w nocy — świadomy kompromis: doba serwera jest jedna, a
 * strefa klienta bywa różna nawet w jednym gospodarstwie.
 */
@Injectable()
export class AiUsageCountersService {
  constructor(private readonly prisma: PrismaService) {}

  /** `YYYY-MM` (UTC) — okres kwot miesięcznych. */
  monthKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 7);
  }

  /** `YYYY-MM-DD` (UTC) — okres budżetu dobowego. */
  dayKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  /**
   * Kiedy odnawia się kwota miesięczna: północ UTC pierwszego dnia
   * następnego miesiąca. Do odpowiedzi `GET /agent/usage` i do `details`
   * przy 429 — użytkownik ma wiedzieć, KIEDY limit wraca, nie tylko że go nie ma.
   */
  monthResetsAt(now: Date = new Date()): Date {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    );
  }

  /**
   * Plan gospodarstwa: `AI_TIER_OVERRIDE=PRO` → PRO dla wszystkich;
   * inaczej nadanie operatora (`tierOverride`), potem żywa subskrypcja
   * (ACTIVE/GRACE i `expiresAt` w przyszłości albo bez daty), inaczej TRIAL.
   */
  async resolvePlan(
    householdId: string,
    now: Date = new Date(),
  ): Promise<HouseholdPlan> {
    const env = readAgentEnv();
    if (env.tierOverride === 'PRO') return this.proPlan('ENV', now, env);
    const household = await this.prisma.household.findUnique({
      where: { id: householdId },
      select: {
        tierOverride: true,
        subscription: { select: { status: true, expiresAt: true } },
      },
    });
    if (household?.tierOverride === 'PRO') {
      return this.proPlan('GRANTED', now, env);
    }
    const sub = household?.subscription;
    const alive =
      sub &&
      (sub.status === 'ACTIVE' || sub.status === 'GRACE') &&
      (sub.expiresAt === null || sub.expiresAt.getTime() > now.getTime());
    if (alive) return this.proPlan('SUBSCRIPTION', now, env);
    return {
      tier: 'TRIAL',
      source: 'TRIAL',
      periodKey: TRIAL_PERIOD_KEY,
      renews: false,
      resetsAt: null,
      messagesLimit: env.trialMessages,
      plansLimit: env.trialPlans,
    };
  }

  private proPlan(
    source: HouseholdPlanSource,
    now: Date,
    env: ReturnType<typeof readAgentEnv>,
  ): HouseholdPlan {
    return {
      tier: 'PRO',
      source,
      periodKey: this.monthKey(now),
      renews: true,
      resetsAt: this.monthResetsAt(now).toISOString(),
      messagesLimit: env.messagesPerMonth,
      plansLimit: env.plansPerMonth,
    };
  }

  /**
   * `details` dla 429 z planu: te same pola, co w `GET /agent/usage`, plus
   * `tier` — telefon na próbie pokazuje „Odblokuj PRO", nie datę odnowienia.
   */
  quotaDetailsFor(kind: UsageKind, plan: HouseholdPlan): string[] {
    const limit = kind === 'plans' ? plan.plansLimit : plan.messagesLimit;
    return [
      `kind:${kind}`,
      `limit:${limit}`,
      'remaining:0',
      `tier:${plan.tier}`,
      plan.resetsAt ? `resetsAt:${plan.resetsAt}` : 'renews:false',
    ];
  }

  /** `details` dla 429 — te same pola, co w `GET /agent/usage`. */
  quotaDetails(
    kind: UsageKind,
    limit: number,
    now: Date = new Date(),
  ): string[] {
    return [
      `kind:${kind}`,
      `limit:${limit}`,
      'remaining:0',
      `resetsAt:${this.monthResetsAt(now).toISOString()}`,
    ];
  }

  /**
   * Zdejmuje 1 z kwoty, jeśli jest z czego. `false` = limit wyczerpany
   * (wołający oddaje 429 `AI_QUOTA_EXCEEDED`). Limit 0 nigdy nie przechodzi.
   */
  async tryConsume(
    client: UsageCounterClient,
    scopeId: string,
    periodKey: string,
    kind: UsageKind,
    limit: number,
  ): Promise<boolean> {
    if (limit <= 0) return false;
    // Wiersz musi istnieć, żeby `updateMany` miał co podnieść; `create` bez
    // `update` jest bezpieczne przy wyścigu (P2002 obsłuży ponowny odczyt
    // wołającego, a `upsert` z pustym `update` po prostu nic nie robi).
    await client.aiUsageCounter.upsert({
      where: { scopeId_periodKey_kind: { scopeId, periodKey, kind } },
      create: { scopeId, periodKey, kind, value: 0 },
      update: {},
    });
    const consumed = await client.aiUsageCounter.updateMany({
      where: { scopeId, periodKey, kind, value: { lt: limit } },
      data: { value: { increment: 1 } },
    });
    return consumed.count === 1;
  }

  /**
   * Dolicza `delta` (ujemna = zwrot kwoty po nieudanej turze). Zwrot nie
   * schodzi poniżej zera — przy równoległym resecie okresu licznik mógłby
   * inaczej wpaść na wartość ujemną i rozdać darmowe tury.
   */
  async add(
    client: UsageCounterClient,
    scopeId: string,
    periodKey: string,
    kind: UsageKind,
    delta: number,
  ): Promise<void> {
    if (delta === 0) return;
    await client.aiUsageCounter.upsert({
      where: { scopeId_periodKey_kind: { scopeId, periodKey, kind } },
      create: { scopeId, periodKey, kind, value: Math.max(0, delta) },
      update: { value: { increment: delta } },
    });
    if (delta < 0) {
      await client.aiUsageCounter.updateMany({
        where: { scopeId, periodKey, kind, value: { lt: 0 } },
        data: { value: 0 },
      });
    }
  }

  async read(
    scopeId: string,
    periodKey: string,
    kind: UsageKind,
    client: UsageCounterClient = this.prisma,
  ): Promise<number> {
    const row = await client.aiUsageCounter.findUnique({
      where: { scopeId_periodKey_kind: { scopeId, periodKey, kind } },
      select: { value: true },
    });
    return row?.value ?? 0;
  }
}
