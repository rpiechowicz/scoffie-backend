import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUuid } from '../../common/uuid';
import { REFERENCE_USD_PLN } from '../../config/ai-unit-economics';
import {
  SUBSCRIPTION_SCOPE_PREFIX,
  TRIAL_SCOPE_PREFIX,
} from '../../config/purchase-identity';
import { PrismaService } from '../../prisma/prisma.service';
import type { ProfitData, ProfitPeriod, ProfitRow } from '../contract';
import { readOnlyQuery } from '../read-only-query';
import {
  isContractProductId,
  marginTrendPp,
  proposalCounts,
  profitWindows,
  revenueByDay,
  roundTo,
  secondsOf,
  trendPct,
  TURN_BUCKET_THRESHOLDS_MS,
  turnHistogram,
  usdOf,
  type ProfitWindow,
} from './profit-math';
import { PANEL_TIME_ZONE } from './warsaw-calendar';

type Tx = Prisma.TransactionClient;

/**
 * Chwila jako `timestamp` w UTC — tak Prisma trzyma `DateTime` w Postgresie
 * (`timestamp(3)` bez strefy). Jawne rzutowanie zamiast gołego parametru:
 * porównanie `timestamp` z `timestamptz` zależałoby od strefy SESJI bazy.
 */
const utc = (instant: Date): Prisma.Sql =>
  Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

type DailyCostRow = { day: string; cost: bigint; trialCost: bigint };
type ScopeRow = {
  scope: string;
  turns: number;
  cost: bigint;
  householdId: string | null;
};
type TurnStatsRow = {
  p50: number | null;
  p95: number | null;
  trials: number;
};
type BucketRow = { bucket: number; count: number };
type ModelRow = { model: string; turns: number; cost: bigint };

/**
 * Rentowność asystenta (ROADMAPA §5.4) — liczona na żywo z `AiUsage`,
 * `AgentTurn`, `AgentProposal` i `Subscription`, bez `AdminDailyStat`.
 *
 * WYNIK FINANSOWY PER ZAKRES PULI, NIE PER DOM: koszt tury przypisujemy po
 * `AgentTurn.quotaScopeId` (`sub:<id>` — subskrypcja, `trial:<hasz>` — próba
 * osoby, UUID domu — nadanie operatora). Subskrypcja należy do osoby i pula
 * wędruje z nią, więc „dom” w wierszu to dom PŁATNIKA.
 */
@Injectable()
export class AdminProfitService {
  constructor(private readonly prisma: PrismaService) {}

  profit(period: ProfitPeriod, now: Date = new Date()): Promise<ProfitData> {
    const { current, previous } = profitWindows(period, now);
    return readOnlyQuery(this.prisma, (tx) =>
      this.compute(tx, current, previous),
    );
  }

  private async compute(
    tx: Tx,
    current: ProfitWindow,
    previous: ProfitWindow,
  ): Promise<ProfitData> {
    const { from, to } = current;

    // 1. Koszt dzień po dniu (polski dzień), bieżący i poprzedni okres naraz.
    // Koszt prób = wiersze `AiUsage`, których tura zeszła z puli próbnej;
    // wiersz bez tury (rozmowa skasowana) liczy się do kosztu, ale nie da się
    // go przypisać do żadnego zakresu.
    const dailyCost = await tx.$queryRaw<DailyCostRow[]>(Prisma.sql`
      SELECT
        to_char((u."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${PANEL_TIME_ZONE}, 'YYYY-MM-DD') AS day,
        COALESCE(SUM(u."costMicroUsd"), 0)::bigint AS cost,
        COALESCE(SUM(u."costMicroUsd") FILTER (
          WHERE starts_with(t."quotaScopeId", ${TRIAL_SCOPE_PREFIX})
        ), 0)::bigint AS "trialCost"
      FROM "AiUsage" u
      LEFT JOIN "AgentTurn" t ON t.id = u."turnId"
      WHERE u."createdAt" >= ${utc(previous.from)} AND u."createdAt" < ${utc(to)}
      GROUP BY 1
    `);

    // 2. Zakresy subskrypcji z turą albo kosztem w okresie. Tury liczymy po
    // `AgentTurn.createdAt`, koszt po `AiUsage.createdAt` (jak dzień po dniu);
    // dom ostatniej tury to zapasowy „dom płatnika”, gdy konta płatnika już nie
    // ma albo nie ma ono domu.
    const scopeRows = await tx.$queryRaw<ScopeRow[]>(Prisma.sql`
      WITH turns AS (
        SELECT
          t."quotaScopeId" AS scope,
          COUNT(*)::int AS turns,
          (array_agg(c."householdId" ORDER BY t."createdAt" DESC))[1] AS "householdId"
        FROM "AgentTurn" t
        JOIN "AgentConversation" c ON c.id = t."conversationId"
        WHERE starts_with(t."quotaScopeId", ${SUBSCRIPTION_SCOPE_PREFIX})
          AND t."createdAt" >= ${utc(from)} AND t."createdAt" < ${utc(to)}
        GROUP BY t."quotaScopeId"
      ), costs AS (
        SELECT t."quotaScopeId" AS scope, SUM(u."costMicroUsd")::bigint AS cost
        FROM "AiUsage" u
        JOIN "AgentTurn" t ON t.id = u."turnId"
        WHERE starts_with(t."quotaScopeId", ${SUBSCRIPTION_SCOPE_PREFIX})
          AND u."createdAt" >= ${utc(from)} AND u."createdAt" < ${utc(to)}
        GROUP BY t."quotaScopeId"
      )
      SELECT
        COALESCE(turns.scope, costs.scope) AS scope,
        COALESCE(turns.turns, 0)::int AS turns,
        COALESCE(costs.cost, 0)::bigint AS cost,
        turns."householdId"::text AS "householdId"
      FROM turns
      FULL OUTER JOIN costs ON costs.scope = turns.scope
    `);

    // 3. Czas tury (p50/p95 z tur zakończonych) i liczba prób z turą. p50/p95
    // jako `percentile_disc`, czyli ta sama definicja (najbliższa pozycja), co
    // `percentile` w `pnpm agent:report:usage`.
    const [stats] = await tx.$queryRaw<TurnStatsRow[]>(Prisma.sql`
      SELECT
        percentile_disc(0.5) WITHIN GROUP (ORDER BY t."durationMs")
          FILTER (WHERE t.status <> 'RUNNING' AND t."durationMs" IS NOT NULL) AS p50,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY t."durationMs")
          FILTER (WHERE t.status <> 'RUNNING' AND t."durationMs" IS NOT NULL) AS p95,
        COUNT(DISTINCT t."quotaScopeId") FILTER (
          WHERE starts_with(t."quotaScopeId", ${TRIAL_SCOPE_PREFIX})
        )::int AS trials
      FROM "AgentTurn" t
      WHERE t."createdAt" >= ${utc(from)} AND t."createdAt" < ${utc(to)}
    `);

    // 4. Histogram czasu tury — `width_bucket` z tymi samymi progami, co
    // etykiety kubełków (`turnBucketIndex` w profit-math).
    const buckets = await tx.$queryRaw<BucketRow[]>(Prisma.sql`
      SELECT
        width_bucket(t."durationMs", ARRAY[${Prisma.join([...TURN_BUCKET_THRESHOLDS_MS])}]::int[]) AS bucket,
        COUNT(*)::int AS count
      FROM "AgentTurn" t
      WHERE t."createdAt" >= ${utc(from)} AND t."createdAt" < ${utc(to)}
        AND t.status <> 'RUNNING' AND t."durationMs" IS NOT NULL
      GROUP BY 1
    `);

    // 5. Modele z księgi: tura z przekazaniem pałeczki liczy się przy obu
    // modelach (każdy wydał na niej pieniądze); wiersze bez tury wchodzą do
    // kosztu, ale nie do liczby tur.
    const models = await tx.$queryRaw<ModelRow[]>(Prisma.sql`
      SELECT
        u.model AS model,
        COUNT(DISTINCT u."turnId")::int AS turns,
        COALESCE(SUM(u."costMicroUsd"), 0)::bigint AS cost
      FROM "AiUsage" u
      WHERE u."createdAt" >= ${utc(from)} AND u."createdAt" < ${utc(to)}
      GROUP BY u.model
      ORDER BY cost DESC, model ASC
    `);

    // 6–7. Kody błędów tur i propozycje wg statusu.
    const errors = await tx.agentTurn.groupBy({
      by: ['errorCode'],
      where: { createdAt: { gte: from, lt: to }, errorCode: { not: null } },
      _count: { _all: true },
    });
    const proposals = await tx.agentProposal.groupBy({
      by: ['status'],
      where: { createdAt: { gte: from, lt: to } },
      _count: { _all: true },
    });

    // 8. Subskrypcje: te, które niosą przychód w którymkolwiek z dwóch okien
    // (Apple, produkcja, opłacony okres zachodzi na okno), oraz te, których
    // pule pracowały w okresie (także sandbox i Chmura Rodzinna — przychodu
    // 0, ale koszt prawdziwy).
    const scopeSubscriptionIds = scopeRows
      .map((row) => row.scope.slice(SUBSCRIPTION_SCOPE_PREFIX.length))
      .filter((id) => isUuid(id));
    const subscriptions = await tx.subscription.findMany({
      where: {
        OR: [
          ...(scopeSubscriptionIds.length > 0
            ? [{ id: { in: scopeSubscriptionIds } }]
            : []),
          {
            provider: 'APPLE',
            environment: 'Production',
            createdAt: { lt: to },
            expiresAt: { gt: previous.from },
          },
        ],
      },
      select: {
        id: true,
        provider: true,
        productId: true,
        environment: true,
        ownershipType: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        operatorHoldAt: true,
        purchaserUserId: true,
      },
    });

    // Przychód dzień po dniu — z każdej subskrypcji osobno, żeby wiersz
    // zakresu dostał swoją część okresu.
    const revenueNow = current.days.map(() => 0);
    const revenueBefore = previous.days.map(() => 0);
    const revenueBySubscription = new Map<string, number>();
    for (const subscription of subscriptions) {
      const inPeriod = revenueByDay(subscription, current.days);
      const before = revenueByDay(subscription, previous.days);
      inPeriod.forEach((value, index) => (revenueNow[index] += value));
      before.forEach((value, index) => (revenueBefore[index] += value));
      const total = inPeriod.reduce((sum, value) => sum + value, 0);
      if (total > 0) revenueBySubscription.set(subscription.id, total);
    }

    // Zakresy do wierszy: z pracą w okresie + opłacające się bez pracy
    // (czysty zysk też jest informacją — „pod kreską” widać wtedy wszystkich).
    const usageByScope = new Map(scopeRows.map((row) => [row.scope, row]));
    for (const subscriptionId of revenueBySubscription.keys()) {
      const scope = `${SUBSCRIPTION_SCOPE_PREFIX}${subscriptionId}`;
      if (!usageByScope.has(scope)) {
        usageByScope.set(scope, {
          scope,
          turns: 0,
          cost: 0n,
          householdId: null,
        });
      }
    }

    // 9–10. Dom płatnika (osoba należy najwyżej do jednego domu — pilnuje
    // `HouseholdsService`) i domy zapasowe z ostatniej tury zakresu.
    const subscriptionsById = new Map(
      subscriptions.map((subscription) => [subscription.id, subscription]),
    );
    const purchaserIds = [
      ...new Set(
        subscriptions
          .map((subscription) => subscription.purchaserUserId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const memberships =
      purchaserIds.length > 0
        ? await tx.membership.findMany({
            where: { userId: { in: purchaserIds } },
            orderBy: { createdAt: 'desc' },
            select: {
              userId: true,
              household: { select: { id: true, name: true } },
            },
          })
        : [];
    const householdOfPurchaser = new Map<
      string,
      { id: string; name: string }
    >();
    for (const membership of memberships) {
      if (!householdOfPurchaser.has(membership.userId)) {
        householdOfPurchaser.set(membership.userId, membership.household);
      }
    }
    const fallbackIds = [
      ...new Set(
        scopeRows
          .map((row) => row.householdId)
          .filter((id): id is string => id !== null && isUuid(id)),
      ),
    ];
    const fallbackHouseholds =
      fallbackIds.length > 0
        ? await tx.household.findMany({
            where: { id: { in: fallbackIds } },
            select: { id: true, name: true },
          })
        : [];
    const householdsById = new Map(
      fallbackHouseholds.map((household) => [household.id, household]),
    );

    const rows: ProfitRow[] = [];
    for (const usage of usageByScope.values()) {
      const subscription = subscriptionsById.get(
        usage.scope.slice(SUBSCRIPTION_SCOPE_PREFIX.length),
      );
      // Zakres bez wiersza subskrypcji albo z SKU spoza kontraktu panelu nie
      // ma produktu, który front umie narysować (`PlanBadge`) — pomijamy go,
      // koszt i tak jest w „dzień po dniu” i w modelach.
      if (!subscription || !isContractProductId(subscription.productId)) {
        continue;
      }
      const household =
        (subscription.purchaserUserId
          ? householdOfPurchaser.get(subscription.purchaserUserId)
          : undefined) ??
        (usage.householdId ? householdsById.get(usage.householdId) : undefined);
      rows.push({
        scopeId: usage.scope,
        // Konto płatnika skasowane i żadnej tury w okresie: nie ma domu do
        // pokazania — pusty identyfikator i kreska zamiast wymyślonej nazwy.
        householdId: household?.id ?? '',
        householdName: household?.name ?? '—',
        productId: subscription.productId,
        revenueZl: roundTo(revenueBySubscription.get(subscription.id) ?? 0, 2),
        costUsd: usdOf(Number(usage.cost)),
        turns: usage.turns,
      });
    }
    rows.sort(
      (a, b) => b.costUsd - a.costUsd || a.scopeId.localeCompare(b.scopeId),
    );

    const costByDay = new Map(
      dailyCost.map((row) => [
        row.day,
        { cost: Number(row.cost), trialCost: Number(row.trialCost) },
      ]),
    );
    const costOf = (window: ProfitWindow): number =>
      usdOf(
        window.days.reduce(
          (sum, day) => sum + (costByDay.get(day.key)?.cost ?? 0),
          0,
        ),
      );
    const sum = (values: number[]): number =>
      values.reduce((total, value) => total + value, 0);
    const revenueCurrent = sum(revenueNow);
    const revenuePrevious = sum(revenueBefore);

    return {
      fxUsdPln: REFERENCE_USD_PLN,
      revenueTrend: trendPct(revenueCurrent, revenuePrevious),
      marginTrendPp: marginTrendPp(
        { revenueZl: revenueCurrent, costUsd: costOf(current) },
        { revenueZl: revenuePrevious, costUsd: costOf(previous) },
        REFERENCE_USD_PLN,
      ),
      trials: stats?.trials ?? 0,
      days: current.days.map((day, index) => ({
        date: day.start.toISOString(),
        revenueZl: roundTo(revenueNow[index], 2),
        costUsd: usdOf(costByDay.get(day.key)?.cost ?? 0),
        trialCostUsd: usdOf(costByDay.get(day.key)?.trialCost ?? 0),
      })),
      rows,
      proposals: proposalCounts(
        proposals.map((row) => ({
          status: row.status,
          count: row._count._all,
        })),
      ),
      turnHistogram: turnHistogram(
        new Map(buckets.map((row) => [row.bucket, row.count])),
      ),
      p50: secondsOf(stats?.p50),
      p95: secondsOf(stats?.p95),
      models: models.map((row) => ({
        model: row.model,
        turns: row.turns,
        costUsd: usdOf(Number(row.cost)),
      })),
      errors: errors
        .filter((row): row is typeof row & { errorCode: string } =>
          Boolean(row.errorCode),
        )
        .map((row) => ({ code: row.errorCode, count: row._count._all }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    };
  }
}
