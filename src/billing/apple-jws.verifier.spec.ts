import {
  AppleJwsError,
  appleDate,
  checkTransactionPayload,
  verifyAppleJws,
  verifyCertificateChain,
} from './apple-jws.verifier';
import {
  APPLE_ROOT_CA_G3_PEM,
  APPLE_ROOT_CA_G3_SHA256,
  readBillingEnv,
  type BillingEnv,
} from './billing-env';
import { X509Certificate } from 'node:crypto';

/**
 * Bramka pieniężna: to jedyne miejsce, które decyduje, czy podpisany ładunek
 * naprawdę wyszedł od Apple. Testy chodzą po ATAKACH, nie po ścieżce szczęścia
 * — bo ścieżkę szczęścia zepsuje najbliższy błąd konfiguracji, a atak zostanie
 * niezauważony aż do rachunku.
 *
 * Prawdziwego łańcucha Apple nie da się tu podrobić (i o to chodzi), więc do
 * testów służą DWA PRAWDZIWE certyfikaty główne Apple: G3 (nasz przypięty) i
 * G2 (poprawny, ale nie ten). Para „prawdziwy, lecz nie przypięty" to
 * dokładnie ta sytuacja, którą przypinanie ma wyłapać.
 */

/** Apple Root CA - G2 w base64 (DER) — prawdziwy korzeń, ale NIE nasz. */
const APPLE_ROOT_G2_DER =
  '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';

const APPLE_ROOT_G2_PEM = `-----BEGIN CERTIFICATE-----\n${
  APPLE_ROOT_G2_DER.match(/.{1,64}/g)?.join('\n') ?? ''
}\n-----END CERTIFICATE-----`;

const APPLE_ROOT_G3_DER = APPLE_ROOT_CA_G3_PEM.replace(
  /-----[A-Z ]+-----|\s/g,
  '',
);

const NOW = new Date('2026-09-03T12:00:00.000Z');

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const token = (header: unknown, payload: unknown, signature = 'AAAA'): string =>
  `${b64url(header)}.${b64url(payload)}.${signature}`;

const billingEnv = (over: Partial<BillingEnv> = {}): BillingEnv => ({
  ...readBillingEnv(),
  bundleId: 'app.scoffie',
  environment: 'Production',
  acceptSandbox: false,
  ...over,
});

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof AppleJwsError
      ? error.code
      : `NIE-JWS:${String(error)}`;
  }
  return 'BRAK-BLEDU';
};

describe('przypięty korzeń Apple', () => {
  it('wpisany na sztywno certyfikat to naprawdę Apple Root CA - G3', () => {
    const cert = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
    expect(cert.subject).toContain('Apple Root CA - G3');
    expect(cert.fingerprint256).toBe(APPLE_ROOT_CA_G3_SHA256);
    // Korzeń podpisuje sam siebie — inaczej nie byłby korzeniem.
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(Date.parse(cert.validTo)).toBeGreaterThan(NOW.getTime());
  });
});

describe('łańcuch certyfikatów', () => {
  it('odrzuca brak łańcucha i łańcuch z jednym ogniwem', () => {
    expect(codeOf(() => verifyCertificateChain([], NOW))).toBe(
      'CHAIN_TOO_SHORT',
    );
    expect(codeOf(() => verifyCertificateChain([APPLE_ROOT_G3_DER], NOW))).toBe(
      'CHAIN_TOO_SHORT',
    );
  });

  it('odrzuca łańcuch dłuższy, niż Apple kiedykolwiek wysyła', () => {
    const long = Array.from({ length: 6 }, () => APPLE_ROOT_G3_DER);
    expect(codeOf(() => verifyCertificateChain(long, NOW))).toBe(
      'CHAIN_TOO_LONG',
    );
  });

  it('odrzuca coś, co nie jest certyfikatem', () => {
    expect(
      codeOf(() => verifyCertificateChain(['nie-certyfikat', 'ani-to'], NOW)),
    ).toBe('CHAIN_UNPARSABLE');
  });

  it('PRAWDZIWY, ale nieprzypięty korzeń Apple nie przechodzi', () => {
    // To jest atak „podstawiony klucz w x5c" w najtrudniejszej wersji:
    // napastnik ma poprawny, samopodpisany certyfikat prawdziwej firmy.
    expect(
      codeOf(() =>
        verifyCertificateChain([APPLE_ROOT_G2_DER, APPLE_ROOT_G2_DER], NOW),
      ),
    ).toBe('ROOT_NOT_PINNED');
  });

  it('łańcuch niepodpisany przez następne ogniwo nie przechodzi', () => {
    // G3 nie jest podpisany przez G2 — sam podpis rozstrzyga wcześniej niż
    // przypięcie, więc dostajemy CHAIN_BROKEN.
    expect(
      codeOf(() =>
        verifyCertificateChain([APPLE_ROOT_G3_DER, APPLE_ROOT_G2_DER], NOW),
      ),
    ).toBe('CHAIN_BROKEN');
  });

  it('certyfikat poza okresem ważności nie przechodzi', () => {
    const before = new Date('2000-01-01T00:00:00.000Z');
    expect(
      codeOf(() =>
        verifyCertificateChain([APPLE_ROOT_G3_DER, APPLE_ROOT_G3_DER], before),
      ),
    ).toBe('CERT_EXPIRED');
  });

  it('poprawny, przypięty korzeń przechodzi i oddaje liść', () => {
    const leaf = verifyCertificateChain(
      [APPLE_ROOT_G3_DER, APPLE_ROOT_G3_DER],
      NOW,
    );
    expect(leaf.subject).toContain('Apple Root CA - G3');
  });

  it('inny przypięty korzeń zmienia werdykt — przypięcie naprawdę działa', () => {
    expect(
      codeOf(() =>
        verifyCertificateChain(
          [APPLE_ROOT_G3_DER, APPLE_ROOT_G3_DER],
          NOW,
          APPLE_ROOT_G2_PEM,
        ),
      ),
    ).toBe('ROOT_NOT_PINNED');
  });
});

describe('podpis JWS', () => {
  it('odrzuca token, który nie ma trzech części', () => {
    expect(codeOf(() => verifyAppleJws('a.b'))).toBe('MALFORMED');
    expect(codeOf(() => verifyAppleJws(''))).toBe('MALFORMED');
  });

  it('odrzuca `alg: none` — klasyczne obejście podpisu', () => {
    expect(
      codeOf(() =>
        verifyAppleJws(token({ alg: 'none', x5c: [] }, { productId: 'x' }), {
          now: NOW,
        }),
      ),
    ).toBe('BAD_ALG');
  });

  it('odrzuca podmianę na HMAC (HS256) z certyfikatem w roli sekretu', () => {
    expect(
      codeOf(() =>
        verifyAppleJws(
          token({ alg: 'HS256', x5c: [APPLE_ROOT_G3_DER] }, { a: 1 }),
          { now: NOW },
        ),
      ),
    ).toBe('BAD_ALG');
  });

  it('sprawdza łańcuch ZANIM uwierzy podpisowi', () => {
    expect(
      codeOf(() =>
        verifyAppleJws(
          token(
            { alg: 'ES256', x5c: [APPLE_ROOT_G2_DER, APPLE_ROOT_G2_DER] },
            {
              a: 1,
            },
          ),
          { now: NOW },
        ),
      ),
    ).toBe('ROOT_NOT_PINNED');
  });

  it('poprawny łańcuch z niepasującym podpisem nie przechodzi', () => {
    expect(
      codeOf(() =>
        verifyAppleJws(
          token(
            { alg: 'ES256', x5c: [APPLE_ROOT_G3_DER, APPLE_ROOT_G3_DER] },
            {
              productId: 'darmowe-pro',
            },
          ),
          { now: NOW },
        ),
      ),
    ).toBe('BAD_SIGNATURE');
  });
});

describe('treść transakcji', () => {
  const full = {
    transactionId: '2000000123',
    originalTransactionId: '2000000000',
    bundleId: 'app.scoffie',
    productId: 'app.scoffie.pro.solo.monthly',
    purchaseDate: 1_756_000_000_000,
    environment: 'Production',
  };

  it('przyjmuje kompletną transakcję z naszej aplikacji', () => {
    const info = checkTransactionPayload(full, billingEnv());
    expect(info.originalTransactionId).toBe('2000000000');
    expect(info.productId).toBe('app.scoffie.pro.solo.monthly');
  });

  it('odrzuca transakcję z INNEJ aplikacji, choć podpis jest prawdziwy', () => {
    expect(
      codeOf(() =>
        checkTransactionPayload(
          { ...full, bundleId: 'cudza.apka' },
          billingEnv(),
        ),
      ),
    ).toBe('WRONG_BUNDLE');
  });

  it('odrzuca transakcję z sandboxa na produkcji', () => {
    expect(
      codeOf(() =>
        checkTransactionPayload(
          { ...full, environment: 'Sandbox' },
          billingEnv(),
        ),
      ),
    ).toBe('WRONG_ENVIRONMENT');
  });

  it('przyjmuje sandbox tam, gdzie jest na to zgoda', () => {
    const info = checkTransactionPayload(
      { ...full, environment: 'Sandbox' },
      billingEnv({ acceptSandbox: true }),
    );
    expect(info.environment).toBe('Sandbox');
  });

  it('odrzuca transakcję bez wymaganych pól', () => {
    expect(
      codeOf(() =>
        checkTransactionPayload(
          { ...full, productId: undefined },
          billingEnv(),
        ),
      ),
    ).toBe('INCOMPLETE');
  });

  it('brak `environment` traktuje jak produkcję, nie jak dziurę', () => {
    const info = checkTransactionPayload(
      { ...full, environment: undefined },
      billingEnv(),
    );
    expect(info.environment).toBe('Production');
  });
});

describe('daty od Apple', () => {
  it('milisekundy zamienia na datę', () => {
    expect(appleDate(1_756_000_000_000)?.toISOString()).toBe(
      '2025-08-24T01:46:40.000Z',
    );
  });

  it('odrzuca wartości spoza rozsądnego zakresu i puste', () => {
    // Sekundy wpisane jako milisekundy dałyby rok 1970 — subskrypcja
    // „wygasła 55 lat temu" u kogoś, kto właśnie zapłacił.
    expect(appleDate(1_756_000_000)).toBeNull();
    // Milisekundy wpisane jako sekundy dałyby rok 57 000.
    expect(appleDate(1_756_000_000_000_000)).toBeNull();
    expect(appleDate(0)).toBeNull();
    expect(appleDate(undefined)).toBeNull();
    expect(appleDate(Number.NaN)).toBeNull();
  });
});
