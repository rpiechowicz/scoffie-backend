import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AdminAccessContext } from '../admin-request';
import { AdminAuthException } from './admin-auth.errors';
import type { AdminAuthMethod } from './admin-sessions.service';

/** 5 nieudanych prób w 15 minut — per adres z bramki i per IP (ROADMAPA §4). */
export const ADMIN_LOCK_MAX_FAILURES = 5;
export const ADMIN_LOCK_WINDOW_MS = 15 * 60_000;

export type AttemptKind = 'LOGIN' | 'STEP_UP';

/**
 * Blokada logowania i step-upu.
 *
 * Liczy się z `AdminLoginAttempt`, nie z pamięci procesu: deploy w trakcie
 * zgadywania nie może zerować licznika. Udane wejście z danego adresu
 * zeruje JEGO licznik (liczą się porażki po ostatnim sukcesie), więc admin,
 * który raz się pomylił, nie wlecze tego przez kwadrans.
 *
 * Step-up liczy się razem z logowaniem: ukradzione ciasteczko sesji nie może
 * służyć do zgadywania kodu TOTP przez `POST /admin/auth/step-up`.
 *
 * Żądanie odrzucone blokadą zostaje zapisane (`LOCKED`), ale nie przedłuża
 * blokady — ta kończy się kwadrans po piątej porażce, jak obiecuje
 * `lockedUntil`.
 */
@Injectable()
export class AdminLockoutService {
  constructor(private readonly prisma: PrismaService) {}

  async lockedUntil(
    access: Pick<AdminAccessContext, 'email' | 'ip'>,
    now: Date = new Date(),
  ): Promise<Date | null> {
    const keys: Prisma.AdminLoginAttemptWhereInput[] = [
      { email: access.email },
    ];
    if (access.ip) keys.push({ ip: access.ip });
    let until: Date | null = null;
    for (const key of keys) {
      const candidate = await this.lockedUntilFor(key, now);
      if (candidate && (!until || candidate > until)) until = candidate;
    }
    return until;
  }

  private async lockedUntilFor(
    key: Prisma.AdminLoginAttemptWhereInput,
    now: Date,
  ): Promise<Date | null> {
    const windowStart = new Date(now.getTime() - ADMIN_LOCK_WINDOW_MS);
    const lastSuccess = await this.prisma.adminLoginAttempt.findFirst({
      where: { ...key, result: 'SUCCESS', createdAt: { gt: windowStart } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const since = lastSuccess?.createdAt ?? windowStart;
    const failures = await this.prisma.adminLoginAttempt.findMany({
      where: { ...key, result: 'FAILED', createdAt: { gt: since } },
      orderBy: { createdAt: 'desc' },
      take: ADMIN_LOCK_MAX_FAILURES,
      select: { createdAt: true },
    });
    if (failures.length < ADMIN_LOCK_MAX_FAILURES) return null;
    // Blokada trwa, dopóki piąta od końca porażka nie wypadnie z okna.
    const fifth = failures[ADMIN_LOCK_MAX_FAILURES - 1];
    const until = new Date(fifth.createdAt.getTime() + ADMIN_LOCK_WINDOW_MS);
    return until > now ? until : null;
  }

  /** Rzuca 429 `LOCKED` (z `lockedUntil`) i odnotowuje odrzuconą próbę. */
  async assertNotLocked(
    access: AdminAccessContext,
    method: AdminAuthMethod,
    kind: AttemptKind,
    adminUserId: string | null,
    now: Date = new Date(),
  ): Promise<void> {
    const until = await this.lockedUntil(access, now);
    if (!until) return;
    await this.record(access, method, kind, 'LOCKED', adminUserId, 'LOCKED');
    throw new AdminAuthException('LOCKED', undefined, { lockedUntil: until });
  }

  async record(
    access: AdminAccessContext,
    method: AdminAuthMethod,
    kind: AttemptKind,
    result: 'SUCCESS' | 'FAILED' | 'LOCKED',
    adminUserId: string | null,
    reason: string | null = null,
  ): Promise<void> {
    await this.prisma.adminLoginAttempt.create({
      data: {
        email: access.email,
        adminUserId,
        ip: access.ip,
        country: access.country,
        userAgent: access.userAgent,
        method,
        kind,
        result,
        reason,
      },
    });
  }
}
