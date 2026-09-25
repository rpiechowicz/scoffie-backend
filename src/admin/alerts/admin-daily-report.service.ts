import {
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { readMailEnv } from '../../mail/mail-env';
import { MailOutboxService } from '../../mail/mail-outbox.service';
import { MailRenderer } from '../../mail/mail-renderer';
import type { DailyReportPayload } from '../../mail/mail-template';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import {
  addDays,
  sqlInstant,
  sqlWarsawDay,
  warsawDateKey,
} from '../common/warsaw-calendar';
import type {
  DailyReportInfo,
  DailyReportPreview,
  DailyReportSendResult,
} from '../contract';
import { missingSentry, readSentryEnv } from '../integrations/integrations-env';
import { fetchSentry } from '../integrations/sentry.client';
import { AdminDashboardService } from '../users/admin-dashboard.service';
import { readAlertsEnv } from './alerts-env';
import { recipientTag } from './admin-watch.service';
import {
  REPORT_DEDUPE_PREFIX,
  buildReportPayload,
  dueReportDay,
  reportPanelDays,
  type ReportCounts,
} from './daily-report';

/** Co ~5 minut sprawdzamy, czy już pora i czy raport za wczoraj wyszedł. */
const TICK_MS = 5 * 60_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

type CountRow = {
  day: string;
  assistantUsers: number;
  mailsSent: number;
  mailsFailed: number;
  reports: number;
};

/**
 * Raport „Scoffie wczoraj” o 7:00 (Europe/Warsaw) do właściciela.
 *
 * „TYLKO RAZ” TRZYMA BAZA, nie pamięć procesu: przed zebraniem danych
 * sprawdzamy, czy w skrzynce nadawczej jest już wiersz `daily-report:<doba>`,
 * a przy kolejkowaniu `dedupeKey` z tą samą dobą odbija drugi raz od
 * UNIQUE — restart o 7:03 nie wyśle raportu drugi raz.
 *
 * Domyślnie WYŁĄCZONY (`ADMIN_DAILY_REPORT`), jak cała poczta. Podgląd
 * i „Wyślij teraz” w panelu działają niezależnie od wyłącznika.
 */
@Injectable()
export class AdminDailyReportService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AdminDailyReportService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboard: AdminDashboardService,
    private readonly outbox: MailOutboxService,
    private readonly renderer: MailRenderer,
    private readonly audit: AdminAuditService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    // Pętla chodzi zawsze, a wyłącznik czyta każdy przebieg — tak jak
    // robotnik poczty. Przebieg przy wyłączonym raporcie to jeden `if`.
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Jeden przebieg pętli. Nigdy nie rzuca. */
  async tick(now: Date = new Date()): Promise<'sent' | 'skipped'> {
    if (this.running) return 'skipped';
    const env = readAlertsEnv();
    if (!env.reportEnabled || !readMailEnv().enabled) return 'skipped';
    if (env.reportEmails.length === 0) return 'skipped';
    const day = dueReportDay(now);
    if (!day) return 'skipped';

    this.running = true;
    try {
      // Ręczne „Wyślij teraz” (`…:manual-…`) nie zastępuje porannego.
      const already = await this.prisma.mailMessage.findFirst({
        where: {
          dedupeKey: { startsWith: `${REPORT_DEDUPE_PREFIX}${day}:` },
          NOT: { dedupeKey: { contains: ':manual-' } },
        },
        select: { id: true },
      });
      if (already) return 'skipped';
      const payload = await this.payload(day, now);
      const queued = await this.enqueue(
        payload,
        env.reportEmails,
        (email) => `${REPORT_DEDUPE_PREFIX}${day}:${recipientTag(email)}`,
      );
      if (queued > 0) this.logger.log(`Raport dzienny za ${day} w kolejce.`);
      return queued > 0 ? 'sent' : 'skipped';
    } catch (error) {
      this.logger.error(
        `raport dzienny padł: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'skipped';
    } finally {
      this.running = false;
    }
  }

  /** Stan dla karty „Raport dzienny” w panelu. */
  async info(): Promise<DailyReportInfo> {
    const env = readAlertsEnv();
    const last = await this.prisma.mailMessage.findFirst({
      where: {
        dedupeKey: { startsWith: REPORT_DEDUPE_PREFIX },
        status: 'SENT',
      },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true, dedupeKey: true },
    });
    const day =
      last?.dedupeKey.slice(
        REPORT_DEDUPE_PREFIX.length,
        REPORT_DEDUPE_PREFIX.length + 10,
      ) ?? null;
    return {
      enabled: env.reportEnabled,
      emails: env.reportEmails,
      lastSentAt: last?.sentAt?.toISOString() ?? null,
      lastDay: day && DAY_KEY.test(day) ? day : null,
    };
  }

  async preview(
    rawDay: string | undefined,
    now: Date = new Date(),
  ): Promise<DailyReportPreview> {
    const day = this.resolveDay(rawDay, now);
    const payload = await this.payload(day, now);
    const rendered = this.renderer.render(
      'DAILY_REPORT',
      payload as unknown as Record<string, unknown>,
    );
    return { day, subject: rendered.subject, html: rendered.html };
  }

  /**
   * „Wyślij teraz” z panelu — na adresy z konfiguracji, niezależnie od
   * `ADMIN_DAILY_REPORT` (świadome kliknięcie jest tą decyzją). Osobny
   * `dedupeKey` z chwilą wysyłki: ręczny raport nie blokuje porannego
   * i nie jest przez niego blokowany.
   */
  send(
    actor: AdminActor,
    rawDay: string | undefined,
    now: Date = new Date(),
  ): Promise<DailyReportSendResult> {
    const day = this.resolveDay(rawDay, now);
    const env = readAlertsEnv();
    return this.audit.run(
      actor,
      {
        action: 'daily-report.send',
        targetType: 'DailyReport',
        targetId: day,
        details: { recipients: env.reportEmails.length },
      },
      async () => {
        if (!readMailEnv().enabled) {
          throw new AppException(
            'SERVICE_UNAVAILABLE',
            'Poczta jest wyłączona (MAIL_ENABLED) — raport by nie wyszedł.',
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }
        if (env.reportEmails.length === 0) {
          throw new AppException(
            'CONFLICT',
            'Brak adresatów — ustaw ADMIN_REPORT_EMAILS albo ADMIN_BOOTSTRAP_EMAIL.',
            HttpStatus.CONFLICT,
          );
        }
        const payload = await this.payload(day, now);
        const stamp = now.getTime().toString(36);
        const queued = await this.enqueue(
          payload,
          env.reportEmails,
          (email) =>
            `${REPORT_DEDUPE_PREFIX}${day}:manual-${stamp}:${recipientTag(email)}`,
        );
        return { day, queued, recipients: env.reportEmails };
      },
      (result) => ({ queued: result.queued }),
    );
  }

  /** Domyślnie wczoraj; data z przyszłości albo dziś (niepełna doba) — 400. */
  private resolveDay(raw: string | undefined, now: Date): string {
    const yesterday = addDays(warsawDateKey(now), -1);
    if (raw === undefined || raw === '') return yesterday;
    if (!DAY_KEY.test(raw) || raw > warsawDateKey(now)) {
      const detail = 'date must be YYYY-MM-DD, not in the future';
      throw new AppException(
        'VALIDATION_ERROR',
        detail,
        HttpStatus.BAD_REQUEST,
        [detail],
      );
    }
    return raw;
  }

  private async enqueue(
    payload: DailyReportPayload,
    emails: string[],
    key: (email: string) => string,
  ): Promise<number> {
    let queued = 0;
    for (const email of emails) {
      // Mail do operatora nie ma `userId` — patrz `OPERATOR_MAIL_TEMPLATES`.
      const outcome = await this.outbox.enqueueStandalone({
        template: 'DAILY_REPORT',
        dedupeKey: key(email),
        to: email,
        userId: null,
        payload,
      });
      if (outcome === 'QUEUED') queued += 1;
    }
    return queued;
  }

  private async payload(day: string, now: Date): Promise<DailyReportPayload> {
    const days = reportPanelDays(day);
    const [{ stats, subscriptions }, counts, openAlerts, sentryNew24h] =
      await Promise.all([
        this.dashboard.reportDays(days, now),
        this.counts(days[0].start, days[1].end),
        this.prisma.adminAlert.count({ where: { resolvedAt: null } }),
        this.sentryNew24h(),
      ]);
    const byDay = (key: string): ReportCounts => {
      const row = counts.find((c) => c.day === key);
      return {
        assistantUsers: row?.assistantUsers ?? 0,
        mailsSent: row?.mailsSent ?? 0,
        mailsFailed: row?.mailsFailed ?? 0,
        reports: row?.reports ?? 0,
      };
    };
    return buildReportPayload({
      days,
      now,
      panelUrl: readAlertsEnv().panelUrl,
      stats,
      subscriptions,
      counts: days.map((d) => byDay(d.key)),
      openAlerts,
      sentryNew24h,
    });
  }

  /** Liczby, których pulpit nie ma, jednym zapytaniem na obie doby. */
  private async counts(from: Date, to: Date): Promise<CountRow[]> {
    const day = (column: Prisma.Sql) => sqlWarsawDay(column);
    const f = sqlInstant(from);
    const t = sqlInstant(to);
    const rows = await this.prisma.$queryRaw<
      { metric: keyof Omit<CountRow, 'day'>; day: string; value: number }[]
    >`
      SELECT 'assistantUsers' AS "metric", ${day(Prisma.sql`"createdAt"`)} AS "day",
             COUNT(DISTINCT "userId")::int AS "value"
        FROM "AgentTurn" WHERE "createdAt" >= ${f} AND "createdAt" < ${t} GROUP BY 2
      UNION ALL
      SELECT 'mailsSent', ${day(Prisma.sql`"createdAt"`)}, COUNT(*)::int
        FROM "MailMessage" WHERE "status" = 'SENT'
          AND "createdAt" >= ${f} AND "createdAt" < ${t} GROUP BY 2
      UNION ALL
      SELECT 'mailsFailed', ${day(Prisma.sql`"createdAt"`)}, COUNT(*)::int
        FROM "MailMessage" WHERE "status" = 'FAILED'
          AND "createdAt" >= ${f} AND "createdAt" < ${t} GROUP BY 2
      UNION ALL
      SELECT 'reports', ${day(Prisma.sql`"createdAt"`)}, COUNT(*)::int
        FROM "AgentReport" WHERE "createdAt" >= ${f} AND "createdAt" < ${t} GROUP BY 2`;
    const out = new Map<string, CountRow>();
    for (const row of rows) {
      const entry = out.get(row.day) ?? {
        day: row.day,
        assistantUsers: 0,
        mailsSent: 0,
        mailsFailed: 0,
        reports: 0,
      };
      entry[row.metric] = row.value;
      out.set(row.day, entry);
    }
    return [...out.values()];
  }

  /** Sentry to dodatek — jego brak albo awaria nie zatrzymuje raportu. */
  private async sentryNew24h(): Promise<number | null> {
    const env = readSentryEnv();
    if (missingSentry(env).length > 0) return null;
    try {
      const data = await fetchSentry(env);
      return data.projects.reduce((sum, p) => sum + p.new24h, 0);
    } catch {
      return null;
    }
  }
}
