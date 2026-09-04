/**
 * Konfiguracja płatności App Store — czytana przy każdym użyciu, jak
 * `agent-env.ts`, żeby test mógł ją podmienić bez restartu modułu.
 *
 * KAŻDA ZMIENNA MA DOMYŚLNĄ WARTOŚĆ. Brak konfiguracji nie wywraca startu
 * serwera; wyłącza wyłącznie przyjmowanie zakupów (`enabled === false`), a
 * asystent działa dalej na nadaniu operatora i na puli próbnej.
 */

/** Odcisk SHA-256 certyfikatu „Apple Root CA - G3" (ważny do 30.04.2039). */
export const APPLE_ROOT_CA_G3_SHA256 =
  '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';

/**
 * Certyfikat główny Apple, wpisany na sztywno.
 *
 * DLACZEGO NA SZTYWNO, A NIE Z SIECI. Łańcuch z `x5c` przychodzi razem z
 * podpisem, więc sam się nie uwierzytelnia — to napastnik decyduje, co w nim
 * położy. Jedynym punktem zaczepienia jest korzeń, który MUSIMY znać z góry.
 * Pobieranie go w locie z apple.com oznaczałoby, że przejęcie tego połączenia
 * przejmuje całą weryfikację zakupów.
 *
 * Pobrany z https://www.apple.com/certificateauthority/AppleRootCA-G3.cer;
 * sprawdzalny jednym poleceniem:
 *   openssl x509 -in AppleRootCA-G3.cer -inform DER -fingerprint -sha256 -noout
 */
export const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

export type AppleEnvironment = 'Production' | 'Sandbox';

export type BillingEnv = {
  /**
   * Czy przyjmujemy zakupy. `false` = `/billing/*` odpowiada 503, paywall w
   * aplikacji pokazuje ofertę i nie pobiera pieniędzy. Domyślnie WYŁĄCZONE:
   * włączenie płatności ma być świadomą decyzją, nie skutkiem ubocznym deploya.
   */
  enabled: boolean;
  bundleId: string;
  /** Numeryczne `appAppleId` z App Store Connect; 0 = nie sprawdzamy. */
  appAppleId: number;
  /**
   * Środowisko, którego transakcje uznajemy. Sandbox NIE daje PRO na
   * produkcji — inaczej każdy z TestFlightem miałby darmowe PRO na zawsze.
   */
  environment: AppleEnvironment;
  /** Czy dopuścić też transakcje z sandboxa (tylko dla środowiska testowego). */
  acceptSandbox: boolean;
  issuerId: string;
  keyId: string;
  /** Zawartość klucza `.p8` (z nagłówkiem PEM albo bez). */
  privateKey: string;
  rootCaSha256: string;
  /** Adres App Store Server API — inny dla sandboxa. */
  serverApiBaseUrl: string;
  /** Twardy limit czasu na odpowiedź Apple. */
  serverApiTimeoutMs: number;
  /**
   * Ile godzin bez uzgodnienia z Apple zanim uznamy subskrypcję za wymagającą
   * odświeżenia (zgubione powiadomienie).
   */
  reconcileAfterHours: number;
};

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function readInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/**
 * Klucz `.p8` do App Store Server API.
 *
 * NAZWA Z `BILLING`, BO TO INNY KLUCZ NIŻ `APPLE_PRIVATE_KEY`. Ten drugi jest
 * kluczem „Zaloguj się przez Apple" (unieważnianie tokenów przy usuwaniu
 * konta) i ma własne `APPLE_KEY_ID`. Pomylenie ich daje 401 z Apple przy
 * każdej weryfikacji zakupu — czyli paywall, który nie potwierdza płatności.
 *
 * Railway nie lubi znaków nowej linii, więc przyjmujemy zarówno prawdziwe
 * łamania, jak i zapisane jako `\n`.
 */
function readPrivateKey(): string {
  const raw = process.env.APPLE_BILLING_PRIVATE_KEY?.trim() ?? '';
  if (!raw) return '';
  const withNewlines = raw.replace(/\\n/g, '\n');
  if (withNewlines.includes('BEGIN')) return withNewlines;
  // Sam base64 bez nagłówków — dokładamy je, żeby `crypto` to przyjęło.
  const body = withNewlines
    .replace(/\s+/g, '')
    .match(/.{1,64}/g)
    ?.join('\n');
  return body
    ? `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`
    : '';
}

export function readBillingEnv(): BillingEnv {
  const environment: AppleEnvironment =
    process.env.APPLE_ENVIRONMENT?.trim() === 'Production'
      ? 'Production'
      : 'Sandbox';
  const issuerId = process.env.APPLE_ISSUER_ID?.trim() ?? '';
  const keyId = process.env.APPLE_BILLING_KEY_ID?.trim() ?? '';
  const privateKey = readPrivateKey();
  return {
    // Włączone tylko wtedy, gdy JEST czym rozmawiać z Apple. Sam
    // `BILLING_ENABLED=true` bez klucza dałby paywall, który przyjmuje
    // pieniądze i nie umie potwierdzić ani jednej transakcji.
    enabled:
      readBool('BILLING_ENABLED', false) &&
      Boolean(issuerId && keyId && privateKey),
    bundleId: process.env.APPLE_BUNDLE_ID?.trim() || 'rpiechowicz.weekly-meals',
    appAppleId: readInt('APPLE_APP_APPLE_ID', 0),
    environment,
    // Na produkcji sandbox jest odrzucany zawsze; poza produkcją domyślnie
    // przyjmowany, bo inaczej nie da się niczego przetestować.
    acceptSandbox: readBool(
      'APPLE_ACCEPT_SANDBOX',
      environment !== 'Production',
    ),
    issuerId,
    keyId,
    privateKey,
    rootCaSha256:
      process.env.APPLE_ROOT_CA_SHA256?.trim() || APPLE_ROOT_CA_G3_SHA256,
    serverApiBaseUrl:
      process.env.APPLE_SERVER_API_URL?.trim() ||
      (environment === 'Production'
        ? 'https://api.storekit.apple.com'
        : 'https://api.storekit-sandbox.itunes.apple.com'),
    serverApiTimeoutMs: readInt('APPLE_SERVER_API_TIMEOUT_MS', 8000),
    reconcileAfterHours: readInt('APPLE_RECONCILE_AFTER_HOURS', 24),
  };
}

/** Które środowiska transakcji wpuszczamy przy tej konfiguracji. */
export function acceptedEnvironments(env: BillingEnv): AppleEnvironment[] {
  return env.acceptSandbox ? [env.environment, 'Sandbox'] : [env.environment];
}
