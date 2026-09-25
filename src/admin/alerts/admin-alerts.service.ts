import { HttpStatus, Injectable } from '@nestjs/common';
import type { AdminAlert } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { readMailEnv } from '../../mail/mail-env';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import type { AdminAlertRow, AlertSeverity, AlertsData } from '../contract';
import { AdminDailyReportService } from './admin-daily-report.service';
import { AdminWatchService } from './admin-watch.service';
import { readAlertsEnv } from './alerts-env';

const HISTORY_MS = 30 * 24 * 60 * 60_000;
const HISTORY_LIMIT = 100;
const OPEN_LIMIT = 100;

const toRow = (a: AdminAlert): AdminAlertRow => ({
  id: a.id,
  key: a.key,
  kind: a.kind,
  severity: (a.severity === 'critical'
    ? 'critical'
    : 'warning') as AlertSeverity,
  title: a.title,
  detail: a.detail,
  firstAt: a.firstAt.toISOString(),
  lastAt: a.lastAt.toISOString(),
  resolvedAt: a.resolvedAt?.toISOString() ?? null,
  acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
  acknowledgedBy: a.acknowledgedBy,
});

/** Ekran „Alerty”: otwarte, historia 30 dni, kanały i raport dzienny. */
@Injectable()
export class AdminAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly watch: AdminWatchService,
    private readonly report: AdminDailyReportService,
  ) {}

  async data(
    state: 'open' | 'all',
    now: Date = new Date(),
  ): Promise<AlertsData> {
    const env = readAlertsEnv();
    const [open, recent, report] = await Promise.all([
      this.prisma.adminAlert.findMany({
        where: { resolvedAt: null },
        orderBy: [{ lastAt: 'desc' }],
        take: OPEN_LIMIT,
      }),
      state === 'all'
        ? this.prisma.adminAlert.findMany({
            where: {
              resolvedAt: {
                not: null,
                gte: new Date(now.getTime() - HISTORY_MS),
              },
            },
            orderBy: [{ resolvedAt: 'desc' }],
            take: HISTORY_LIMIT,
          })
        : Promise.resolve([]),
      this.report.info(),
    ]);
    // Krytyczne pierwsze, w obrębie wagi — najświeższe.
    const rows = open
      .map(toRow)
      .sort(
        (a, b) =>
          Number(b.severity === 'critical') -
            Number(a.severity === 'critical') ||
          b.lastAt.localeCompare(a.lastAt),
      );
    return {
      open: rows,
      recent: recent.map(toRow),
      lastCheckAt: this.watch.lastCheckAt()?.toISOString() ?? null,
      channels: {
        webhook: (process.env.OPS_ALERT_WEBHOOK_URL ?? '').trim() !== '',
        emails: env.alertEmails,
        mail: readMailEnv().enabled,
        enabled: env.enabled,
      },
      report,
    };
  }

  /**
   * „Przyjąłem” — alert zostaje otwarty (zamyka go dopiero zniknięcie
   * problemu), ale panel wie, że ktoś już patrzy. Bez step-upu: niczego nie
   * zmienia na produkcji. Drugie kliknięcie nie nadpisuje pierwszego.
   */
  ack(actor: AdminActor, id: string): Promise<void> {
    return this.audit
      .run(
        actor,
        { action: 'alert.ack', targetType: 'AdminAlert', targetId: id },
        async () => {
          const { count } = await this.prisma.adminAlert.updateMany({
            where: { id, acknowledgedAt: null },
            data: {
              acknowledgedAt: new Date(),
              acknowledgedBy: actor.adminEmail,
            },
          });
          if (count === 0) {
            const exists = await this.prisma.adminAlert.findUnique({
              where: { id },
              select: { id: true },
            });
            if (!exists) {
              throw new AppException(
                'NOT_FOUND',
                'Nie ma takiego alertu.',
                HttpStatus.NOT_FOUND,
              );
            }
          }
          return { changed: count === 1 };
        },
        (result) => result,
      )
      .then(() => undefined);
  }
}
