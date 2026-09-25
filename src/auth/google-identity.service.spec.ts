import { Logger } from '@nestjs/common';
import { GoogleIdentityService } from './google-identity.service';
import {
  makeFakeGoogle,
  TEST_GOOGLE_CLIENT_ID,
} from './google-id-token.spec-helper';

describe('GoogleIdentityService', () => {
  const ENV_BEFORE = process.env.GOOGLE_OAUTH_CLIENT_IDS;
  const google = makeFakeGoogle();
  let service: GoogleIdentityService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_IDS = ` other.apps.googleusercontent.com , ${TEST_GOOGLE_CLIENT_ID}`;
    service = new GoogleIdentityService();
    service._overrideCerts(google.certs);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    if (ENV_BEFORE === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_IDS;
    else process.env.GOOGLE_OAUTH_CLIENT_IDS = ENV_BEFORE;
  });

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return {
        code: (error as { getResponse(): { code: string } }).getResponse().code,
        status: (error as { getStatus(): number }).getStatus(),
      };
    }
    throw new Error('oczekiwano odmowy');
  };

  it('poprawny token: claimy znormalizowane, adres małymi literami', async () => {
    const token = google.sign({
      sub: '1122334455',
      email: 'Jan.Kowalski@Gmail.com',
      email_verified: true,
      name: 'Jan Kowalski',
      given_name: 'Jan',
      family_name: 'Kowalski',
      picture: 'https://lh3.googleusercontent.com/a/x',
    });

    await expect(service.verify(token)).resolves.toEqual({
      googleSub: '1122334455',
      email: 'jan.kowalski@gmail.com',
      emailVerified: true,
      name: 'Jan Kowalski',
      givenName: 'Jan',
      familyName: 'Kowalski',
      picture: 'https://lh3.googleusercontent.com/a/x',
    });
  });

  it('przyjmuje iss bez schematu (accounts.google.com)', async () => {
    const token = google.sign({ sub: '1', iss: 'accounts.google.com' });
    await expect(service.verify(token)).resolves.toMatchObject({
      googleSub: '1',
    });
  });

  it('email_verified tylko jako jawne true', async () => {
    const token = google.sign({
      sub: '1',
      email: 'a@b.pl',
      email_verified: 'true',
    });
    await expect(service.verify(token)).resolves.toMatchObject({
      emailVerified: false,
    });
  });

  it('zły aud → 401 APPLE_IDENTITY_INVALID', async () => {
    const token = google.sign({
      sub: '1',
      aud: 'ktos-inny.apps.googleusercontent.com',
    });
    await expect(codeOf(service.verify(token))).resolves.toEqual({
      code: 'APPLE_IDENTITY_INVALID',
      status: 401,
    });
  });

  it('obcy wystawca → 401', async () => {
    const token = google.sign({ sub: '1', iss: 'https://evil.example.com' });
    await expect(codeOf(service.verify(token))).resolves.toMatchObject({
      code: 'APPLE_IDENTITY_INVALID',
    });
  });

  it('wygasły token → 401', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const token = google.sign({ sub: '1', iat: past - 3600, exp: past });
    await expect(codeOf(service.verify(token))).resolves.toMatchObject({
      code: 'APPLE_IDENTITY_INVALID',
    });
  });

  it('podpis innym kluczem → 401', async () => {
    const stranger = makeFakeGoogle();
    const token = stranger.sign({ sub: '1' });
    await expect(codeOf(service.verify(token))).resolves.toMatchObject({
      code: 'APPLE_IDENTITY_INVALID',
    });
  });

  it('nonce: zgodny przechodzi, niezgodny lub brakujący w tokenie → 401', async () => {
    const token = google.sign({ sub: '1', nonce: 'nonce-12345678' });
    await expect(
      service.verify(token, 'nonce-12345678'),
    ).resolves.toMatchObject({ googleSub: '1' });
    await expect(
      codeOf(service.verify(token, 'nonce-inny-000')),
    ).resolves.toMatchObject({ code: 'APPLE_IDENTITY_INVALID' });

    const withoutClaim = google.sign({ sub: '1' });
    await expect(
      codeOf(service.verify(withoutClaim, 'nonce-12345678')),
    ).resolves.toMatchObject({ code: 'APPLE_IDENTITY_INVALID' });
  });

  it('bez nonce w żądaniu claim nie jest wymagany', async () => {
    const token = google.sign({ sub: '1', nonce: 'cokolwiek-123' });
    await expect(service.verify(token)).resolves.toMatchObject({
      googleSub: '1',
    });
  });

  it('brak GOOGLE_OAUTH_CLIENT_IDS → 503 SERVICE_UNAVAILABLE, bez weryfikacji', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_IDS = ' , ';
    const token = google.sign({ sub: '1' });
    await expect(codeOf(service.verify(token))).resolves.toEqual({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
    });
    delete process.env.GOOGLE_OAUTH_CLIENT_IDS;
    expect(() => service.assertEnabled()).toThrow();
  });

  it('log odmowy nie zawiera tokenu ani adresu e-mail', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const token = google.sign({
      sub: '1',
      email: 'tajny@gmail.com',
      iat: past - 3600,
      exp: past,
    });
    await codeOf(service.verify(token));
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('expired');
    expect(logged).not.toContain('tajny@gmail.com');
    expect(logged).not.toContain(token.split('.')[1]);
  });
});
