import { Injectable, Logger } from '@nestjs/common';
import { importPKCS8, SignJWT } from 'jose';

export type AppleRevocationOutcome = 'revoked' | 'not_configured' | 'failed';

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const APPLE_AUDIENCE = 'https://appleid.apple.com';
const DEFAULT_CLIENT_ID = 'rpiechowicz.weekly-meals';

/**
 * Unieważnienie tokenów Sign in with Apple przy kasowaniu konta.
 *
 * Wytyczne App Store 5.1.1(v) od czerwca 2022: aplikacja, która pozwala
 * skasować konto, MUSI przy tym unieważnić tokeny Apple przez
 * `/auth/revoke`. Bez tego konto znika u nas, a u Apple w „Aplikacje
 * używające Apple ID" nadal wisi Weekly Meals z aktywnym logowaniem.
 *
 * Potrzebne są (Railway): `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`
 * (klucz .p8 z portalu deweloperskiego, PEM; \n może być zapisane jako `\\n`)
 * i `APPLE_CLIENT_ID` (bundle id, domyślnie jak w `AppleIdentityService`).
 * Brak którejkolwiek = `not_configured`: kasowanie konta działa dalej, a w
 * logu zostaje ostrzeżenie — to ma być widoczne, nie ciche.
 *
 * Telefon musi przysłać ŚWIEŻY `authorizationCode` z ponownego
 * `ASAuthorizationAppleIDRequest` tuż przed kasowaniem (kody żyją 5 minut
 * i są jednorazowe). Kod wymieniamy na refresh token i ten unieważniamy.
 * Nigdy nie rzuca: porażka u Apple nie może zatrzymać usunięcia konta,
 * do którego użytkownik ma prawo (RODO art. 17).
 */
@Injectable()
export class AppleRevocationService {
  private readonly logger = new Logger(AppleRevocationService.name);
  private fetchImpl: typeof fetch = globalThis.fetch;

  /** Testy podstawiają `fetch`; metoda, nie parametr konstruktora (DI Nesta). */
  useFetch(fetchImpl: typeof fetch): void {
    this.fetchImpl = fetchImpl;
  }

  isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(
      (env.APPLE_TEAM_ID ?? '').trim() &&
      (env.APPLE_KEY_ID ?? '').trim() &&
      (env.APPLE_PRIVATE_KEY ?? '').trim(),
    );
  }

  async revoke(
    authorizationCode: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<AppleRevocationOutcome> {
    if (!this.isConfigured(env)) {
      this.logger.warn(
        'kasowanie konta Apple bez unieważnienia tokenów — brak APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY',
      );
      return 'not_configured';
    }
    const clientId =
      (env.APPLE_CLIENT_ID ?? env.APPLE_AUDIENCE ?? '').split(',')[0].trim() ||
      DEFAULT_CLIENT_ID;

    try {
      const clientSecret = await this.clientSecret(env, clientId);
      const token = await this.post(APPLE_TOKEN_URL, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: authorizationCode,
      });
      if (!token.ok) {
        this.logger.warn(
          `Apple /auth/token odmówił (${token.status}) — tokeny nieunieważnione`,
        );
        return 'failed';
      }
      const body = (await token.json()) as { refresh_token?: string };
      if (!body.refresh_token) {
        this.logger.warn(
          'Apple /auth/token bez refresh_token — nie ma czego unieważnić',
        );
        return 'failed';
      }
      const revoke = await this.post(APPLE_REVOKE_URL, {
        client_id: clientId,
        client_secret: clientSecret,
        token: body.refresh_token,
        token_type_hint: 'refresh_token',
      });
      if (!revoke.ok) {
        this.logger.warn(`Apple /auth/revoke odmówił (${revoke.status})`);
        return 'failed';
      }
      return 'revoked';
    } catch (error) {
      this.logger.warn(
        `unieważnienie tokenów Apple nie powiodło się: ${
          error instanceof Error ? error.message : 'nieznany błąd'
        }`,
      );
      return 'failed';
    }
  }

  /** Sekret klienta = JWT ES256 podpisany kluczem .p8, ważny kilka minut. */
  private async clientSecret(
    env: NodeJS.ProcessEnv,
    clientId: string,
  ): Promise<string> {
    const pem = (env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
    const key = await importPKCS8(pem, 'ES256');
    return new SignJWT({})
      .setProtectedHeader({
        alg: 'ES256',
        kid: (env.APPLE_KEY_ID ?? '').trim(),
      })
      .setIssuer((env.APPLE_TEAM_ID ?? '').trim())
      .setIssuedAt()
      .setExpirationTime('5m')
      .setAudience(APPLE_AUDIENCE)
      .setSubject(clientId)
      .sign(key);
  }

  private post(url: string, form: Record<string, string>): Promise<Response> {
    return this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }
}
