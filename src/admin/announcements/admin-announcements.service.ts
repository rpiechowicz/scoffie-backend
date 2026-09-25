import { HttpStatus, Injectable } from '@nestjs/common';
import type { AppAnnouncement } from '@prisma/client';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_MAX_ACTIVE,
  ANNOUNCEMENT_TITLE_MAX,
  charCount,
  compareAnnouncements,
  plainTextProblem,
} from '../../announcements/announcements.rules';
import { AnnouncementsService } from '../../announcements/announcements.service';
import { AppException } from '../../common/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import type {
  AnnouncementCreate,
  AnnouncementRow,
  AnnouncementsData,
  AnnouncementState,
} from '../contract';

const DAY_MS = 24 * 60 * 60 * 1000;

const conflict = (message: string) =>
  new AppException('CONFLICT', message, HttpStatus.CONFLICT, [message]);

const invalid = (problems: string[]) =>
  new AppException(
    'VALIDATION_ERROR',
    problems.join('; '),
    HttpStatus.BAD_REQUEST,
    problems,
  );

export function announcementState(
  row: Pick<AppAnnouncement, 'startsAt' | 'endsAt'>,
  now: Date,
): AnnouncementState {
  if (row.endsAt && row.endsAt <= now) return 'ended';
  if (row.startsAt > now) return 'scheduled';
  return 'active';
}

const toRow = (row: AppAnnouncement, now: Date): AnnouncementRow => ({
  id: row.id,
  title: row.title,
  body: row.body,
  severity: row.severity,
  audience: row.audience,
  householdIds: row.householdIds,
  startsAt: row.startsAt.toISOString(),
  endsAt: row.endsAt?.toISOString() ?? null,
  dismissible: row.dismissible,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  state: announcementState(row, now),
});

/**
 * Komunikaty (banery) w aplikacji: lista, publikacja, „zakończ teraz”.
 * Publikacja i zakończenie — step-up (kontroler), powód, audyt i od razu
 * odświeżona pamięć `AnnouncementsService` (aplikacja widzi zmianę od
 * następnego `GET /me/announcements`).
 */
@Injectable()
export class AdminAnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly announcements: AnnouncementsService,
    private readonly audit: AdminAuditService,
  ) {}

  async data(now: Date = new Date()): Promise<AnnouncementsData> {
    const [open, ended] = await Promise.all([
      this.prisma.appAnnouncement.findMany({
        where: { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      }),
      this.prisma.appAnnouncement.findMany({
        where: {
          endsAt: { lte: now, gte: new Date(now.getTime() - 30 * DAY_MS) },
        },
        orderBy: { endsAt: 'desc' },
        take: 50,
      }),
    ]);
    const active = open
      .filter((row) => announcementState(row, now) === 'active')
      .sort(compareAnnouncements);
    const scheduled = open
      .filter((row) => announcementState(row, now) === 'scheduled')
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    return {
      active: active.map((row) => toRow(row, now)),
      scheduled: scheduled.map((row) => toRow(row, now)),
      ended: ended.map((row) => toRow(row, now)),
      limits: {
        titleMax: ANNOUNCEMENT_TITLE_MAX,
        bodyMax: ANNOUNCEMENT_BODY_MAX,
        maxActive: ANNOUNCEMENT_MAX_ACTIVE,
      },
    };
  }

  async create(
    actor: AdminActor,
    input: AnnouncementCreate,
    now: Date = new Date(),
  ): Promise<AnnouncementRow> {
    const title = input.title.trim();
    const body = input.body.trim().replace(/\r\n?/g, '\n');
    const startsAt = input.startsAt ? new Date(input.startsAt) : now;
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    const householdIds =
      input.audience === 'households'
        ? [...new Set((input.householdIds ?? []).map((id) => id.toLowerCase()))]
        : [];

    const problems: string[] = [];
    if (charCount(title) < 1 || charCount(title) > ANNOUNCEMENT_TITLE_MAX) {
      problems.push(`tytuł: 1–${ANNOUNCEMENT_TITLE_MAX} znaków`);
    }
    if (charCount(body) < 1 || charCount(body) > ANNOUNCEMENT_BODY_MAX) {
      problems.push(`treść: 1–${ANNOUNCEMENT_BODY_MAX} znaków`);
    }
    const titleProblem = plainTextProblem(title, false);
    if (titleProblem) problems.push(`tytuł: ${titleProblem}`);
    const bodyProblem = plainTextProblem(body, true);
    if (bodyProblem) problems.push(`treść: ${bodyProblem}`);
    if (endsAt && endsAt <= startsAt) {
      problems.push('koniec musi być po początku');
    }
    if (endsAt && endsAt <= now) problems.push('koniec musi być w przyszłości');
    if (input.audience === 'households' && householdIds.length === 0) {
      problems.push('wybierz co najmniej jeden dom');
    }
    if (problems.length > 0) throw invalid(problems);

    const created = await this.audit.run(
      actor,
      {
        action: 'announcements.create',
        targetType: 'AppAnnouncement',
        reason: input.reason,
        details: {
          title,
          severity: input.severity,
          audience: input.audience,
          households: householdIds.length,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt?.toISOString() ?? null,
          dismissible: input.dismissible,
        },
      },
      async () => {
        if (householdIds.length > 0) {
          const found = await this.prisma.household.count({
            where: { id: { in: householdIds } },
          });
          if (found !== householdIds.length) {
            throw invalid(['nie ma części wybranych domów']);
          }
        }
        // „Najwyżej 3 naraz” liczone ostrożnie: każdy niezakończony
        // komunikat, którego okno zachodzi na okno nowego.
        const overlapping = await this.prisma.appAnnouncement.count({
          where: {
            AND: [
              { OR: [{ endsAt: null }, { endsAt: { gt: startsAt } }] },
              { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
              ...(endsAt ? [{ startsAt: { lt: endsAt } }] : []),
            ],
          },
        });
        if (overlapping >= ANNOUNCEMENT_MAX_ACTIVE) {
          throw conflict(
            `W tym czasie są już ${overlapping} komunikaty — najwyżej ${ANNOUNCEMENT_MAX_ACTIVE} naraz. Zakończ któryś albo zmień termin.`,
          );
        }
        return this.prisma.appAnnouncement.create({
          data: {
            title,
            body,
            severity: input.severity,
            audience: input.audience,
            householdIds,
            startsAt,
            endsAt,
            dismissible: input.dismissible,
            createdBy: actor.adminEmail,
          },
        });
      },
      (row) => ({ id: row.id }),
    );
    await this.announcements.refresh();
    return toRow(created, now);
  }

  async end(
    actor: AdminActor,
    id: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<AnnouncementRow> {
    const ended = await this.audit.run(
      actor,
      {
        action: 'announcements.end',
        targetType: 'AppAnnouncement',
        targetId: id,
        reason,
      },
      async () => {
        const row = await this.prisma.appAnnouncement.findUnique({
          where: { id },
        });
        if (!row) {
          throw new AppException(
            'NOT_FOUND',
            'Nie ma takiego komunikatu.',
            HttpStatus.NOT_FOUND,
          );
        }
        if (announcementState(row, now) === 'ended') {
          throw conflict('Ten komunikat już się zakończył.');
        }
        return this.prisma.appAnnouncement.update({
          where: { id },
          data: {
            endsAt: now,
            // Zaplanowany, zakończony przed startem: puste okno.
            ...(row.startsAt > now ? { startsAt: now } : {}),
          },
        });
      },
    );
    await this.announcements.refresh();
    return toRow(ended, now);
  }
}
