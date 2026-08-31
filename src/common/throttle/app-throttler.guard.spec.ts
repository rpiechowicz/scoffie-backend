import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { AppException } from '../app-exception';
import { AppThrottlerGuard } from './app-throttler.guard';

describe('AppThrottlerGuard', () => {
  const recordThrottled = jest.fn();
  const verifyAsync = jest.fn();

  const buildGuard = () =>
    new AppThrottlerGuard(
      { throttlers: [] },
      { increment: jest.fn() } as never,
      new Reflector(),
      { verifyAsync } as unknown as JwtService,
      { recordThrottled } as never,
    );

  const httpContext = (req: Record<string, unknown>): ExecutionContext =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    recordThrottled.mockClear();
    verifyAsync.mockReset();
  });

  describe('shouldSkip', () => {
    it.each([
      ['http', 'http', false],
      ['ws', 'ws', true],
      ['rpc', 'rpc', true],
    ])('%s → %s', async (_label, type, expected) => {
      const guard = buildGuard();
      const context = { getType: () => type } as unknown as ExecutionContext;
      await expect(guard['shouldSkip'](context)).resolves.toBe(expected);
    });
  });

  describe('getTracker', () => {
    it('liczy limit per użytkownik, gdy token jest ważny', async () => {
      verifyAsync.mockResolvedValue({ sub: 'user-1' });
      const guard = buildGuard();
      await expect(
        guard['getTracker']({
          ip: '10.0.0.1',
          headers: { authorization: 'Bearer abc' },
        }),
      ).resolves.toBe('user:user-1');
      // Podpis MUSI być sprawdzony — inaczej `sub` z podrobionego tokenu
      // dawałby świeży limit na każde żądanie.
      expect(verifyAsync).toHaveBeenCalledWith('abc');
    });

    it.each([
      ['brak nagłówka', {}, undefined],
      ['nagłówek bez Bearer', { authorization: 'Basic abc' }, undefined],
      ['token nieważny', { authorization: 'Bearer abc' }, 'invalid'],
      ['token bez sub', { authorization: 'Bearer abc' }, 'no-sub'],
    ])('spada na IP: %s', async (_label, headers, mode) => {
      if (mode === 'invalid') verifyAsync.mockRejectedValue(new Error('nope'));
      if (mode === 'no-sub') verifyAsync.mockResolvedValue({ sub: 42 });
      const guard = buildGuard();
      await expect(
        guard['getTracker']({ ip: '10.0.0.1', headers }),
      ).resolves.toBe('ip:10.0.0.1');
    });

    it('bez adresu nadal daje stabilny klucz', async () => {
      const guard = buildGuard();
      await expect(guard['getTracker']({ headers: {} })).resolves.toBe(
        'ip:unknown',
      );
    });
  });

  describe('throwThrottlingException', () => {
    const detail = (
      overrides: Partial<ThrottlerLimitDetail>,
    ): ThrottlerLimitDetail =>
      ({
        limit: 5,
        ttl: 60,
        key: 'k',
        tracker: 't',
        totalHits: 6,
        timeToExpire: 30,
        isBlocked: true,
        timeToBlockExpire: 12,
        ...overrides,
      }) as ThrottlerLimitDetail;

    it('oddaje kontrakt aplikacji zamiast ThrottlerException', async () => {
      const guard = buildGuard();
      const context = httpContext({
        method: 'POST',
        route: { path: '/auth/dev' },
      });

      await expect(
        guard['throwThrottlingException'](context, detail({})),
      ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

      try {
        await guard['throwThrottlingException'](context, detail({}));
      } catch (error) {
        const exception = error as AppException;
        expect(exception).toBeInstanceOf(AppException);
        expect(exception.getStatus()).toBe(429);
        expect(exception.details).toEqual(['retryAfterSeconds:12']);
      }
    });

    it('liczy 429 w metrykach — interceptor logujący ich nie widzi', async () => {
      const guard = buildGuard();
      await guard['throwThrottlingException'](
        httpContext({ method: 'GET', route: { path: '/agent/turns/:id' } }),
        detail({}),
      ).catch(() => undefined);
      expect(recordThrottled).toHaveBeenCalledWith('GET /agent/turns/:id');
    });

    it('retryAfterSeconds nigdy nie jest zerem', async () => {
      const guard = buildGuard();
      try {
        await guard['throwThrottlingException'](
          httpContext({ method: 'GET', path: '/x' }),
          detail({ timeToBlockExpire: 0, timeToExpire: 0 }),
        );
      } catch (error) {
        expect((error as AppException).details).toEqual([
          'retryAfterSeconds:1',
        ]);
      }
    });
  });
});
