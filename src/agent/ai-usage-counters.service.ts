import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readAgentEnv } from '../config/agent-env';
import { productLimits } from '../config/subscription-products';
import { subscriptionScopeId, trialScopeId } from '../config/purchase-identity';
import {
  pickBestSubscription,
  type SubscriptionCandidate,
} from '../config/subscription-lifetime';
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
  /**
   * Zakres licznika kwoty. NIE zawsze jest to gospodarstwo:
   *
   *   • `sub:<id>`     — subskrypcja. Pula wisi na UMOWIE, więc przeprowadzka
   *                      do innego domu jej nie odnawia (jedna opłata = jedna
   *                      pula miesięcznie, gdziekolwiek płatnik akurat jest).
   *   • `trial:<hasz>` — pula próbna osoby, jedna na życie. Nie na domu, bo
   *                      „wyjdź z domu → załóż nowy" dawało świeżą próbę.
   *   • `<householdId>`— nadanie operatora i `AI_TIER_OVERRIDE`; te nigdzie
   *                      nie wędrują, bo `tierOverride` jest kolumną domu.
   */
  quotaScopeId: string;
  /** `YYYY-MM` (PRO) albo `trial` (jedna pula bez odnowienia). */
  periodKey: string;
  renews: boolean;
  /** ISO albo `null` (próba się nie odnawia). */
  resetsAt: string | null;
  messagesLimit: number;
  plansLimit: number;
  /** Nazwa planu z App Store (Solo/Duet/Rodzina); `null` = limity z env. */
  product: string | null;
  /** Id żywej subskrypcji, jeśli to ona daje PRO — do panelu i do ops. */
  subscriptionId: string | null;
};

/**
 * Kto pyta o plan. Potrzebne, bo pula PRÓBNA należy do osoby, nie do domu.
 * `identityHash` jest opcjonalny — dociągamy go z domu, jeśli wołający go nie
 * ma pod ręką.
 */
export type PlanActor = { userId: string; identityHash?: string | null };

/** Klucz okresu puli próbnej — jedna na całe życie OSOBY (patrz `trialScopeId`). */
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
   * Koszt gospodarstwa w bieżącym miesiącu — surowiec dla sufitu z
   * `AI_HOUSEHOLD_MONTHLY_COST_USD`. Zawsze `monthKey`, także na próbie:
   * pula próbna nie ma miesiąca, ale pieniądze wydają się w miesiącach.
   */
  async addHouseholdCost(
    client: UsageCounterClient,
    householdId: string,
    costMicroUsd: number,
    now: Date = new Date(),
  ): Promise<void> {
    if (costMicroUsd <= 0) return;
    await this.add(
      client,
      householdId,
      this.monthKey(now),
      'costMicroUsd',
      costMicroUsd,
    );
  }

  /**
   * Plan gospodarstwa NA TERAZ — liczony, nigdy nie odczytywany z przypisania.
   *
   * DLACZEGO TAK, A NIE „SUBSKRYPCJA PRZYPIĘTA DO DOMU". Poprzednia wersja
   * czytała jeden wiersz przypięty do gospodarstwa. Cztery niezależne testy
   * obalające pokazały tę samą wadę: zdarzeń, które to przypisanie PSUJĄ
   * (wyjście z domu, usunięcie członka, skasowanie konta, sprzątnięcie pustego
   * domu, przyjęcie zaproszenia, przegrana w regule „wyższy limit wygrywa"),
   * jest więcej niż miejsc, które je NAPRAWIAJĄ — a żadne z tych naprawiających
   * nie leżało na ścieżce, którą naprawdę chodzi człowiek. Skutek: „płacę Apple
   * i nie mam asystenta, i nie ma przycisku, który by to odkręcił".
   *
   * Tutaj nie ma czego przypiąć. Pytanie brzmi „czy któryś z OBECNYCH
   * domowników ma teraz żywą subskrypcję" i odpowiedź liczy się od zera przy
   * każdym żądaniu. Kto wyszedł — zabiera swoje PRO ze sobą w tej samej
   * sekundzie. Kto wszedł — wnosi je bez żadnej akcji administracyjnej.
   *
   * ODPOWIEDŹ NA PYTANIE RAFAŁA („user ma Solo i zaprasza domownika"):
   * domownik MA asystenta od razu, w pełni, bez kupowania czegokolwiek i bez
   * żadnej akcji ze strony płatnika. Pula (30/8 przy Solo) jest WSPÓLNA dla
   * całego domu — dokładnie tak, jak wspólny jest plan tygodnia i lista
   * zakupów, które ten asystent układa. Wielkość planu jest etykietą zużycia,
   * nie bramką na miejsca: większy dom szybciej zjada pulę, więc wybiera
   * wyższy plan. Drugiej subskrypcji w tym samym domu nie przyjmujemy —
   * wygrywa ta o wyższym limicie, druga leży nieużywana u swojego płatnika i
   * odżyje, gdy ten się wyprowadzi.
   *
   * Kolejność: `AI_TIER_OVERRIDE` → nadanie operatora → żywa subskrypcja
   * domownika → próba.
   */
  async resolvePlan(
    householdId: string,
    actor: PlanActor,
    now: Date = new Date(),
  ): Promise<HouseholdPlan> {
    const env = readAgentEnv();
    if (env.tierOverride === 'PRO') {
      return this.proPlan('ENV', now, env, householdId);
    }
    const household = await this.prisma.household.findUnique({
      where: { id: householdId },
      select: {
        tierOverride: true,
        memberships: {
          select: { userId: true, user: { select: { identityHash: true } } },
        },
      },
    });
    if (household?.tierOverride === 'PRO') {
      return this.proPlan('GRANTED', now, env, householdId);
    }

    const members = household?.memberships ?? [];
    const hashes = members
      .map((membership) => membership.user.identityHash)
      .filter((hash): hash is string => Boolean(hash));

    if (hashes.length > 0) {
      const candidates = await this.prisma.subscription.findMany({
        where: {
          identityHash: { in: hashes },
          status: { in: ['ACTIVE', 'GRACE'] },
        },
        select: {
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
        },
      });
      const winner = pickBestSubscription(candidates, now);
      if (winner) {
        return this.proPlan('SUBSCRIPTION', now, env, householdId, winner);
      }
    }

    // Pula próbna należy do OSOBY, nie do domu — inaczej „wyjdź z domu →
    // załóż nowy" rozdawało świeże próby w nieskończoność.
    const actorHash =
      actor.identityHash ??
      members.find((membership) => membership.userId === actor.userId)?.user
        .identityHash ??
      null;
    return {
      tier: 'TRIAL',
      source: 'TRIAL',
      quotaScopeId: trialScopeId(actorHash, actor.userId),
      periodKey: TRIAL_PERIOD_KEY,
      renews: false,
      resetsAt: null,
      messagesLimit: env.trialMessages,
      plansLimit: env.trialPlans,
      product: null,
      subscriptionId: null,
    };
  }

  private proPlan(
    source: HouseholdPlanSource,
    now: Date,
    env: ReturnType<typeof readAgentEnv>,
    householdId: string,
    sub?: SubscriptionCandidate,
  ): HouseholdPlan {
    // Limity biorą się z KUPIONEGO produktu (Solo/Duet/Rodzina); nadanie
    // operatora i `AI_TIER_OVERRIDE` nie mają produktu, więc dostają limity
    // z env — tak jak dotąd.
    const limits = productLimits(sub?.productId, {
      messagesPerMonth: env.messagesPerMonth,
      plansPerMonth: env.plansPerMonth,
    });
    // MIGAWKA WYGRYWA Z CENNIKIEM. Limit zapisany przy zakupie jest obietnicą
    // złożoną konkretnej osobie; obniżenie cennika nie ma prawa jej obniżyć
    // (to zmiana warunków umowy w trakcie i wprost sprzeczność z paywallem,
    // App Store 3.1.2(c)). Podwyżka limitu działa od razu i dla wszystkich —
    // stąd `Math.max`, a nie zwykłe pierwszeństwo migawki.
    const messagesLimit = Math.max(
      limits.messagesPerMonth,
      sub?.messagesLimitSnapshot ?? 0,
    );
    const plansLimit = Math.max(
      limits.plansPerMonth,
      sub?.plansLimitSnapshot ?? 0,
    );
    return {
      tier: 'PRO',
      source,
      // Pula subskrypcji wisi na UMOWIE, nadanie operatora — na domu.
      quotaScopeId: sub ? subscriptionScopeId(sub.id) : householdId,
      periodKey: this.monthKey(now),
      renews: true,
      resetsAt: this.monthResetsAt(now).toISOString(),
      messagesLimit,
      plansLimit,
      product: limits.product,
      subscriptionId: sub?.id ?? null,
    };
  }

  /**
   * `details` dla 429 z planu: te same pola, co w `GET /agent/usage`, plus
   * `tier` — telefon na próbie pokazuje „Wybierz plan", nie datę odnowienia.
   *
   * `PRO` jest tu nazwą WEWNĘTRZNĄ poziomu (płatny kontra próbny). Człowiek
   * jej nie widzi: kupuje plan Solo, We dwoje albo Rodzina, i tak nazywa się
   * to na każdym ekranie.
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

export {
  pickBestSubscription,
  subscriptionAlive,
} from '../config/subscription-lifetime';
