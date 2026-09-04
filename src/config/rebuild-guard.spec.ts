// Strażnik żyje w CommonJS obok skryptu, który go używa (`scripts/`), bo
// skrypt migracji biegnie przed buildem i nie może importować z `dist/`.
// Spec leży w `src/`, bo tylko tu jest jest.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const guard = require('../../scripts/lib/rebuild-guard.js') as {
  decideRebuild: (input: { env: NodeJS.ProcessEnv; now?: Date }) => {
    requested: boolean;
    allowed: boolean;
    host: string | null;
    reason: string;
  };
  hostOf: (url: string | undefined) => string | null;
  todayUtc: (now: Date) => string;
};

const NOW = new Date('2026-08-28T10:00:00.000Z');
const TODAY = '2026-08-28';
const PROD_URL =
  'postgresql://postgres:sekret@caboose.proxy.rlwy.net:59892/railway';

describe('decideRebuild', () => {
  it('bez flagi niczego nie żąda', () => {
    const result = guard.decideRebuild({ env: {}, now: NOW });
    expect(result).toMatchObject({ requested: false, allowed: false });
  });

  it('YES_I_UNDERSTAND już nie wystarcza', () => {
    const result = guard.decideRebuild({
      env: {
        SAFE_MIGRATE_REBUILD_DB: 'true',
        SAFE_MIGRATE_REBUILD_CONFIRM: 'YES_I_UNDERSTAND',
      },
      now: NOW,
    });
    expect(result).toMatchObject({ requested: true, allowed: false });
    expect(result.reason).toContain(TODAY);
  });

  it('wczorajsza data odmawia (potwierdzenie wygasa)', () => {
    const result = guard.decideRebuild({
      env: {
        SAFE_MIGRATE_REBUILD_DB: 'true',
        SAFE_MIGRATE_REBUILD_CONFIRM: '2026-08-27',
      },
      now: NOW,
    });
    expect(result.allowed).toBe(false);
  });

  it('dzisiejsza data pozwala poza produkcją', () => {
    const result = guard.decideRebuild({
      env: {
        SAFE_MIGRATE_REBUILD_DB: 'true',
        SAFE_MIGRATE_REBUILD_CONFIRM: TODAY,
        DATABASE_URL: 'postgresql://scoffie:scoffie@db:5432/scoffie',
      },
      now: NOW,
    });
    expect(result).toMatchObject({
      requested: true,
      allowed: true,
      host: 'db:5432',
    });
  });

  it('na produkcji sama data nie wystarcza', () => {
    const result = guard.decideRebuild({
      env: {
        NODE_ENV: 'production',
        SAFE_MIGRATE_REBUILD_DB: 'true',
        SAFE_MIGRATE_REBUILD_CONFIRM: TODAY,
        DATABASE_URL: PROD_URL,
      },
      now: NOW,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('caboose.proxy.rlwy.net:59892');
    // Powód idzie do logu — hasło z DATABASE_URL nie może się w nim znaleźć.
    expect(result.reason).not.toContain('sekret');
  });

  it('na produkcji host w SAFE_MIGRATE_ALLOW_PROD_REBUILD musi się zgadzać', () => {
    const base = {
      NODE_ENV: 'production',
      SAFE_MIGRATE_REBUILD_DB: 'true',
      SAFE_MIGRATE_REBUILD_CONFIRM: TODAY,
      DATABASE_URL: PROD_URL,
    };
    expect(
      guard.decideRebuild({
        env: { ...base, SAFE_MIGRATE_ALLOW_PROD_REBUILD: 'inny-host:5432' },
        now: NOW,
      }).allowed,
    ).toBe(false);
    expect(
      guard.decideRebuild({
        env: {
          ...base,
          SAFE_MIGRATE_ALLOW_PROD_REBUILD: 'caboose.proxy.rlwy.net:59892',
        },
        now: NOW,
      }),
    ).toMatchObject({ allowed: true, host: 'caboose.proxy.rlwy.net:59892' });
  });

  it('na produkcji bez rozpoznawalnego hosta odmawia', () => {
    const result = guard.decideRebuild({
      env: {
        NODE_ENV: 'production',
        SAFE_MIGRATE_REBUILD_DB: 'true',
        SAFE_MIGRATE_REBUILD_CONFIRM: TODAY,
        DATABASE_URL: 'not-a-url',
        SAFE_MIGRATE_ALLOW_PROD_REBUILD: 'x',
      },
      now: NOW,
    });
    expect(result).toMatchObject({ allowed: false, host: null });
  });
});

describe('hostOf', () => {
  it('zwraca host z portem, bez hasła', () => {
    expect(guard.hostOf(PROD_URL)).toBe('caboose.proxy.rlwy.net:59892');
  });

  it('zwraca null dla śmieci i braku', () => {
    expect(guard.hostOf(undefined)).toBeNull();
    expect(guard.hostOf('')).toBeNull();
    expect(guard.hostOf('::')).toBeNull();
  });
});

describe('todayUtc', () => {
  it('liczy datę w UTC, nie w strefie procesu', () => {
    expect(guard.todayUtc(new Date('2026-08-27T23:30:00.000Z'))).toBe(
      '2026-08-27',
    );
    expect(guard.todayUtc(new Date('2026-08-28T00:30:00.000Z'))).toBe(
      '2026-08-28',
    );
  });
});
