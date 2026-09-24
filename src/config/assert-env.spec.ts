import { assertRuntimeEnv, inspectRuntimeEnv } from './assert-env';

// 32 B w base64 — taki sam kształt jak w CI (`backend-ci.yml`).
const ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const STRONG = 'x'.repeat(40);
const OTHER_STRONG = 'y'.repeat(40);

const productionEnv = (
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv => {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'production',
    JWT_SECRET: STRONG,
    REFRESH_TOKEN_PEPPER: OTHER_STRONG,
    DATABASE_URL: 'postgresql://u:p@db.internal:5432/app',
    COOKIDOO_SERVICE_TOKEN: 't'.repeat(44),
    COOKIDOO_ENCRYPTION_KEY: ENCRYPTION_KEY,
    OPS_TOKEN: 'o'.repeat(40),
    AUTH_DEV_LOGIN_ENABLED: 'false',
    COOKIDOO_SERVICE_URL: 'http://cookidoo.railway.internal:8000',
    ...overrides,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
};

describe('inspectRuntimeEnv', () => {
  it('produkcja z kompletem zmiennych przechodzi bez naruszeń', () => {
    const report = inspectRuntimeEnv(productionEnv());
    expect(report).toEqual({ production: true, violations: [], warnings: [] });
  });

  it.each([
    ['brak JWT_SECRET', { JWT_SECRET: undefined }, /JWT_SECRET jest pusty/],
    ['JWT_SECRET z repo', { JWT_SECRET: 'dev-secret-change-me' }, /publiczną/],
    ['JWT_SECRET z CI', { JWT_SECRET: 'ci-secret' }, /publiczną/],
    ['krótki JWT_SECRET', { JWT_SECRET: 'x'.repeat(10) }, /10 znaków/],
    [
      'brak pepper',
      { REFRESH_TOKEN_PEPPER: undefined },
      /REFRESH_TOKEN_PEPPER jest pusty/,
    ],
    [
      'krótki pepper (dzisiejszy prod)',
      { REFRESH_TOKEN_PEPPER: 'p'.repeat(10) },
      /REFRESH_TOKEN_PEPPER ma 10 znaków/,
    ],
    [
      'pepper równy sekretowi',
      { REFRESH_TOKEN_PEPPER: STRONG },
      /równy JWT_SECRET/,
    ],
    ['brak DATABASE_URL', { DATABASE_URL: undefined }, /DATABASE_URL/],
    [
      'pusty token Cookidoo',
      { COOKIDOO_SERVICE_TOKEN: '' },
      /COOKIDOO_SERVICE_TOKEN/,
    ],
    [
      'zły klucz szyfrowania',
      { COOKIDOO_ENCRYPTION_KEY: 'abc' },
      /COOKIDOO_ENCRYPTION_KEY/,
    ],
    ['brak OPS_TOKEN', { OPS_TOKEN: undefined }, /OPS_TOKEN/],
    [
      'dev-login włączony',
      { AUTH_DEV_LOGIN_ENABLED: 'true' },
      /AUTH_DEV_LOGIN_ENABLED=true/,
    ],
    // Obejście bramki Cloudflare Access panelu admina — wejście do panelu
    // bez logowania do Google. Tylko lokalnie, na produkcji odmowa startu.
    [
      'obejście bramki panelu admina',
      { ADMIN_ACCESS_DEV_EMAIL: 'ja@dev.local' },
      /ADMIN_ACCESS_DEV_EMAIL/,
    ],
    // AUDYT 12.09.2026 (P0.3). `off` z włączonym asystentem znaczy, że model
    // zapisuje plan sam: bez karty, bez potwierdzenia i bez „Cofnij". Ta sama
    // reguła co przy WS_AUTH_MODE=soft — tryb, który zdejmuje zgodę człowieka,
    // nie wchodzi na produkcję przez zapomnianą zmienną.
    [
      'zapis planu bez potwierdzenia człowieka',
      { AI_ENABLED: 'true', AI_PROVIDER: 'stub', AI_CARDS_MODE: 'off' },
      /AI_CARDS_MODE=off/,
    ],
    [
      'Cookidoo po publicznym http',
      { COOKIDOO_SERVICE_URL: 'http://cookidoo.up.railway.app' },
      /COOKIDOO_SERVICE_URL=http:/,
    ],
    [
      'Cookidoo z adresem, który nie jest URL-em',
      { COOKIDOO_SERVICE_URL: 'cookidoo:8000' },
      /COOKIDOO_SERVICE_URL nie jest poprawnym/,
    ],
    [
      'WS_AUTH_MODE=soft (tożsamość z payloadu)',
      { WS_AUTH_MODE: 'soft' },
      /WS_AUTH_MODE=soft/,
    ],
  ])('produkcja: %s → naruszenie', (_label, overrides, pattern) => {
    const report = inspectRuntimeEnv(productionEnv(overrides));
    expect(report.violations.some((v) => pattern.test(v))).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it('produkcja wymienia wszystkie naruszenia naraz, bez wartości sekretów', () => {
    const report = inspectRuntimeEnv(
      productionEnv({
        JWT_SECRET: 'tajne-haslo-krotkie',
        REFRESH_TOKEN_PEPPER: undefined,
        OPS_TOKEN: undefined,
      }),
    );
    expect(report.violations).toHaveLength(3);
    expect(report.violations.join('\n')).not.toContain('tajne-haslo-krotkie');
  });

  it('poza produkcją braki sekretów to tylko ostrzeżenia', () => {
    const report = inspectRuntimeEnv({
      NODE_ENV: 'development',
      JWT_SECRET: 'dev-secret-change-me',
    });
    expect(report.production).toBe(false);
    expect(report.violations).toEqual([]);
    expect(report.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('poza produkcją Cookidoo, OPS_TOKEN i dev-login nie są sprawdzane', () => {
    const report = inspectRuntimeEnv({
      NODE_ENV: 'test',
      JWT_SECRET: STRONG,
      REFRESH_TOKEN_PEPPER: OTHER_STRONG,
      AUTH_DEV_LOGIN_ENABLED: 'true',
      COOKIDOO_SERVICE_URL: 'http://cookidoo.up.railway.app',
      WS_AUTH_MODE: 'soft',
    });
    expect(report).toEqual({ production: false, violations: [], warnings: [] });
  });

  it.each([
    ['https publiczny', 'https://cookidoo.up.railway.app'],
    ['sieć prywatna Railway', 'http://cookidoo.railway.internal:8000'],
    ['localhost (api z hosta)', 'http://localhost:8000'],
    ['docker-compose', 'http://cookidoo.local:8000'],
    ['brak zmiennej', undefined],
  ])('produkcja: COOKIDOO_SERVICE_URL %s przechodzi', (_label, url) => {
    const report = inspectRuntimeEnv(
      productionEnv({ COOKIDOO_SERVICE_URL: url }),
    );
    expect(report.violations).toEqual([]);
  });

  it('krótki OPS_TOKEN na produkcji to ostrzeżenie, nie blokada startu', () => {
    const report = inspectRuntimeEnv(
      productionEnv({ OPS_TOKEN: 'o'.repeat(12) }),
    );
    expect(report.violations).toEqual([]);
    expect(report.warnings).toEqual([
      expect.stringMatching(/OPS_TOKEN ma 12 znaków/),
    ]);
    expect(report.warnings.join('\n')).not.toContain('oooooooooooo');
  });
});

describe('assertRuntimeEnv', () => {
  it('rzuca jednym błędem z listą naruszeń na produkcji', () => {
    expect(() =>
      assertRuntimeEnv(productionEnv({ JWT_SECRET: undefined }), {
        warn: () => undefined,
      }),
    ).toThrow(/Odmowa startu[\s\S]*JWT_SECRET/);
  });

  it('nie rzuca, tylko ostrzega poza produkcją', () => {
    const warn = jest.fn();
    expect(() =>
      assertRuntimeEnv({ NODE_ENV: 'development' }, { warn }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('milczy, gdy komplet jest w porządku', () => {
    const warn = jest.fn();
    expect(() => assertRuntimeEnv(productionEnv(), { warn })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('WS_AUTH_MODE w assert-env', () => {
  it('strict i brak zmiennej nie są naruszeniem, jawne soft jest', () => {
    expect(inspectRuntimeEnv(productionEnv()).violations).toEqual([]);
    expect(
      inspectRuntimeEnv(productionEnv({ WS_AUTH_MODE: 'strict' })).violations,
    ).toEqual([]);
    expect(
      inspectRuntimeEnv(productionEnv({ WS_AUTH_MODE: 'soft' })).violations,
    ).toEqual([expect.stringContaining('WS_AUTH_MODE=soft')]);
  });

  it('literówka to naruszenie na produkcji i ostrzeżenie poza nią', () => {
    expect(
      inspectRuntimeEnv(productionEnv({ WS_AUTH_MODE: 'required' })).violations,
    ).toEqual([expect.stringContaining('WS_AUTH_MODE=required')]);
    expect(
      inspectRuntimeEnv({
        NODE_ENV: 'development',
        JWT_SECRET: STRONG,
        REFRESH_TOKEN_PEPPER: OTHER_STRONG,
        WS_AUTH_MODE: 'off',
      }).warnings,
    ).toEqual([expect.stringContaining('WS_AUTH_MODE=off')]);
  });
});
