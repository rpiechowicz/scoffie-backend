import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { readThrottleLimit } from '../common/throttle/throttle-env';
import { AdminGate } from './admin-gate';
import { AdminRateLimiter } from './admin-rate-limiter';
import { AdminRequest, hiddenNotFound, requestHeader } from './admin-request';
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
 *   2a. Żądanie zmieniające stan (POST/PUT/PATCH/DELETE) spoza pochodzenia
 *      panelu — 403 `CROSS_SITE` (`Sec-Fetch-Site`), ciało inne niż JSON —
 *      415 `UNSUPPORTED_MEDIA_TYPE` (`assertSameOriginJson`).
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
    private readonly gate: AdminGate,
    private readonly limiter: AdminRateLimiter,
    private readonly sessions: AdminSessionsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const http = context.switchToHttp();
    const req = http.getRequest<AdminRequest>();
    const res = http.getResponse<Response>();

    // Zwykle policzone już przez `AdminGateMiddleware` — tu tylko odczyt.
    const access = await this.gate.pass(req);
    if (!access) throw hiddenNotFound(req);
    req.adminAccess = access;
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    assertSameOriginJson(req);

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
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF w obrębie witryny (audyt logowania 25.09.2026). `SameSite=Strict`
 * chroni przed obcą domeną, ale NIE przed inną stroną tej samej witryny
 * (`*.scoffie.app`) — dla przeglądarki to „same-site”, więc ciasteczko
 * sesji jedzie. Dwie zapory, obie zgodne z frontem panelu (`src/api/client.ts`:
 * POST/PUT/PATCH zawsze z `Content-Type: application/json`, DELETE bez
 * ciała i bez nagłówka):
 *
 *   1. `Sec-Fetch-Site` obecny i inny niż `same-origin` = 403 `CROSS_SITE`.
 *      Panel woła `/api/*` z własnego pochodzenia, a Worker przekazuje
 *      nagłówki przeglądarki. Brak nagłówka (curl, testy, stara przeglądarka)
 *      nie jest odrzucany — o to dba punkt 2.
 *   2. Ciało (albo `Content-Type`) tylko jako `application/json`, inaczej
 *      415 `UNSUPPORTED_MEDIA_TYPE`. Formularz HTML nie wyśle JSON-a, a
 *      `fetch` z JSON-em na obce pochodzenie wymaga preflightu CORS, którego
 *      backend nie przepuszcza. Żądanie bez ciała i bez `Content-Type` (DELETE
 *      z panelu) przechodzi.
 */
export function assertSameOriginJson(req: AdminRequest): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return;
  const site = requestHeader(req, 'sec-fetch-site');
  if (site && site.toLowerCase() !== 'same-origin') {
    throw new AdminAuthException('CROSS_SITE');
  }
  const contentType = requestHeader(req, 'content-type');
  const length = Number(requestHeader(req, 'content-length') ?? '0');
  const hasBody =
    (Number.isFinite(length) && length > 0) ||
    requestHeader(req, 'transfer-encoding') !== null;
  if (!contentType && !hasBody) return;
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (mime !== 'application/json') {
    throw new AdminAuthException('UNSUPPORTED_MEDIA_TYPE');
  }
}
