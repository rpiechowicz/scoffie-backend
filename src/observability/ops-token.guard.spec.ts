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

  it('bez OPS_TOKEN poza produkcją wpuszcza', () => {
    delete process.env.OPS_TOKEN;
    process.env.NODE_ENV = 'test';
    expect(guard.canActivate(contextWithHeader(undefined))).toBe(true);
  });

  it('bez OPS_TOKEN na produkcji odmawia zawsze', () => {
    delete process.env.OPS_TOKEN;
    process.env.NODE_ENV = 'production';
    expect(() => guard.canActivate(contextWithHeader('cokolwiek'))).toThrow(
      ForbiddenException,
    );
  });

  it('z OPS_TOKEN wymaga zgodnego nagłówka', () => {
    process.env.OPS_TOKEN = 'sekret-ops-123';
    expect(guard.canActivate(contextWithHeader('sekret-ops-123'))).toBe(true);
    expect(guard.canActivate(contextWithHeader(' sekret-ops-123 '))).toBe(
      true,
    );
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
