import { JwtService } from '@nestjs/jwt';
import { AccessTokenService, parseBearer } from './access-token.service';

// Prawdziwy JwtService z testowym sekretem — podpis, exp i błędy jsonwebtoken
// są sednem tego, co weryfikujemy; mock ukryłby różnicę expired/invalid.
const SECRET = 'test-secret-for-access-token-service';

const makePrisma = (
  found: { id: string } | null,
  memberships: Array<{ householdId: string }> = [],
) => ({
  user: { findUnique: jest.fn().mockResolvedValue(found) },
  membership: { findMany: jest.fn().mockResolvedValue(memberships) },
});

const membershipsOf = (...ids: string[]) =>
  ids.map((householdId) => ({ householdId }));

const USER_ID = '11111111-1111-4111-8111-111111111111';

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

  it('poprawny token → userId i exp', async () => {
    const prisma = makePrisma({ id: USER_ID });
    const token = await jwt.signAsync({ sub: USER_ID }, { expiresIn: '1h' });

    const verdict = await build(prisma).verify(token);

    expect(verdict).toMatchObject({ ok: true, userId: USER_ID });
    expect(verdict.ok && verdict.exp).toBeGreaterThan(Date.now() / 1000);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER_ID } }),
    );
  });

  it('householdIds czyta członkostwa usera', async () => {
    const prisma = makePrisma({ id: USER_ID }, membershipsOf('hh-1', 'hh-2'));
    await expect(build(prisma).householdIds(USER_ID)).resolves.toEqual([
      'hh-1',
      'hh-2',
    ]);
    expect(prisma.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });

  it('sub spoza UUID → invalid bez zapytania do bazy (P2023 dawałoby 500)', async () => {
    const prisma = makePrisma({ id: USER_ID });
    const token = await jwt.signAsync({ sub: 'not-a-uuid' });

    expect(await build(prisma).verify(token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ['brak tokenu', '', 'missing'],
    ['same spacje', '   ', 'missing'],
    ['nie-JWT', 'not-a-token', 'invalid'],
  ])('%s → %s', async (_label, token, reason) => {
    const prisma = makePrisma({ id: USER_ID });
    const verdict = await build(prisma).verify(token);
    expect(verdict).toEqual({ ok: false, reason });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('wygasły token → expired (nie invalid)', async () => {
    const prisma = makePrisma({ id: USER_ID });
    const token = await jwt.signAsync({ sub: USER_ID }, { expiresIn: -1 });

    const verdict = await build(prisma).verify(token);

    expect(verdict).toEqual({ ok: false, reason: 'expired' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('zły podpis → invalid', async () => {
    const prisma = makePrisma({ id: USER_ID });
    const foreign = new JwtService({ secret: 'other-secret' });
    const token = await foreign.signAsync({ sub: USER_ID });

    expect(await build(prisma).verify(token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('token bez sub → invalid', async () => {
    const prisma = makePrisma({ id: USER_ID });
    const token = await jwt.signAsync({ role: 'x' });

    expect(await build(prisma).verify(token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('ważny token skasowanego konta → user_gone', async () => {
    const prisma = makePrisma(null);
    const token = await jwt.signAsync({ sub: USER_ID });

    expect(await build(prisma).verify(token)).toEqual({
      ok: false,
      reason: 'user_gone',
    });
  });
});
