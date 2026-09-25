import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { accessGateConfigured, readAdminEnv } from '../config/admin-env';
import {
  ACCESS_JWT_HEADER,
  AccessJwtVerifier,
} from './access/access-jwt.verifier';
import {
  type AdminAccessContext,
  type AdminRequest,
  describeAdminRequest,
  requestHeader,
} from './admin-request';

/**
 * Bramka Access (warstwa 0, ROADMAPA §4): tożsamość z JWT
 * `Cf-Access-Jwt-Assertion` albo z obejścia deweloperskiego poza produkcją.
 *
 * Wynik liczy się RAZ na żądanie i leży w `req.adminGate` — middleware
 * (`AdminGateMiddleware`) i `AdminGuard` czytają tę samą obietnicę.
 */
@Injectable()
export class AdminGate {
  constructor(private readonly verifier: AccessJwtVerifier) {}

  /** Tożsamość z bramki albo `null` (= 404). Nigdy nie rzuca. */
  pass(req: AdminRequest): Promise<AdminAccessContext | null> {
    req.adminGate ??= this.evaluate(req).catch(() => null);
    return req.adminGate;
  }

  private async evaluate(
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

/**
 * Weryfikacja JWT Access na CAŁYM prefiksie `/admin` — także na ścieżkach,
 * których nie ma.
 *
 * DLACZEGO. Guard biegnie tylko na istniejących trasach, więc bez tego
 * `/admin/users` (weryfikacja podpisu RS256, czasem pobranie JWKS) odpowiadał
 * wolniej niż `/admin/nie-ma` (router od razu 404) — czas odpowiedzi zdradzał,
 * które trasy istnieją, mimo identycznego ciała 404. Middleware sam niczego
 * nie odrzuca: liczy bramkę, odkłada wynik w `req.adminGate` i puszcza dalej —
 * odpowiedź (to samo ukryte 404 albo trasa) dalej daje router i `AdminGuard`,
 * który drugi raz nie weryfikuje.
 */
@Injectable()
export class AdminGateMiddleware implements NestMiddleware {
  constructor(private readonly gate: AdminGate) {}

  async use(
    req: AdminRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    await this.gate.pass(req);
    next();
  }
}
