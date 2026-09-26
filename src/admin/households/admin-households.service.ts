import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AiUsageCountersService } from '../../agent/ai-usage-counters.service';
import { AppException } from '../../common/app-exception';
import { effectiveAvatarColor } from '../../common/avatar-color.util';
import { catalogHouseholdId } from '../../common/catalog-owner';
import { readAgentEnv } from '../../config/agent-env';
import type { SubscriptionCandidate } from '../../config/subscription-lifetime';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  HouseholdDetail,
  HouseholdListItem,
  HouseholdPlan,
  Invitation,
  Pool,
} from '../contract';
import { readOnlyQuery } from '../read-only-query';
import {
  byMemberPreference,
  counterKey,
  memberIdentityHash,
  poolOf,
  resolveHouseholdPlan,
  type PlanCalendar,
  type PlanEnv,
  type PlanMember,
} from './household-plan';
import {
  cookidooStatus,
  latest,
  orderMealTypes,
  parseMealSlotTimes,
} from './household-view';

/** Sufit listy — więcej domów panel i tak nie narysuje w jednej tabeli. */
export const HOUSEHOLDS_LIST_LIMIT = 1000;
/** Zaproszeń na karcie domu: najnowsze, reszta to archeologia. */
export const HOUSEHOLD_INVITATIONS_LIMIT = 50;

const MEMBERSHIP_SELECT = {
  role: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      displayName: true,
      avatarColor: true,
      lastLoginAt: true,
      lastSeenAt: true,
      identityHash: true,
      appleSub: true,
      googleId: true,
      authProvider: true,
    },
  },
} satisfies Prisma.MembershipSelect;

const LIST_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  tierOverride: true,
  memberships: { select: MEMBERSHIP_SELECT },
  cookidooIntegration: { select: { status: true } },
} satisfies Prisma.HouseholdSelect;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  enabledMealTypes: true,
  mealSlotTimes: true,
  cookidooIntegration: {
    select: {
      status: true,
      lastVerifiedAt: true,
      lastErrorCode: true,
      // Kto połączył — i NIC więcej: poświadczenia są write-only.
      connectedBy: { select: { displayName: true } },
    },
  },
  _count: {
    select: {
      recipeFavorites: true,
      agentMemories: true,
      // „Tygodnie z planem": pusty `WeeklyPlan` (założony i wyczyszczony)
      // planem nie jest — ta sama definicja, co „gospodarstwa z planem"
      // na pulpicie.
      weeklyPlans: { where: { items: { some: {} } } },
    },
  },
} satisfies Prisma.HouseholdSelect;

/** Pola `Subscription`, których potrzebuje `pickBestSubscription` — jak w `resolvePlan`. */
const CANDIDATE_SELECT = {
  id: true,
  identityHash: true,
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
} satisfies Prisma.SubscriptionSelect;

type MembershipRow = Prisma.MembershipGetPayload<{
  select: typeof MEMBERSHIP_SELECT;
}>;

type ListRow = {
  id: string;
  name: string;
  createdAt: Date;
  tierOverride: string | null;
  memberships: MembershipRow[];
  cookidooIntegration: { status: string } | null;
};

type Resolved = { plan: HouseholdPlan; pool: Pool };

export type TierChange = {
  from: 'PRO' | 'TRIAL' | null;
  to: 'PRO' | null;
};

const planMember = (membership: MembershipRow): PlanMember => ({
  userId: membership.user.id,
  role: membership.role,
  joinedAt: membership.createdAt,
  identityHash: membership.user.identityHash,
  appleSub: membership.user.appleSub,
  googleId: membership.user.googleId,
  authProvider: membership.user.authProvider,
});

const householdNotFound = () =>
  new AppException(
    'HOUSEHOLD_NOT_FOUND',
    'Nie ma takiego gospodarstwa.',
    HttpStatus.NOT_FOUND,
  );

/**
 * Gospodarstwo katalogu (bot importu) nie jest domem żadnej osoby: nie ma go
 * na liście ani w `total`, a karta i zapisy na nim kończą się tym samym 404,
 * co na nieistniejącym — tak jak w wyszukiwarce ⌘K i na pulpicie. Nadanie PRO
 * albo reset sufitu kosztu botowi to pomyłka, nie akcja obsługi.
 */
const isCatalogHousehold = (id: string): boolean =>
  id.toLowerCase() === catalogHouseholdId().toLowerCase();

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/**
 * Gospodarstwa w panelu: lista, karta domu, nadanie PRO i reset sufitu
 * kosztu (ROADMAPA §5.3).
 *
 * Odczyty idą przez `readOnlyQuery` (transakcja tylko do odczytu z limitem
 * czasu). Zapisy robią dokładnie to, co ich odpowiedniki w `/ops` —
 * `POST /ops/households/:id/tier` i `POST /ops/billing/households/:id/cost-reset`
 * piszą Prismą wprost, bo domena nie ma na to serwisu; panel nie dokłada
 * drugiej, innej semantyki.
 */
@Injectable()
export class AdminHouseholdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly counters: AiUsageCountersService,
  ) {}

  async list(
    now: Date = new Date(),
  ): Promise<{ total: number; items: HouseholdListItem[] }> {
    const env = readAgentEnv();
    const calendar = this.calendar(now);
    return readOnlyQuery(this.prisma, async (tx) => {
      const catalog = catalogHouseholdId();
      const total = await tx.household.count({
        where: { id: { not: catalog } },
      });
      // Kolejność liczy baza: „najnowsza aktywność" to najpóźniejsza obecność
      // w aplikacji któregokolwiek domownika (`lastSeenAt`, nie pełne
      // logowanie — sesja odnawia się po cichu). Sortowanie w pamięci po `take`
      // pokazywałoby przy >1000 domów przypadkowy tysiąc, nie najświeższy.
      const order = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT h.id
        FROM "Household" h
        LEFT JOIN "Membership" m ON m."householdId" = h.id
        LEFT JOIN "User" u ON u.id = m."userId"
        WHERE h.id <> ${catalog}::uuid
        GROUP BY h.id
        ORDER BY MAX(u."lastSeenAt") DESC NULLS LAST, h."createdAt" DESC, h.id
        LIMIT ${HOUSEHOLDS_LIST_LIMIT}
      `);
      const ids = order.map((row) => row.id);
      const rows = ids.length
        ? await tx.household.findMany({
            where: { id: { in: ids } },
            select: LIST_SELECT,
          })
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((row): row is (typeof rows)[number] => row !== undefined);
      const resolved = await this.resolvePlans(tx, ordered, env, calendar, now);
      return {
        total,
        items: ordered.map((row) => this.listItem(row, resolved)),
      };
    });
  }

  async detail(id: string, now: Date = new Date()): Promise<HouseholdDetail> {
    const env = readAgentEnv();
    const calendar = this.calendar(now);
    if (isCatalogHousehold(id)) throw householdNotFound();
    return readOnlyQuery(this.prisma, async (tx) => {
      const row = await tx.household.findUnique({
        where: { id },
        select: DETAIL_SELECT,
      });
      if (!row) throw householdNotFound();

      const resolved = await this.resolvePlans(tx, [row], env, calendar, now);
      // KOSZT WOBEC SUFITU = LICZNIK, KTÓRY SUFIT CZYTA. Bramka
      // `AI_HOUSEHOLD_MONTHLY_COST_USD` porównuje się z `AiUsageCounter`
      // (zakres domu, miesiąc UTC), a nie z sumą `AiUsage` — i to ten licznik
      // zeruje „Resetuj koszt". Suma księgi pokazywałaby po resecie dalej
      // czerwony pasek nad sufitem, który już nikogo nie blokuje. Bez resetu
      // obie liczby są równe: tura dopisuje księgę i licznik w tej samej
      // transakcji (`AgentTurnRunner.finishDone`).
      const cost = await tx.aiUsageCounter.findUnique({
        where: {
          scopeId_periodKey_kind: {
            scopeId: row.id,
            periodKey: calendar.monthKey,
            kind: 'costMicroUsd',
          },
        },
        select: { value: true },
      });
      const invitations = await tx.invitation.findMany({
        where: { householdId: row.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: HOUSEHOLD_INVITATIONS_LIMIT,
        // Ani `tokenHash`, ani wycofywany `token` — panel pokazuje, kto i
        // kiedy, nigdy działającego wejścia do domu.
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
          redeemedAt: true,
          declinedAt: true,
          createdBy: { select: { displayName: true } },
          invitedUser: { select: { displayName: true } },
          redeemedBy: { select: { displayName: true } },
        },
      });

      const integration = row.cookidooIntegration;
      const costCap = env.householdMonthlyCostUsd;
      return {
        ...this.listItem(row, resolved),
        enabledMealTypes: orderMealTypes(row.enabledMealTypes),
        mealSlotTimes: parseMealSlotTimes(row.mealSlotTimes),
        invitations: invitations.map(
          (invitation): Invitation => ({
            id: invitation.id,
            createdByName: invitation.createdBy?.displayName ?? null,
            invitedUserName: invitation.invitedUser?.displayName ?? null,
            redeemedByName: invitation.redeemedBy?.displayName ?? null,
            createdAt: invitation.createdAt.toISOString(),
            expiresAt: invitation.expiresAt.toISOString(),
            redeemedAt: iso(invitation.redeemedAt),
            declinedAt: iso(invitation.declinedAt),
          }),
        ),
        costMonthUsd: (cost?.value ?? 0) / 1_000_000,
        // `off` (jawny brak sufitu) nie ma liczby — kontrakt chce liczby,
        // więc 0 znaczy tu „sufit wyłączony", a nie „sufit zero dolarów".
        costCapUsd: costCap ?? 0,
        cookidooInfo: integration
          ? {
              connectedByName: integration.connectedBy?.displayName ?? null,
              lastVerifiedAt: iso(integration.lastVerifiedAt),
              lastErrorCode: integration.lastErrorCode,
            }
          : null,
        weeklyPlans: row._count.weeklyPlans,
        favorites: row._count.recipeFavorites,
        memoryNotes: row._count.agentMemories,
      };
    });
  }

  /**
   * Nadanie / zdjęcie PRO — semantyka `POST /ops/households/:id/tier`
   * (`tierOverride` na domu), bez `TRIAL`, którego panel nie wysyła.
   *
   * Poprzednia wartość idzie do audytu jako `from`, więc czytamy ją pod
   * blokadą wiersza (`FOR UPDATE`) w tej samej transakcji co zapis — inaczej
   * dwa równoległe kliknięcia zapisałyby w dzienniku zmianę, której nie było.
   * Transakcja trzyma wyłącznie ten jeden zamek, więc nie wchodzi w kolejkę
   * zamków planu (`lockHouseholdRoster` → `lockWeekForWrite`).
   */
  async setTier(id: string, tier: 'PRO' | null): Promise<TierChange> {
    if (isCatalogHousehold(id)) throw householdNotFound();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ tierOverride: string | null }[]>(
        Prisma.sql`
          SELECT "tierOverride"::text AS "tierOverride"
          FROM "Household"
          WHERE id = ${id}::uuid
          FOR UPDATE
        `,
      );
      const current = rows[0];
      if (!current) throw householdNotFound();
      await tx.household.update({
        where: { id },
        data: { tierOverride: tier },
        select: { id: true },
      });
      const from =
        current.tierOverride === 'PRO' || current.tierOverride === 'TRIAL'
          ? current.tierOverride
          : null;
      return { from, to: tier };
    });
  }

  /** Okres licznika kosztu, który zeruje reset — ta sama funkcja, co sufit. */
  costPeriodKey(now: Date = new Date()): string {
    return this.counters.monthKey(now);
  }

  /**
   * Zwolnienie sufitu kosztu miesięcznego — jak `resetCost` w
   * `BillingOpsController`: licznik `costMicroUsd` domu w bieżącym miesiącu
   * na zero. Dobowy licznik (`AI_HOUSEHOLD_DAILY_COST_USD`) zostaje, tak jak
   * w `/ops` — zdejmuje go sama północ UTC.
   */
  async resetCost(
    id: string,
    now: Date = new Date(),
  ): Promise<{ periodKey: string; reset: number }> {
    if (isCatalogHousehold(id)) throw householdNotFound();
    const periodKey = this.costPeriodKey(now);
    const household = await this.prisma.household.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!household) throw householdNotFound();
    const result = await this.prisma.aiUsageCounter.updateMany({
      where: { scopeId: id, periodKey, kind: 'costMicroUsd' },
      data: { value: 0 },
    });
    return { periodKey, reset: result.count };
  }

  private calendar(now: Date): PlanCalendar {
    return {
      monthKey: this.counters.monthKey(now),
      monthResetsAt: this.counters.monthResetsAt(now).toISOString(),
    };
  }

  /**
   * Plan i pula dla wielu domów: jedno zapytanie o subskrypcje wszystkich
   * domowników i jedno o liczniki wszystkich zakresów — bez N+1.
   */
  private async resolvePlans(
    tx: Prisma.TransactionClient,
    households: readonly ListRow[],
    env: PlanEnv,
    calendar: PlanCalendar,
    now: Date,
  ): Promise<Map<string, Resolved>> {
    const hashes = new Set<string>();
    for (const household of households) {
      for (const membership of household.memberships) {
        const hash = memberIdentityHash(planMember(membership));
        if (hash) hashes.add(hash);
      }
    }
    const subscriptions = hashes.size
      ? await tx.subscription.findMany({
          where: {
            identityHash: { in: [...hashes] },
            status: { in: ['ACTIVE', 'GRACE'] },
          },
          select: CANDIDATE_SELECT,
        })
      : [];
    const byHash = new Map<string, SubscriptionCandidate[]>();
    for (const subscription of subscriptions) {
      const list = byHash.get(subscription.identityHash) ?? [];
      list.push(subscription);
      byHash.set(subscription.identityHash, list);
    }

    const resolutions = households.map((household) => ({
      id: household.id,
      resolution: resolveHouseholdPlan(
        {
          id: household.id,
          tierOverride: household.tierOverride,
          members: household.memberships.map(planMember),
        },
        byHash,
        env,
        calendar,
        now,
      ),
    }));

    const scopeIds = new Set<string>();
    const periodKeys = new Set<string>();
    for (const { resolution } of resolutions) {
      for (const scope of resolution.scopes) {
        scopeIds.add(scope.scopeId);
        periodKeys.add(scope.periodKey);
      }
    }
    // Nadzbiór (każdy zakres × każdy okres), dokładne pary wybiera mapa.
    // Taniej niż tysiąc `OR`-ów, a zbędnych wierszy jest garstka: okresy to
    // `trial`, bieżący miesiąc i daty odnowień żywych subskrypcji.
    const counterRows = scopeIds.size
      ? await tx.aiUsageCounter.findMany({
          where: {
            scopeId: { in: [...scopeIds] },
            periodKey: { in: [...periodKeys] },
            kind: { in: ['messages', 'plans'] },
          },
          select: { scopeId: true, periodKey: true, kind: true, value: true },
        })
      : [];
    const values = new Map(
      counterRows.map((row) => [
        counterKey(row.scopeId, row.periodKey, row.kind),
        row.value,
      ]),
    );

    return new Map(
      resolutions.map(({ id, resolution }) => [
        id,
        {
          plan: resolution.plan,
          pool: poolOf(
            resolution,
            (scope, kind) =>
              values.get(counterKey(scope.scopeId, scope.periodKey, kind)) ?? 0,
          ),
        },
      ]),
    );
  }

  private listItem(
    row: ListRow,
    resolved: ReadonlyMap<string, Resolved>,
  ): HouseholdListItem {
    const plan = resolved.get(row.id);
    if (!plan) {
      // Błąd programisty: `resolvePlans` liczy każdy dom, który dostaje.
      throw new Error(`brak planu dla domu ${row.id}`);
    }
    const members = [...row.memberships].sort((a, b) =>
      byMemberPreference(planMember(a), planMember(b)),
    );
    return {
      id: row.id,
      name: row.name,
      plan: plan.plan,
      members: members.map((membership) => ({
        userId: membership.user.id,
        displayName: membership.user.displayName,
        role: membership.role,
        // Kolor, którym osoba NAPRAWDĘ świeci w aplikacji — dla kont bez
        // przydziału ten sam hasz id, co liczy iOS.
        avatarColor: effectiveAvatarColor(membership.user),
      })),
      pool: plan.pool,
      cookidoo: cookidooStatus(row.cookidooIntegration?.status),
      lastLoginAt: iso(
        latest(members.map((membership) => membership.user.lastLoginAt)),
      ),
      lastSeenAt: iso(
        latest(members.map((membership) => membership.user.lastSeenAt)),
      ),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
