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
    OPS_TOKEN: 'o'.repeat(24),
    AUTH_DEV_LOGIN_ENABLED: 'false',
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
    });
    expect(report).toEqual({ production: false, violations: [], warnings: [] });
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
