import { refreshFamilies, type RefreshTokenRow } from './refresh-families';

const NOW = new Date('2026-09-24T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR);

const token = (
  id: string,
  createdHoursAgo: number,
  patch: Partial<RefreshTokenRow> = {},
): RefreshTokenRow => ({
  id,
  tokenHash: `hash-${id}`,
  replacedByHash: null,
  createdAt: at(createdHoursAgo),
  expiresAt: new Date(at(createdHoursAgo).getTime() + 60 * 24 * HOUR),
  revokedAt: null,
  revokedReason: null,
  ...patch,
});

describe('refreshFamilies — sesja to łańcuch rotacji, nie wiersz', () => {
  it('łańcuch rotacji to jedna sesja: od logowania do żywej głowy', () => {
    const rows = [
      token('login', 48, {
        replacedByHash: 'hash-r1',
        revokedAt: at(24),
        revokedReason: 'ROTATED',
      }),
      token('r1', 24, {
        replacedByHash: 'hash-r2',
        revokedAt: at(1),
        revokedReason: 'ROTATED',
      }),
      token('r2', 1),
    ];
    expect(refreshFamilies(rows, NOW)).toEqual([
      {
        id: 'login',
        createdAt: at(48).toISOString(),
        expiresAt: rows[2].expiresAt.toISOString(),
        revokedAt: null,
        revokedReason: null,
      },
    ]);
  });

  it('wylogowanie i wykryta kopia widać po głowie; najświeższa sesja pierwsza', () => {
    const rows = [
      token('old', 100, { revokedAt: at(90), revokedReason: 'LOGOUT' }),
      token('stolen', 50, {
        replacedByHash: 'hash-stolen-2',
        revokedAt: at(40),
        revokedReason: 'REUSE',
      }),
      token('stolen-2', 40, { revokedAt: at(2), revokedReason: 'REUSE' }),
      token('fresh', 1),
    ];
    const sessions = refreshFamilies(rows, NOW);
    expect(sessions.map((session) => session.id)).toEqual([
      'fresh',
      'stolen',
      'old',
    ]);
    expect(sessions[1]).toMatchObject({
      revokedReason: 'REUSE',
      revokedAt: at(2).toISOString(),
    });
    expect(sessions[2].revokedReason).toBe('LOGOUT');
  });

  it('wygasła bez unieważnienia to nie sesja; limit trzyma najświeższe', () => {
    const expired = token('expired', 2000, {
      expiresAt: new Date(NOW.getTime() - HOUR),
    });
    const many = Array.from({ length: 25 }, (_, index) =>
      token(`s${index}`, index + 1),
    );
    const sessions = refreshFamilies([expired, ...many], NOW);
    expect(sessions).toHaveLength(20);
    expect(sessions[0].id).toBe('s0');
    expect(sessions.some((session) => session.id === 'expired')).toBe(false);
  });

  it('pętla we wskaźnikach nie zawiesza odczytu', () => {
    const rows = [
      token('a', 5, { replacedByHash: 'hash-b' }),
      token('b', 4, { replacedByHash: 'hash-a' }),
      token('c', 3),
    ];
    expect(refreshFamilies(rows, NOW).map((session) => session.id)).toEqual([
      'c',
    ]);
  });
});
