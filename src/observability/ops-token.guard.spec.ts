import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { OpsTokenGuard } from './ops-token.guard';

const contextWithHeader = (
  header: string | string[] | undefined,
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers: header === undefined ? {} : { 'x-ops-token': header },
      }),
    }),
  }) as unknown as ExecutionContext;

describe('OpsTokenGuard', () => {
  const guard = new OpsTokenGuard();
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // a) pusty OPS_TOKEN — fail-closed WSZĘDZIE poza jawnym środowiskiem testowym.
  it.each(['production', 'staging', 'development', '', undefined])(
    'pusty OPS_TOKEN przy NODE_ENV=%p odmawia — także z dowolnym nagłówkiem',
    (nodeEnv) => {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      for (const token of [undefined, '', '   ']) {
        if (token === undefined) delete process.env.OPS_TOKEN;
        else process.env.OPS_TOKEN = token;
        expect(() => guard.canActivate(contextWithHeader(undefined))).toThrow(
          ForbiddenException,
        );
        expect(() => guard.canActivate(contextWithHeader('cokolwiek'))).toThrow(
          ForbiddenException,
        );
        // Pusty nagłówek nie może „zgodzić się" z pustym tokenem.
        expect(() => guard.canActivate(contextWithHeader(''))).toThrow(
          ForbiddenException,
        );
      }
    },
  );

  // d) jawne środowisko testowe — jedyny wyjątek.
  it('pusty OPS_TOKEN przy NODE_ENV=test wpuszcza (jawny wyjątek testowy)', () => {
    delete process.env.OPS_TOKEN;
    process.env.NODE_ENV = 'test';
    expect(guard.canActivate(contextWithHeader(undefined))).toBe(true);
  });

  it('wyjątek testowy nie jest przybliżony: TEST, testing, test-staging odmawiają', () => {
    delete process.env.OPS_TOKEN;
    for (const nodeEnv of ['TEST', 'testing', 'test-staging', ' test']) {
      process.env.NODE_ENV = nodeEnv;
      expect(() => guard.canActivate(contextWithHeader(undefined))).toThrow(
        ForbiddenException,
      );
    }
  });

  it('ustawiony OPS_TOKEN obowiązuje także przy NODE_ENV=test', () => {
    process.env.OPS_TOKEN = 'sekret-ops-123';
    process.env.NODE_ENV = 'test';
    expect(() => guard.canActivate(contextWithHeader(undefined))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(contextWithHeader('zly'))).toThrow(
      ForbiddenException,
    );
  });

  // b) błędny token — i odmowa nie zdradza żadnej z wartości.
  it('błędny token: odmowa bez tokenu w treści błędu', () => {
    process.env.OPS_TOKEN = 'sekret-ops-123';
    process.env.NODE_ENV = 'staging';
    for (const header of [
      'zly-token-xyz',
      'sekret-ops-12',
      'sekret-ops-1234',
    ]) {
      let thrown: unknown;
      try {
        guard.canActivate(contextWithHeader(header));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      const body = JSON.stringify((thrown as ForbiddenException).getResponse());
      expect(body).not.toContain('sekret-ops-123');
      expect(body).not.toContain(header);
    }
  });

  // c) poprawny token.
  it('z OPS_TOKEN wymaga zgodnego nagłówka', () => {
    process.env.OPS_TOKEN = 'sekret-ops-123';
    expect(guard.canActivate(contextWithHeader('sekret-ops-123'))).toBe(true);
    expect(guard.canActivate(contextWithHeader(' sekret-ops-123 '))).toBe(true);
    expect(() => guard.canActivate(contextWithHeader('zly'))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(contextWithHeader(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('bierze pierwszy nagłówek, gdy przyszła tablica', () => {
    process.env.OPS_TOKEN = 'sekret-ops-123';
    expect(
      guard.canActivate(contextWithHeader(['sekret-ops-123', 'inny'])),
    ).toBe(true);
  });
});
