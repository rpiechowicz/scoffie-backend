import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  catalogHouseholdId,
  catalogOwnerUserId,
} from '../../common/catalog-owner';
import { WsTelemetryService } from '../../common/ws-telemetry.service';
import { RequestMetricsService } from '../../observability/request-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  DashboardData,
  DayStat,
  MealType,
  Production,
  TopRecipe,
} from '../contract';
import { readOnlyQuery } from '../read-only-query';
import {
  MRR_ENVIRONMENT,
  endOfDayPoints,
  kcalPerServing,
  subscriptionSeries,
  trendOfSeries,
  type SubscriptionHistoryRow,
} from './admin-metrics';
import {
  daysBefore,
  sqlInstant,
  sqlWarsawDay,
  warsawDays,
  warsawWeekStart,
  type PanelDay,
} from './warsaw-time';

/** Wykres aktywności: 30 dób do dziś włącznie. */
export const DASHBOARD_DAYS = 30;
/** Iskierki MRR i subskrypcji: 14 dób, ostatni punkt = teraz. */
export const SPARK_DAYS = 14;
export const TOP_RECIPES = 8;

/** Tury, które nie skończyły się odpowiedzią (LIMITED = budżet uciął w trakcie). */
const FAILED_TURN_STATUSES = ['FAILED', 'LIMITED'];

type SeriesRow = {
  metric: 'newUsers' | 'turns' | 'planItems' | 'aiCostMicroUsd';
  day: string;
  value: number;
};

type Counters = {
  loggedInToday: number;
  households: number;
  plannedHouseholds: number;
  turnsDone: number;
  turnsFailed: number;
  turnsRunning: number;
  reports: number;
  mailsFailed: number;
  subsInGrace: number;
  appleUnprocessed: number;
  cookidooFailed: number;
  tokenReuse24h: number;
};

type TopRecipeRow = {
  id: string;
  title: string;
  imageUrl: string | null;
  mealType: MealType;
  nutritionKcal: number;
  servings: number;
  prepTimeMinutes: number;
  plans: number;
};

/**
 * `GET /admin/dashboard` — pulpit „jedno spojrzenie rano" (ROADMAPA §5.1).
 *
 * Pięć zapytań w jednej transakcji tylko do odczytu: serie dzienne (jedno
 * `GROUP BY` doby na metrykę, sklejone `UNION ALL`), liczniki (podzapytania
 * skalarne), subskrypcje do odtworzenia MRR, najczęstsze przepisy tygodnia
 * i stan migracji. Metryki procesu (żądania, sockety) z pamięci.
 *
 * Konto bota katalogu i jego gospodarstwo są techniczne — nie liczą się
 * ani do osób, ani do domów.
 */
@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestMetrics: RequestMetricsService,
    private readonly wsTelemetry: WsTelemetryService,
  ) {}

  dashboard(): Promise<DashboardData> {
    const now = new Date();
    const days = warsawDays(now, DASHBOARD_DAYS);
    const today = days[days.length - 1];
    const sparkPoints = endOfDayPoints(days.slice(-SPARK_DAYS), now);
    const weekStart = warsawWeekStart(now);

    return readOnlyQuery(this.prisma, async (tx) => {
      const series = await this.dailySeries(tx, days);
      const counters = await this.counters(tx, now, today.start, weekStart);
      const subscriptions = await this.subscriptionHistory(
        tx,
        now,
        sparkPoints[0],
      );
      const topRecipes = await this.topRecipes(tx, weekStart);
      const migrations = await this.migrations(tx);

      const { counts, mrrZl } = subscriptionSeries(subscriptions, sparkPoints);
      const todayStat = series[series.length - 1];

      return {
        loggedInToday: counters.loggedInToday,
        // `lastLoginAt` trzyma wyłącznie OSTATNIE logowanie: kto logował się
        // wczoraj i dziś, wczoraj już „nie istnieje". Wczorajszej liczby nie
        // da się rzetelnie odtworzyć, więc trendu nie zmyślamy — 0 i bez
        // `d7`, dopóki nie powstanie dzienna tabela aktywności
        // (`UserActivityDay`, ROADMAPA §6). Rodziny refresh tokenów też jej
        // nie zastąpią: ratunek zgubionej rotacji zakłada rodzinę tak samo
        // jak logowanie.
        loggedInTrend: { d1: 0 },
        today: {
          newUsers: todayStat.newUsers,
          turns: todayStat.turns,
          planItems: todayStat.planItems,
          aiCostUsd: todayStat.aiCostUsd,
        },
        turnsToday: {
          done: counters.turnsDone,
          failed: counters.turnsFailed,
          running: counters.turnsRunning,
        },
        mrrZl: mrrZl[mrrZl.length - 1],
        mrrTrend: trendOfSeries(mrrZl),
        mrrSpark: mrrZl,
        activeSubs: counts[counts.length - 1],
        subsTrend: trendOfSeries(counts),
        subsSpark: counts,
        plannedHouseholds: counters.plannedHouseholds,
        households: counters.households,
        days: series,
        topRecipes,
        attention: {
          reports: counters.reports,
          mailsFailed: counters.mailsFailed,
          subsInGrace: counters.subsInGrace,
          appleUnprocessed: counters.appleUnprocessed,
          cookidooFailed: counters.cookidooFailed,
          tokenReuse24h: counters.tokenReuse24h,
        },
        production: this.production(migrations),
      };
    });
  }

  /**
   * Cztery serie dzienne jednym zapytaniem: każda to `GROUP BY` doby
   * warszawskiej (grupowanie po numerze kolumny, bo strefa jest parametrem,
   * a dwa różne parametry to dla Postgresa dwa różne wyrażenia).
   */
  private async dailySeries(
    tx: Prisma.TransactionClient,
    days: PanelDay[],
  ): Promise<DayStat[]> {
    const from = sqlInstant(days[0].start);
    const day = sqlWarsawDay(Prisma.sql`"createdAt"`);
    const rows = await tx.$queryRaw<SeriesRow[]>`
      SELECT 'newUsers' AS "metric", ${day} AS "day", COUNT(*)::float8 AS "value"
        FROM "User"
        WHERE "createdAt" >= ${from} AND "id" <> ${catalogOwnerUserId()}::uuid
        GROUP BY 2
      UNION ALL
      SELECT 'turns', ${day}, COUNT(*)::float8
        FROM "AgentTurn" WHERE "createdAt" >= ${from} GROUP BY 2
      UNION ALL
      SELECT 'planItems', ${day}, COUNT(*)::float8
        FROM "PlanItem" WHERE "createdAt" >= ${from} GROUP BY 2
      UNION ALL
      SELECT 'aiCostMicroUsd', ${day}, COALESCE(SUM("costMicroUsd"), 0)::float8
        FROM "AiUsage" WHERE "createdAt" >= ${from} GROUP BY 2`;

    const byDay = new Map<string, Map<SeriesRow['metric'], number>>();
    for (const row of rows) {
      const metrics =
        byDay.get(row.day) ?? new Map<SeriesRow['metric'], number>();
      metrics.set(row.metric, row.value);
      byDay.set(row.day, metrics);
    }
    return days.map((panelDay) => {
      const metrics = byDay.get(panelDay.key);
      return {
        date: panelDay.start.toISOString(),
        newUsers: metrics?.get('newUsers') ?? 0,
        turns: metrics?.get('turns') ?? 0,
        planItems: metrics?.get('planItems') ?? 0,
        aiCostUsd: (metrics?.get('aiCostMicroUsd') ?? 0) / 1e6,
      };
    });
  }

  private async counters(
    tx: Prisma.TransactionClient,
    now: Date,
    todayStart: Date,
    weekStart: Date,
  ): Promise<Counters> {
    const today = sqlInstant(todayStart);
    const catalogHousehold = catalogHouseholdId();
    const [row] = await tx.$queryRaw<Counters[]>`
      SELECT
        (SELECT COUNT(*) FROM "User"
          WHERE "id" <> ${catalogOwnerUserId()}::uuid
            AND "lastLoginAt" >= ${today})::int AS "loggedInToday",
        (SELECT COUNT(*) FROM "Household"
          WHERE "id" <> ${catalogHousehold}::uuid)::int AS "households",
        -- Plan „na ten tydzień" = wiersz tygodnia, który ma choć jedno danie;
        -- pusty wiersz zostaje po wyczyszczeniu planu i nie jest planem.
        (SELECT COUNT(*) FROM "WeeklyPlan" wp
          WHERE wp."weekStart" = ${sqlInstant(weekStart)}
            AND wp."householdId" <> ${catalogHousehold}::uuid
            AND EXISTS (SELECT 1 FROM "PlanItem" pi
                        WHERE pi."weeklyPlanId" = wp."id"))::int AS "plannedHouseholds",
        (SELECT COUNT(*) FROM "AgentTurn"
          WHERE "createdAt" >= ${today} AND "status" = 'DONE')::int AS "turnsDone",
        (SELECT COUNT(*) FROM "AgentTurn"
          WHERE "createdAt" >= ${today}
            AND "status" = ANY(${FAILED_TURN_STATUSES}::text[]))::int AS "turnsFailed",
        (SELECT COUNT(*) FROM "AgentTurn"
          WHERE "createdAt" >= ${today} AND "status" = 'RUNNING')::int AS "turnsRunning",
        (SELECT COUNT(*) FROM "AgentReport"
          WHERE "status" = 'NEW'
            AND "createdAt" >= ${sqlInstant(daysBefore(now, 7))})::int AS "reports",
        (SELECT COUNT(*) FROM "MailMessage" WHERE "status" = 'FAILED')::int AS "mailsFailed",
        (SELECT COUNT(*) FROM "Subscription" WHERE "status" = 'GRACE')::int AS "subsInGrace",
        (SELECT COUNT(*) FROM "AppleNotification"
          WHERE "processedAt" IS NULL)::int AS "appleUnprocessed",
        (SELECT COUNT(*) FROM "CookidooIntegration"
          WHERE "status" = 'AUTH_FAILED')::int AS "cookidooFailed",
        -- OSOBY, nie wiersze: jedno wykrycie kopii przepisuje powód na całej
        -- rodzinie (także starych, zrotowanych tokenów), więc jeden incydent
        -- to często kilka wierszy REUSE.
        (SELECT COUNT(DISTINCT "userId") FROM "RefreshToken"
          WHERE "revokedReason" = 'REUSE'
            AND "revokedAt" >= ${sqlInstant(daysBefore(now, 1))})::int AS "tokenReuse24h"`;
    return row;
  }

  /**
   * Wiersze, które mogły być opłacone w którymkolwiek punkcie iskierki:
   * żywe teraz albo zmienione po pierwszym punkcie (martwy wiersz nie żył po
   * swoim ostatnim zapisie — patrz `paidAt`). Tylko Production: sandbox to
   * testy, nie przychód.
   */
  private subscriptionHistory(
    tx: Prisma.TransactionClient,
    now: Date,
    firstPoint: Date,
  ): Promise<SubscriptionHistoryRow[]> {
    return tx.subscription.findMany({
      where: {
        environment: MRR_ENVIRONMENT,
        createdAt: { lte: now },
        OR: [
          { status: { in: ['ACTIVE', 'GRACE'] } },
          { updatedAt: { gt: firstPoint } },
        ],
      },
      select: {
        productId: true,
        status: true,
        environment: true,
        expiresAt: true,
        graceExpiresAt: true,
        neverExpires: true,
        revokedAt: true,
        operatorHoldAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /** Przepisy KATALOGU najczęściej wstawiane do planów bieżącego tygodnia. */
  private async topRecipes(
    tx: Prisma.TransactionClient,
    weekStart: Date,
  ): Promise<TopRecipe[]> {
    const rows = await tx.$queryRaw<TopRecipeRow[]>`
      SELECT r."id", r."title", r."imageUrl", r."mealType"::text AS "mealType",
             r."nutritionKcal", r."servings", r."prepTimeMinutes",
             COUNT(*)::int AS "plans"
      FROM "PlanItem" pi
      JOIN "WeeklyPlan" wp ON wp."id" = pi."weeklyPlanId"
      JOIN "Recipe" r ON r."id" = pi."recipeId"
      WHERE wp."weekStart" = ${sqlInstant(weekStart)} AND r."isCatalog" = true
      GROUP BY r."id"
      ORDER BY "plans" DESC, r."title" ASC, r."id" ASC
      LIMIT ${TOP_RECIPES}::int`;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      imageUrl: row.imageUrl ?? '',
      mealType: row.mealType,
      kcalPerServing: kcalPerServing(row.nutritionKcal, row.servings),
      prepTimeMinutes: row.prepTimeMinutes,
      plans: row.plans,
    }));
  }

  /**
   * Stan migracji z tabeli Prismy — jak `OpsController.migrationsSnapshot`:
   * tylko ona wie, co NAPRAWDĘ weszło do bazy.
   */
  private async migrations(
    tx: Prisma.TransactionClient,
  ): Promise<Production['migrations']> {
    const [row] = await tx.$queryRaw<
      { applied: number; latest: string | null }[]
    >`
      SELECT COUNT(*)::int AS "applied",
             (SELECT "migration_name" FROM "_prisma_migrations"
               WHERE "finished_at" IS NOT NULL
               ORDER BY "finished_at" DESC LIMIT 1) AS "latest"
      FROM "_prisma_migrations"
      WHERE "finished_at" IS NOT NULL`;
    return { applied: row?.applied ?? 0, latest: row?.latest ?? '' };
  }

  private production(migrations: Production['migrations']): Production {
    const http = this.requestMetrics.snapshot();
    const ws = this.wsTelemetry.snapshot();
    return {
      // Jak `/ops/health`: siedem znaków wystarcza na „czy prod ma już tę
      // poprawkę" i nie mówi nic więcej.
      commit: (
        process.env.APP_COMMIT ??
        process.env.RAILWAY_GIT_COMMIT_SHA ??
        'unknown'
      ).slice(0, 7),
      uptimeSeconds: Math.floor(process.uptime()),
      requests: http.totals.requests,
      errors5xx: http.totals.errors5xx,
      migrations,
      // Pięć gatewayów dzieli JEDEN serwer Socket.IO, więc każdy z nich widzi
      // każde połączenie — suma liczyłaby jeden telefon pięć razy. Liczba
      // połączonych to stan jednego gatewaya (bierzemy najwyższy).
      ws: {
        connected: Math.max(
          0,
          ...ws.gateways.map((gateway) => gateway.activeConnections),
        ),
      },
    };
  }
}
