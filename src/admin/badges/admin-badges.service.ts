import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { roleHasPermission, type AdminPermission } from '../admin-permissions';
import type { AdminBadges } from '../contract';
import { GDPR_OPEN_STATUSES, GDPR_WARN_DAYS } from '../gdpr/gdpr-rules';
import { DeployTrackerService } from '../integrations/deploy-tracker.service';
import { systemBadge } from './badges-rules';

const DAY_MS = 24 * 60 * 60_000;
/** Rodzaj reguły z centrum alertów (`alert-rules.ts`). */
export const CLAUDE_LOW_KIND = 'anthropic-balance-low';

/**
 * Liczniki paska bocznego panelu jednym lekkim zapytaniem: same `COUNT`-y
 * z bazy i ostatni znany stan Railwaya z pamięci procesu — nigdy żadnego
 * zewnętrznego API, bo pasek pyta o to przy każdej stronie. Pole, do którego
 * rola nie ma uprawnienia odczytu (tego samego co ekran źródłowy), jest `null`.
 */
@Injectable()
export class AdminBadgesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deploys: DeployTrackerService,
  ) {}

  async badges(role: string, now: Date = new Date()): Promise<AdminBadges> {
    const can = (p: AdminPermission) => roleHasPermission(role, p);
    const when = <T>(p: AdminPermission, run: () => Promise<T>) =>
      can(p) ? run() : Promise.resolve(null);
    const open = [...GDPR_OPEN_STATUSES];
    const soon = new Date(now.getTime() + GDPR_WARN_DAYS * DAY_MS);

    const [reports, alerts, mailsFailed, subsInGrace, gdpr, claudeLow] =
      await Promise.all([
        when('assistant.read', () =>
          this.prisma.agentReport.count({ where: { status: 'NEW' } }),
        ),
        when('alerts.read', async () => {
          const [openCount, critical] = await Promise.all([
            this.prisma.adminAlert.count({ where: { resolvedAt: null } }),
            this.prisma.adminAlert.count({
              where: { resolvedAt: null, severity: 'critical' },
            }),
          ]);
          return { open: openCount, critical };
        }),
        when('dashboard.read', () =>
          this.prisma.mailMessage.count({ where: { status: 'FAILED' } }),
        ),
        when('dashboard.read', () =>
          this.prisma.subscription.count({ where: { status: 'GRACE' } }),
        ),
        when('gdpr.read', async () => {
          const [overdue, dueSoon] = await Promise.all([
            this.prisma.gdprRequest.count({
              where: { status: { in: open }, dueAt: { lt: now } },
            }),
            this.prisma.gdprRequest.count({
              where: { status: { in: open }, dueAt: { gte: now, lt: soon } },
            }),
          ]);
          return { overdue, dueSoon };
        }),
        when('assistant.read', async () => {
          const n = await this.prisma.adminAlert.count({
            where: { kind: CLAUDE_LOW_KIND, resolvedAt: null },
          });
          return n > 0;
        }),
      ]);

    return {
      reports,
      alerts,
      mailsFailed,
      subsInGrace,
      gdpr,
      system: can('ops.read') ? systemBadge(this.deploys.lastKnown()) : null,
      claudeLow,
    };
  }
}
