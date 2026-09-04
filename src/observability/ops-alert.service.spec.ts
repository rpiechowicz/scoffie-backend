import { OpsAlertService } from './ops-alert.service';

describe('OpsAlertService', () => {
  const original = process.env.OPS_ALERT_WEBHOOK_URL;
  let clock: number;
  let fetchMock: jest.Mock;
  let service: OpsAlertService;

  beforeEach(() => {
    clock = 1_000_000;
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    service = new OpsAlertService(
      fetchMock as unknown as typeof fetch,
      () => clock,
    );
    process.env.OPS_ALERT_WEBHOOK_URL = 'https://hooks.example/abc';
  });

  afterEach(() => {
    if (original === undefined) delete process.env.OPS_ALERT_WEBHOOK_URL;
    else process.env.OPS_ALERT_WEBHOOK_URL = original;
  });

  it('bez zmiennej nic nie wysyła — alerty są opcjonalne', async () => {
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    expect(await service.notify('k', 'x')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wysyła POST z tym samym zdaniem w `content` (Discord) i `text` (Slack)', async () => {
    expect(await service.notify('ai-budget-paused:2026-09-02', 'budżet')).toBe(
      true,
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example/abc');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      content: '[Scoffie] budżet',
      text: '[Scoffie] budżet',
    });
  });

  it('ten sam klucz nie budzi operatora częściej niż raz na 6 godzin', async () => {
    await service.notify('k', 'raz');
    clock += 5 * 60 * 60 * 1000;
    expect(await service.notify('k', 'dwa')).toBe(false);
    clock += 2 * 60 * 60 * 1000;
    expect(await service.notify('k', 'trzy')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('błąd webhooka nie wywraca wołającego', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(service.notify('k', 'x')).resolves.toBe(false);
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(service.notify('inny', 'x')).resolves.toBe(false);
  });
});
