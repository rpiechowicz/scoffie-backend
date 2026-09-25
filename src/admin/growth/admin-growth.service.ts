import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { catalogOwnerUserId } from '../../common/catalog-owner';
import { PrismaService } from '../../prisma/prisma.service';
import type { ActiveDay, GrowthData, GrowthPeriod } from '../contract';
import { readOnlyQuery } from '../read-only-query';
import { MRR_ENVIRONMENT } from '../users/admin-metrics';
import {
  addDays,
  mondayOf,
  sqlInstant,
  warsawDateKey,
  warsawDayStart,
  warsawDays,
} from '../common/warsaw-calendar';
import {
  ACTIVE_DAYS,
  COHORT_OFFSETS,
  cohortMatrix,
  cohortWeekKeys,
  funnelSteps,
  type CohortRow,
  type FunnelRow,
} from './growth-math';

/** Migracja, która założyła `UserActivityDay` — jej wdrożenie to początek zbierania. */
export const ACTIVITY_MIGRATION = '20260925173000_user_activity_day';

type ActiveRow = { day: string; dau: number; wau: number; mau: number };

/**
 * `GET /admin/growth` — lejek, kohorty i DAU/WAU/MAU (ROADMAPA §5.8).
 *
 * Trzy zapytania w transakcji tylko do odczytu. Konto bota katalogu nie
 * jest osobą — wypada z każdego z nich. Arytmetyka (lejek sekwencyjny,
 * procenty, mediany, puste komórki kohort) w `growth-math.ts`.
 */
@Injectable()
export class AdminGrowthService {
  constructor(private readonly prisma: PrismaService) {}

  growth(period: GrowthPeriod, now: Date = new Date()): Promise<GrowthData> {
    const todayKey = warsawDateKey(now);
    return readOnlyQuery(this.prisma, async (tx) => {
      const since = await this.activitySince(tx);
      const sinceKey = since ? warsawDateKey(since) : null;
      const funnel = funnelSteps(await this.funnelRows(tx, period, now));
      const weekKeys = cohortWeekKeys(
        mondayOf(todayKey).toISOString().slice(0, 10),
      );
      const cohorts = cohortMatrix(
        weekKeys,
        await this.cohortRows(tx, weekKeys[0]),
        todayKey,
        sinceKey,
      );
      const active = await this.activeDays(tx, todayKey);
      return {
        period,
        funnel,
        cohorts,
        active,
        activitySince: since ? since.toISOString() : null,
      };
    });
  }

  /**
   * Chwila wdrożenia tabeli aktywności. Z `_prisma_migrations`, nie z
   * najstarszego wiersza: backfill wstawił doby rejestracji wstecz, więc
   * najstarszy wiersz kłamałby, że zbieramy od początku. Najstarszy wiersz
   * tylko jako zapas (baza bez historii migracji).
   */
  private async activitySince(
    tx: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const [row] = await tx.$queryRaw<{ since: Date | null }[]>`
      SELECT COALESCE(
        (SELECT "finished_at" FROM "_prisma_migrations"
          WHERE "migration_name" = ${ACTIVITY_MIGRATION}
            AND "finished_at" IS NOT NULL
          LIMIT 1),
        (SELECT MIN("date")::timestamptz FROM "UserActivityDay")
      ) AS "since"`;
    return row?.since ?? null;
  }

  /**
   * Osoby zarejestrowane w ostatnich `period` dobach (od północy w Warszawie)
   * z chwilą pierwszego wejścia na każdy krok. Podzapytania skalarne po
   * indeksach (`Membership` unikat userId+householdId, `WeeklyPlan` unikat
   * householdId+weekStart, `ConsentEvent` userId+kind+createdAt, `AgentTurn`
   * userId+createdAt, `Subscription` identityHash / purchaserUserId).
   *
   * Plan: pierwsze danie w domu osoby dodane PO jej dołączeniu (dom
   * z gotowym planem to nie jej pierwszy plan). Zakup: subskrypcja App
   * Store z produkcji na hasz tożsamości albo z osobą jako kupującym.
   */
  private async funnelRows(
    tx: Prisma.TransactionClient,
    period: GrowthPeriod,
    now: Date,
  ): Promise<FunnelRow[]> {
    const from = warsawDays(now, Number(period))[0].start;
    return tx.$queryRaw<FunnelRow[]>`
      SELECT
        u."createdAt" AS "registered",
        u."onboardingCompletedAt" AS "onboarded",
        (SELECT MIN(m."createdAt") FROM "Membership" m
          WHERE m."userId" = u."id") AS "household",
        (SELECT MIN(pi."createdAt")
           FROM "Membership" m
           JOIN "WeeklyPlan" wp ON wp."householdId" = m."householdId"
           JOIN "PlanItem" pi ON pi."weeklyPlanId" = wp."id"
          WHERE m."userId" = u."id" AND pi."createdAt" >= m."createdAt") AS "plan",
        (SELECT MIN(ce."createdAt") FROM "ConsentEvent" ce
          WHERE ce."userId" = u."id" AND ce."kind" = 'AI_ASSISTANT'
            AND ce."action" = 'GRANTED') AS "aiConsent",
        (SELECT MIN(t."createdAt") FROM "AgentTurn" t
          WHERE t."userId" = u."id") AS "firstTurn",
        (SELECT MIN(s."createdAt") FROM "Subscription" s
          WHERE s."provider" = 'APPLE' AND s."environment" = ${MRR_ENVIRONMENT}
            AND (s."purchaserUserId" = u."id"
                 OR (u."identityHash" IS NOT NULL
                     AND s."identityHash" = u."identityHash"))) AS "purchase"
      FROM "User" u
      WHERE u."createdAt" >= ${sqlInstant(from)}
        AND u."createdAt" <= ${sqlInstant(now)}
        AND u."id" <> ${catalogOwnerUserId()}::uuid`;
  }

  /**
   * Rozmiar kohort i aktywni w tygodniach 0..8 jednym zapytaniem. Tydzień
   * rejestracji liczony raz w CTE (`date_trunc('week')` = poniedziałek)
   * z doby warszawskiej; aktywność po kluczu głównym (userId, date).
   */
  private cohortRows(
    tx: Prisma.TransactionClient,
    firstWeekKey: string,
  ): Promise<CohortRow[]> {
    const span = COHORT_OFFSETS * 7;
    return tx.$queryRaw<CohortRow[]>`
      WITH cohort AS (
        SELECT u."id",
               date_trunc('week',
                 (u."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw')::date AS "week"
          FROM "User" u
         WHERE u."createdAt" >= ${sqlInstant(warsawDayStart(firstWeekKey))}
           AND u."id" <> ${catalogOwnerUserId()}::uuid
      )
      SELECT to_char(c."week", 'YYYY-MM-DD') AS "week",
             NULL::int AS "offset",
             COUNT(*)::int AS "users"
        FROM cohort c
       GROUP BY c."week"
      UNION ALL
      SELECT to_char(x."week", 'YYYY-MM-DD'), x."offset", COUNT(DISTINCT x."id")::int
        FROM (
          SELECT c."week", c."id", ((a."date" - c."week") / 7)::int AS "offset"
            FROM cohort c
            JOIN "UserActivityDay" a
              ON a."userId" = c."id"
             AND a."date" >= c."week"
             AND a."date" < c."week" + ${span}::int
        ) x
       GROUP BY x."week", x."offset"`;
  }

  /**
   * DAU/WAU/MAU z ostatnich 30 dób: dla każdej doby osoby aktywne tego dnia,
   * w 7 i w 30 dobach do niej włącznie (okno kroczące). Zakres po indeksie
   * `UserActivityDay(date)`.
   */
  private async activeDays(
    tx: Prisma.TransactionClient,
    todayKey: string,
  ): Promise<ActiveDay[]> {
    const fromKey = addDays(todayKey, -(ACTIVE_DAYS - 1));
    const bot = catalogOwnerUserId();
    const rows = await tx.$queryRaw<ActiveRow[]>`
      WITH days AS (
        SELECT g::date AS "day"
          FROM generate_series(${fromKey}::date, ${todayKey}::date, interval '1 day') g
      )
      SELECT to_char(d."day", 'YYYY-MM-DD') AS "day",
        (SELECT COUNT(*) FROM "UserActivityDay" a
          WHERE a."date" = d."day" AND a."userId" <> ${bot}::uuid)::int AS "dau",
        (SELECT COUNT(DISTINCT a."userId") FROM "UserActivityDay" a
          WHERE a."date" BETWEEN d."day" - 6 AND d."day"
            AND a."userId" <> ${bot}::uuid)::int AS "wau",
        (SELECT COUNT(DISTINCT a."userId") FROM "UserActivityDay" a
          WHERE a."date" BETWEEN d."day" - 29 AND d."day"
            AND a."userId" <> ${bot}::uuid)::int AS "mau"
      FROM days d
      ORDER BY d."day"`;
    return rows.map((row) => ({
      date: warsawDayStart(row.day).toISOString(),
      dau: row.dau,
      wau: row.wau,
      mau: row.mau,
    }));
  }
}
