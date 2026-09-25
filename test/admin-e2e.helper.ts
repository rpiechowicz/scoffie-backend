import { randomBytes } from 'crypto';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_MS,
  ADMIN_STEP_UP_MS,
  hashSessionToken,
} from '../src/admin/auth/admin-sessions.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Pomocnik e2e panelu administratora (`/admin/*`).
 *
 * Bramkę Access zastępuje obejście deweloperskie (`ADMIN_ACCESS_DEV_EMAIL`,
 * działa tylko poza produkcją i poza Railwayem), a sesję panelu — wiersz
 * `AdminSession` wstawiony wprost do bazy z ciasteczkiem, które niesie jego
 * token. Tak testy endpointów danych nie zależą od ceremonii WebAuthn;
 * samo logowanie ma własny zestaw (`admin-auth.e2e-spec.ts`).
 */
export const ADMIN_E2E_EMAIL = 'admin-e2e@scoffie.local';

const ADMIN_ENV_KEYS = [
  'ADMIN_ACCESS_DEV_EMAIL',
  'ADMIN_ACCESS_TEAM_DOMAIN',
  'ADMIN_ACCESS_AUD',
  'THROTTLE_ADMIN_LIMIT',
  'THROTTLE_ADMIN_AUTH_LIMIT',
  'THROTTLE_ADMIN_CODE_LIMIT',
] as const;

/** Obejście bramki na czas testu; zwraca funkcję przywracającą env. */
export function useAdminDevGate(email = ADMIN_E2E_EMAIL): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of ADMIN_ENV_KEYS) saved[key] = process.env[key];
  process.env.ADMIN_ACCESS_DEV_EMAIL = email;
  // Testy odpytują panel seriami — limit po bramce nie może ich dławić.
  // Wysoka liczba, nie 0: `readThrottleLimit` traktuje 0 jako błąd i wraca
  // do domyślnej, więc „0” po cichu zostawiało limity włączone.
  process.env.THROTTLE_ADMIN_LIMIT = '100000';
  process.env.THROTTLE_ADMIN_AUTH_LIMIT = '100000';
  process.env.THROTTLE_ADMIN_CODE_LIMIT = '100000';
  return () => {
    for (const key of ADMIN_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

export type AdminE2ESession = {
  adminUserId: string;
  sessionId: string;
  /** Wartość nagłówka `Cookie` do `supertest`. */
  cookie: string;
};

/**
 * Admin (tworzony, jeśli go nie ma) + otwarta sesja panelu. `stepUp` = sesja
 * ze świeżym potwierdzeniem (akcje, które bolą); `mustReenroll` = sesja
 * otwarta kodem odzyskiwania.
 */
export async function createAdminSession(
  prisma: PrismaService,
  options: {
    email?: string;
    role?: string;
    stepUp?: boolean;
    mustReenroll?: boolean;
  } = {},
): Promise<AdminE2ESession> {
  const email = (options.email ?? ADMIN_E2E_EMAIL).toLowerCase();
  const admin = await prisma.adminUser.upsert({
    where: { email },
    create: {
      email,
      displayName: 'Admin E2E',
      role: options.role ?? 'OWNER',
      webauthnUserId: randomBytes(32).toString('base64url'),
    },
    update: { role: options.role ?? 'OWNER', disabledAt: null },
    select: { id: true },
  });
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const session = await prisma.adminSession.create({
    data: {
      adminUserId: admin.id,
      tokenHash: hashSessionToken(token),
      method: 'passkey',
      mustReenroll: options.mustReenroll ?? false,
      stepUpUntil: options.stepUp ? new Date(now + ADMIN_STEP_UP_MS) : null,
      expiresAt: new Date(now + ADMIN_SESSION_MAX_MS),
    },
    select: { id: true },
  });
  return {
    adminUserId: admin.id,
    sessionId: session.id,
    cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
  };
}

/** Sprzątanie po teście: konta adminów z adresami testu (z sesjami i audytem). */
export async function cleanupAdmins(
  prisma: PrismaService,
  emails: string[] = [ADMIN_E2E_EMAIL],
): Promise<void> {
  const admins = await prisma.adminUser.findMany({
    where: { email: { in: emails.map((email) => email.toLowerCase()) } },
    select: { id: true },
  });
  const ids = admins.map((admin) => admin.id);
  await prisma.adminAuditLog.deleteMany({
    where: { adminUserId: { in: ids } },
  });
  await prisma.adminLoginAttempt.deleteMany({
    where: { email: { in: emails.map((email) => email.toLowerCase()) } },
  });
  await prisma.adminUser.deleteMany({ where: { id: { in: ids } } });
}
