import { ExecutionContext, NotFoundException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AppException } from '../common/app-exception';
import { AccessJwtVerifier } from './access/access-jwt.verifier';
import { AdminGuard } from './admin.guard';
import { AdminRateLimiter } from './admin-rate-limiter';
import type { AdminRequest } from './admin-request';
import {
  ADMIN_ALLOW_REENROLL,
  ADMIN_PERMISSION,
  ADMIN_SESSION_MODE,
  ADMIN_STEP_UP,
} from './admin.decorators';
import type {
  AdminSessionsService,
  ResolvedAdminSession,
} from './auth/admin-sessions.service';

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
    'THROTTLE_ADMIN_LIMIT',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  let verify: jest.Mock;
  let resolve: jest.Mock;
  let guard: AdminGuard;
  let limiter: AdminRateLimiter;
  /** Metadane trasy — domyślnie trasa BEZ sesji, bo tu sprawdzamy bramkę. */
  let meta: Record<string, unknown>;

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
    delete process.env.THROTTLE_ADMIN_LIMIT;
    verify = jest.fn().mockResolvedValue(null);
    resolve = jest.fn().mockResolvedValue(null);
    limiter = new AdminRateLimiter();
    meta = { [ADMIN_SESSION_MODE]: 'none' };
    const reflector = {
      getAllAndOverride: (key: string) => meta[key],
    } as unknown as Reflector;
    guard = new AdminGuard(
      { verify } as unknown as AccessJwtVerifier,
      limiter,
      { resolve } as unknown as AdminSessionsService,
      reflector,
    );
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
  describe('sesja panelu po bramce', () => {
    const session = (
      over: Partial<ResolvedAdminSession> = {},
    ): ResolvedAdminSession => ({
      id: 's1',
      adminUserId: 'a1',
      method: 'passkey',
      mustReenroll: false,
      stepUpUntil: null,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      admin: {
        id: 'a1',
        email: 'rafal@example.com',
        displayName: 'Rafał',
        role: 'OWNER',
      },
      ...over,
    });
    const withToken = () => {
      verify.mockResolvedValue({ email: 'rafal@example.com', subject: 's' });
      return request({ 'cf-access-jwt-assertion': 'ok' });
    };

    it('trasa wymagająca sesji bez sesji — 404 jak brak trasy, mimo tokenu', async () => {
      meta = {};
      await expect(run(withToken()).result).rejects.toMatchObject({
        message: 'Cannot GET /admin/users?q=ala',
      });
      expect(resolve).toHaveBeenCalledWith(
        expect.anything(),
        'rafal@example.com',
      );
    });

    it('z sesją — przepuszcza i odkłada sesję w żądaniu', async () => {
      meta = {};
      resolve.mockResolvedValue(session());
      const req = withToken();
      await expect(run(req).result).resolves.toBe(true);
      expect(req.adminSession?.id).toBe('s1');
    });

    it('sesja z kodu odzyskiwania — 403 NOT_ALLOWED poza konfiguracją wejścia', async () => {
      meta = {};
      resolve.mockResolvedValue(session({ mustReenroll: true }));
      await expect(run(withToken()).result).rejects.toMatchObject({
        code: 'NOT_ALLOWED',
      });
      meta = { [ADMIN_ALLOW_REENROLL]: true };
      await expect(run(withToken()).result).resolves.toBe(true);
    });

    it('rola bez uprawnienia — 404, nie 403', async () => {
      meta = { [ADMIN_PERMISSION]: 'users.read' };
      resolve.mockResolvedValue(
        session({
          admin: {
            id: 'a1',
            email: 'rafal@example.com',
            displayName: 'Rafał',
            role: 'NIKT',
          },
        }),
      );
      await expect(run(withToken()).result).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('akcja ze step-upem: bez świeżego potwierdzenia 403, z nim przepuszcza', async () => {
      meta = { [ADMIN_STEP_UP]: true };
      resolve.mockResolvedValue(
        session({ stepUpUntil: new Date(Date.now() - 1) }),
      );
      await expect(run(withToken()).result).rejects.toMatchObject({
        code: 'STEP_UP_REQUIRED',
      });
      resolve.mockResolvedValue(
        session({ stepUpUntil: new Date(Date.now() + 60_000) }),
      );
      await expect(run(withToken()).result).resolves.toBe(true);
    });

    it('z sesją limit liczy się per admin (THROTTLE_ADMIN_LIMIT), nie per IP', async () => {
      meta = {};
      process.env.THROTTLE_ADMIN_LIMIT = '1';
      process.env.THROTTLE_ADMIN_AUTH_LIMIT = '100';
      resolve.mockResolvedValue(session());
      await expect(run(withToken()).result).resolves.toBe(true);
      await expect(run(withToken()).result).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
      });
    });
  });
});
