import { ExecutionContext } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { AccessTokenVerdict } from './access-token.service';
import { JwtAuthGuard } from './jwt-auth.guard';

const contextWithHeader = (
  authorization?: string,
): { context: ExecutionContext; request: { user?: { id: string } } } => {
  const request: { headers: Record<string, string>; user?: { id: string } } = {
    headers: authorization === undefined ? {} : { authorization },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
};

const guardWith = (verdict: AccessTokenVerdict) => {
  const verify = jest.fn().mockResolvedValue(verdict);
  return { guard: new JwtAuthGuard({ verify } as never), verify };
};

describe('JwtAuthGuard', () => {
  it('poprawny token → request.user.id z tokenu', async () => {
    const { guard, verify } = guardWith({
      ok: true,
      userId: 'user-1',
      exp: null,
    });
    const { context, request } = contextWithHeader('Bearer good');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ id: 'user-1' });
    expect(verify).toHaveBeenCalledWith('good');
  });

  it.each([
    ['brak nagłówka', undefined],
    ['zły typ', 'Basic abc'],
    ['Bearer bez tokenu', 'Bearer'],
  ])('%s → UNAUTHORIZED/missing bez weryfikacji', async (_label, header) => {
    const { guard, verify } = guardWith({ ok: false, reason: 'invalid' });
    const { context } = contextWithHeader(header);

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
      response: { code: 'UNAUTHORIZED', details: ['missing'] },
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'expired', 'user_gone'] as const)(
    'odmowa weryfikatora %s → UNAUTHORIZED z powodem w details',
    async (reason) => {
      const { guard } = guardWith({ ok: false, reason });
      const { context, request } = contextWithHeader('Bearer whatever');

      const error = await guard.canActivate(context).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).getStatus()).toBe(401);
      expect((error as AppException).code).toBe('UNAUTHORIZED');
      expect((error as AppException).details).toEqual([reason]);
      expect(request.user).toBeUndefined();
    },
  );
});
