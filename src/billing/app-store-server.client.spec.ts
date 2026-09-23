import {
  AppStoreKeyError,
  AppStoreServerClient,
  AppStoreUnavailableError,
} from './app-store-server.client';
import { BillingPreflightService } from './billing-preflight.service';

/**
 * WARSTWA, KTÓRA ROZMAWIA Z APPLE — do tej pory bez ANI JEDNEGO testu.
 *
 * We wszystkich pozostałych testach ten klient jest podmieniany atrapą, więc
 * jedyna rzecz, która naprawdę decyduje o tym, czy zakup zostanie potwierdzony,
 * nie była sprawdzona nigdy. Tutaj podstawiamy `fetch` i sprawdzamy zachowanie
 * przy odpowiedziach, które Apple naprawdę wysyła.
 *
 * `fetch` jest jedyną atrapą. Budowanie tokenu, czytanie ciała błędu, zejście
 * na sandbox i klasyfikacja odmów są prawdziwe.
 */

const KLUCZ_TESTOWY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkzaBmcUb1S0rWYyE',
  'Gk83/u7UdOBe+gOhqj2XJ3Kj6l2hRANCAATfX4rYHmsFUF00eKdCDWZLknkj+fY1',
  'SVKH0n6qowW1BH4tCFjcd5z7qLa0Z/clD4YroLN1T0Zt+8Wuxte0pR6z',
  '-----END PRIVATE KEY-----',
].join('\n');

const PRODUKCJA = 'https://api.storekit.apple.com';
const SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com';

const odpowiedz = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('AppStoreServerClient', () => {
  const originals = { ...process.env };
  let client: AppStoreServerClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.BILLING_ENABLED = 'true';
    process.env.APPLE_ISSUER_ID = 'issuer-1';
    process.env.APPLE_BILLING_KEY_ID = 'key-1';
    process.env.APPLE_BILLING_PRIVATE_KEY = KLUCZ_TESTOWY;
    process.env.APPLE_ENVIRONMENT = 'Production';
    process.env.APPLE_BUNDLE_ID = 'app.scoffie.ios';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new AppStoreServerClient();
  });

  afterEach(() => {
    process.env = { ...originals };
    jest.restoreAllMocks();
  });

  const adresy = () =>
    fetchMock.mock.calls.map((call) => String(call[0]).split('/inApps')[0]);

  describe('zejście na sandbox', () => {
    it('404 z kodem 4040010 na produkcji POWTARZA pytanie w sandboxie', async () => {
      // Recenzent App Store testuje PRODUKCYJNY build kontem sandboxowym.
      // Bez tego zejścia klika „Kup", płaci i dostaje odmowę — czyli
      // odrzucenie aplikacji, zanim pojawi się pierwszy prawdziwy klient.
      fetchMock
        .mockResolvedValueOnce(odpowiedz(404, { errorCode: 4040010 }))
        .mockResolvedValueOnce(odpowiedz(404, { errorCode: 4040010 }));

      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreUnavailableError);
      expect(adresy()).toEqual([PRODUKCJA, SANDBOX]);
    });

    it('404 z INNYM kodem nie schodzi do sandboxa', async () => {
      fetchMock.mockResolvedValueOnce(odpowiedz(404, { errorCode: 4040005 }));
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreUnavailableError);
      expect(adresy()).toEqual([PRODUKCJA]);
    });

    it('w sandboxie nie ma do czego schodzić — jedno pytanie', async () => {
      process.env.APPLE_ENVIRONMENT = 'Sandbox';
      fetchMock.mockResolvedValueOnce(odpowiedz(404, { errorCode: 4040010 }));
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreUnavailableError);
      expect(adresy()).toEqual([SANDBOX]);
    });
  });

  describe('aplikacja przed pierwszym wydaniem w App Store', () => {
    // Produkcja odmawia (401) każdemu żądaniu aplikacji bez wydania — także
    // z dobrym kluczem. Na prod 23.09.2026 gasiło to sprzedaż, a recenzent
    // App Store kupujący w sandboxie dostałby odmowę zamiast dostępu.
    beforeEach(() => {
      process.env.APPLE_ACCEPT_SANDBOX = 'true';
    });

    it('401 z produkcji przy zgodzie na sandbox pyta sandbox', async () => {
      fetchMock
        .mockResolvedValueOnce(odpowiedz(401, {}))
        .mockResolvedValueOnce(odpowiedz(404, { errorCode: 4040010 }));
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreUnavailableError);
      // Sandbox pytany RAZ — już był źródłem, nie ma do czego schodzić drugi raz.
      expect(adresy()).toEqual([PRODUKCJA, SANDBOX]);
    });

    it('sandbox też odmawia — klucz jest naprawdę zły', async () => {
      fetchMock
        .mockResolvedValueOnce(odpowiedz(401, {}))
        .mockResolvedValueOnce(odpowiedz(401, {}));
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreKeyError);
    });

    it('403 z produkcji NIE schodzi do sandboxa — to nie jest blokada przed wydaniem', async () => {
      fetchMock.mockResolvedValueOnce(odpowiedz(403, {}));
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreKeyError);
      expect(adresy()).toEqual([PRODUKCJA]);
    });

    it('bez zgody na sandbox 401 z produkcji zostaje błędem klucza', async () => {
      delete process.env.APPLE_ACCEPT_SANDBOX;
      fetchMock.mockResolvedValueOnce(odpowiedz(401, {}));
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreKeyError);
      expect(adresy()).toEqual([PRODUKCJA]);
    });

    it('sprawdzenie przy starcie: sandbox przyjmuje token → klucz dobry, sprzedaż zostaje', async () => {
      fetchMock
        .mockResolvedValueOnce(odpowiedz(401, {}))
        .mockResolvedValueOnce(odpowiedz(404, { errorCode: 4040010 }));
      const wynik = await client.verifyCredentials();
      expect(wynik.stan).toBe('ok');
      expect(wynik.szczegol).toMatch(/pierwszego wydania/);
    });

    it('sprawdzenie przy starcie: sandbox też odmawia → zły klucz', async () => {
      fetchMock
        .mockResolvedValueOnce(odpowiedz(401, {}))
        .mockResolvedValueOnce(odpowiedz(401, {}));
      await expect(client.verifyCredentials()).resolves.toMatchObject({
        stan: 'klucz',
      });
    });
  });

  describe('klasyfikacja odmów', () => {
    it('ŚWIEŻO KUPIONA transakcja to awaria CHWILOWA, nie „nie ma takiej"', async () => {
      // App Store Server API bywa opóźnione o kilka minut wobec zakupu. To 404
      // kosztowało dokładnie pierwszy zakup każdego klienta: telefon uznawał
      // odmowę za trwałą, domykał transakcję i pieniądze przepadały bez ratunku.
      fetchMock
        .mockResolvedValueOnce(odpowiedz(404, { errorCode: 4040010 }))
        .mockResolvedValueOnce(odpowiedz(404, { errorCode: 4040010 }));
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreUnavailableError);
    });

    it('401 to NASZ klucz, a nie awaria Apple', async () => {
      fetchMock.mockResolvedValueOnce(odpowiedz(401, {}));
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreKeyError);
    });

    it('403 też jest błędem klucza', async () => {
      fetchMock.mockResolvedValueOnce(odpowiedz(403, {}));
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreKeyError);
    });

    it('KLUCZ NIE DO ODCZYTANIA nie melduje się jako awaria Apple — i nie wysyła żądania', async () => {
      process.env.APPLE_BILLING_PRIVATE_KEY = 'to-nie-jest-klucz';
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreKeyError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('errorCode od Apple trafia do komunikatu — bez niego wsparcie Apple nie ma o co pytać', async () => {
      fetchMock.mockResolvedValueOnce(
        odpowiedz(500, {
          errorCode: 5000000,
          errorMessage: 'General internal',
        }),
      );
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toThrow(/5000000/);
    });

    it('awaria sieci to awaria chwilowa', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(
        client.subscriptionState('2000000000000001'),
      ).rejects.toBeInstanceOf(AppStoreUnavailableError);
    });
  });

  describe('token do Apple', () => {
    it('nagłówek i roszczenia są takie, jakich wymaga App Store Server API', async () => {
      fetchMock.mockResolvedValueOnce(odpowiedz(404, { errorCode: 4040005 }));
      await client.subscriptionState('2000000000000001').catch(() => undefined);

      const naglowki = fetchMock.mock.calls[0][1].headers as Record<
        string,
        string
      >;
      const token = naglowki.authorization.replace('Bearer ', '');
      const [head, body] = token
        .split('.')
        .slice(0, 2)
        .map(
          (part) =>
            JSON.parse(
              Buffer.from(part, 'base64url').toString('utf8'),
            ) as Record<string, unknown>,
        );

      expect(head.alg).toBe('ES256');
      expect(head.kid).toBe('key-1');
      expect(head.typ).toBe('JWT');
      expect(body.iss).toBe('issuer-1');
      expect(body.aud).toBe('appstoreconnect-v1');
      expect(body.bid).toBe('app.scoffie.ios');
      // Apple dopuszcza godzinę; my dajemy pięć minut, żeby token nie przeżył
      // rotacji klucza.
      expect(Number(body.exp) - Number(body.iat)).toBeLessThanOrEqual(3600);
      expect(Number(body.exp) - Number(body.iat)).toBeGreaterThan(0);
    });
  });

  describe('sprawdzenie klucza przed sprzedażą', () => {
    it('404 znaczy „token przyjęty" — klucz jest dobry', async () => {
      fetchMock.mockResolvedValueOnce(odpowiedz(404, { errorCode: 4040010 }));
      await expect(client.verifyCredentials()).resolves.toMatchObject({
        stan: 'ok',
      });
    });

    it('401 znaczy zły klucz', async () => {
      fetchMock.mockResolvedValueOnce(odpowiedz(401, {}));
      await expect(client.verifyCredentials()).resolves.toMatchObject({
        stan: 'klucz',
      });
    });

    it('awaria sieci to „nie wiadomo", a nie „zły klucz"', async () => {
      fetchMock.mockRejectedValueOnce(new Error('timeout'));
      await expect(client.verifyCredentials()).resolves.toMatchObject({
        stan: 'nieznany',
      });
    });
  });
});

describe('BillingPreflightService', () => {
  const originals = { ...process.env };
  afterEach(() => {
    process.env = { ...originals };
  });

  const preflightZ = (stan: string) =>
    new BillingPreflightService({
      verifyCredentials: jest.fn().mockResolvedValue({ stan, szczegol: 'x' }),
    } as unknown as AppStoreServerClient);

  it('ZŁY KLUCZ GASI SPRZEDAŻ — nikt nie zapłaci za dostęp, którego nie umiemy nadać', async () => {
    const preflight = preflightZ('klucz');
    await preflight.sprawdz();
    expect(preflight.wolnoSprzedawac()).toBe(false);
  });

  it('dobry klucz pozwala sprzedawać', async () => {
    const preflight = preflightZ('ok');
    await preflight.sprawdz();
    expect(preflight.wolnoSprzedawac()).toBe(true);
  });

  it('„nie wiadomo" NIE gasi sprzedaży — cudza awaria to nie nasz błąd', async () => {
    const preflight = preflightZ('nieznany');
    await preflight.sprawdz();
    expect(preflight.wolnoSprzedawac()).toBe(true);
  });

  it('przed pierwszym sprawdzeniem sprzedaż jest dozwolona, ale stan jest „nieznany"', () => {
    const preflight = preflightZ('ok');
    expect(preflight.ostatni().stan).toBe('nieznany');
    expect(preflight.wolnoSprzedawac()).toBe(true);
  });

  it('wyłączone płatności nie pytają Apple o nic', async () => {
    process.env.BILLING_ENABLED = 'false';
    const appStore = {
      verifyCredentials: jest.fn(),
    } as unknown as AppStoreServerClient;
    const preflight = new BillingPreflightService(appStore);
    await preflight.onApplicationBootstrap();
    expect(appStore.verifyCredentials).not.toHaveBeenCalled();
  });
});
