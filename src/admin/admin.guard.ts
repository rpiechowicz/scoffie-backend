import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { readThrottleLimit } from '../common/throttle/throttle-env';
import {
  ACCESS_JWT_HEADER,
  AccessJwtVerifier,
} from './access/access-jwt.verifier';
import { accessGateConfigured, readAdminEnv } from '../config/admin-env';
import { AdminRateLimiter } from './admin-rate-limiter';
import {
  AdminAccessContext,
  AdminRequest,
  describeAdminRequest,
  hiddenNotFound,
  requestHeader,
} from './admin-request';
import { roleHasPermission, type AdminPermission } from './admin-permissions';
import {
  ADMIN_ALLOW_REENROLL,
  ADMIN_PERMISSION,
  ADMIN_SESSION_MODE,
  ADMIN_STEP_UP,
  type AdminSessionMode,
} from './admin.decorators';
import { AdminAuthException } from './auth/admin-auth.errors';
import {
  AdminSessionsService,
  stepUpValid,
} from './auth/admin-sessions.service';

/**
 * Jedyna bramka wszystkich tras `/admin/*` (ROADMAPA §3–§4).
 *
 * Kolejność jest częścią bezpieczeństwa:
 *   1. Bramka Access (JWT z `Cf-Access-Jwt-Assertion`, albo obejście
 *      deweloperskie poza produkcją). Brak = 404 identyczne z nieistniejącą
 *      trasą — PRZED czymkolwiek innym, także przed limitem, więc obcy nie
 *      widzi nawet 429.
 *   2. `X-Robots-Tag` — dopiero po bramce, bo nagłówek na 404 odróżniałby
 *      `/admin/users` od trasy, której nie ma.
 *   3. Sesja panelu (ciasteczko `__Host-scoffie_admin`, związane z adresem
 *      z bramki) i limit żądań: z sesją po `admin:<id>`, bez niej po IP
 *      (niski limit tras logowania).
 *   4. Trasa wymagająca sesji bez sesji — 404 jak brak trasy.
 *   5. Sesja otwarta kodem odzyskiwania widzi wyłącznie konfigurację
 *      logowania (403 `NOT_ALLOWED`).
 *   6. Uprawnienie roli — brak = 404 jak brak trasy.
 *   7. Step-up (świeże potwierdzenie passkeyem albo TOTP) — 403
 *      `STEP_UP_REQUIRED` PRZED walidacją ciała i przed jakimkolwiek skutkiem.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly verifier: AccessJwtVerifier,
    private readonly limiter: AdminRateLimiter,
    private readonly sessions: AdminSessionsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const http = context.switchToHttp();
    const req = http.getRequest<AdminRequest>();
    const res = http.getResponse<Response>();

    const access = await this.passGate(req);
    if (!access) throw hiddenNotFound(req);
    req.adminAccess = access;
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    const targets = [context.getHandler(), context.getClass()];
    const mode =
      this.reflector.getAllAndOverride<AdminSessionMode | undefined>(
        ADMIN_SESSION_MODE,
        targets,
      ) ?? 'required';

    const session =
      mode === 'none' ? null : await this.sessions.resolve(req, access.email);
    req.adminSession = session;

    if (session) {
      this.limiter.check(
        `admin:${session.adminUserId}`,
        readThrottleLimit('THROTTLE_ADMIN_LIMIT'),
      );
    } else {
      this.limiter.check(
        `ip:${access.ip ?? 'unknown'}`,
        readThrottleLimit('THROTTLE_ADMIN_AUTH_LIMIT'),
      );
    }

    if (mode === 'required' && !session) throw hiddenNotFound(req);
    if (!session) return true;

    const allowReenroll =
      this.reflector.getAllAndOverride<boolean | undefined>(
        ADMIN_ALLOW_REENROLL,
        targets,
      ) ?? false;
    if (session.mustReenroll && !allowReenroll) {
      throw new AdminAuthException(
        'NOT_ALLOWED',
        'Najpierw dodaj nowy klucz dostępu albo kod z aplikacji.',
      );
    }

    const permission = this.reflector.getAllAndOverride<
      AdminPermission | undefined
    >(ADMIN_PERMISSION, targets);
    if (permission && !roleHasPermission(session.admin.role, permission)) {
      throw hiddenNotFound(req);
    }

    const stepUp =
      this.reflector.getAllAndOverride<boolean | undefined>(
        ADMIN_STEP_UP,
        targets,
      ) ?? false;
    if (stepUp && !stepUpValid(session)) {
      throw new AdminAuthException('STEP_UP_REQUIRED');
    }
    return true;
  }

  /** Tożsamość z bramki albo `null` (= 404). Nigdy nie rzuca. */
  private async passGate(
    req: AdminRequest,
  ): Promise<AdminAccessContext | null> {
    const env = readAdminEnv();
    const described = describeAdminRequest(req);
    if (env.devEmail) {
      return { email: env.devEmail, subject: null, via: 'dev', ...described };
    }
    if (!accessGateConfigured(env)) return null;
    const identity = await this.verifier.verify(
      requestHeader(req, ACCESS_JWT_HEADER) ?? undefined,
      env,
    );
    if (!identity) return null;
    return { ...identity, via: 'access', ...described };
  }
}
