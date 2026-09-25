import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { normalizeEmail } from '../../mail/mail-eligibility';
import { readMailEnv } from '../../mail/mail-env';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import {
  sqlInstant,
  sqlWarsawDay,
  warsawDays,
} from '../common/warsaw-calendar';
import type {
  MailData,
  MailDay,
  MailFilters,
  MailRow,
  MailStatus,
  MailTemplate,
} from '../contract';
import { IntegrationCache } from './integration-fetch';
import { fetchResendDomains } from './resend-domains.client';

const PAGE = 100;
const SUPPRESSIONS = 200;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RESEND_TTL_MS = 5 * 60 * 1000;
const STATUSES: MailStatus[] = [
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'SKIPPED',
];
const DAYS = 30;

type DayRow = { day: string; status: MailStatus; count: number };

/**
 * Poczta w panelu (ROADMAPA §5.10): skrzynka nadawcza, lista wykluczeń
 * i stan domeny u Resend. „Ponów” mieszka w `AdminMailsService` (karta
 * osoby) — ten ekran woła tę samą trasę.
 *
 * Wykluczenia to jedyne akcje tutaj. Dodanie — bez step-upu (tylko chroni
 * adres przed kolejnymi mailami), zdjęcie — ze step-upem, bo ponowna wysyłka
 * na adres po twardym odrzucie albo skardze psuje reputację domeny
 * wszystkim pozostałym mailom.
 */
@Injectable()
export class AdminMailService {
  private readonly cache = new IntegrationCache();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async data(filters: MailFilters, now: Date = new Date()): Promise<MailData> {
    const env = readMailEnv();
    const where: Prisma.MailMessageWhereInput = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.template ? { template: filters.template } : {}),
      ...(filters.q?.trim()
        ? { to: { contains: filters.q.trim(), mode: 'insensitive' } }
        : {}),
    };

    const days = warsawDays(now, DAYS);
    const [rows, grouped, queue, suppressions, perDay] = await Promise.all([
      this.prisma.mailMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: PAGE,
        select: {
          id: true,
          template: true,
          status: true,
          attempts: true,
          lastError: true,
          sentAt: true,
          createdAt: true,
          to: true,
          userId: true,
          subject: true,
          scrubbedAt: true,
          providerMessageId: true,
          nextAttemptAt: true,
        },
      }),
      this.prisma.mailMessage.groupBy({
        by: ['status'],
        where: { createdAt: { gte: new Date(now.getTime() - WINDOW_MS) } },
        _count: { _all: true },
      }),
      this.prisma.mailMessage.aggregate({
        where: { status: { in: ['QUEUED', 'SENDING'] } },
        _count: { _all: true },
        _min: { createdAt: true },
      }),
      this.prisma.mailSuppression.findMany({
        orderBy: { createdAt: 'desc' },
        take: SUPPRESSIONS,
      }),
      this.prisma.$queryRaw<DayRow[]>`
        SELECT ${sqlWarsawDay(Prisma.sql`"createdAt"`)} AS "day", "status",
               COUNT(*)::int AS "count"
          FROM "MailMessage"
          WHERE "createdAt" >= ${sqlInstant(days[0].start)}
          GROUP BY 1, 2`,
    ]);

    // Wykluczenie mogło przyjść po wysyłce — sprawdzamy adresy tej strony.
    const addresses = [
      ...new Set(
        rows
          .filter((r) => !r.scrubbedAt && r.to)
          .map((r) => normalizeEmail(r.to)),
      ),
    ];
    const suppressed = new Set(
      addresses.length === 0
        ? []
        : (
            await this.prisma.mailSuppression.findMany({
              where: { email: { in: addresses } },
              select: { email: true },
            })
          ).map((s) => s.email),
    );

    const last30 = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
      MailStatus,
      number
    >;
    for (const g of grouped) last30[g.status] = g._count._all;

    return {
      enabled: env.enabled,
      transport: env.transport,
      redirected: env.redirectTo !== '',
      last30,
      queue: {
        waiting: queue._count._all,
        oldestAt: queue._min.createdAt?.toISOString() ?? null,
      },
      from: env.from,
      replyTo: env.replyTo,
      daily: days.map((d): MailDay => {
        const of = (status: MailStatus) =>
          perDay.find((r) => r.day === d.key && r.status === status)?.count ??
          0;
        return {
          date: d.start.toISOString(),
          sent: of('SENT'),
          failed: of('FAILED'),
          skipped: of('SKIPPED'),
        };
      }),
      messages: rows.map((r): MailRow => {
        const to = r.scrubbedAt || !r.to.trim() ? null : r.to;
        return {
          id: r.id,
          template: r.template as MailTemplate,
          status: r.status,
          attempts: r.attempts,
          lastError: r.lastError,
          sentAt: r.sentAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
          to,
          userId: r.userId,
          subject: r.scrubbedAt ? null : r.subject,
          suppressed: to !== null && suppressed.has(normalizeEmail(to)),
          providerMessageId: r.providerMessageId,
          nextAttemptAt:
            r.status === 'QUEUED' ? r.nextAttemptAt.toISOString() : null,
        };
      }),
      suppressions: suppressions.map((s) => ({
        email: s.email,
        reason: s.reason,
        detail: s.detail,
        createdAt: s.createdAt.toISOString(),
      })),
      resend:
        env.transport === 'resend' && env.apiKey
          ? await this.cache.get('resend-domains', RESEND_TTL_MS, () =>
              fetchResendDomains(env.apiKey),
            )
          : {
              status: 'off',
              missing: env.apiKey
                ? ['MAIL_TRANSPORT=resend']
                : ['RESEND_API_KEY'],
            },
    };
  }

  async suppress(
    actor: AdminActor,
    rawEmail: string,
    reason: string,
  ): Promise<void> {
    const email = normalizeEmail(rawEmail);
    await this.audit.run(
      actor,
      {
        action: 'mail.suppression.add',
        targetType: 'MailSuppression',
        targetId: email,
        reason,
      },
      async () => {
        try {
          await this.prisma.mailSuppression.create({
            data: { email, reason: 'MANUAL', detail: reason },
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw new AppException(
              'CONFLICT',
              'Ten adres już jest na liście wykluczeń.',
              HttpStatus.CONFLICT,
            );
          }
          throw error;
        }
      },
    );
  }

  async unsuppress(
    actor: AdminActor,
    rawEmail: string,
    reason: string,
  ): Promise<void> {
    const email = normalizeEmail(rawEmail);
    await this.audit.run(
      actor,
      {
        action: 'mail.suppression.remove',
        targetType: 'MailSuppression',
        targetId: email,
        reason,
      },
      async () => {
        const removed = await this.prisma.mailSuppression.deleteMany({
          where: { email },
        });
        if (removed.count === 0) {
          throw new AppException(
            'NOT_FOUND',
            'Tego adresu nie ma na liście wykluczeń.',
            HttpStatus.NOT_FOUND,
          );
        }
        return removed;
      },
    );
  }
}
