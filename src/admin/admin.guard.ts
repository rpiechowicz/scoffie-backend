import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
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
 *   3. Limit żądań panelu.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly verifier: AccessJwtVerifier,
    private readonly limiter: AdminRateLimiter,
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

    this.limiter.check(
      `ip:${access.ip ?? 'unknown'}`,
      readThrottleLimit('THROTTLE_ADMIN_AUTH_LIMIT'),
    );
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
