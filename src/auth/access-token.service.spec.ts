import { JwtService } from '@nestjs/jwt';
import { AccessTokenService, parseBearer } from './access-token.service';

// Prawdziwy JwtService z testowym sekretem — podpis, exp i błędy jsonwebtoken
// są sednem tego, co weryfikujemy; mock ukryłby różnicę expired/invalid.
const SECRET = 'test-secret-for-access-token-service';

const makePrisma = (found: { id: string; memberships: unknown[] } | null) => ({
  user: { findUnique: jest.fn().mockResolvedValue(found) },
});

const membershipsOf = (...ids: string[]) =>
  ids.map((householdId) => ({ householdId }));

describe('parseBearer', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc', null],
    ['Basic abc', null],
    ['Bearer', null],
    ['', null],
    [undefined, null],
    [['Bearer first', 'Bearer second'], 'first'],
    ['  Bearer   spaced  ', 'spaced'],
  ])('%p → %p', (header, expected) => {
    expect(parseBearer(header)).toBe(expected);
  });
});

describe('AccessTokenService.verify', () => {
  const jwt = new JwtService({ secret: SECRET });
  const build = (prisma: ReturnType<typeof makePrisma>) =>
    new AccessTokenService(jwt, prisma as never);

  it('poprawny token → userId, exp i gospodarstwa usera', async () => {
    const prisma = makePrisma({
      id: 'user-1',
      memberships: membershipsOf('hh-1', 'hh-2'),
    });
    const token = await jwt.signAsync({ sub: 'user-1' }, { expiresIn: '1h' });

    const verdict = await build(prisma).verify(token);

    expect(verdict).toMatchObject({
      ok: true,
      userId: 'user-1',
      householdIds: ['hh-1', 'hh-2'],
    });
    expect(verdict.ok && verdict.exp).toBeGreaterThan(Date.now() / 1000);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' } }),
    );
  });

  it.each([
    ['brak tokenu', '', 'missing'],
    ['same spacje', '   ', 'missing'],
    ['nie-JWT', 'not-a-token', 'invalid'],
  ])('%s → %s', async (_label, token, reason) => {
    const prisma = makePrisma({ id: 'user-1', memberships: [] });
    const verdict = await build(prisma).verify(token);
    expect(verdict).toEqual({ ok: false, reason });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('wygasły token → expired (nie invalid)', async () => {
    const prisma = makePrisma({ id: 'user-1', memberships: [] });
    const token = await jwt.signAsync({ sub: 'user-1' }, { expiresIn: -1 });

    const verdict = await build(prisma).verify(token);

    expect(verdict).toEqual({ ok: false, reason: 'expired' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('zły podpis → invalid', async () => {
    const prisma = makePrisma({ id: 'user-1', memberships: [] });
    const foreign = new JwtService({ secret: 'other-secret' });
    const token = await foreign.signAsync({ sub: 'user-1' });

    expect(await build(prisma).verify(token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('token bez sub → invalid', async () => {
    const prisma = makePrisma({ id: 'user-1', memberships: [] });
    const token = await jwt.signAsync({ role: 'x' });

    expect(await build(prisma).verify(token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('ważny token skasowanego konta → user_gone', async () => {
    const prisma = makePrisma(null);
    const token = await jwt.signAsync({ sub: 'ghost' });

    expect(await build(prisma).verify(token)).toEqual({
      ok: false,
      reason: 'user_gone',
    });
  });
});
