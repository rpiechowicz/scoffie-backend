/**
 * Konfiguracja płatności App Store — czytana przy każdym użyciu, jak
 * `agent-env.ts`, żeby test mógł ją podmienić bez restartu modułu.
 *
 * KAŻDA ZMIENNA MA DOMYŚLNĄ WARTOŚĆ. Brak konfiguracji nie wywraca startu
 * serwera; wyłącza wyłącznie przyjmowanie zakupów (`enabled === false`), a
 * asystent działa dalej na nadaniu operatora i na puli próbnej.
 */

import {
  acceptedTransactionEnvironments,
  readAcceptSandbox,
  readAppleEnvironment,
  type AppleEnvironment,
} from '../config/apple-environment';

export type { AppleEnvironment };

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
  /**
   * Czy przyjmujemy transakcje z Chmury Rodzinnej (`inAppOwnershipType ===
   * 'FAMILY_SHARED'`). Domyślnie NIE — patrz `checkTransactionPayload`.
   */
  acceptFamilyShared: boolean;
  issuerId: string;
  keyId: string;
  /** Zawartość klucza `.p8` (z nagłówkiem PEM albo bez). */
  privateKey: string;
  rootCaSha256: string;
  /**
   * Certyfikat korzenia, do którego musi prowadzić łańcuch z `x5c`.
   *
   * DOMYŚLNIE I NA PRODUKCJI ZAWSZE: wpisany na sztywno korzeń Apple. Podmiana
   * jest możliwa WYŁĄCZNIE poza produkcją (`NODE_ENV !== 'production'`) i
   * służy jednej rzeczy — testowi na żywej bazie, który podpisuje transakcje
   * własnym łańcuchem, bo prawdziwych podpisów Apple nie da się trzymać w
   * repozytorium. Na produkcji zmienna jest ignorowana, więc jej ustawienie
   * (przez pomyłkę albo złośliwie) niczego nie otwiera.
   */
  rootCaPem: string;
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

/**
 * Liczba z env. PUSTA ZMIENNA TO BRAK WARTOŚCI, NIE ZERO — `Number('')` daje 0,
 * więc pusty `APPLE_SERVER_API_TIMEOUT_MS` w Railway (a puste pole zostawia się
 * tam jednym kliknięciem) ustawiał limit czasu na 0 ms i każde pytanie do Apple
 * kończyło się natychmiastowym przerwaniem: paywall, który nie potwierdza
 * żadnego zakupu, i to bez jednego czytelnego błędu w logu.
 */
function readInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
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

/**
 * Korzeń łańcucha. Na produkcji nie ma tu żadnego wyboru — patrz `rootCaPem`.
 */
function readRootCaPem(): string {
  if (process.env.NODE_ENV === 'production') return APPLE_ROOT_CA_G3_PEM;
  const raw = process.env.APPLE_ROOT_CA_PEM?.trim();
  if (!raw) return APPLE_ROOT_CA_G3_PEM;
  // Railway nie lubi znaków nowej linii — tak samo, jak przy kluczu `.p8`.
  return raw.includes('BEGIN CERTIFICATE')
    ? raw.replace(/\\n/g, '\n')
    : APPLE_ROOT_CA_G3_PEM;
}

export function readBillingEnv(): BillingEnv {
  const environment = readAppleEnvironment();
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
    bundleId: process.env.APPLE_BUNDLE_ID?.trim() || 'app.scoffie.ios',
    appAppleId: readInt('APPLE_APP_APPLE_ID', 0),
    environment,
    // Na produkcji sandbox jest odrzucany zawsze; poza produkcją domyślnie
    // przyjmowany, bo inaczej nie da się niczego przetestować.
    acceptSandbox: readAcceptSandbox(),
    // Chmura Rodzinna: domyślnie NIE. Jedna opłata dałaby do sześciu osobnych
    // pul, bo każdy członek rodziny dostaje własną transakcję z własnym
    // `originalTransactionId`, czyli własny wiersz i własny zakres licznika.
    acceptFamilyShared: readBool('APPLE_ACCEPT_FAMILY_SHARED', false),
    issuerId,
    keyId,
    privateKey,
    rootCaSha256:
      process.env.APPLE_ROOT_CA_SHA256?.trim() || APPLE_ROOT_CA_G3_SHA256,
    rootCaPem: readRootCaPem(),
    serverApiBaseUrl:
      process.env.APPLE_SERVER_API_URL?.trim() ||
      (environment === 'Production'
        ? 'https://api.storekit.apple.com'
        : 'https://api.storekit-sandbox.itunes.apple.com'),
    serverApiTimeoutMs: readInt('APPLE_SERVER_API_TIMEOUT_MS', 8000, 1),
    reconcileAfterHours: readInt('APPLE_RECONCILE_AFTER_HOURS', 24, 1),
  };
}

/** Które środowiska transakcji wpuszczamy przy tej konfiguracji. */
export function acceptedEnvironments(env: BillingEnv): AppleEnvironment[] {
  return env.acceptSandbox && env.environment !== 'Sandbox'
    ? [env.environment, 'Sandbox']
    : [env.environment];
}

export { acceptedTransactionEnvironments };
