import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthService } from '../../auth/auth.service';
import { AppException } from '../../common/app-exception';
import { catalogOwnerUserId } from '../../common/catalog-owner';
import { MINIMUM_CONSENT_VERSIONS } from '../../common/legal-documents';
import { DataExportService } from '../../data-export/data-export.service';
import type { UserExport } from '../../data-export/user-export';
import { ApnsService } from '../../notifications/apns.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../../users/users.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import type {
  ConsentEvent,
  ConsentKind,
  HealthData,
  Mail,
  MailTemplate,
  ProductId,
  PushDevice,
  Subscription,
  UserDetail,
  UserList,
} from '../contract';
import { readOnlyQuery } from '../read-only-query';
import { loadLiveSubscriptions, payingUserIds } from './admin-plans';
import {
  sqlFoldedContains,
  sqlIdContains,
  normalizeQuery,
} from './admin-text-search';
import {
  USER_ROW_SELECT,
  buildUserListItems,
  type UserRow,
} from './admin-user-items';
import type { AdminUserListQueryDto } from './admin-users.dto';
import { refreshFamilies } from './refresh-families';
import {
  daysBefore,
  sqlInstant,
  sqlWarsawDay,
  warsawMonthDays,
} from './warsaw-time';

/** Sufit listy — panel filtruje i sortuje resztę po swojej stronie. */
export const USER_LIST_LIMIT = 1000;
/** Ile ostatnich maili pokazuje karta osoby. */
const MAIL_LIMIT = 20;
/** Odsłonięcie danych o zdrowiu trwa tyle (ROADMAPA §1.3). */
export const HEALTH_REVEAL_MS = 5 * 60_000;
const APPLE_RELAY_SUFFIX = '%@privaterelay.appleid.com';

/** Tury, które nie skończyły się odpowiedzią (LIMITED = budżet uciął w trakcie). */
const FAILED_TURN_STATUSES = ['FAILED', 'LIMITED'];

const CONSENT_KINDS: readonly ConsentKind[] = [
  'TERMS',
  'PRIVACY',
  'AI_ASSISTANT',
  'COOKIDOO',
  'AGE_16',
  'HEALTH_DATA',
];

export function userNotFound(): AppException {
  // `NOT_FOUND`, nie osobny `USER_NOT_FOUND`: takiego kodu nie ma w
  // `APP_ERROR_CODES` (lista z parytetem w iOS), a kasowanie konta i eksport
  // odpowiadają na brak osoby właśnie `NOT_FOUND`.
  return new AppException(
    'NOT_FOUND',
    'Nie ma takiego użytkownika.',
    HttpStatus.NOT_FOUND,
  );
}

/**
 * Użytkownicy w panelu: lista z przekrojem, karta osoby i akcje na koncie.
 *
 * Odczyty idą w `readOnlyQuery` (transakcja tylko do odczytu z limitem
 * czasu). Akcje — WYŁĄCZNIE przez serwisy domeny (`AuthService`,
 * `DataExportService`, `UsersService`) i każda przez dziennik audytu:
 * wylogowanie bierze zamek sesji, kasowanie konta rozlicza dom i kolejkuje
 * pożegnanie — tego panel nie ma prawa robić gołą Prismą (ROADMAPA §1.1).
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly auth: AuthService,
    private readonly dataExport: DataExportService,
    private readonly users: UsersService,
    private readonly apns: ApnsService,
  ) {}

  // ——— lista ———

  list(filters: AdminUserListQueryDto): Promise<UserList> {
    const now = new Date();
    return readOnlyQuery(this.prisma, async (tx) => {
      // Komplet żywych subskrypcji: filtr „płaci" i statystyka liczą się
      // na całej bazie, a plan domu i tak potrzebuje tych samych wierszy.
      const liveSubscriptions = await loadLiveSubscriptions(tx);
      const paying = payingUserIds(liveSubscriptions, now);
      const where = this.listWhere(filters, [...paying], now);

      const rows = await tx.$queryRaw<UserRow[]>`
        SELECT u."id", u."displayName", u."email", u."avatarColor",
               u."onboardingCompletedAt", u."lastLoginAt", u."createdAt"
        FROM "User" u
        WHERE ${where}
        ORDER BY u."lastLoginAt" DESC NULLS LAST, u."createdAt" DESC, u."id" ASC
        LIMIT ${USER_LIST_LIMIT}::int`;
      const [counted] = await tx.$queryRaw<{ total: number }[]>`
        SELECT COUNT(*)::int AS "total" FROM "User" u WHERE ${where}`;

      const { items } = await buildUserListItems(
        tx,
        rows,
        now,
        liveSubscriptions,
      );
      return {
        total: counted?.total ?? 0,
        items,
        stats: await this.stats(tx, paying, now),
      };
    });
  }

  /**
   * Warunki listy. Bot importu katalogu to konto techniczne (autor 500
   * przepisów), nie osoba — nie wchodzi ani do listy, ani do liczb.
   */
  private listWhere(
    filters: AdminUserListQueryDto,
    payingIds: string[],
    now: Date,
  ): Prisma.Sql {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`u."id" <> ${catalogOwnerUserId()}::uuid`,
    ];
    const q = normalizeQuery(filters.q);
    if (q) {
      conditions.push(
        Prisma.sql`(${sqlFoldedContains(Prisma.sql`u."displayName"`, q)}
          OR ${sqlFoldedContains(Prisma.sql`COALESCE(u."email", '')`, q)}
          OR ${sqlIdContains(Prisma.sql`u."id"`, q)})`,
      );
    }
    if (filters.onboarding !== undefined) {
      conditions.push(
        filters.onboarding
          ? Prisma.sql`u."onboardingCompletedAt" IS NOT NULL`
          : Prisma.sql`u."onboardingCompletedAt" IS NULL`,
      );
    }
    if (filters.active7 !== undefined) {
      const since = sqlInstant(daysBefore(now, 7));
      conditions.push(
        filters.active7
          ? Prisma.sql`u."lastLoginAt" >= ${since}`
          : Prisma.sql`(u."lastLoginAt" IS NULL OR u."lastLoginAt" < ${since})`,
      );
    }
    if (filters.noHousehold !== undefined) {
      const member = Prisma.sql`EXISTS (SELECT 1 FROM "Membership" m WHERE m."userId" = u."id")`;
      conditions.push(filters.noHousehold ? Prisma.sql`NOT ${member}` : member);
    }
    if (filters.subscribed !== undefined) {
      const paying = Prisma.sql`u."id" = ANY(${payingIds}::uuid[])`;
      conditions.push(
        filters.subscribed ? paying : Prisma.sql`NOT (${paying})`,
      );
    }
    return Prisma.join(conditions, ' AND ');
  }

  /** Przekrój CAŁEJ bazy — niezależny od filtrów listy. */
  private async stats(
    tx: Prisma.TransactionClient,
    paying: ReadonlySet<string>,
    now: Date,
  ): Promise<UserList['stats']> {
    const botId = catalogOwnerUserId();
    const [row] = await tx.$queryRaw<
      {
        total: number;
        hiddenEmail: number;
        onboarded: number;
        loggedIn7d: number;
        aiConsent: number;
      }[]
    >`
      SELECT
        COUNT(*)::int AS "total",
        COUNT(*) FILTER (WHERE lower(trim(u."email")) LIKE ${APPLE_RELAY_SUFFIX})::int AS "hiddenEmail",
        COUNT(*) FILTER (WHERE u."onboardingCompletedAt" IS NOT NULL)::int AS "onboarded",
        COUNT(*) FILTER (WHERE u."lastLoginAt" >= ${sqlInstant(daysBefore(now, 7))})::int AS "loggedIn7d",
        (
          -- Zgoda „aktualna" = ostatnie zdarzenie osoby to GRANTED w wersji nie
          -- starszej niż minimalna — ta sama reguła co ConsentsService.isGranted.
          SELECT COUNT(*)::int FROM (
            SELECT DISTINCT ON (c."userId") c."userId", c."action", c."documentVersion"
            FROM "ConsentEvent" c
            WHERE c."kind" = 'AI_ASSISTANT'
            ORDER BY c."userId", c."createdAt" DESC, c."id" DESC
          ) latest
          WHERE latest."action" = 'GRANTED'
            AND latest."documentVersion" >= ${MINIMUM_CONSENT_VERSIONS.AI_ASSISTANT}
            AND latest."userId" <> ${botId}::uuid
        ) AS "aiConsent"
      FROM "User" u
      WHERE u."id" <> ${botId}::uuid`;
    return {
      total: row?.total ?? 0,
      hiddenEmail: row?.hiddenEmail ?? 0,
      onboarded: row?.onboarded ?? 0,
      loggedIn7d: row?.loggedIn7d ?? 0,
      paying: [...paying].filter((userId) => userId !== botId).length,
      aiConsent: row?.aiConsent ?? 0,
    };
  }

  // ——— karta osoby ———

  detail(id: string): Promise<UserDetail> {
    const now = new Date();
    const month = warsawMonthDays(now);
    return readOnlyQuery(this.prisma, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id },
        select: {
          ...USER_ROW_SELECT,
          pushDevices: {
            orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
            select: {
              id: true,
              appBundleId: true,
              apnsEnvironment: true,
              isActive: true,
              createdAt: true,
              lastSeenAt: true,
            },
          },
          consentEvents: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              kind: true,
              action: true,
              documentVersion: true,
              appVersion: true,
              createdAt: true,
            },
          },
          mailMessages: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: MAIL_LIMIT,
            select: {
              id: true,
              template: true,
              status: true,
              attempts: true,
              lastError: true,
              sentAt: true,
              createdAt: true,
            },
          },
          dailySteps: {
            orderBy: [{ date: 'desc' }, { updatedAt: 'desc' }],
            take: 1,
            select: { source: true },
          },
          // „Kupiona przez tę osobę": nadania ręczne (MANUAL) nie mają
          // kupującego, więc tu ich nie ma — i słusznie, to nie zakup.
          subscriptions: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: {
              id: true,
              productId: true,
              status: true,
              environment: true,
              ownershipType: true,
              expiresAt: true,
              graceExpiresAt: true,
              autoRenewStatus: true,
              lastVerifiedAt: true,
              operatorHoldAt: true,
              createdAt: true,
            },
          },
          refreshTokens: {
            select: {
              id: true,
              tokenHash: true,
              replacedByHash: true,
              createdAt: true,
              expiresAt: true,
              revokedAt: true,
              revokedReason: true,
            },
          },
        },
      });
      if (!user) throw userNotFound();

      const { items, homes, households } = await buildUserListItems(
        tx,
        [user],
        now,
      );
      const home = homes.get(id);
      const household = home ? households.get(home.householdId) : undefined;

      return {
        ...items[0],
        householdMembers: household?.members.length ?? 0,
        assistant: await this.assistantMonth(tx, id, month),
        subscription: user.subscriptions[0]
          ? toSubscription(user.subscriptions[0])
          : null,
        pushDevices: user.pushDevices.map(
          (device): PushDevice => ({
            id: device.id,
            appBundleId: device.appBundleId,
            // Urządzenie, które nie powiedziało, z jakiego buildu jest, dostaje
            // środowisko domyślne — to samo, pod które NAPRAWDĘ idzie push.
            apnsEnvironment:
              device.apnsEnvironment === 'SANDBOX' ||
              device.apnsEnvironment === 'PRODUCTION'
                ? device.apnsEnvironment
                : this.apns.defaultEnvironment,
            isActive: device.isActive,
            createdAt: device.createdAt.toISOString(),
            lastSeenAt: device.lastSeenAt.toISOString(),
          }),
        ),
        sessions: refreshFamilies(user.refreshTokens, now),
        consents: user.consentEvents
          .filter((event) =>
            (CONSENT_KINDS as readonly string[]).includes(event.kind),
          )
          .map(
            (event): ConsentEvent => ({
              id: event.id,
              kind: event.kind as ConsentKind,
              action: event.action === 'REVOKED' ? 'REVOKED' : 'GRANTED',
              documentVersion: event.documentVersion,
              appVersion: event.appVersion,
              createdAt: event.createdAt.toISOString(),
            }),
          ),
        mails: user.mailMessages.map(
          (mail): Mail => ({
            id: mail.id,
            template: mail.template as MailTemplate,
            status: mail.status,
            attempts: mail.attempts,
            lastError: mail.lastError,
            sentAt: mail.sentAt?.toISOString() ?? null,
            createdAt: mail.createdAt.toISOString(),
          }),
        ),
        stepsSource: toStepsSource(user.dailySteps[0]?.source),
        memoryNotes: await tx.agentMemory.count({ where: { aboutUserId: id } }),
      };
    });
  }

  /**
   * Asystent w bieżącym miesiącu (Warszawa): jedno zapytanie na wszystko,
   * `daily` = tury doba po dobie od 1. dnia do dziś. Treści rozmów panel nie
   * czyta (ROADMAPA §1.4) — tylko liczby i czasy.
   */
  private async assistantMonth(
    tx: Prisma.TransactionClient,
    userId: string,
    month: ReturnType<typeof warsawMonthDays>,
  ): Promise<UserDetail['assistant']> {
    const since = sqlInstant(month[0].start);
    const [row] = await tx.$queryRaw<
      {
        turns: number;
        failed: number;
        avgMs: number | null;
        conversations: number;
        costMicroUsd: number;
        applied: number;
        daily: { day: string; turns: number }[] | null;
      }[]
    >`
      WITH t AS (
        SELECT "conversationId", "status", "durationMs",
               ${sqlWarsawDay(Prisma.sql`"createdAt"`)} AS "day"
        FROM "AgentTurn"
        WHERE "userId" = ${userId}::uuid AND "createdAt" >= ${since}
      )
      SELECT
        (SELECT COUNT(*) FROM t)::int AS "turns",
        (SELECT COUNT(*) FROM t WHERE "status" = ANY(${FAILED_TURN_STATUSES}::text[]))::int AS "failed",
        (SELECT AVG("durationMs") FROM t WHERE "durationMs" IS NOT NULL)::float8 AS "avgMs",
        (SELECT COUNT(DISTINCT "conversationId") FROM t)::int AS "conversations",
        (SELECT COALESCE(SUM("costMicroUsd"), 0) FROM "AiUsage"
          WHERE "userId" = ${userId}::uuid AND "createdAt" >= ${since})::float8 AS "costMicroUsd",
        (SELECT COUNT(*) FROM "AgentProposal"
          WHERE "userId" = ${userId}::uuid AND "status" = 'APPLIED'
            AND "appliedAt" >= ${since})::int AS "applied",
        (SELECT json_agg(json_build_object('day', d."day", 'turns', d."turns"))
          FROM (SELECT "day", COUNT(*)::int AS "turns" FROM t GROUP BY 1) d) AS "daily"`;

    const perDay = new Map(
      (row?.daily ?? []).map((entry) => [entry.day, entry.turns]),
    );
    return {
      turns: row?.turns ?? 0,
      failed: row?.failed ?? 0,
      costUsd: (row?.costMicroUsd ?? 0) / 1e6,
      avgTurnSeconds:
        row?.avgMs === null || row?.avgMs === undefined
          ? 0
          : Math.round(row.avgMs / 100) / 10,
      conversations: row?.conversations ?? 0,
      proposalsApplied: row?.applied ?? 0,
      daily: month.map((day) => perDay.get(day.key) ?? 0),
    };
  }

  // ——— akcje ———

  /**
   * „Odsłoń" (ROADMAPA §1.3): dane szczególnej kategorii dopiero z powodem,
   * a w dzienniku sam fakt i powód — NIGDY wartości. Odczyt bez zapisu:
   * brak wiersza preferencji to wartości domyślne ze schematu, dokładnie te,
   * które `UsersService.getPreferences` założyłby przy pierwszym odczycie.
   */
  revealHealth(
    actor: AdminActor,
    id: string,
    reason: string,
  ): Promise<HealthData> {
    return this.audit.run(
      actor,
      {
        action: 'user.health.reveal',
        targetType: 'user',
        targetId: id,
        reason,
        details: { minutes: HEALTH_REVEAL_MS / 60_000 },
      },
      () =>
        readOnlyQuery(this.prisma, async (tx) => {
          const user = await tx.user.findUnique({
            where: { id },
            select: {
              yearOfBirth: true,
              heightCm: true,
              weightKg: true,
              sex: true,
              preferences: {
                select: {
                  goal: true,
                  calorieGoal: true,
                  dietPreference: true,
                  allergens: true,
                  activityLevel: true,
                },
              },
            },
          });
          if (!user) throw userNotFound();
          const defaults = UsersService.preferencesDefaults;
          return {
            yearOfBirth: user.yearOfBirth,
            heightCm: user.heightCm,
            weightKg: user.weightKg,
            sex: user.sex,
            goal: user.preferences?.goal ?? 'HEALTHY',
            calorieGoal:
              user.preferences?.calorieGoal ?? defaults.calorieGoalDefault,
            dietPreference: user.preferences?.dietPreference ?? 'NONE',
            allergens: user.preferences?.allergens ?? [],
            activityLevel:
              user.preferences?.activityLevel ?? defaults.activityLevelDefault,
            revealedUntil: new Date(
              Date.now() + HEALTH_REVEAL_MS,
            ).toISOString(),
          };
        }),
    );
  }

  /**
   * „Wyloguj zewsząd" — ta sama droga co `POST /auth/logout-everywhere`:
   * zamek sesji, unieważnienie wszystkich refresh tokenów, podbicie
   * `tokenVersion` i zerwanie socketów.
   */
  logoutEverywhere(actor: AdminActor, id: string): Promise<{ closed: number }> {
    return this.audit.run(
      actor,
      { action: 'user.logout-everywhere', targetType: 'user', targetId: id },
      async () => {
        await this.assertUserExists(id);
        const { revokedSessions } = await this.auth.logoutEverywhere(id);
        return { closed: revokedSessions };
      },
      (result) => ({ closed: result.closed }),
    );
  }

  /**
   * Eksport RODO (art. 15/20) — TA SAMA paczka co `GET /me/export`.
   *
   * Świadoma decyzja: backend nie ma dziś ani przechowalni plików, ani
   * jednorazowych linków, a wysłanie danych osobowych mailem wymagałoby
   * obu. Paczka wraca więc do panelu (panel zapisuje ją jako plik), a
   * dalsze przekazanie osobie idzie kanałem obsługi — jak `pnpm rodo:export`.
   */
  exportData(
    actor: AdminActor,
    id: string,
    reason: string,
  ): Promise<UserExport> {
    return this.audit.run(
      actor,
      { action: 'user.export', targetType: 'user', targetId: id, reason },
      () => this.dataExport.exportFor(id),
      (bundle) => ({ format: bundle.format }),
    );
  }

  /**
   * Usunięcie konta — TA SAMA ścieżka co z telefonu (`UsersService.deleteAccount`):
   * przepisy przechodzą na bota, dom zostaje domownikom (albo znika, gdy był
   * pusty), pożegnanie ACCOUNT_DELETED kolejkuje się w tej samej transakcji.
   * Bez unieważnienia tokenów Apple: to wymaga świeżego `authorizationCode`
   * z telefonu osoby — tak samo jak przy `pnpm accounts:delete`.
   */
  async deleteAccount(
    actor: AdminActor,
    id: string,
    reason: string,
  ): Promise<void> {
    await this.audit.run(
      actor,
      { action: 'user.delete', targetType: 'user', targetId: id, reason },
      () => this.users.deleteAccount(id),
    );
  }

  private async assertUserExists(id: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!user) throw userNotFound();
  }
}

function toSubscription(row: {
  id: string;
  productId: string;
  status: Subscription['status'];
  environment: string | null;
  ownershipType: string | null;
  expiresAt: Date | null;
  graceExpiresAt: Date | null;
  autoRenewStatus: boolean | null;
  lastVerifiedAt: Date | null;
  operatorHoldAt: Date | null;
  createdAt: Date;
}): Subscription {
  return {
    id: row.id,
    productId: row.productId as ProductId,
    status: row.status,
    // Apple podaje środowisko przy każdej transakcji; wszystko poza
    // Production (Sandbox, Xcode) to zakup testowy.
    environment: row.environment === 'Production' ? 'Production' : 'Sandbox',
    ownershipType:
      row.ownershipType === 'FAMILY_SHARED' ? 'FAMILY_SHARED' : 'PURCHASED',
    expiresAt: row.expiresAt?.toISOString() ?? null,
    graceExpiresAt: row.graceExpiresAt?.toISOString() ?? null,
    autoRenewStatus: row.autoRenewStatus,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    operatorHoldAt: row.operatorHoldAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toStepsSource(source: string | undefined): UserDetail['stepsSource'] {
  return source === 'APPLE_HEALTH' || source === 'GARMIN' ? source : null;
}
