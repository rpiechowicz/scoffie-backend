import { createPrivateKey, sign } from 'node:crypto';
import { X509Certificate } from 'node:crypto';
import {
  APPLE_APP_STORE_SIGNING_OID,
  APPLE_WWDR_INTERMEDIATE_OID,
  AppleJwsError,
  certificateExtensionOids,
  checkTransactionPayload,
  verifyAppleJws,
} from './apple-jws.verifier';
import {
  TEST_INTERMEDIATE_PEM,
  TEST_LEAF_PEM,
  TEST_LEAF_PRIVATE_KEY_PEM,
  TEST_LEAF_UNDER_UNMARKED_PEM,
  TEST_LEAF_UNDER_UNMARKED_PRIVATE_KEY_PEM,
  TEST_P384_LEAF_PEM,
  TEST_P384_LEAF_PRIVATE_KEY_PEM,
  TEST_ROOT_PEM,
  TEST_UNMARKED_INTERMEDIATE_PEM,
  TEST_UNMARKED_LEAF_PEM,
  TEST_UNMARKED_LEAF_PRIVATE_KEY_PEM,
  TEST_X5C,
  derOf,
} from './apple-jws-chain.spec-helper';
import { readBillingEnv, type BillingEnv } from './billing-env';

/**
 * PODPIS, KTÓRY MA PRZEJŚĆ.
 *
 * `apple-jws.verifier.spec.ts` sprawdza wyłącznie ODMOWY: zły algorytm, zerwany
 * łańcuch, obcy korzeń, podrobiony podpis. To znaczy, że weryfikator odrzucający
 * WSZYSTKO — także prawdziwe transakcje — przechodziłby tamten zestaw w
 * komplecie. A weryfikator, który odrzuca wszystko, to paywall, który pobiera
 * pieniądze i nigdy nie potwierdza zakupu; z zewnątrz wygląda dokładnie jak
 * awaria App Store, więc nikt nie szuka błędu u siebie.
 *
 * Tutaj podpisujemy token NAPRAWDĘ (ES256, klucz liścia z własnego łańcucha) i
 * przypinamy własny korzeń przez `rootPem`. Ścieżka kodu jest ta sama, co przy
 * Apple: sprawdzenie `alg`, ważność każdego ogniwa, podpis każdego ogniwa przez
 * następne, zgodność wystawcy, odcisk korzenia i dopiero na końcu sam podpis
 * tokenu kluczem z liścia.
 */

const NOW = new Date('2026-09-04T12:00:00.000Z');

const b64url = (input: Buffer | string): string =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** Prawdziwy JWS: nagłówek z `x5c`, treść i podpis ES256 w postaci r||s. */
function signJws(
  payload: Record<string, unknown>,
  over: { alg?: string; x5c?: string[]; key?: string } = {},
): string {
  const header = b64url(
    JSON.stringify({ alg: over.alg ?? 'ES256', x5c: over.x5c ?? TEST_X5C }),
  );
  const body = b64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`, 'ascii'), {
    key: createPrivateKey(over.key ?? TEST_LEAF_PRIVATE_KEY_PEM),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${body}.${b64url(signature)}`;
}

const transactionPayload = (over: Record<string, unknown> = {}) => ({
  transactionId: '2000000000000009',
  originalTransactionId: '2000000000000001',
  bundleId: 'app.scoffie.ios',
  productId: 'app.scoffie.pro.solo.monthly',
  purchaseDate: Date.parse('2026-09-01T00:00:00.000Z'),
  expiresDate: Date.parse('2026-10-01T00:00:00.000Z'),
  environment: 'Production',
  inAppOwnershipType: 'PURCHASED',
  ...over,
});

const envWith = (over: Partial<BillingEnv> = {}): BillingEnv => ({
  ...readBillingEnv(),
  bundleId: 'app.scoffie.ios',
  environment: 'Production',
  acceptSandbox: false,
  acceptFamilyShared: false,
  ...over,
});

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof AppleJwsError
      ? error.code
      : `INNY:${String(error)}`;
  }
  return 'BRAK-BLEDU';
};

describe('verifyAppleJws — ścieżka udana', () => {
  it('PRAWDZIWY podpis ES256 z pełnym łańcuchem do przypiętego korzenia PRZECHODZI', () => {
    const token = signJws(transactionPayload());
    const payload = verifyAppleJws(token, {
      now: NOW,
      rootPem: TEST_ROOT_PEM,
    }) as Record<string, unknown>;
    expect(payload.transactionId).toBe('2000000000000009');
    expect(payload.bundleId).toBe('app.scoffie.ios');
  });

  it('ta sama treść z CUDZYM podpisem nie przechodzi', () => {
    // PODPIS BIERZEMY SPOD INNEJ TREŚCI, a nie podmieniamy w nim znaku.
    //
    // Pierwsza wersja tego testu przestawiała OSTATNI znak base64url podpisu
    // i była LOSOWO ZAWODNA — padała mniej więcej raz na pięć uruchomień.
    // Podpis ES256 ma 64 bajty, czyli 512 bitów, a 86 znaków base64url niesie
    // 516: ostatni znak ma cztery bity znaczące i dwa wypełniające. ECDSA
    // losuje podpis przy każdym podpisaniu, więc co jakiś czas podmiana
    // trafiała wyłącznie w bity wypełniające — odkodowany podpis wychodził
    // IDENTYCZNY, weryfikacja słusznie przechodziła, a test padał bez winy
    // kodu. Podpis spod innej treści jest zły zawsze i deterministycznie.
    const token = signJws(transactionPayload());
    const obcy = signJws(transactionPayload({ productId: 'app.scoffie.inny' }));
    const [header, body] = token.split('.');
    const podpisObcy = obcy.split('.')[2];
    expect(
      codeOf(() =>
        verifyAppleJws(`${header}.${body}.${podpisObcy}`, {
          now: NOW,
          rootPem: TEST_ROOT_PEM,
        }),
      ),
    ).toBe('BAD_SIGNATURE');
  });

  it('prawdziwy podpis, ale korzeń NIE nasz — odmowa (to jest sedno przypinania)', () => {
    // Bez `rootPem` przypięty jest korzeń Apple, a token podpisał nasz łańcuch.
    const token = signJws(transactionPayload());
    expect(codeOf(() => verifyAppleJws(token, { now: NOW }))).toBe(
      'ROOT_NOT_PINNED',
    );
  });

  it('prawdziwy podpis liścia, ale łańcuch obcięty do samego liścia — odmowa', () => {
    const token = signJws(transactionPayload(), { x5c: [TEST_X5C[0]] });
    expect(
      codeOf(() => verifyAppleJws(token, { now: NOW, rootPem: TEST_ROOT_PEM })),
    ).toBe('CHAIN_TOO_SHORT');
  });

  it('data spoza ważności certyfikatów ucina weryfikację, choć podpis jest dobry', () => {
    const token = signJws(transactionPayload());
    expect(
      codeOf(() =>
        verifyAppleJws(token, {
          // Certyfikaty w atrapie są ważne od 1.01.2020 (patrz spec-helper).
          now: new Date('2019-06-01T00:00:00.000Z'),
          rootPem: TEST_ROOT_PEM,
        }),
      ),
    ).toBe('CERT_EXPIRED');
  });
});

describe('verifyAppleJws — role certyfikatów Apple (audyt 7.10.2026)', () => {
  // Każdy z tych łańcuchów ma PRAWDZIWE podpisy aż do przypiętego korzenia —
  // tak wygląda certyfikat Apple Pay albo inny certyfikat dewelopera spod
  // Apple Root CA - G3. Odmowę daje wyłącznie sprawdzenie ról ogniw.
  const notification = {
    notificationType: 'DID_RENEW',
    signedDate: Date.parse('2099-01-01T00:00:00.000Z'),
  };
  const verify = (token: string) =>
    codeOf(() => verifyAppleJws(token, { now: NOW, rootPem: TEST_ROOT_PEM }));

  it('odczytuje znaczniki ról z rozszerzeń certyfikatu', () => {
    expect(
      certificateExtensionOids(new X509Certificate(TEST_LEAF_PEM)),
    ).toContain(APPLE_APP_STORE_SIGNING_OID);
    expect(
      certificateExtensionOids(new X509Certificate(TEST_INTERMEDIATE_PEM)),
    ).toContain(APPLE_WWDR_INTERMEDIATE_OID);
    expect(
      certificateExtensionOids(new X509Certificate(TEST_UNMARKED_LEAF_PEM)),
    ).not.toContain(APPLE_APP_STORE_SIGNING_OID);
  });

  it('liść bez znacznika podpisu App Store — odmowa, choć podpis i łańcuch są prawdziwe', () => {
    const token = signJws(notification, {
      x5c: [TEST_UNMARKED_LEAF_PEM, TEST_INTERMEDIATE_PEM, TEST_ROOT_PEM].map(
        derOf,
      ),
      key: TEST_UNMARKED_LEAF_PRIVATE_KEY_PEM,
    });
    expect(verify(token)).toBe('LEAF_NOT_APP_STORE');
  });

  it('pośredni bez znacznika Apple WWDR — odmowa', () => {
    const token = signJws(notification, {
      x5c: [
        TEST_LEAF_UNDER_UNMARKED_PEM,
        TEST_UNMARKED_INTERMEDIATE_PEM,
        TEST_ROOT_PEM,
      ].map(derOf),
      key: TEST_LEAF_UNDER_UNMARKED_PRIVATE_KEY_PEM,
    });
    expect(verify(token)).toBe('INTERMEDIATE_NOT_WWDR');
  });

  it('liść z kluczem innym niż P-256 — odmowa', () => {
    const token = signJws(notification, {
      x5c: [TEST_P384_LEAF_PEM, TEST_INTERMEDIATE_PEM, TEST_ROOT_PEM].map(
        derOf,
      ),
      key: TEST_P384_LEAF_PRIVATE_KEY_PEM,
    });
    expect(verify(token)).toBe('LEAF_KEY_NOT_ES256');
  });

  it('łańcuch bez pośredniego (liść podpisany wprost korzeniem) — odmowa', () => {
    const token = signJws(notification, {
      x5c: [TEST_INTERMEDIATE_PEM, TEST_ROOT_PEM].map(derOf),
    });
    expect(verify(token)).toBe('CHAIN_NOT_APP_STORE');
  });
});

describe('checkTransactionPayload na PRAWDZIWIE zweryfikowanej treści', () => {
  const verified = (over: Record<string, unknown> = {}) =>
    verifyAppleJws(signJws(transactionPayload(over)), {
      now: NOW,
      rootPem: TEST_ROOT_PEM,
    }) as Record<string, unknown>;

  it('normalny zakup przechodzi i oddaje pola, na których stoi cała reszta', () => {
    const info = checkTransactionPayload(verified(), envWith());
    expect(info.originalTransactionId).toBe('2000000000000001');
    expect(info.productId).toBe('app.scoffie.pro.solo.monthly');
    expect(info.environment).toBe('Production');
    expect(info.inAppOwnershipType).toBe('PURCHASED');
  });

  it('CHMURA RODZINNA jest odrzucana — jedna opłata nie może dać sześciu pul', () => {
    // Każdy członek rodziny dostaje własną transakcję z własnym
    // `originalTransactionId`, czyli własny wiersz i własny `sub:<id>`.
    // Wcześniej kod TYLKO to logował, a wiersz i tak powstawał.
    expect(
      codeOf(() =>
        checkTransactionPayload(
          verified({ inAppOwnershipType: 'FAMILY_SHARED' }),
          envWith(),
        ),
      ),
    ).toBe('FAMILY_SHARED');
  });

  it('Chmura Rodzinna przechodzi TYLKO przy jawnej zgodzie w konfiguracji', () => {
    const info = checkTransactionPayload(
      verified({ inAppOwnershipType: 'FAMILY_SHARED' }),
      envWith({ acceptFamilyShared: true }),
    );
    expect(info.inAppOwnershipType).toBe('FAMILY_SHARED');
  });

  it('sandbox na produkcji jest odrzucany, choć podpis Apple jest prawdziwy', () => {
    expect(
      codeOf(() =>
        checkTransactionPayload(
          verified({ environment: 'Sandbox' }),
          envWith(),
        ),
      ),
    ).toBe('WRONG_ENVIRONMENT');
  });

  it('cudza aplikacja jest odrzucana', () => {
    expect(
      codeOf(() =>
        checkTransactionPayload(
          verified({ bundleId: 'com.ktos.inny' }),
          envWith(),
        ),
      ),
    ).toBe('WRONG_BUNDLE');
  });

  it('appAccountToken wraca do wołającego — na nim stoi „czyj to zakup"', () => {
    const info = checkTransactionPayload(
      verified({ appAccountToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      envWith(),
    );
    expect(info.appAccountToken).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
});
