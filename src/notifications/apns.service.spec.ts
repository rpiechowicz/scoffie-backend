import { ApnsSendError, ApnsService, apnsReason } from './apns.service';

type Deliver = (
  token: string,
  payload: unknown,
  bundle?: string,
  environment?: string | null,
) => Promise<{ status: number; body: string; apnsId: string | null }>;

/** Serwis z podstawionym żądaniem HTTP/2 — żadnego połączenia z Apple. */
function service(deliver: jest.Mock<ReturnType<Deliver>, Parameters<Deliver>>) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    APNS_ENABLED: 'true',
    APNS_KEY_ID: 'KEY',
    APNS_TEAM_ID: 'TEAM',
    APNS_BUNDLE_ID: 'app.scoffie',
    APNS_PRIVATE_KEY: 'x',
    APNS_USE_SANDBOX: 'false',
  });
  const apns = new ApnsService();
  process.env = saved;
  (apns as unknown as { deliver: Deliver }).deliver = deliver;
  return apns;
}

const payload = { title: 't', body: 'b' };

describe('apnsReason', () => {
  it('wyciąga `reason` z JSON-a, inne ciało skraca, puste = null', () => {
    expect(apnsReason('{"reason":"BadDeviceToken"}')).toBe('BadDeviceToken');
    expect(apnsReason('  ')).toBeNull();
    expect(apnsReason('x'.repeat(200))).toHaveLength(80);
    expect(apnsReason('{"other":1}')).toBe('{"other":1}');
  });
});

describe('ApnsService.sendWithResult (test z panelu)', () => {
  it('sukces: status, apns-id, środowisko i topic urządzenia', async () => {
    const deliver = jest.fn().mockResolvedValue({
      status: 200,
      body: '',
      apnsId: 'ABC-123',
    });
    const result = await service(deliver).sendWithResult(
      'tok',
      payload,
      'app.scoffie.dev',
      'SANDBOX',
    );
    expect(result).toEqual({
      status: 200,
      apnsId: 'ABC-123',
      reason: null,
      environment: 'SANDBOX',
      topic: 'app.scoffie.dev',
    });
    expect(deliver).toHaveBeenCalledWith(
      'tok',
      payload,
      'app.scoffie.dev',
      'SANDBOX',
    );
  });

  it('odmowa: powód z ciała, bez wyjątku; bez środowiska — domyślne', async () => {
    const deliver = jest.fn().mockResolvedValue({
      status: 410,
      body: '{"reason":"Unregistered","timestamp":1}',
      apnsId: 'X',
    });
    const result = await service(deliver).sendWithResult('tok', payload);
    expect(result).toMatchObject({
      status: 410,
      reason: 'Unregistered',
      environment: 'PRODUCTION',
      topic: 'app.scoffie',
    });
  });

  it('brak odpowiedzi (sieć) → status 0 i `NoResponse`', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await service(deliver).sendWithResult('tok', payload);
    expect(result).toMatchObject({ status: 0, reason: 'NoResponse' });
  });

  it('`sendToDevice` dalej rzuca `ApnsSendError` przy odmowie (zwykła wysyłka)', async () => {
    const deliver = jest.fn().mockResolvedValue({
      status: 400,
      body: '{"reason":"BadDeviceToken"}',
      apnsId: null,
    });
    const apns = service(deliver);
    await expect(apns.sendToDevice('tok', payload)).rejects.toBeInstanceOf(
      ApnsSendError,
    );
    deliver.mockResolvedValueOnce({ status: 200, body: '', apnsId: 'ok' });
    await expect(apns.sendToDevice('tok', payload)).resolves.toBeUndefined();
  });
});
