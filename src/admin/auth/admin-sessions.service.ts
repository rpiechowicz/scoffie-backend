import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import type { AdminAccessContext } from '../admin-request';
import { sameAdminIdentity } from '../../config/admin-env';
import { emitLive } from '../../common/live-events';

/** Ciasteczko sesji: `__Host-` wymusza Secure, Path=/ i brak Domain. */
export const ADMIN_SESSION_COOKIE = '__Host-scoffie_admin';
/** Bezczynność, po której sesja umiera (ROADMAPA §4). 2 h od 26.09.2026 — 30 min wyrzucało z panelu kilka razy dziennie. */
export const ADMIN_SESSION_IDLE_MS = 2 * 60 * 60_000;
/** Twardy koniec sesji od jej otwarcia. */
export const ADMIN_SESSION_MAX_MS = 12 * 60 * 60_000;
/** Ważność ponownego potwierdzenia (step-up). */
export const ADMIN_STEP_UP_MS = 5 * 60_000;
/**
 * `lastSeenAt` zapisujemy najwyżej raz na minutę — panel odpytuje kilka
 * endpointów naraz, a zapis przy każdym żądaniu byłby czystym kosztem.
 * Bezczynność liczy się więc z dokładnością do tej minuty.
 */
const TOUCH_EVERY_MS = 60_000;

export const ADMIN_AUTH_METHODS = ['passkey', 'totp', 'recovery'] as const;
export type AdminAuthMethod = (typeof ADMIN_AUTH_METHODS)[number];

export type ResolvedAdminSession = {
  id: string;
  adminUserId: string;
  method: AdminAuthMethod;
  mustReenroll: boolean;
  stepUpUntil: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  admin: { id: string; email: string; displayName: string; role: string };
};

/** `GET /admin/auth/sessions` — kształt z API-AUTH.md. */
export type AdminSessionInfo = {
  id: string;
  current: boolean;
  method: AdminAuthMethod;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  country: string | null;
  userAgent: string | null;
};

const ADMIN_SELECT = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  disabledAt: true,
} as const;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function asMethod(value: string): AdminAuthMethod {
  return (ADMIN_AUTH_METHODS as readonly string[]).includes(value)
    ? (value as AdminAuthMethod)
    : 'passkey';
}

/** Surowa wartość ciasteczka z nagłówka `Cookie` (bez zależności od cookie-parsera). */
export function readCookie(
  req: Pick<Request, 'headers'>,
  name: string,
): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return value || null;
  }
  return null;
}

/**
 * `HttpOnly` (JS strony go nie widzi), `Secure` + prefiks `__Host-` (tylko
 * https i tylko ten host, bez `Domain`), `SameSite=Strict` (żadne żądanie
 * z obcej strony go nie niesie — to jest cała ochrona przed CSRF, bo panel
 * jest jednym pochodzeniem przez Workera). `Max-Age` = twardy koniec sesji.
 */
export function setSessionCookie(res: Response, token: string): void {
  res.append(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_MAX_MS / 1000}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.append(
    'Set-Cookie',
    `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  );
}

/**
 * Sesje panelu: w bazie hasz tokenu, w ciasteczku token. 2 godziny
 * bezczynności, 12 godzin twardo, związane z adresem z bramki Access —
 * ciasteczko przeniesione do przeglądarki zalogowanej w Access innym kontem
 * nie otwiera niczego.
 */
@Injectable()
export class AdminSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    adminUserId: string,
    method: AdminAuthMethod,
    access: AdminAccessContext,
    options: { mustReenroll?: boolean; stepUp?: boolean } = {},
    now: Date = new Date(),
  ): Promise<{ token: string; session: ResolvedAdminSession }> {
    const token = randomBytes(32).toString('base64url');
    const row = await this.prisma.adminSession.create({
      data: {
        adminUserId,
        tokenHash: hashSessionToken(token),
        method,
        mustReenroll: options.mustReenroll ?? false,
        // Świeże logowanie passkeyem albo TOTP JEST potwierdzeniem — bez
        // tego pierwsza groźna akcja zaraz po wejściu pytałaby drugi raz.
        stepUpUntil: options.stepUp
          ? new Date(now.getTime() + ADMIN_STEP_UP_MS)
          : null,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + ADMIN_SESSION_MAX_MS),
        ip: access.ip,
        country: access.country,
        userAgent: access.userAgent,
      },
      include: { admin: { select: ADMIN_SELECT } },
    });
    return { token, session: this.toResolved(row) };
  }

  /**
   * Sesja z ciasteczka albo `null`. Nie rzuca — co zrobić z brakiem sesji
   * (404, 403), decyduje guard.
   *
   * `touch: false` — sprawdzenie bez przesuwania `lastSeenAt`. Używa go kanał
   * na żywo przy ponownej walidacji co minutę: otwarta karta nie może
   * podtrzymywać sesji bez końca (bezczynność liczy się z żądań REST).
   */
  async resolve(
    req: Pick<Request, 'headers'>,
    accessEmail: string,
    now: Date = new Date(),
    options: { touch?: boolean } = {},
  ): Promise<ResolvedAdminSession | null> {
    const token = readCookie(req, ADMIN_SESSION_COOKIE);
    if (!token || token.length > 200) return null;
    const row = await this.prisma.adminSession.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { admin: { select: ADMIN_SELECT } },
    });
    if (!row || row.revokedAt) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    if (row.lastSeenAt.getTime() + ADMIN_SESSION_IDLE_MS <= now.getTime()) {
      return null;
    }
    if (row.admin.disabledAt) return null;
    if (!sameAdminIdentity(row.admin.email, accessEmail)) return null;

    if (
      options.touch !== false &&
      now.getTime() - row.lastSeenAt.getTime() >= TOUCH_EVERY_MS
    ) {
      await this.prisma.adminSession.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { lastSeenAt: now },
      });
      row.lastSeenAt = now;
    }
    return this.toResolved(row);
  }

  async markStepUp(sessionId: string, now: Date = new Date()): Promise<Date> {
    const until = new Date(now.getTime() + ADMIN_STEP_UP_MS);
    await this.prisma.adminSession.update({
      where: { id: sessionId },
      data: { stepUpUntil: until },
    });
    return until;
  }

  async clearMustReenroll(sessionId: string): Promise<void> {
    await this.prisma.adminSession.update({
      where: { id: sessionId },
      data: { mustReenroll: false },
    });
  }

  /** Aktywne sesje admina (niewylogowane, niewygasłe, niebezczynne). */
  async list(
    adminUserId: string,
    currentId: string,
    now: Date = new Date(),
  ): Promise<AdminSessionInfo[]> {
    const rows = await this.prisma.adminSession.findMany({
      where: {
        adminUserId,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: { gt: new Date(now.getTime() - ADMIN_SESSION_IDLE_MS) },
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      current: row.id === currentId,
      method: asMethod(row.method),
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      ip: row.ip,
      country: row.country,
      userAgent: row.userAgent,
    }));
  }

  /** `true`, gdy zgaszono sesję tego admina (cudzej nie da się dotknąć). */
  async revoke(
    adminUserId: string,
    sessionId: string,
    reason: 'LOGOUT' | 'REVOKED',
    now: Date = new Date(),
  ): Promise<boolean> {
    const { count } = await this.prisma.adminSession.updateMany({
      where: { id: sessionId, adminUserId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    if (count === 1) {
      // Kanał na żywo zamyka gniazda tej sesji od razu, nie przy walidacji.
      emitLive({
        topics: ['admin-sessions'],
        adminUserId,
        revokedAdminSessionId: sessionId,
      });
    }
    return count === 1;
  }

  private toResolved(row: {
    id: string;
    adminUserId: string;
    method: string;
    mustReenroll: boolean;
    stepUpUntil: Date | null;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
    admin: { id: string; email: string; displayName: string; role: string };
  }): ResolvedAdminSession {
    return {
      id: row.id,
      adminUserId: row.adminUserId,
      method: asMethod(row.method),
      mustReenroll: row.mustReenroll,
      stepUpUntil: row.stepUpUntil,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      admin: {
        id: row.admin.id,
        email: row.admin.email,
        displayName: row.admin.displayName,
        role: row.admin.role,
      },
    };
  }
}

export function stepUpValid(
  session: Pick<ResolvedAdminSession, 'stepUpUntil'>,
  now: Date = new Date(),
): boolean {
  return (
    session.stepUpUntil !== null &&
    session.stepUpUntil.getTime() > now.getTime()
  );
}
