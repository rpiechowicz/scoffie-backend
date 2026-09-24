import { Injectable, Logger } from '@nestjs/common';
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { AdminEnv } from '../../config/admin-env';

/** Nagłówek, w którym Cloudflare Access (i Worker panelu) niesie JWT bramki. */
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/** Tożsamość potwierdzona przez bramkę — wszystko, czego panel od niej chce. */
export type AccessIdentity = {
  /** Adres z tokenu Access, małymi literami. */
  email: string;
  /** `sub` użytkownika w Access (do dziennika; nie wiąże konta). */
  subject: string | null;
};

/**
 * Tolerancja zegara przy `exp`/`nbf`/`iat`. Token Access żyje tyle, co sesja
 * bramki, więc pół minuty nie zmienia niczego w bezpieczeństwie, a chroni
 * przed odrzuceniem świeżego tokenu, gdy zegar Railwaya odrobinę się spóźnia.
 */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Weryfikacja JWT Cloudflare Access (warstwa 0, ROADMAPA §4).
 *
 * Sprawdza PODPIS kluczem z JWKS zespołu (`https://<zespół>/cdn-cgi/access/certs`,
 * klucze w pamięci — `createRemoteJWKSet` trzyma je i sam dociąga po rotacji,
 * najwyżej raz na 30 s dla nieznanego `kid`), `iss` = domena zespołu, `aud` =
 * tag aplikacji, `exp` — OBOWIĄZKOWY: `jose` sprawdza `exp` tylko wtedy, gdy
 * claim jest obecny, więc token bez `exp` przeszedłby jako wieczny. Do tego
 * adres e-mail: token bez niego (np. token usługi) nie jest człowiekiem.
 *
 * Nigdy nie rzuca — `null` znaczy „nie ma bramki", a to, jak odpowiedzieć
 * (identyczne 404), decyduje guard. Treści tokenu nie logujemy.
 */
@Injectable()
export class AccessJwtVerifier {
  private readonly logger = new Logger(AccessJwtVerifier.name);
  private jwks: { teamDomain: string; keys: JWTVerifyGetKey } | null = null;
  private override: JWTVerifyGetKey | null = null;

  /** Testy podstawiają lokalny zestaw kluczy (`createLocalJWKSet`). */
  _overrideJwks(keys: JWTVerifyGetKey | null): void {
    this.override = keys;
  }

  private keysFor(teamDomain: string): JWTVerifyGetKey {
    if (this.override) return this.override;
    if (!this.jwks || this.jwks.teamDomain !== teamDomain) {
      this.jwks = {
        teamDomain,
        keys: createRemoteJWKSet(
          new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
          { timeoutDuration: 5_000, cooldownDuration: 30_000 },
        ),
      };
    }
    return this.jwks.keys;
  }

  async verify(
    token: string | undefined,
    env: AdminEnv,
  ): Promise<AccessIdentity | null> {
    const raw = (token ?? '').trim();
    if (!raw || !env.accessTeamDomain || env.accessAud.length === 0) {
      return null;
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(raw, this.keysFor(env.accessTeamDomain), {
        issuer: `https://${env.accessTeamDomain}`,
        audience: env.accessAud,
        algorithms: ['RS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['exp'],
      }));
    } catch (error) {
      // Poziom debug: każdy skaner z losowym tokenem trafiałby do logu.
      this.logger.debug(
        `token Access odrzucony: ${error instanceof Error ? error.name : 'błąd'}`,
      );
      return null;
    }
    const email =
      typeof payload.email === 'string'
        ? payload.email.trim().toLowerCase()
        : '';
    if (!email || !email.includes('@')) return null;
    return {
      email,
      subject: typeof payload.sub === 'string' ? payload.sub : null,
    };
  }
}
