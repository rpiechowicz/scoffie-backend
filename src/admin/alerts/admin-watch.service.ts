import { createHash } from 'crypto';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MailOutboxService } from '../../mail/mail-outbox.service';
import { readMailEnv } from '../../mail/mail-env';
import { OpsAlertService } from '../../observability/ops-alert.service';
import { PrismaService } from '../../prisma/prisma.service';
import { emitLive } from '../../common/live-events';
import { warsawDateKey } from '../common/warsaw-calendar';
import { IntegrationError } from '../integrations/integration-fetch';
import {
  missingAscReports,
  missingSentry,
  readAscReportsEnv,
  readAscVendorNumber,
  readRailwayToken,
  readSentryEnv,
} from '../integrations/integrations-env';
import { fetchRailway } from '../integrations/railway.client';
import {
  DeployTrackerService,
  latestOf,
} from '../integrations/deploy-tracker.service';
import { fetchResendDomains } from '../integrations/resend-domains.client';
import { fetchSentry } from '../integrations/sentry.client';
import { AdminAnthropicService } from '../anthropic/admin-anthropic.service';
import { readAnthropicAdminKey } from '../anthropic/anthropic-billing.client';
import {
  anthropicBalanceAlerts,
  appleReportAlerts,
  cronAlerts,
  crashFreeAlerts,
  domainAlerts,
  gdprAlerts,
  mailFailedAlerts,
  mailQueueAlerts,
  planAlerts,
  railwayAlerts,
  sentryFatalAlerts,
  type DetectedAlert,
  type Detection,
} from './alert-rules';
import { readAlertsEnv } from './alerts-env';
import { GDPR_OPEN_STATUSES } from '../gdpr/gdpr-rules';

/** Co 10 minut — częściej nie ma po co (Railway i Sentry mają limity). */
export const WATCH_INTERVAL_MS = 10 * 60_000;
/** Pierwszy przebieg minutę po starcie — nie w trakcie healthchecku. */
const FIRST_CHECK_DELAY_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Skrót adresu do `dedupeKey` — klucz przeżywa retencję, adres nie powinien. */
export const recipientTag = (email: string): string =>
  createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 12);

/**
 * Centrum alertów: co 10 minut sprawdza produkcję i zapisuje problemy
 * w `AdminAlert` (reguły w `alert-rules.ts`).
 *
 * Nowy problem → wiersz + webhook (`OpsAlertService`) + mail do operatora
 * (`OPS_ALERT` przez skrzynkę nadawczą). Trwający → tylko `lastAt`.
 * Zniknął → `resolvedAt` + webhook „rozwiązane” (bez maila: skrzynka
 * operatora ma dostawać to, co wymaga ruchu, nie każde zamknięcie).
 *
 * `dedupeKey` maila = `ops-alert:<klucz alertu>:<doba>:<adresat>`. Doba,
 * bo klucz alertu wraca (crash-free spada drugi raz) — sam klucz raz na
 * zawsze zablokowałby każdy kolejny mail o tym samym problemie, a bez doby
 * migotanie problemu słałoby mail co 10 minut. Tak jest najwyżej jeden
 * mail na problem na dobę; webhook ma własne okno 6 h.
 *
 * Jedna instancja Railway → `setInterval` z `unref`, jak robotnik poczty.
 * W testach (`NODE_ENV=test`) i przy `ADMIN_ALERTS=false` pętla nie startuje;
 * reguła bez klucza (Railway, Sentry, Resend) po prostu się nie wykonuje.
 */
@Injectable()
export class AdminWatchService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AdminWatchService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;
  private lastCheck: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: MailOutboxService,
    private readonly ops: OpsAlertService,
    private readonly deploys: DeployTrackerService,
    private readonly anthropic: AdminAnthropicService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    if (!readAlertsEnv().enabled) {
      this.logger.log('Centrum alertów wyłączone (ADMIN_ALERTS=false).');
      return;
    }
    this.first = setTimeout(() => {
      void this.check();
      this.timer = setInterval(() => void this.check(), WATCH_INTERVAL_MS);
      this.timer.unref();
    }, FIRST_CHECK_DELAY_MS);
    this.first.unref();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  lastCheckAt(): Date | null {
    return this.lastCheck;
  }

  /** Jeden przebieg. Nigdy nie rzuca — wyjątek w pętli tła ubiłby ją na zawsze. */
  async check(now: Date = new Date()): Promise<void> {
    if (this.running || !readAlertsEnv().enabled) return;
    this.running = true;
    try {
      const detections = await this.detect(now);
      await this.apply(detections, now);
      this.lastCheck = now;
    } catch (error) {
      this.logger.error(
        `przebieg alertów padł: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Każda reguła osobno: awaria jednego dostawcy nie wyłącza pozostałych. */
  private async detect(now: Date): Promise<Detection[]> {
    const detections: Detection[] = [];
    const attempt = async (
      name: string,
      run: () => Promise<Detection[]>,
    ): Promise<void> => {
      try {
        detections.push(...(await run()));
      } catch (error) {
        // Brak odpowiedzi to „nie wiem”, nie „w porządku” — reguła nie oddaje
        // nic, więc jej otwarte alerty zostają otwarte.
        this.logger.warn(
          `alerty — ${name} niedostępne: ${
            error instanceof IntegrationError || error instanceof Error
              ? error.message
              : String(error)
          }`,
        );
      }
    };

    const railwayToken = readRailwayToken();
    if (railwayToken) {
      await attempt('Railway', async () => {
        const railway = await fetchRailway(railwayToken);
        // Zmiana stanu wdrożeń od ostatniego odczytu → sygnał `ops`
        // (i śledzenie co 8 s, jeśli coś jest w toku).
        this.deploys.observe(latestOf(railway));
        return [
          { kind: 'deploy-failed', problems: railwayAlerts(railway) },
          { kind: 'cron-failed', problems: cronAlerts(railway) },
        ];
      });
    }

    const sentryEnv = readSentryEnv();
    if (missingSentry(sentryEnv).length === 0) {
      await attempt('Sentry', async () => {
        const sentry = await fetchSentry(sentryEnv);
        return [
          { kind: 'crash-free', problems: crashFreeAlerts(sentry) },
          { kind: 'sentry-fatal', problems: sentryFatalAlerts(sentry, now) },
        ];
      });
    }

    const mailEnv = readMailEnv();
    await attempt('poczta', async () => {
      const [queued, sending, failed24h] = await Promise.all([
        this.prisma.mailMessage.aggregate({
          where: { status: 'QUEUED', nextAttemptAt: { lte: now } },
          _min: { nextAttemptAt: true },
        }),
        this.prisma.mailMessage.aggregate({
          where: { status: 'SENDING' },
          _min: { updatedAt: true },
        }),
        this.prisma.mailMessage.count({
          where: {
            status: 'FAILED',
            updatedAt: { gte: new Date(now.getTime() - DAY_MS) },
          },
        }),
      ]);
      const since = [queued._min.nextAttemptAt, sending._min.updatedAt]
        .filter((d): d is Date => d instanceof Date)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      return [
        {
          kind: 'mail-queue',
          problems: mailQueueAlerts({
            mailEnabled: mailEnv.enabled,
            oldestWaitingSince: since ?? null,
            now,
          }),
        },
        { kind: 'mail-failed', problems: mailFailedAlerts(failed24h) },
      ];
    });

    await attempt('RODO', async () => {
      const open = await this.prisma.gdprRequest.findMany({
        where: { status: { in: [...GDPR_OPEN_STATUSES] } },
        select: { id: true, kind: true, dueAt: true },
      });
      return [{ kind: 'gdpr-due', problems: gdprAlerts(open, now) }];
    });

    if (mailEnv.transport === 'resend' && mailEnv.apiKey) {
      await attempt('Resend', async () => [
        {
          kind: 'mail-domain',
          problems: domainAlerts(
            (await fetchResendDomains(mailEnv.apiKey)).domains,
          ),
        },
      ]);
    }

    // Przychód z Apple: stan ostatniej synchronizacji leży w bazie
    // (`AppleReportsSyncService`) — bez klucza/vendora reguła milczy.
    if (
      missingAscReports(readAscReportsEnv(), readAscVendorNumber()).length === 0
    ) {
      await attempt('raporty Apple', async () => [
        {
          kind: 'apple-reports',
          problems: appleReportAlerts(
            await this.prisma.appleReportSync.findMany({
              select: { kind: true, lastError: true },
            }),
          ),
        },
      ]);
    }

    // Kredyty Claude: saldo z kotwicy w panelu minus wydatki z Anthropic.
    // Błąd pobrania to „nie wiem” — rzucamy, żeby alert nie zniknął.
    if (readAnthropicAdminKey()) {
      await attempt('Anthropic', async () => {
        const billing = await this.anthropic.billing(now);
        if (billing.error) throw new IntegrationError(billing.error);
        return [
          {
            kind: 'anthropic-balance-low',
            problems: anthropicBalanceAlerts(billing),
          },
        ];
      });
    }

    return detections;
  }

  private async apply(detections: Detection[], now: Date): Promise<void> {
    const keys = detections.flatMap((d) => d.problems.map((p) => p.key));
    const stored = await this.prisma.adminAlert.findMany({
      where: { OR: [{ key: { in: keys } }, { resolvedAt: null }] },
      select: { id: true, key: true, kind: true, resolvedAt: true },
    });
    const plan = planAlerts(stored, detections);

    for (const alert of plan.open) {
      try {
        await this.prisma.adminAlert.create({
          data: { ...this.fields(alert), firstAt: now, lastAt: now },
        });
      } catch (error) {
        // Równoległy przebieg (druga replika) zdążył pierwszy — jego
        // powiadomienie wystarczy.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          continue;
        }
        throw error;
      }
      await this.notifyOpened(alert, now, now);
    }

    for (const { row, alert } of plan.reopen) {
      const { count } = await this.prisma.adminAlert.updateMany({
        where: { id: row.id, resolvedAt: { not: null } },
        data: {
          ...this.fields(alert),
          firstAt: now,
          lastAt: now,
          resolvedAt: null,
          acknowledgedAt: null,
          acknowledgedBy: null,
        },
      });
      if (count === 1) await this.notifyOpened(alert, now, now);
    }

    if (plan.touch.length > 0) emitLive({ topics: ['alerts'] });
    for (const { row, alert } of plan.touch) {
      await this.prisma.adminAlert.update({
        where: { id: row.id },
        data: {
          severity: alert.severity,
          title: alert.title,
          detail: alert.detail,
          lastAt: now,
        },
      });
    }

    for (const row of plan.resolve) {
      const { count } = await this.prisma.adminAlert.updateMany({
        where: { id: row.id, resolvedAt: null },
        data: { resolvedAt: now },
      });
      if (count === 1) {
        const resolved = await this.prisma.adminAlert.findUnique({
          where: { id: row.id },
          select: { title: true },
        });
        emitLive({
          topics: ['alerts', 'dashboard'],
          notice: {
            level: 'success',
            title: `Rozwiązane: ${resolved?.title ?? row.key}`,
            link: '/alerts',
            topic: 'alerts',
          },
        });
        void this.ops.notify(
          `admin-alert-resolved:${row.key}`,
          `Rozwiązane: ${resolved?.title ?? row.key}`,
        );
      }
    }
  }

  private fields(alert: DetectedAlert) {
    return {
      key: alert.key,
      kind: alert.kind,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
    };
  }

  private async notifyOpened(
    alert: DetectedAlert,
    firstAt: Date,
    now: Date,
  ): Promise<void> {
    const env = readAlertsEnv();
    emitLive({
      topics: ['alerts', 'dashboard'],
      notice: {
        level: alert.severity === 'critical' ? 'error' : 'warning',
        title: alert.title,
        body: alert.detail,
        link: '/alerts',
        topic: 'alerts',
      },
    });
    void this.ops.notify(
      `admin-alert:${alert.key}`,
      `${alert.severity === 'critical' ? '[krytyczny]' : '[uwaga]'} ${alert.title} — ${alert.detail}`,
    );
    const day = warsawDateKey(now);
    for (const email of env.alertEmails) {
      // Mail do operatora nie ma `userId` — patrz `OPERATOR_MAIL_TEMPLATES`.
      await this.outbox.enqueueStandalone({
        template: 'OPS_ALERT',
        dedupeKey: `ops-alert:${alert.key}:${day}:${recipientTag(email)}`,
        to: email,
        userId: null,
        payload: {
          severity: alert.severity,
          title: alert.title,
          detail: alert.detail,
          firstAtIso: firstAt.toISOString(),
          panelUrl: env.panelUrl,
        },
      });
    }
  }
}
