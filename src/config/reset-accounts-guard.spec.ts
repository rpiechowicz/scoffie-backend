// Strażnik żyje w CommonJS obok skryptu (`scripts/lib`), tak jak
// `rebuild-guard.js`; spec leży w `src/`, bo tylko tu jest jest.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const guard = require('../../scripts/lib/reset-accounts-guard.js') as {
  decideResetAccounts: (input: {
    env: NodeJS.ProcessEnv;
    argv?: string[];
    now?: Date;
  }) => {
    requested: boolean;
    allowed: boolean;
    host: string | null;
    reason: string;
  };
  isLocalHost: (host: string | null) => boolean;
};

const NOW = new Date('2026-09-02T10:00:00.000Z');
const TODAY = '2026-09-02';
const PROD_URL =
  'postgresql://postgres:sekret@caboose.proxy.rlwy.net:59892/railway';
const LOCAL_URL =
  'postgresql://scoffie:scoffie@localhost:5432/scoffie?schema=public';

describe('decideResetAccounts', () => {
  it('bez flagi to dry-run, niezależnie od reszty zmiennych', () => {
    const result = guard.decideResetAccounts({
      env: {
        DATABASE_URL: PROD_URL,
        RESET_ACCOUNTS_CONFIRM: TODAY,
        RESET_ACCOUNTS_ALLOW_HOST: 'caboose.proxy.rlwy.net:59892',
      },
      now: NOW,
    });
    expect(result).toMatchObject({ requested: false, allowed: false });
  });

  it('sama RESET_ACCOUNTS_WRITE=true już nie wystarcza', () => {
    // Dokładnie ten scenariusz: zmienna zostawiona w Railway Variables
    // i kolejne „pokaż raport" z telefonu.
    const result = guard.decideResetAccounts({
      env: { DATABASE_URL: PROD_URL, RESET_ACCOUNTS_WRITE: 'true' },
      now: NOW,
    });
    expect(result).toMatchObject({ requested: true, allowed: false });
    expect(result.reason).toContain(TODAY);
  });

  it('wczorajsza data odmawia (potwierdzenie wygasa)', () => {
    const result = guard.decideResetAccounts({
      env: {
        DATABASE_URL: LOCAL_URL,
        RESET_ACCOUNTS_WRITE: 'true',
        RESET_ACCOUNTS_CONFIRM: '2026-09-01',
      },
      now: NOW,
    });
    expect(result.allowed).toBe(false);
  });

  it('baza lokalna: data wystarcza', () => {
    const result = guard.decideResetAccounts({
      env: {
        DATABASE_URL: LOCAL_URL,
        RESET_ACCOUNTS_CONFIRM: TODAY,
      },
      argv: ['--write'],
      now: NOW,
    });
    expect(result).toMatchObject({
      requested: true,
      allowed: true,
      host: 'localhost:5432',
    });
  });

  it('baza spoza maszyny bez hosta w RESET_ACCOUNTS_ALLOW_HOST odmawia', () => {
    // `railway run` odpala skrypt lokalnie ze zmiennymi produkcji, a
    // NODE_ENV lokalnie jest pusty — dlatego strażnik patrzy na host,
    // nie na NODE_ENV.
    const result = guard.decideResetAccounts({
      env: {
        DATABASE_URL: PROD_URL,
        RESET_ACCOUNTS_WRITE: 'true',
        RESET_ACCOUNTS_CONFIRM: TODAY,
      },
      now: NOW,
    });
    expect(result.allowed).toBe(false);
    expect(result.host).toBe('caboose.proxy.rlwy.net:59892');
    expect(result.reason).toContain('caboose.proxy.rlwy.net:59892');
  });

  it('baza spoza maszyny z dokładnym hostem przechodzi', () => {
    const result = guard.decideResetAccounts({
      env: {
        DATABASE_URL: PROD_URL,
        RESET_ACCOUNTS_WRITE: 'true',
        RESET_ACCOUNTS_CONFIRM: TODAY,
        RESET_ACCOUNTS_ALLOW_HOST: 'caboose.proxy.rlwy.net:59892',
      },
      now: NOW,
    });
    expect(result).toMatchObject({ requested: true, allowed: true });
  });

  it('nieczytelny DATABASE_URL odmawia zamiast zgadywać', () => {
    const result = guard.decideResetAccounts({
      env: {
        DATABASE_URL: 'to nie jest url',
        RESET_ACCOUNTS_WRITE: 'true',
        RESET_ACCOUNTS_CONFIRM: TODAY,
      },
      now: NOW,
    });
    expect(result).toMatchObject({ allowed: false, host: null });
  });

  it('isLocalHost rozpoznaje localhost, pętlę zwrotną i usługę `db` z compose', () => {
    expect(guard.isLocalHost('localhost:5432')).toBe(true);
    expect(guard.isLocalHost('127.0.0.1')).toBe(true);
    expect(guard.isLocalHost('db:5432')).toBe(true);
    expect(guard.isLocalHost('caboose.proxy.rlwy.net:59892')).toBe(false);
    expect(guard.isLocalHost(null)).toBe(false);
  });
});
