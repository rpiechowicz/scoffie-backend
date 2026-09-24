import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { AppException } from '../../common/app-exception';
import { decryptSecret, encryptSecret } from '../../common/crypto.util';
import { readAdminEnv, readAdminTotpKey } from '../../config/admin-env';
import { OpsAlertService } from '../../observability/ops-alert.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { AdminAccessContext } from '../admin-request';
import { adminActor, AdminAuditService } from '../audit/admin-audit.service';
import type {
  AdminPasskey,
  AdminSession as AdminSessionView,
  AuthState,
} from '../contract';
import { AdminAuthException } from './admin-auth.errors';
import { AdminLockoutService, type AttemptKind } from './admin-lockout.service';
import {
  AdminSessionsService,
  stepUpValid,
  type AdminAuthMethod,
  type ResolvedAdminSession,
} from './admin-sessions.service';
import { AdminWebAuthnService } from './admin-webauthn.service';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeKey,
} from './recovery-codes';
import { generateTotpSecret, matchTotpStep, otpauthUrl } from './totp';

/** Sekret TOTP w trakcie konfiguracji żyje najwyżej kwadrans. */
const TOTP_PENDING_TTL_MS = 15 * 60_000;
/** Nazwa wystawcy w aplikacji Authenticator. */
const TOTP_ISSUER = 'Scoffie Admin';
const PASSKEY_NAME_MAX = 40;

/** Wynik udanego wejścia: surowy token do ciasteczka + widok sesji dla panelu. */
export type OpenedSession = { token: string; view: AdminSessionView };

type AdminRow = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  webauthnUserId: string;
  disabledAt: Date | null;
};

const iso = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;

/** Nazwa klucza z formularza — przycięta, bez znaków sterujących, z zapasem. */
function passkeyName(raw: unknown): string {
  const text =
    typeof raw === 'string'
      ? raw
          .replace(/[\p{Cc}\p{Cf}]/gu, '')
          .trim()
          .slice(0, PASSKEY_NAME_MAX)
      : '';
  return text || 'Klucz';
}

/** „piechowicz.rafal98@…” → „Piechowicz Rafal” — do pierwszego konta, gdy nie podano imienia. */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  const words = local
    .split(/[._\-+]+/)
    .map((word) => word.replace(/\d+/g, ''))
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1));
  return words.join(' ') || 'Admin';
}

/**
 * Logowanie do panelu — warstwa 1 za bramką Cloudflare Access (ROADMAPA §4).
 *
 * Tożsamość z bramki (adres Google / Cloudflare) jest pierwszym składnikiem,
 * a ten serwis dokłada drugi: passkey (sam w sobie dwuskładnikowy — urządzenie
 * + biometria), kod TOTP albo — w ostateczności — jednorazowy kod
 * odzyskiwania, po którym sesja widzi wyłącznie konfigurację nowego wejścia.
 *
 * Zasady wspólne dla każdej ścieżki:
 *   - blokada 5 porażek / 15 min per adres i per IP liczona PRZED weryfikacją
 *     (`AdminLockoutService`), każda próba zostaje w `AdminLoginAttempt`,
 *   - wejście i każda zmiana sposobu logowania idzie do dziennika audytu,
 *   - każde udane logowanie budzi alert operatora (`OPS_ALERT_WEBHOOK_URL`),
 *     wejście kodem odzyskiwania — wyraźniejszy,
 *   - pierwsze konto zakłada wyłącznie `ADMIN_BOOTSTRAP_EMAIL` i tylko wtedy,
 *     gdy w bazie nie ma żadnego admina.
 */
@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: AdminSessionsService,
    private readonly lockout: AdminLockoutService,
    private readonly webauthn: AdminWebAuthnService,
    private readonly audit: AdminAuditService,
    private readonly alerts: OpsAlertService,
  ) {}

  // ——— stan przed zalogowaniem ———

  async state(access: AdminAccessContext): Promise<AuthState> {
    const [admin, lockedUntil] = await Promise.all([
      this.findAdmin(access.email),
      this.lockout.lockedUntil(access),
    ]);
    if (!admin) {
      return {
        email: access.email,
        bootstrap: await this.canBootstrap(access.email),
        methods: [],
        lockedUntil: iso(lockedUntil),
      };
    }
    const setup = await this.setupOf(admin.id);
    const keyReady = readAdminTotpKey() !== null;
    const methods: AuthState['methods'] = [];
    if (setup.passkeys > 0) methods.push('passkey');
    if (setup.totp && keyReady) methods.push('totp');
    if (setup.recoveryCodesLeft > 0 && keyReady) methods.push('recovery');
    return {
      email: access.email,
      bootstrap: false,
      methods,
      lockedUntil: iso(lockedUntil),
    };
  }

  /** `GET /admin/session` — to, co panel wie o bieżącej sesji. */
  async view(session: ResolvedAdminSession): Promise<AdminSessionView> {
    const setup = await this.setupOf(session.adminUserId);
    return {
      name: session.admin.displayName,
      email: session.admin.email,
      method: session.method,
      expiresAt: session.expiresAt.toISOString(),
      stepUpUntil: stepUpValid(session) ? iso(session.stepUpUntil) : null,
      setup,
      mustReenroll: session.mustReenroll,
    };
  }

  // ——— wejście ———

  async passkeyLoginOptions(
    access: AdminAccessContext,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const admin = await this.requireAdmin(access);
    await this.lockout.assertNotLocked(access, 'passkey', 'LOGIN', admin.id);
    return this.webauthn.authenticationOptions({
      email: access.email,
      adminUserId: admin.id,
      sessionId: null,
      purpose: 'LOGIN',
    });
  }

  async passkeyLogin(
    access: AdminAccessContext,
    response: AuthenticationResponseJSON,
  ): Promise<OpenedSession> {
    const admin = await this.requireAdmin(access);
    await this.lockout.assertNotLocked(access, 'passkey', 'LOGIN', admin.id);
    const verified = await this.webauthn.verifyAuthentication(response, {
      email: access.email,
      sessionId: null,
      adminUserId: admin.id,
      purpose: 'LOGIN',
    });
    if (!verified) {
      await this.failed(access, admin, 'passkey', 'LOGIN', 'PASSKEY_FAILED');
      throw new AdminAuthException('PASSKEY_FAILED');
    }
    return this.open(access, admin, 'passkey');
  }

  async totpLogin(
    access: AdminAccessContext,
    code: string,
  ): Promise<OpenedSession> {
    const key = this.requireTotpKey();
    const admin = await this.requireAdmin(access);
    await this.lockout.assertNotLocked(access, 'totp', 'LOGIN', admin.id);
    if (!(await this.claimTotp(admin.id, code, key))) {
      await this.failed(access, admin, 'totp', 'LOGIN', 'INVALID_CODE');
      throw new AdminAuthException('INVALID_CODE');
    }
    return this.open(access, admin, 'totp');
  }

  async recoveryLogin(
    access: AdminAccessContext,
    code: string,
  ): Promise<OpenedSession> {
    const key = this.requireTotpKey();
    const admin = await this.requireAdmin(access);
    await this.lockout.assertNotLocked(access, 'recovery', 'LOGIN', admin.id);
    const normalized = normalizeRecoveryCode(code);
    let used = false;
    if (normalized) {
      const { count } = await this.prisma.adminRecoveryCode.updateMany({
        where: {
          adminUserId: admin.id,
          codeHash: hashRecoveryCode(normalized, recoveryCodeKey(key)),
          usedAt: null,
        },
        data: { usedAt: new Date() },
      });
      used = count === 1;
    }
    if (!used) {
      await this.failed(access, admin, 'recovery', 'LOGIN', 'INVALID_CODE');
      throw new AdminAuthException('INVALID_CODE');
    }
    return this.open(access, admin, 'recovery');
  }

  // ——— passkeye ———

  /**
   * Opcje rejestracji passkeya. Bez sesji — wyłącznie pierwsze konto
   * (bootstrap); z sesją — kolejny klucz tego admina, co wymaga świeżego
   * potwierdzenia, chyba że sesja otwarta kodem odzyskiwania właśnie
   * odtwarza wejście.
   */
  async passkeyRegisterOptions(
    access: AdminAccessContext,
    session: ResolvedAdminSession | null,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if (!session) {
      if (!(await this.canBootstrap(access.email))) {
        throw new AdminAuthException('NOT_ALLOWED');
      }
      return this.webauthn.registrationOptions({
        email: access.email,
        admin: null,
        sessionId: null,
      });
    }
    this.requireFreshUnlessReenroll(session);
    const admin = await this.adminById(session.adminUserId);
    return this.webauthn.registrationOptions({
      email: access.email,
      admin: {
        id: admin.id,
        webauthnUserId: admin.webauthnUserId,
        displayName: admin.displayName,
      },
      sessionId: session.id,
    });
  }

  /**
   * Zapis passkeya. Przy bootstrapie w jednej transakcji powstaje konto,
   * klucz i — w kontrolerze — sesja; wyścig dwóch pierwszych wejść kończy
   * unikalność adresu (drugie dostaje `NOT_ALLOWED`).
   */
  async passkeyRegister(
    access: AdminAccessContext,
    session: ResolvedAdminSession | null,
    rawName: unknown,
    response: RegistrationResponseJSON,
  ): Promise<{ passkey: AdminPasskey; opened: OpenedSession | null }> {
    const name = passkeyName(rawName);
    if (session) this.requireFreshUnlessReenroll(session);
    const verified = await this.webauthn.verifyRegistration(response, {
      email: access.email,
      sessionId: session?.id ?? null,
    });
    if (!verified) {
      await this.audit.record(adminActor(session, access), {
        action: session ? 'auth.passkey.register' : 'auth.bootstrap',
        result: 'FAILED',
        errorCode: 'PASSKEY_FAILED',
      });
      throw new AdminAuthException('PASSKEY_FAILED');
    }
    const credentialData = {
      credentialId: verified.credentialId,
      publicKey: Uint8Array.from(verified.publicKey),
      counter: verified.counter,
      transports: verified.transports,
      deviceType: verified.deviceType,
      backedUp: verified.backedUp,
      name,
    };

    if (!session) {
      if (verified.adminUserId !== null) {
        throw new AdminAuthException('NOT_ALLOWED');
      }
      const created = await this.bootstrapAdmin(
        access,
        verified.webauthnUserId,
        credentialData,
      );
      const opened = await this.open(access, created.admin, 'passkey', {
        action: 'auth.bootstrap',
      });
      return { passkey: this.toPasskey(created.credential), opened };
    }

    if (verified.adminUserId !== session.adminUserId) {
      throw new AdminAuthException('NOT_ALLOWED');
    }
    const credential = await this.audit.run(
      adminActor(session, access),
      {
        action: 'auth.passkey.register',
        targetType: 'AdminCredential',
        details: { name },
      },
      () =>
        this.prisma.adminCredential.create({
          data: { ...credentialData, adminUserId: session.adminUserId },
        }),
      (row) => ({ credentialRowId: row.id }),
    );
    if (session.mustReenroll) await this.sessions.clearMustReenroll(session.id);
    return { passkey: this.toPasskey(credential), opened: null };
  }

  async passkeys(session: ResolvedAdminSession): Promise<AdminPasskey[]> {
    const rows = await this.prisma.adminCredential.findMany({
      where: { adminUserId: session.adminUserId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toPasskey(row));
  }

  /** Usunięcie klucza — nigdy ostatniego sposobu wejścia (passkey albo TOTP). */
  async deletePasskey(
    access: AdminAccessContext,
    session: ResolvedAdminSession,
    id: string,
  ): Promise<void> {
    const credential = await this.prisma.adminCredential.findFirst({
      where: { id, adminUserId: session.adminUserId },
      select: { id: true, name: true },
    });
    if (!credential) {
      throw new AppException(
        'NOT_FOUND',
        'Nie ma takiego klucza.',
        HttpStatus.NOT_FOUND,
      );
    }
    const setup = await this.setupOf(session.adminUserId);
    if (setup.passkeys <= 1 && !setup.totp) {
      throw new AdminAuthException('LAST_METHOD');
    }
    await this.audit.run(
      adminActor(session, access),
      {
        action: 'auth.passkey.delete',
        targetType: 'AdminCredential',
        targetId: credential.id,
        details: { name: credential.name },
      },
      () =>
        this.prisma.adminCredential.deleteMany({
          where: { id: credential.id, adminUserId: session.adminUserId },
        }),
    );
  }

  // ——— TOTP i kody odzyskiwania ———

  /** Nowy sekret TOTP (czeka na pierwszy kod). Zmiana działającego wymaga step-upu. */
  async totpSetup(
    access: AdminAccessContext,
    session: ResolvedAdminSession,
  ): Promise<{ otpauthUrl: string; secret: string }> {
    const key = this.requireTotpKey();
    const existing = await this.prisma.adminTotp.findUnique({
      where: { adminUserId: session.adminUserId },
      select: { confirmedAt: true },
    });
    if (existing?.confirmedAt) this.requireFreshUnlessReenroll(session);
    const secret = generateTotpSecret();
    const pendingSecretEncrypted = encryptSecret(secret, key);
    await this.prisma.adminTotp.upsert({
      where: { adminUserId: session.adminUserId },
      create: {
        adminUserId: session.adminUserId,
        pendingSecretEncrypted,
        pendingCreatedAt: new Date(),
      },
      update: { pendingSecretEncrypted, pendingCreatedAt: new Date() },
    });
    await this.audit.record(adminActor(session, access), {
      action: 'auth.totp.setup',
      result: 'SUCCESS',
    });
    return {
      otpauthUrl: otpauthUrl({
        secret,
        issuer: TOTP_ISSUER,
        account: session.admin.email,
      }),
      secret,
    };
  }

  /**
   * Pierwszy kod z aplikacji włącza sekret. Kody odzyskiwania wracają tylko
   * wtedy, gdy konto nie ma już żadnego niewykorzystanego.
   */
  async totpConfirm(
    access: AdminAccessContext,
    session: ResolvedAdminSession,
    code: string,
  ): Promise<{ recoveryCodes: string[] | null }> {
    const key = this.requireTotpKey();
    const row = await this.prisma.adminTotp.findUnique({
      where: { adminUserId: session.adminUserId },
    });
    const pendingFresh =
      row?.pendingSecretEncrypted &&
      row.pendingCreatedAt &&
      Date.now() - row.pendingCreatedAt.getTime() < TOTP_PENDING_TTL_MS;
    if (!row || !pendingFresh || !row.pendingSecretEncrypted) {
      throw new AdminAuthException(
        'INVALID_CODE',
        'Kod z aplikacji wygasł — zacznij konfigurację od nowa.',
      );
    }
    const secret = decryptSecret(row.pendingSecretEncrypted, key);
    const step = matchTotpStep(secret, code, Date.now(), null);
    if (step === null) throw new AdminAuthException('INVALID_CODE');

    const recoveryCodes = await this.audit.run(
      adminActor(session, access),
      { action: 'auth.totp.enable' },
      async () => {
        await this.prisma.adminTotp.update({
          where: { adminUserId: session.adminUserId },
          data: {
            secretEncrypted: row.pendingSecretEncrypted,
            confirmedAt: new Date(),
            lastUsedStep: step,
            pendingSecretEncrypted: null,
            pendingCreatedAt: null,
          },
        });
        const left = await this.prisma.adminRecoveryCode.count({
          where: { adminUserId: session.adminUserId, usedAt: null },
        });
        return left > 0
          ? null
          : this.issueRecoveryCodes(session.adminUserId, key);
      },
      (codes) => ({ recoveryCodesIssued: codes?.length ?? 0 }),
    );
    if (session.mustReenroll) await this.sessions.clearMustReenroll(session.id);
    return { recoveryCodes };
  }

  /** Nowy komplet kodów — stare przestają działać. Wymaga step-upu (guard). */
  async regenerateRecoveryCodes(
    access: AdminAccessContext,
    session: ResolvedAdminSession,
  ): Promise<{ recoveryCodes: string[] }> {
    const key = this.requireTotpKey();
    const recoveryCodes = await this.audit.run(
      adminActor(session, access),
      { action: 'auth.recovery.regenerate' },
      () => this.issueRecoveryCodes(session.adminUserId, key),
      (codes) => ({ recoveryCodesIssued: codes.length }),
    );
    return { recoveryCodes };
  }

  // ——— step-up ———

  async stepUpOptions(
    access: AdminAccessContext,
    session: ResolvedAdminSession,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    await this.lockout.assertNotLocked(
      access,
      'passkey',
      'STEP_UP',
      session.adminUserId,
    );
    return this.webauthn.authenticationOptions({
      email: access.email,
      adminUserId: session.adminUserId,
      sessionId: session.id,
      purpose: 'STEP_UP',
    });
  }

  async stepUp(
    access: AdminAccessContext,
    session: ResolvedAdminSession,
    proof: { passkey?: AuthenticationResponseJSON; totp?: string },
  ): Promise<{ stepUpUntil: string }> {
    const method: AdminAuthMethod = proof.passkey ? 'passkey' : 'totp';
    const admin = await this.adminById(session.adminUserId);
    await this.lockout.assertNotLocked(access, method, 'STEP_UP', admin.id);
    let ok = false;
    if (proof.passkey) {
      ok =
        (await this.webauthn.verifyAuthentication(proof.passkey, {
          email: access.email,
          sessionId: session.id,
          adminUserId: admin.id,
          purpose: 'STEP_UP',
        })) !== null;
    } else if (typeof proof.totp === 'string') {
      ok = await this.claimTotp(admin.id, proof.totp, this.requireTotpKey());
    }
    if (!ok) {
      const code = method === 'passkey' ? 'PASSKEY_FAILED' : 'INVALID_CODE';
      await this.failed(access, admin, method, 'STEP_UP', code, session);
      throw new AdminAuthException(code);
    }
    await this.lockout.record(access, method, 'STEP_UP', 'SUCCESS', admin.id);
    const until = await this.sessions.markStepUp(session.id);
    await this.audit.record(adminActor(session, access), {
      action: 'auth.step-up',
      result: 'SUCCESS',
      details: { method },
    });
    return { stepUpUntil: until.toISOString() };
  }

  // ——— sesje ———

  async revokeSession(
    access: AdminAccessContext,
    session: ResolvedAdminSession,
    id: string,
  ): Promise<{ current: boolean }> {
    const current = id === session.id;
    const revoked = await this.sessions.revoke(
      session.adminUserId,
      id,
      current ? 'LOGOUT' : 'REVOKED',
    );
    if (!revoked) {
      throw new AppException(
        'NOT_FOUND',
        'Nie ma takiej sesji.',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.audit.record(adminActor(session, access), {
      action: current ? 'auth.logout' : 'auth.session.revoke',
      targetType: 'AdminSession',
      targetId: id,
      result: 'SUCCESS',
    });
    return { current };
  }

  async logout(
    access: AdminAccessContext,
    session: ResolvedAdminSession | null,
  ): Promise<void> {
    if (!session) return;
    await this.sessions.revoke(session.adminUserId, session.id, 'LOGOUT');
    await this.audit.record(adminActor(session, access), {
      action: 'auth.logout',
      targetType: 'AdminSession',
      targetId: session.id,
      result: 'SUCCESS',
    });
  }

  // ——— pomocnicze ———

  private async open(
    access: AdminAccessContext,
    admin: AdminRow,
    method: AdminAuthMethod,
    options: { action?: string } = {},
  ): Promise<OpenedSession> {
    const recovery = method === 'recovery';
    const { token, session } = await this.sessions.create(
      admin.id,
      method,
      access,
      // Passkey i TOTP to świeże potwierdzenie; kod odzyskiwania — nie, a do
      // tego zamyka sesję w konfiguracji nowego wejścia.
      { mustReenroll: recovery, stepUp: !recovery },
    );
    await this.lockout.record(access, method, 'LOGIN', 'SUCCESS', admin.id);
    await this.audit.record(adminActor(session, access), {
      action: options.action ?? 'auth.login',
      targetType: 'AdminSession',
      targetId: session.id,
      result: 'SUCCESS',
      details: { method, via: access.via },
    });
    const where = [access.country, access.ip].filter(Boolean).join(', ');
    void this.alerts.notify(
      `admin-login:${session.id}`,
      recovery
        ? `UWAGA: wejście do panelu KODEM ODZYSKIWANIA (${admin.email}${where ? `, ${where}` : ''}).`
        : `Logowanie do panelu: ${admin.email}, ${method}${where ? ` (${where})` : ''}.`,
    );
    return { token, view: await this.view(session) };
  }

  private async failed(
    access: AdminAccessContext,
    admin: AdminRow,
    method: AdminAuthMethod,
    kind: AttemptKind,
    reason: string,
    session: ResolvedAdminSession | null = null,
  ): Promise<void> {
    await this.lockout.record(access, method, kind, 'FAILED', admin.id, reason);
    await this.audit.record(adminActor(session, access), {
      action: kind === 'LOGIN' ? 'auth.login' : 'auth.step-up',
      result: 'FAILED',
      errorCode: reason,
      details: { method },
    });
  }

  /**
   * Kod TOTP: dopasowanie kroku (okno ±1, bez kroków już zużytych) i PRZEJĘCIE
   * go warunkowym zapisem — dwa równoległe żądania z tym samym kodem nie
   * przejdą oba.
   */
  private async claimTotp(
    adminUserId: string,
    code: string,
    key: Buffer,
  ): Promise<boolean> {
    const row = await this.prisma.adminTotp.findUnique({
      where: { adminUserId },
      select: { secretEncrypted: true, confirmedAt: true, lastUsedStep: true },
    });
    if (!row?.secretEncrypted || !row.confirmedAt) return false;
    let secret: string;
    try {
      secret = decryptSecret(row.secretEncrypted, key);
    } catch (error) {
      this.logger.error(
        `nie da się odszyfrować TOTP admina: ${error instanceof Error ? error.message : 'błąd'}`,
      );
      return false;
    }
    const step = matchTotpStep(secret, code, Date.now(), row.lastUsedStep);
    if (step === null) return false;
    const { count } = await this.prisma.adminTotp.updateMany({
      where: {
        adminUserId,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
      },
      data: { lastUsedStep: step },
    });
    return count === 1;
  }

  private async issueRecoveryCodes(
    adminUserId: string,
    key: Buffer,
  ): Promise<string[]> {
    const codes = generateRecoveryCodes();
    const hmacKey = recoveryCodeKey(key);
    await this.prisma.$transaction([
      this.prisma.adminRecoveryCode.deleteMany({ where: { adminUserId } }),
      this.prisma.adminRecoveryCode.createMany({
        data: codes.map((code) => ({
          adminUserId,
          codeHash: hashRecoveryCode(
            normalizeRecoveryCode(code) ?? code,
            hmacKey,
          ),
        })),
      }),
    ]);
    return codes;
  }

  private async bootstrapAdmin(
    access: AdminAccessContext,
    webauthnUserId: string,
    credential: {
      credentialId: string;
      publicKey: Uint8Array<ArrayBuffer>;
      counter: number;
      transports: string[];
      deviceType: string;
      backedUp: boolean;
      name: string;
    },
  ): Promise<{
    admin: AdminRow;
    credential: {
      id: string;
      name: string;
      createdAt: Date;
      lastUsedAt: Date | null;
    };
  }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if ((await tx.adminUser.count()) > 0) {
          throw new AdminAuthException('NOT_ALLOWED');
        }
        const admin = await tx.adminUser.create({
          data: {
            email: access.email,
            displayName:
              (process.env.ADMIN_BOOTSTRAP_NAME ?? '').trim().slice(0, 60) ||
              nameFromEmail(access.email),
            role: 'OWNER',
            webauthnUserId,
          },
        });
        const row = await tx.adminCredential.create({
          data: { ...credential, adminUserId: admin.id },
        });
        return { admin, credential: row };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AdminAuthException('NOT_ALLOWED');
      }
      throw error;
    }
  }

  private async canBootstrap(email: string): Promise<boolean> {
    const bootstrapEmail = readAdminEnv().bootstrapEmail;
    if (!bootstrapEmail || bootstrapEmail !== email) return false;
    return (await this.prisma.adminUser.count()) === 0;
  }

  private async findAdmin(email: string): Promise<AdminRow | null> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    return admin && !admin.disabledAt ? admin : null;
  }

  /** Admin z bramki albo 403 — bramka przepuściła człowieka, który kontem panelu nie jest. */
  private async requireAdmin(access: AdminAccessContext): Promise<AdminRow> {
    const admin = await this.findAdmin(access.email);
    if (!admin) throw new AdminAuthException('NOT_ALLOWED');
    return admin;
  }

  private async adminById(id: string): Promise<AdminRow> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin || admin.disabledAt) throw new AdminAuthException('NOT_ALLOWED');
    return admin;
  }

  private async setupOf(
    adminUserId: string,
  ): Promise<AdminSessionView['setup']> {
    const [passkeys, totp, recoveryCodesLeft] = await Promise.all([
      this.prisma.adminCredential.count({ where: { adminUserId } }),
      this.prisma.adminTotp.findUnique({
        where: { adminUserId },
        select: { confirmedAt: true, secretEncrypted: true },
      }),
      this.prisma.adminRecoveryCode.count({
        where: { adminUserId, usedAt: null },
      }),
    ]);
    return {
      passkeys,
      totp: Boolean(totp?.confirmedAt && totp.secretEncrypted),
      recoveryCodesLeft,
    };
  }

  private requireTotpKey(): Buffer {
    const key = readAdminTotpKey();
    if (!key) {
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        'Kody z aplikacji nie są skonfigurowane (ADMIN_TOTP_ENCRYPTION_KEY).',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return key;
  }

  /**
   * Zmiana sposobu wejścia wymaga świeżego potwierdzenia — poza sesją
   * otwartą kodem odzyskiwania, której jedynym celem jest właśnie odtworzenie
   * wejścia (i która passkeyem ani TOTP potwierdzić się nie może).
   */
  private requireFreshUnlessReenroll(session: ResolvedAdminSession): void {
    if (session.mustReenroll) return;
    if (!stepUpValid(session)) {
      throw new AdminAuthException('STEP_UP_REQUIRED');
    }
  }

  private toPasskey(row: {
    id: string;
    name: string;
    createdAt: Date;
    lastUsedAt: Date | null;
  }): AdminPasskey {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: iso(row.lastUsedAt),
    };
  }
}
