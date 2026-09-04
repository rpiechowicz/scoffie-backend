import { createPrivateKey, sign } from 'node:crypto';
import {
  AppleJwsError,
  checkTransactionPayload,
  verifyAppleJws,
} from './apple-jws.verifier';
import {
  TEST_LEAF_PRIVATE_KEY_PEM,
  TEST_ROOT_PEM,
  TEST_X5C,
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
  over: { alg?: string; x5c?: string[] } = {},
): string {
  const header = b64url(
    JSON.stringify({ alg: over.alg ?? 'ES256', x5c: over.x5c ?? TEST_X5C }),
  );
  const body = b64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`, 'ascii'), {
    key: createPrivateKey(TEST_LEAF_PRIVATE_KEY_PEM),
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

  it('ta sama treść z PODMIENIONYM jednym znakiem podpisu już nie przechodzi', () => {
    const token = signJws(transactionPayload());
    const [header, body, signature] = token.split('.');
    const broken = `${header}.${body}.${signature.slice(0, -1)}${
      signature.endsWith('A') ? 'B' : 'A'
    }`;
    expect(
      codeOf(() =>
        verifyAppleJws(broken, { now: NOW, rootPem: TEST_ROOT_PEM }),
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
