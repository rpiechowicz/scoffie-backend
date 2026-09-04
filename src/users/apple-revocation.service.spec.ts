import { generateKeyPairSync } from 'node:crypto';
import { AppleRevocationService } from './apple-revocation.service';

/**
 * Bez sieci i bez prawdziwego klucza Apple: klucz P-256 generujemy w teście,
 * a `fetch` podstawiamy. Sprawdzamy kontrakt z Apple (dwa POST-y w dobrej
 * kolejności, poprawne pola formularza) i to, że porażka nigdy nie rzuca.
 */
describe('AppleRevocationService', () => {
  const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const env = {
    APPLE_TEAM_ID: 'TEAM123',
    APPLE_KEY_ID: 'KEY456',
    APPLE_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
    APPLE_CLIENT_ID: 'app.scoffie',
  } as NodeJS.ProcessEnv;

  const response = (status: number, body: unknown = {}) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }) as unknown as Response;

  it('bez konfiguracji: not_configured i zero wywołań sieci', async () => {
    const service = new AppleRevocationService();
    const fetchMock = jest.fn();
    service.useFetch(fetchMock as unknown as typeof fetch);
    await expect(service.revoke('kod', {} as NodeJS.ProcessEnv)).resolves.toBe(
      'not_configured',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wymienia kod na refresh token i go unieważnia — z sekretem ES256 z klucza .p8', async () => {
    const service = new AppleRevocationService();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response(200, { refresh_token: 'rt-1' }))
      .mockResolvedValueOnce(response(200));
    service.useFetch(fetchMock as unknown as typeof fetch);

    await expect(service.revoke('auth-code', env)).resolves.toBe('revoked');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [
      string,
      { body: string },
    ];
    const tokenForm = new URLSearchParams(tokenInit.body);
    expect(tokenUrl).toBe('https://appleid.apple.com/auth/token');
    expect(tokenForm.get('grant_type')).toBe('authorization_code');
    expect(tokenForm.get('code')).toBe('auth-code');
    expect(tokenForm.get('client_id')).toBe('app.scoffie');
    // Sekret to JWT: trzy części, nagłówek z kid i ES256.
    const secret = tokenForm.get('client_secret') ?? '';
    const header = JSON.parse(
      Buffer.from(secret.split('.')[0], 'base64url').toString(),
    ) as { alg: string; kid: string };
    expect(header).toEqual({ alg: 'ES256', kid: 'KEY456' });

    const [revokeUrl, revokeInit] = fetchMock.mock.calls[1] as [
      string,
      { body: string },
    ];
    const revokeForm = new URLSearchParams(revokeInit.body);
    expect(revokeUrl).toBe('https://appleid.apple.com/auth/revoke');
    expect(revokeForm.get('token')).toBe('rt-1');
    expect(revokeForm.get('token_type_hint')).toBe('refresh_token');
  });

  it('odmowa Apple albo błąd sieci = failed, nigdy wyjątek', async () => {
    const service = new AppleRevocationService();
    service.useFetch(
      jest.fn().mockResolvedValueOnce(response(400)) as unknown as typeof fetch,
    );
    await expect(service.revoke('zły', env)).resolves.toBe('failed');

    service.useFetch(
      jest
        .fn()
        .mockRejectedValueOnce(new Error('sieć')) as unknown as typeof fetch,
    );
    await expect(service.revoke('kod', env)).resolves.toBe('failed');
  });
});
