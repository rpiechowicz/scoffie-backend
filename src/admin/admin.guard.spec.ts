import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { AccessJwtVerifier } from './access/access-jwt.verifier';
import { AdminGuard } from './admin.guard';
import { AdminRateLimiter } from './admin-rate-limiter';
import type { AdminRequest } from './admin-request';

/**
 * Bramka panelu. E2e na żywej bazie (`test/admin-panel.e2e-spec.ts`)
 * sprawdza, że 404 z guarda jest bajt w bajt tym samym, co 404 Nesta; tu —
 * kolejność decyzji i to, że nic nie wycieka przed bramką.
 */
describe('AdminGuard — bramka Access', () => {
  const ENV_KEYS = [
    'NODE_ENV',
    'ADMIN_ACCESS_TEAM_DOMAIN',
    'ADMIN_ACCESS_AUD',
    'ADMIN_ACCESS_DEV_EMAIL',
    'THROTTLE_ADMIN_AUTH_LIMIT',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  let verify: jest.Mock;
  let guard: AdminGuard;
  let limiter: AdminRateLimiter;

  const request = (headers: Record<string, string> = {}): AdminRequest =>
    ({
      method: 'GET',
      originalUrl: '/admin/users?q=ala',
      ip: '10.0.0.1',
      headers,
    }) as unknown as AdminRequest;

  const run = (req: AdminRequest) => {
    const setHeader = jest.fn();
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ setHeader }),
      }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
    return { result: guard.canActivate(context), setHeader };
  };

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_ACCESS_TEAM_DOMAIN = 'scoffie.cloudflareaccess.com';
    process.env.ADMIN_ACCESS_AUD = 'aud';
    delete process.env.ADMIN_ACCESS_DEV_EMAIL;
    delete process.env.THROTTLE_ADMIN_AUTH_LIMIT;
    verify = jest.fn().mockResolvedValue(null);
    limiter = new AdminRateLimiter();
    guard = new AdminGuard({ verify } as unknown as AccessJwtVerifier, limiter);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('bez tokenu — 404 z treścią jak z routera Nesta, bez X-Robots-Tag', async () => {
    const { result, setHeader } = run(request());
    await expect(result).rejects.toBeInstanceOf(NotFoundException);
    await expect(result).rejects.toMatchObject({
      message: 'Cannot GET /admin/users?q=ala',
    });
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('zły token — to samo 404', async () => {
    const { result } = run(
      request({ 'cf-access-jwt-assertion': 'podrobiony' }),
    );
    await expect(result).rejects.toBeInstanceOf(NotFoundException);
    expect(verify).toHaveBeenCalledWith('podrobiony', expect.anything());
  });

  it('bez konfiguracji bramki cały /admin to 404 — nawet z tokenem', async () => {
    delete process.env.ADMIN_ACCESS_AUD;
    verify.mockResolvedValue({ email: 'rafal@example.com', subject: 's' });
    const { result } = run(request({ 'cf-access-jwt-assertion': 'x' }));
    await expect(result).rejects.toBeInstanceOf(NotFoundException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('poprawny token — przepuszcza, kontekst z nagłówków Cloudflare, noindex', async () => {
    verify.mockResolvedValue({ email: 'rafal@example.com', subject: 's' });
    const req = request({
      'cf-access-jwt-assertion': 'ok',
      'cf-connecting-ip': '203.0.113.7',
      'cf-ipcountry': 'pl',
      'user-agent': 'Safari',
    });
    const { result, setHeader } = run(req);
    await expect(result).resolves.toBe(true);
    expect(setHeader).toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow');
    expect(req.adminAccess).toMatchObject({
      email: 'rafal@example.com',
      via: 'access',
      ip: '203.0.113.7',
      country: 'PL',
      userAgent: 'Safari',
    });
  });

  it('obejście deweloperskie wpuszcza bez tokenu poza produkcją', async () => {
    process.env.ADMIN_ACCESS_DEV_EMAIL = 'ja@dev.local';
    const req = request();
    await expect(run(req).result).resolves.toBe(true);
    expect(req.adminAccess).toMatchObject({
      email: 'ja@dev.local',
      via: 'dev',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('obejście deweloperskie NIE działa przy NODE_ENV=production', async () => {
    process.env.ADMIN_ACCESS_DEV_EMAIL = 'ja@dev.local';
    process.env.NODE_ENV = 'production';
    await expect(run(request()).result).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('limit liczy się dopiero PO bramce: obcy nigdy nie widzi 429', async () => {
    process.env.THROTTLE_ADMIN_AUTH_LIMIT = '2';
    for (let i = 0; i < 5; i++) {
      await expect(run(request()).result).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    verify.mockResolvedValue({ email: 'rafal@example.com', subject: 's' });
    const withToken = () =>
      run(request({ 'cf-access-jwt-assertion': 'ok' })).result;
    await expect(withToken()).resolves.toBe(true);
    await expect(withToken()).resolves.toBe(true);
    await expect(withToken()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    await expect(withToken()).rejects.toBeInstanceOf(AppException);
  });
});
