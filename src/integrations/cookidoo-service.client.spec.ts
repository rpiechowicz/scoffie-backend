import { OpsAlertService } from '../observability/ops-alert.service';
import { CookidooServiceClient } from './cookidoo-service.client';

// Sonda po starcie istnieje dla JEDNEGO konkretnego zdarzenia: 13.09.2026
// produkcja przez wiele dni odpowiadała „usługa Cookidoo chwilowo
// niedostępna" na każde żądanie, bo Railway wstrzyknął mikroserwisowi
// `PORT=8080`, a `COOKIDOO_SERVICE_URL` wskazywał `:8000`. Oba serwisy miały
// się dobrze i oba milczały. Test pilnuje tego, co wtedy zawiodło: że rozjazd
// adresu zostawia ślad w logu i alert, zamiast czekać na pierwszego
// użytkownika.
describe('CookidooServiceClient — sonda mikroserwisu po starcie', () => {
  const original = {
    url: process.env.COOKIDOO_SERVICE_URL,
    flag: process.env.COOKIDOO_INTEGRATION_ENABLED,
    fetch: global.fetch,
  };
  let alerts: { notify: jest.Mock };
  let logs: { log: jest.Mock; error: jest.Mock };
  let client: CookidooServiceClient;

  beforeEach(() => {
    process.env.COOKIDOO_SERVICE_URL = 'http://cookidoo.internal:8000';
    delete process.env.COOKIDOO_INTEGRATION_ENABLED;
    alerts = { notify: jest.fn().mockResolvedValue(undefined) };
    client = new CookidooServiceClient(alerts as unknown as OpsAlertService);
    logs = {
      log: jest.fn(),
      error: jest.fn(),
    };
    // Logger jest prywatny i to jest w porządku: test patrzy na to, co widzi
    // operator, więc podmieniamy same ujścia.
    Object.assign(client as unknown as Record<string, unknown>, {
      logger: { ...logs, warn: jest.fn() },
    });
  });

  afterEach(() => {
    global.fetch = original.fetch;
    if (original.url === undefined) delete process.env.COOKIDOO_SERVICE_URL;
    else process.env.COOKIDOO_SERVICE_URL = original.url;
    if (original.flag === undefined)
      delete process.env.COOKIDOO_INTEGRATION_ENABLED;
    else process.env.COOKIDOO_INTEGRATION_ENABLED = original.flag;
  });

  it('mikroserwis odpowiada → adres w logu, bez alertu', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;

    await client.onApplicationBootstrap();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://cookidoo.internal:8000/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(logs.log).toHaveBeenCalledWith(
      expect.stringContaining('http://cookidoo.internal:8000'),
    );
    expect(alerts.notify).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('mikroserwis nieosiągalny → błąd z ADRESEM w logu i alert dla operatora', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    await client.onApplicationBootstrap();

    // Adres w komunikacie jest całą wartością tego logu: to po nim widać, że
    // port nie ten, co ten, na którym mikroserwis słucha.
    const message = String(logs.error.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('http://cookidoo.internal:8000');
    expect(message).toContain('COOKIDOO_SERVICE_URL');
    expect(alerts.notify).toHaveBeenCalledWith(
      'cookidoo-unavailable',
      expect.stringContaining('http://cookidoo.internal:8000'),
    );
  });

  it('zła odpowiedź na /health → też błąd, nie cisza', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 502 }) as unknown as typeof fetch;

    await client.onApplicationBootstrap();

    expect(String(logs.error.mock.calls[0]?.[0] ?? '')).toContain('502');
  });

  it('integracja wyłączona flagą → nie pukamy nigdzie', async () => {
    process.env.COOKIDOO_INTEGRATION_ENABLED = 'false';
    global.fetch = jest.fn() as unknown as typeof fetch;

    await client.onApplicationBootstrap();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('sonda nigdy nie wywraca startu, choćby fetch rzucił czymkolwiek', async () => {
    global.fetch = jest.fn().mockImplementation(() => {
      throw new Error('boom');
    }) as unknown as typeof fetch;

    await expect(client.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
