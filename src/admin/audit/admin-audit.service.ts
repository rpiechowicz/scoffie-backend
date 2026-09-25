import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { PrismaService } from '../../prisma/prisma.service';
import type { AdminAccessContext } from '../admin-request';
import { AdminAuthException } from '../auth/admin-auth.errors';
import type { ResolvedAdminSession } from '../auth/admin-sessions.service';

/** Kto działa — kopiowane do każdego wpisu dziennika. */
export type AdminActor = {
  adminUserId: string | null;
  adminEmail: string;
  sessionId: string | null;
  ip: string | null;
  country: string | null;
  requestId: string | null;
};

export type AdminAuditEntry = {
  /** np. `household.tier.set`, `user.health.reveal`. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  /** Parametry akcji — bez danych osobowych i bez danych o zdrowiu. */
  details?: Record<string, unknown> | null;
};

export function adminActor(
  session: ResolvedAdminSession | null,
  access: AdminAccessContext,
): AdminActor {
  return {
    adminUserId: session?.adminUserId ?? null,
    adminEmail: session?.admin.email ?? access.email,
    sessionId: session?.id ?? null,
    ip: access.ip,
    country: access.country,
    requestId: access.requestId,
  };
}

/** Kod błędu do dziennika: kod kontraktu albo status HTTP. */
export function auditErrorCode(error: unknown): string {
  if (error instanceof AppException || error instanceof AdminAuthException) {
    return error.code;
  }
  if (error instanceof HttpException) return `HTTP_${error.getStatus()}`;
  return 'INTERNAL_ERROR';
}

const asJson = (
  value: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | undefined =>
  value
    ? (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue)
    : undefined;

/**
 * Dziennik audytu panelu (ROADMAPA §1.2) — tylko dopisywanie.
 *
 * `run` zapisuje wiersz `PENDING` PRZED skutkiem, a po nim domyka go na
 * `SUCCESS` albo `FAILED` z kodem błędu. Kolejność jest celowa: gdy nie da się
 * zapisać śladu, akcja w ogóle się nie wykonuje, a proces, który padnie w jej
 * połowie, zostawia wiersz `PENDING` — widać, że COŚ było robione. Zapis
 * „po fakcie" gubiłby dokładnie te przypadki.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    actor: AdminActor,
    entry: AdminAuditEntry,
    action: () => Promise<T>,
    summarize?: (result: T) => Record<string, unknown> | null,
  ): Promise<T> {
    const row = await this.prisma.adminAuditLog.create({
      data: { ...this.base(actor, entry), result: 'PENDING' },
      select: { id: true },
    });
    let result: T;
    try {
      result = await action();
    } catch (error) {
      await this.finish(row.id, {
        result: 'FAILED',
        errorCode: auditErrorCode(error),
      });
      throw error;
    }
    const outcome = summarize?.(result) ?? null;
    await this.finish(row.id, {
      result: 'SUCCESS',
      ...(outcome
        ? { details: asJson({ ...(entry.details ?? {}), ...outcome }) }
        : {}),
    });
    return result;
  }

  /** Zdarzenie jednorazowe (logowanie, wylogowanie) — od razu z wynikiem. */
  async record(
    actor: AdminActor,
    entry: AdminAuditEntry & {
      result: 'SUCCESS' | 'FAILED';
      errorCode?: string | null;
    },
  ): Promise<void> {
    await this.prisma.adminAuditLog.create({
      data: {
        ...this.base(actor, entry),
        result: entry.result,
        errorCode: entry.errorCode ?? null,
        finishedAt: new Date(),
      },
    });
  }

  private base(actor: AdminActor, entry: AdminAuditEntry) {
    return {
      adminUserId: actor.adminUserId,
      adminEmail: actor.adminEmail,
      sessionId: actor.sessionId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      reason: entry.reason?.trim() || null,
      details: asJson(entry.details),
      ip: actor.ip,
      country: actor.country,
      requestId: actor.requestId,
    };
  }

  /**
   * Domknięcie wpisu nigdy nie zmienia wyniku akcji: skutek już zaszedł, a
   * wiersz `PENDING` zostaje śladem. Błąd idzie do logu.
   */
  private async finish(
    id: string,
    data: {
      result: 'SUCCESS' | 'FAILED';
      errorCode?: string;
      details?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    try {
      await this.prisma.adminAuditLog.update({
        where: { id },
        data: { ...data, finishedAt: new Date() },
      });
    } catch (error) {
      this.logger.error(
        `nie domknięto wpisu audytu ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
