import { X509Certificate, verify } from 'node:crypto';
import {
  APPLE_ROOT_CA_G3_PEM,
  acceptedEnvironments,
  type BillingEnv,
} from './billing-env';

/**
 * Weryfikacja podpisanych ładunków Apple (JWS z `x5c`).
 *
 * TO JEST BRAMKA PIENIĘŻNA I JEDYNA. Wszystko, co dalej w module płatności
 * decyduje o nadaniu PRO, wierzy temu plikowi na słowo — więc każdy skrót
 * zrobiony tutaj jest darmowym PRO dla każdego, kto go znajdzie.
 *
 * Cztery ataki, które ten kod ma zatrzymać (z audytu adwersarialnego):
 *
 * 1. **Podstawiony klucz w `x5c`.** Napastnik podpisuje własny ładunek własnym
 *    kluczem i wkłada własny certyfikat do nagłówka. Kod, który bierze klucz
 *    „z liścia" i sprawdza nim podpis, przyjmie to jako prawdziwe. Dlatego
 *    liść musi dać się dociągnąć łańcuchem do KORZENIA, którego nie ma w
 *    ładunku, tylko w naszym kodzie (`APPLE_ROOT_CA_G3_PEM`).
 * 2. **Odczyt bez weryfikacji.** `decodeJwt`/`decodeProtectedHeader` zwracają
 *    treść bez sprawdzenia podpisu. Tutaj nie ma ani jednego takiego wywołania
 *    dla ładunku, który cokolwiek nadaje; nagłówek czytamy WYŁĄCZNIE po to,
 *    żeby wyjąć z niego łańcuch, i nie ufamy niczemu innemu, co w nim jest.
 * 3. **Podmiana algorytmu.** Przyjmujemy tylko `ES256`. Bez tego `alg: none`
 *    albo podmiana na HMAC z kluczem publicznym jako sekretem przechodzi.
 * 4. **Transakcja z innej aplikacji albo z sandboxa.** Podpis Apple pod
 *    transakcją z CUDZEJ aplikacji jest w pełni prawdziwy — sprawdzenie
 *    `bundleId` i `environment` robi wołający (`verifyTransaction`).
 */

/** Ile certyfikatów najwyżej przyjmiemy w `x5c` — Apple wysyła trzy. */
const MAX_CHAIN_LENGTH = 5;

export class AppleJwsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppleJwsError';
  }
}

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function derToPem(base64Der: string): string {
  const body =
    base64Der
      .replace(/\s+/g, '')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

/**
 * Łańcuch certyfikatów z `x5c` sprawdzony do przypiętego korzenia.
 *
 * Kolejność jak w RFC 7515: `x5c[0]` to liść, każdy następny podpisuje
 * poprzedni, ostatni to korzeń. Sprawdzamy WSZYSTKIE trzy rzeczy:
 * ważność w czasie, podpis każdego ogniwa przez następne i tożsamość korzenia.
 */
export function verifyCertificateChain(
  x5c: string[],
  now: Date,
  pinnedRootPem: string = APPLE_ROOT_CA_G3_PEM,
): X509Certificate {
  if (!Array.isArray(x5c) || x5c.length < 2) {
    throw new AppleJwsError(
      'CHAIN_TOO_SHORT',
      'Nagłówek nie zawiera łańcucha certyfikatów.',
    );
  }
  if (x5c.length > MAX_CHAIN_LENGTH) {
    throw new AppleJwsError(
      'CHAIN_TOO_LONG',
      'Łańcuch certyfikatów jest nienaturalnie długi.',
    );
  }

  let chain: X509Certificate[];
  try {
    chain = x5c.map((cert) => new X509Certificate(derToPem(cert)));
  } catch {
    throw new AppleJwsError(
      'CHAIN_UNPARSABLE',
      'Certyfikatu z nagłówka nie da się odczytać.',
    );
  }

  const stamp = now.getTime();
  for (const cert of chain) {
    if (
      Date.parse(cert.validFrom) > stamp ||
      Date.parse(cert.validTo) < stamp
    ) {
      throw new AppleJwsError(
        'CERT_EXPIRED',
        'Certyfikat z łańcucha jest poza okresem ważności.',
      );
    }
  }

  // Każde ogniwo musi być podpisane kluczem następnego. `verify` sprawdza
  // WYŁĄCZNIE podpis — dlatego niżej dochodzi jeszcze zgodność wystawcy.
  for (let i = 0; i < chain.length - 1; i += 1) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (!child.verify(parent.publicKey)) {
      throw new AppleJwsError(
        'CHAIN_BROKEN',
        'Łańcuch certyfikatów nie trzyma się kupy.',
      );
    }
    if (child.issuer !== parent.subject) {
      throw new AppleJwsError(
        'CHAIN_ISSUER_MISMATCH',
        'Wystawca certyfikatu nie zgadza się z kolejnym ogniwem.',
      );
    }
  }

  // Korzeń z ładunku musi być DOKŁADNIE tym, który mamy u siebie. To jedyne
  // miejsce, w którym łańcuch przestaje być „danymi od napastnika".
  const root = chain[chain.length - 1];
  const pinned = new X509Certificate(pinnedRootPem);
  if (root.fingerprint256 !== pinned.fingerprint256) {
    throw new AppleJwsError(
      'ROOT_NOT_PINNED',
      'Korzeń łańcucha nie jest przypiętym certyfikatem Apple.',
    );
  }
  if (!root.verify(pinned.publicKey)) {
    throw new AppleJwsError(
      'ROOT_NOT_SELF_SIGNED',
      'Przypięty korzeń nie potwierdza sam siebie.',
    );
  }

  return chain[0];
}

/**
 * Sprawdza podpis JWS i oddaje jego treść.
 *
 * Zwraca `unknown` celowo: wołający MUSI sam sprawdzić, czy dostał to, czego
 * oczekiwał. Podpis Apple mówi wyłącznie „to wyszło od nas" — nie mówi, że
 * dotyczy naszej aplikacji, naszego środowiska ani naszego produktu.
 */
export function verifyAppleJws(
  token: string,
  options: { now?: Date; rootPem?: string } = {},
): unknown {
  const now = options.now ?? new Date();
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AppleJwsError('MALFORMED', 'To nie jest poprawny token JWS.');
  }
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: unknown; x5c?: unknown };
  try {
    header = JSON.parse(base64UrlToBuffer(headerPart).toString('utf8')) as {
      alg?: unknown;
      x5c?: unknown;
    };
  } catch {
    throw new AppleJwsError(
      'MALFORMED',
      'Nagłówka tokenu nie da się odczytać.',
    );
  }

  // Tylko ES256. Bez tego `alg: none` albo podmiana na HMAC (z certyfikatem w
  // roli sekretu) przechodzi jako prawdziwy podpis Apple.
  if (header.alg !== 'ES256') {
    throw new AppleJwsError(
      'BAD_ALG',
      `Nieoczekiwany algorytm podpisu: ${String(header.alg)}.`,
    );
  }

  const leaf = verifyCertificateChain(
    (header.x5c ?? []) as string[],
    now,
    options.rootPem,
  );

  // `ieee-p1363` — ECDSA w JWS jest zapisane jako gołe r||s, a nie DER.
  const signed = Buffer.from(`${headerPart}.${payloadPart}`, 'ascii');
  const signature = base64UrlToBuffer(signaturePart);
  // `verify` przy podpisie złej długości RZUCA, zamiast oddać `false` —
  // a dla nas „podpis nie do przyjęcia" i „podpis się nie zgadza" to jedno.
  let ok = false;
  try {
    ok = verify(
      'sha256',
      signed,
      {
        // `leaf.publicKey` JEST już `KeyObject` typu `public`. Owinięcie go w
        // `createPublicKey()` RZUCA `ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE`
        // („expected private"), bo ta funkcja przyjmuje z KeyObject wyłącznie
        // klucz PRYWATNY, żeby wyprowadzić z niego publiczny. Wyjątek wpadał
        // prosto w `catch` poniżej i zamieniał się w `ok = false` — czyli
        // KAŻDY prawdziwy podpis Apple kończył się `BILLING_TRANSACTION_INVALID`
        // z powodem `BAD_SIGNATURE`. Paywall pobierałby pieniądze i nie
        // potwierdził ani jednego zakupu, a z zewnątrz wyglądałoby to na awarię
        // App Store. Nie widział tego żaden test, bo wszystkie odrzucały token
        // WCZEŚNIEJ — na algorytmie, łańcuchu albo korzeniu — i do tej linii
        // nigdy nie docierały. Stąd `apple-jws.verifier.positive.spec.ts`.
        key: leaf.publicKey,
        dsaEncoding: 'ieee-p1363',
      },
      signature,
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new AppleJwsError('BAD_SIGNATURE', 'Podpis tokenu się nie zgadza.');
  }

  try {
    return JSON.parse(base64UrlToBuffer(payloadPart).toString('utf8'));
  } catch {
    throw new AppleJwsError('MALFORMED', 'Treści tokenu nie da się odczytać.');
  }
}

/** Treść `signedTransactionInfo` — tylko pola, których naprawdę używamy. */
export type AppleTransactionInfo = {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  type?: string;
  inAppOwnershipType?: string;
  environment?: string;
  revocationDate?: number;
  revocationReason?: number;
  appAccountToken?: string;
};

/** Treść `signedRenewalInfo` — tylko pola, których naprawdę używamy. */
export type AppleRenewalInfo = {
  originalTransactionId: string;
  autoRenewProductId?: string;
  autoRenewStatus?: number;
  expirationIntent?: number;
  gracePeriodExpiresDate?: number;
  environment?: string;
  productId?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Zweryfikowana transakcja, sprawdzona pod kątem „czy to w ogóle nasze".
 *
 * `bundleId` i `environment` są sprawdzane TUTAJ, nie u wołającego, bo podpis
 * Apple pod cudzą transakcją jest równie prawdziwy jak pod naszą: bez tego
 * sprawdzenia darmowe PRO daje dowolny paragon z dowolnej aplikacji w App
 * Store, a na produkcji — dowolna transakcja z sandboxa.
 */
export function verifyTransaction(
  token: string,
  env: BillingEnv,
  now: Date = new Date(),
): AppleTransactionInfo {
  return checkTransactionPayload(
    verifyAppleJws(token, { now, rootPem: env.rootCaPem }) as Record<
      string,
      unknown
    >,
    env,
  );
}

/**
 * Sprawdzenie treści transakcji, oddzielone od sprawdzenia podpisu.
 *
 * Osobno, bo to są dwa różne pytania: „czy to naprawdę Apple to podpisało" i
 * „czy to w ogóle dotyczy nas". Rozdzielenie pozwala też przetestować drugie
 * bez podrabiania pierwszego.
 */
export function checkTransactionPayload(
  payload: Record<string, unknown>,
  env: BillingEnv,
): AppleTransactionInfo {
  const transactionId = asString(payload.transactionId);
  const originalTransactionId = asString(payload.originalTransactionId);
  const bundleId = asString(payload.bundleId);
  const productId = asString(payload.productId);
  if (!transactionId || !originalTransactionId || !bundleId || !productId) {
    throw new AppleJwsError(
      'INCOMPLETE',
      'Transakcja nie zawiera wymaganych pól.',
    );
  }
  if (bundleId !== env.bundleId) {
    throw new AppleJwsError(
      'WRONG_BUNDLE',
      'Transakcja pochodzi z innej aplikacji.',
    );
  }
  const environment = asString(payload.environment) ?? 'Production';
  const allowed = new Set<string>(acceptedEnvironments(env));
  if (!allowed.has(environment)) {
    throw new AppleJwsError(
      'WRONG_ENVIRONMENT',
      `Transakcja ze środowiska ${environment} nie jest tu uznawana.`,
    );
  }

  // CHMURA RODZINNA. Każdy członek rodziny dostaje WŁASNĄ transakcję z własnym
  // `originalTransactionId` i loguje się własnym Apple ID, więc powstaje osobny
  // wiersz, osobny `sub:<id>` i osobna pula wiadomości. Sześć osób na jednej
  // opłacie 29,99 zł to sześć pełnych pul — czyli sześciokrotny rachunek u
  // dostawcy modelu przy jednym przychodzie. Przełącznik w App Store Connect
  // jest tu tylko drugą linią obrony: to jedno kliknięcie w panelu, którego
  // kod nie widzi, a wcześniej całą decyzję opierano wyłącznie na nim.
  const ownershipType = asString(payload.inAppOwnershipType);
  if (ownershipType === 'FAMILY_SHARED' && !env.acceptFamilyShared) {
    throw new AppleJwsError(
      'FAMILY_SHARED',
      'Transakcja z Chmury Rodzinnej nie daje tu dostępu.',
    );
  }

  return {
    transactionId,
    originalTransactionId,
    bundleId,
    productId,
    purchaseDate: asNumber(payload.purchaseDate) ?? 0,
    originalPurchaseDate: asNumber(payload.originalPurchaseDate),
    expiresDate: asNumber(payload.expiresDate),
    type: asString(payload.type),
    inAppOwnershipType: ownershipType,
    environment,
    revocationDate: asNumber(payload.revocationDate),
    revocationReason: asNumber(payload.revocationReason),
    appAccountToken: asString(payload.appAccountToken),
  };
}

/** To samo dla `signedRenewalInfo` (bez `bundleId` — Apple go tam nie daje). */
export function verifyRenewalInfo(
  token: string,
  now: Date = new Date(),
  rootPem?: string,
): AppleRenewalInfo {
  const payload = verifyAppleJws(token, { now, rootPem }) as Record<
    string,
    unknown
  >;
  const originalTransactionId = asString(payload.originalTransactionId);
  if (!originalTransactionId) {
    throw new AppleJwsError(
      'INCOMPLETE',
      'Informacja o odnowieniu nie zawiera identyfikatora transakcji.',
    );
  }
  return {
    originalTransactionId,
    autoRenewProductId: asString(payload.autoRenewProductId),
    autoRenewStatus: asNumber(payload.autoRenewStatus),
    expirationIntent: asNumber(payload.expirationIntent),
    gracePeriodExpiresDate: asNumber(payload.gracePeriodExpiresDate),
    environment: asString(payload.environment),
    productId: asString(payload.productId),
  };
}

/**
 * Daty od Apple są w MILISEKUNDACH od epoki. Pomyłka o rząd wielkości daje
 * albo subskrypcję wygasłą w 1970, albo ważną do roku 55000 — stąd jawna
 * konwersja w jednym miejscu i odrzucanie wartości spoza rozsądnego zakresu.
 */
export function appleDate(value: number | undefined | null): Date | null {
  if (!value || !Number.isFinite(value)) return null;
  // 1.01.2000 – 1.01.2100 w milisekundach.
  if (value < 946_684_800_000 || value > 4_102_444_800_000) return null;
  return new Date(value);
}
