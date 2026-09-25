import { randomUUID } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { GdprRequest, Prisma } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import { toAuditEntry } from '../audit/admin-audit-log.service';
import type {
  GdprChannel,
  GdprData,
  GdprKind,
  GdprRequestDetail,
  GdprRequestRow,
  GdprStatus,
} from '../contract';
import type {
  AdminGdprCloseDto,
  AdminGdprCreateDto,
  AdminGdprQueryDto,
  AdminGdprUpdateDto,
} from './admin-gdpr.dto';
import {
  GDPR_CHANNELS,
  GDPR_KINDS,
  GDPR_OPEN_STATUSES,
  GDPR_STATUSES,
  GDPR_WARN_DAYS,
  gdprDueAt,
  gdprExtendedDueAt,
  isGdprOpen,
} from './gdpr-rules';

const DAY_MS = 24 * 60 * 60_000;
/** Sufit listy — rejestr to dziesiątki wpisów rocznie, nie tysiące. */
const LIST_LIMIT = 500;
/** Wniosek „z przyszłości” to pomyłka; kilka minut zapasu na zegary. */
const FUTURE_SKEW_MS = 5 * 60_000;
/** Starszy wniosek niż rok wstecz to pomyłka w dacie, nie zaległość. */
const MAX_BACKDATE_MS = 366 * DAY_MS;
/** Historia z dziennika na szczególe. */
const HISTORY_LIMIT = 200;

const TARGET = 'GdprRequest';

type RowWithUser = GdprRequest & { user: { displayName: string } | null };

const oneOf = <T extends string>(values: readonly T[], value: string, d: T) =>
  (values as readonly string[]).includes(value) ? (value as T) : d;

function toRow(r: RowWithUser): GdprRequestRow {
  return {
    id: r.id,
    kind: oneOf<GdprKind>(GDPR_KINDS, r.kind, 'ACCESS'),
    status: oneOf<GdprStatus>(GDPR_STATUSES, r.status, 'OPEN'),
    receivedAt: r.receivedAt.toISOString(),
    dueAt: r.dueAt.toISOString(),
    extended: r.extendedAt !== null,
    requesterEmail: r.requesterEmail,
    userId: r.userId,
    userName: r.user?.displayName ?? null,
    channel: oneOf<GdprChannel>(GDPR_CHANNELS, r.channel, 'OTHER'),
    closedAt: r.closedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Nie ma takiego wniosku.',
    HttpStatus.NOT_FOUND,
  );
}

function conflict(message: string): AppException {
  return new AppException('CONFLICT', message, HttpStatus.CONFLICT);
}

/**
 * Rejestr wniosków RODO (ROADMAPA §5.11) — zastępuje prywatny arkusz
 * z `docs/rodo-wnioski.md` §5.
 *
 * Każdy zapis przez dziennik audytu, ale w dzienniku WYŁĄCZNIE id wniosku
 * i parametry (rodzaj, kanał, stan) — adres wnioskodawcy to dane osobowe
 * i zostaje w tej jednej tabeli. Sam rejestr nie wykonuje eksportu ani
 * usunięcia: to istniejące akcje na karcie osoby (z własnym audytem
 * i step-upem), do których panel linkuje z wniosku.
 *
 * Zmiany stanu to warunkowe `updateMany` — dwa okna panelu naraz nie
 * zamkną wniosku dwa razy ani nie przedłużą go podwójnie.
 */
@Injectable()
export class AdminGdprService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(
    query: AdminGdprQueryDto,
    now: Date = new Date(),
  ): Promise<GdprData> {
    const state = query.state ?? 'open';
    const open = [...GDPR_OPEN_STATUSES];
    const where: Prisma.GdprRequestWhereInput = {
      ...(state === 'open' ? { status: { in: open } } : {}),
      ...(state === 'closed' ? { status: { notIn: open } } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    };
    const soon = new Date(now.getTime() + GDPR_WARN_DAYS * DAY_MS);
    const [rows, openCount, dueSoon, overdue, closed30d] = await Promise.all([
      this.prisma.gdprRequest.findMany({
        where,
        include: { user: { select: { displayName: true } } },
        orderBy:
          state === 'open'
            ? [{ dueAt: 'asc' }, { id: 'asc' }]
            : [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: LIST_LIMIT,
      }),
      this.prisma.gdprRequest.count({ where: { status: { in: open } } }),
      this.prisma.gdprRequest.count({
        where: { status: { in: open }, dueAt: { gte: now, lt: soon } },
      }),
      this.prisma.gdprRequest.count({
        where: { status: { in: open }, dueAt: { lt: now } },
      }),
      this.prisma.gdprRequest.count({
        where: {
          status: { notIn: open },
          closedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) },
        },
      }),
    ]);
    return {
      stats: { open: openCount, dueSoon, overdue, closed30d },
      items: rows.map(toRow),
    };
  }

  async detail(id: string): Promise<GdprRequestDetail> {
    const [row, history] = await Promise.all([
      this.prisma.gdprRequest.findUnique({
        where: { id },
        include: { user: { select: { displayName: true } } },
      }),
      this.prisma.adminAuditLog.findMany({
        where: { targetType: TARGET, targetId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: HISTORY_LIMIT,
      }),
    ]);
    if (!row) throw notFound();
    return {
      ...toRow(row),
      notes: row.notes,
      extensionReason: row.extensionReason,
      resolution: row.resolution,
      closedBy: row.closedBy,
      history: history.map(toAuditEntry),
    };
  }

  async create(
    actor: AdminActor,
    dto: AdminGdprCreateDto,
    now: Date = new Date(),
  ): Promise<GdprRequestDetail> {
    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : now;
    if (receivedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
      throw validation('receivedAt nie może być z przyszłości');
    }
    if (now.getTime() - receivedAt.getTime() > MAX_BACKDATE_MS) {
      throw validation('receivedAt starszy niż rok — sprawdź datę');
    }
    if (dto.userId) await this.assertUser(dto.userId);

    // Id z góry: wpis dziennika od początku wskazuje wniosek (historia).
    const id = randomUUID();
    await this.audit.run(
      actor,
      {
        action: 'gdpr.create',
        targetType: TARGET,
        targetId: id,
        details: {
          kind: dto.kind,
          channel: dto.channel,
          linked: Boolean(dto.userId),
        },
      },
      () =>
        this.prisma.gdprRequest.create({
          data: {
            id,
            kind: dto.kind,
            channel: dto.channel,
            receivedAt,
            dueAt: gdprDueAt(receivedAt),
            requesterEmail: dto.requesterEmail,
            userId: dto.userId ?? null,
            notes: dto.notes ?? null,
            createdBy: actor.adminEmail,
          },
          select: { id: true },
        }),
    );
    return this.detail(id);
  }

  async update(
    actor: AdminActor,
    id: string,
    dto: AdminGdprUpdateDto,
  ): Promise<GdprRequestDetail> {
    const data: Prisma.GdprRequestUncheckedUpdateInput = {};
    if (dto.userId !== undefined) {
      if (dto.userId) await this.assertUser(dto.userId);
      data.userId = dto.userId;
    }
    if (dto.notes !== undefined) data.notes = dto.notes;
    const fields = Object.keys(data);
    if (fields.length === 0) return this.detail(id);

    await this.audit.run(
      actor,
      {
        action: 'gdpr.update',
        targetType: TARGET,
        targetId: id,
        // Które pola, nie wartości — notatka może nieść dane osoby.
        details: {
          fields,
          ...(dto.userId !== undefined ? { linked: Boolean(dto.userId) } : {}),
        },
      },
      async () => {
        const { count } = await this.prisma.gdprRequest.updateMany({
          where: { id },
          data,
        });
        if (count === 0) throw notFound();
      },
    );
    return this.detail(id);
  }

  /** OPEN ↔ IN_PROGRESS. Zamknięty wniosek nie wraca — nowy wniosek to nowy wpis. */
  async setStatus(
    actor: AdminActor,
    id: string,
    status: 'OPEN' | 'IN_PROGRESS',
  ): Promise<GdprRequestDetail> {
    await this.audit.run(
      actor,
      {
        action: 'gdpr.status',
        targetType: TARGET,
        targetId: id,
        details: { status },
      },
      async () => {
        const { count } = await this.prisma.gdprRequest.updateMany({
          where: { id, status: { in: [...GDPR_OPEN_STATUSES] } },
          data: { status },
        });
        if (count === 0) {
          await this.assertExists(id);
          throw conflict('Wniosek jest już zamknięty.');
        }
      },
    );
    return this.detail(id);
  }

  /**
   * Przedłużenie o 60 dni (art. 12 ust. 3): raz, na otwartym wniosku
   * i PRZED pierwotnym terminem — o przedłużeniu trzeba poinformować osobę
   * w pierwszym miesiącu, więc po terminie przedłużać już nie wolno.
   * Uzasadnienie zostaje przy wniosku i jako powód w dzienniku.
   */
  async extend(
    actor: AdminActor,
    id: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<GdprRequestDetail> {
    await this.audit.run(
      actor,
      {
        action: 'gdpr.extend',
        targetType: TARGET,
        targetId: id,
        reason,
        details: { days: 60 },
      },
      async () => {
        const row = await this.prisma.gdprRequest.findUnique({
          where: { id },
          select: { receivedAt: true, dueAt: true, status: true },
        });
        if (!row) throw notFound();
        if (!isGdprOpen(row.status)) {
          throw conflict('Wniosek jest już zamknięty.');
        }
        if (row.dueAt.getTime() < now.getTime()) {
          throw conflict(
            'Termin minął — przedłużenie trzeba zgłosić przed jego upływem.',
          );
        }
        const { count } = await this.prisma.gdprRequest.updateMany({
          where: {
            id,
            extendedAt: null,
            status: { in: [...GDPR_OPEN_STATUSES] },
          },
          data: {
            extendedAt: now,
            extensionReason: reason,
            dueAt: gdprExtendedDueAt(row.receivedAt),
          },
        });
        if (count === 0) throw conflict('Wniosek był już przedłużony.');
      },
    );
    return this.detail(id);
  }

  /** DONE / REJECTED z odpowiedzią — ta sama treść idzie jako powód do dziennika. */
  async close(
    actor: AdminActor,
    id: string,
    dto: AdminGdprCloseDto,
    now: Date = new Date(),
  ): Promise<GdprRequestDetail> {
    await this.audit.run(
      actor,
      {
        action: 'gdpr.close',
        targetType: TARGET,
        targetId: id,
        reason: dto.resolution,
        details: { status: dto.status },
      },
      async () => {
        const { count } = await this.prisma.gdprRequest.updateMany({
          where: { id, status: { in: [...GDPR_OPEN_STATUSES] } },
          data: {
            status: dto.status,
            resolution: dto.resolution,
            closedAt: now,
            closedBy: actor.adminEmail,
          },
        });
        if (count === 0) {
          await this.assertExists(id);
          throw conflict('Wniosek jest już zamknięty.');
        }
      },
    );
    return this.detail(id);
  }

  private async assertExists(id: string): Promise<void> {
    const row = await this.prisma.gdprRequest.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!row) throw notFound();
  }

  private async assertUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw validation('userId: nie ma takiego konta');
  }
}

function validation(detail: string): AppException {
  return new AppException('VALIDATION_ERROR', detail, HttpStatus.BAD_REQUEST, [
    detail,
  ]);
}
