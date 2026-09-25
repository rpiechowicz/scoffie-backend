import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type AdminAuditLog } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { isUuid } from '../../common/uuid';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditEntry, AuditPage, AuditResult } from '../contract';
import { AUDIT_PAGE_DEFAULT, type AdminAuditQueryDto } from './admin-audit.dto';

type Cursor = { at: Date; id: string };

/** Kursor = `createdAt` + `id` ostatniego wiersza strony, w base64url. */
export function encodeAuditCursor(cursor: Cursor): string {
  return Buffer.from(
    `${cursor.at.toISOString()}|${cursor.id}`,
    'utf8',
  ).toString('base64url');
}

export function decodeAuditCursor(raw: string): Cursor {
  const [iso, id, ...rest] = Buffer.from(raw, 'base64url')
    .toString('utf8')
    .split('|');
  const at = new Date(iso ?? '');
  if (
    rest.length > 0 ||
    !isUuid(id) ||
    Number.isNaN(at.getTime()) ||
    at.toISOString() !== iso
  ) {
    const detail = 'before must be a cursor from nextCursor';
    throw new AppException('VALIDATION_ERROR', detail, HttpStatus.BAD_REQUEST, [
      detail,
    ]);
  }
  return { at, id };
}

const RESULTS = new Set<string>(['PENDING', 'SUCCESS', 'FAILED']);

/** Wiersz `AdminAuditLog` → wpis kontraktu (Dziennik, historia wniosku RODO). */
export function toAuditEntry(r: AdminAuditLog): AuditEntry {
  return {
    id: r.id,
    at: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    adminEmail: r.adminEmail,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    result: (RESULTS.has(r.result) ? r.result : 'PENDING') as AuditResult,
    errorCode: r.errorCode,
    details:
      r.details && typeof r.details === 'object' && !Array.isArray(r.details)
        ? (r.details as Record<string, unknown>)
        : null,
    ip: r.ip,
    country: r.country,
  };
}

/**
 * Odczyt dziennika audytu panelu (ekran „Dziennik”). Najnowsze pierwsze,
 * stronicowanie kursorem po (`createdAt`, `id`) — stabilne mimo dopisywania
 * nowych wpisów w trakcie przeglądania.
 */
@Injectable()
export class AdminAuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async page(query: AdminAuditQueryDto): Promise<AuditPage> {
    const limit = query.limit ?? AUDIT_PAGE_DEFAULT;
    const cursor = query.before ? decodeAuditCursor(query.before) : null;

    const where: Prisma.AdminAuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.at } },
              { createdAt: cursor.at, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };

    const [rows, actions] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.prisma.adminAuditLog.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
      }),
    ]);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      entries: page.map(toAuditEntry),
      nextCursor:
        rows.length > limit && last
          ? encodeAuditCursor({ at: last.createdAt, id: last.id })
          : null,
      actions: actions.map((a) => a.action),
    };
  }
}
