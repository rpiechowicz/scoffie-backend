import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import {
  OAuth2Client,
  type Certificates,
  type TokenPayload,
} from 'google-auth-library';
import { AppException } from '../common/app-exception';
import { readGoogleOAuthClientIds } from '../config/google-auth-env';

/** Enum biblioteki nie jest eksportowany z jej wejścia — typ bierzemy z metody. */
type CertificateFormat = Awaited<
  ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>
>['format'];

/** Wynik weryfikacji tokenu tożsamości Google — same zweryfikowane claimy. */
export interface VerifiedGoogleIdentity {
  /** Stabilny identyfikator konta Google (`sub`). */
  googleSub: string;
  /** Adres z tokenu, znormalizowany (trim + małe litery); `null`, gdy brak. */
  email: string | null;
  /** `email_verified === true` z tokenu. Wszystko inne = niepotwierdzony. */
  emailVerified: boolean;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  picture: string | null;
}

/**
 * Wystawcy, których przyjmuje Google Identity (obie formy występują w
 * praktyce). Biblioteka sprawdza to samo, ale sprawdzamy jawnie — zmiana
 * domyślnych ustawień biblioteki nie może po cichu poluzować bramki.
 */
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Weryfikuje ID token z Google Sign-In (Android, Credential Manager).
 *
 * Sprawdzane: podpis kluczem Google (certyfikaty pobiera i buforuje
 * `google-auth-library`), `aud` ∈ `GOOGLE_OAUTH_CLIENT_IDS`, `iss`
 * (accounts.google.com), `exp`/`iat` (z tolerancją zegara biblioteki),
 * a gdy klient przysłał `nonce` — równość z claimem `nonce`.
 *
 * Błąd tokenu = `APPLE_IDENTITY_INVALID` 401, ten sam kod co przy złym
 * tokenie Apple: klient reaguje na oba identycznie („zaloguj się ponownie”),
 * a nowy kod oznaczałby nową kopię w każdym kliencie.
 *
 * W logu NIE ma treści błędu biblioteki — jej komunikaty zawierają cały token
 * albo cały payload (z adresem e-mail). Logujemy wyłącznie kategorię.
 */
@Injectable()
export class GoogleIdentityService {
  private readonly logger = new Logger(GoogleIdentityService.name);
  private readonly client = new OAuth2Client();

  /**
   * Hak testowy: podstawia certyfikaty zamiast pobierania ich od Google.
   * Reszta weryfikacji (podpis, aud, iss, exp) idzie prawdziwą ścieżką
   * `verifyIdToken` biblioteki — testy nie sprawdzają atrapy.
   */
  _overrideCerts(certs: Certificates) {
    this.client.getFederatedSignonCertsAsync = () =>
      Promise.resolve({ certs, format: 'PEM' as CertificateFormat });
  }

  /**
   * Lista dopuszczalnych `aud` albo 503, gdy logowanie przez Google nie jest
   * skonfigurowane. Czytane per wywołanie — ustawienie zmiennej włącza
   * endpoint bez builda.
   */
  assertEnabled(): string[] {
    const audiences = readGoogleOAuthClientIds();
    if (audiences.length === 0) {
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        'Logowanie przez Google jest wyłączone w tej instalacji.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return audiences;
  }

  async verify(
    idToken: string,
    nonce?: string | null,
  ): Promise<VerifiedGoogleIdentity> {
    const audiences = this.assertEnabled();
    if (!idToken || typeof idToken !== 'string') {
      throw this.invalid('Missing Google ID token.');
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: audiences,
      });
      payload = ticket.getPayload();
    } catch (error) {
      this.logger.warn(
        `Google ID token rejected: ${this.classify(error as Error)}`,
      );
      throw this.invalid('Invalid Google ID token.');
    }

    if (!payload) {
      throw this.invalid('Invalid Google ID token.');
    }
    if (!GOOGLE_ISSUERS.includes(payload.iss)) {
      this.logger.warn('Google ID token rejected: issuer');
      throw this.invalid('Invalid Google ID token.');
    }
    // Biblioteka to sprawdza, ale `aud` jest bramką bezpieczeństwa (token
    // wydany innej aplikacji nie może nas logować) — więc jeszcze raz, jawnie.
    if (!audiences.includes(payload.aud)) {
      this.logger.warn('Google ID token rejected: audience');
      throw this.invalid('Invalid Google ID token.');
    }

    const expectedNonce = nonce?.trim();
    if (expectedNonce) {
      const claim = typeof payload.nonce === 'string' ? payload.nonce : '';
      if (!this.safeEqual(claim, expectedNonce)) {
        this.logger.warn('Google ID token rejected: nonce mismatch');
        throw this.invalid('Google nonce does not match.');
      }
    }

    const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!sub) {
      throw this.invalid('Google ID token missing sub claim.');
    }

    const email =
      typeof payload.email === 'string' && payload.email.trim().length > 0
        ? payload.email.trim().toLowerCase()
        : null;

    return {
      googleSub: sub,
      email,
      // Tylko jawne `true`. Łączenie kont po adresie stoi na tym polu, więc
      // żadnych „prawie prawd” w stylu stringa "true".
      emailVerified: email !== null && payload.email_verified === true,
      name: this.text(payload.name),
      givenName: this.text(payload.given_name),
      familyName: this.text(payload.family_name),
      picture: this.text(payload.picture),
    };
  }

  private invalid(message: string) {
    return new AppException(
      'APPLE_IDENTITY_INVALID',
      message,
      HttpStatus.UNAUTHORIZED,
    );
  }

  private text(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : null;
  }

  private safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  /**
   * Kategoria odmowy bez danych: komunikaty biblioteki niosą token albo
   * payload (`Token used too late, … : {"email": …}`), więc bierzemy tylko
   * rozpoznany początek.
   */
  private classify(error: Error): string {
    const message = String(error?.message ?? '');
    const known: Array<[RegExp, string]> = [
      [/^Wrong recipient/, 'audience'],
      [/^Invalid issuer/, 'issuer'],
      [/^Token used too late/, 'expired'],
      [/^Token used too early/, 'not yet valid'],
      [/^Expiration time too far/, 'expiry too far'],
      [/^Invalid token signature/, 'signature'],
      [/^No pem found/, 'unknown key id'],
      [/^Wrong number of segments/, 'malformed'],
      [/^Can't parse token/, 'malformed'],
      [/^No issue time|^No expiration time/, 'missing iat/exp'],
    ];
    for (const [pattern, label] of known) {
      if (pattern.test(message)) return label;
    }
    return 'verification failed';
  }
}
