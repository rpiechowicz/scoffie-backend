import {
  adminDevBypassEmail,
  adminEnvProblems,
  normalizeTeamDomain,
  readAdminEnv,
  readAdminProxySecret,
  readAdminTotpKey,
} from './admin-env';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe('admin-env', () => {
  describe('obejście bramki Access (ADMIN_ACCESS_DEV_EMAIL)', () => {
    it('działa lokalnie, gdy adres jest jawnie ustawiony', () => {
      expect(
        adminDevBypassEmail(
          env({
            NODE_ENV: 'development',
            ADMIN_ACCESS_DEV_EMAIL: ' Ja@Dev.local ',
          }),
        ),
      ).toBe('ja@dev.local');
      // Brak NODE_ENV (`pnpm start:dev`) to też nie produkcja.
      expect(
        adminDevBypassEmail(env({ ADMIN_ACCESS_DEV_EMAIL: 'ja@dev.local' })),
      ).toBe('ja@dev.local');
    });

    it('bez zmiennej — brak obejścia', () => {
      expect(adminDevBypassEmail(env({ NODE_ENV: 'development' }))).toBeNull();
    });

    it.each(['production', 'Production', ' PRODUCTION '])(
      'NIEMOŻLIWE przy NODE_ENV=%s',
      (nodeEnv) => {
        expect(
          adminDevBypassEmail(
            env({ NODE_ENV: nodeEnv, ADMIN_ACCESS_DEV_EMAIL: 'ja@dev.local' }),
          ),
        ).toBeNull();
      },
    );

    it('NIEMOŻLIWE na żadnym środowisku Railwaya, nawet z błędnym NODE_ENV', () => {
      expect(
        adminDevBypassEmail(
          env({
            NODE_ENV: 'development',
            RAILWAY_ENVIRONMENT_NAME: 'staging',
            ADMIN_ACCESS_DEV_EMAIL: 'ja@dev.local',
          }),
        ),
      ).toBeNull();
    });
  });

  it('domena zespołu bez schematu i ukośnika', () => {
    expect(normalizeTeamDomain('https://Scoffie.CloudflareAccess.com/')).toBe(
      'scoffie.cloudflareaccess.com',
    );
    expect(normalizeTeamDomain('  ')).toBeNull();
  });

  it('czyta listy AUD i pochodzeń', () => {
    const admin = readAdminEnv(
      env({
        ADMIN_ACCESS_AUD: 'a, b',
        ADMIN_WEBAUTHN_ORIGIN:
          'https://dashboard.scoffie.app/, http://localhost:5173',
        ADMIN_WEBAUTHN_RP_ID: 'Dashboard.Scoffie.App',
        ADMIN_BOOTSTRAP_EMAIL: 'Rafal@Example.com',
      }),
    );
    expect(admin.accessAud).toEqual(['a', 'b']);
    expect(admin.webauthnOrigins).toEqual([
      'https://dashboard.scoffie.app',
      'http://localhost:5173',
    ]);
    expect(admin.webauthnRpId).toBe('dashboard.scoffie.app');
    expect(admin.bootstrapEmail).toBe('rafal@example.com');
  });

  it('klucz TOTP: 32 bajty albo nic', () => {
    expect(
      readAdminTotpKey(env({ ADMIN_TOTP_ENCRYPTION_KEY: KEY })),
    ).toHaveLength(32);
    expect(
      readAdminTotpKey(env({ ADMIN_TOTP_ENCRYPTION_KEY: 'krótki' })),
    ).toBeNull();
    expect(readAdminTotpKey(env({}))).toBeNull();
  });

  describe('adminEnvProblems', () => {
    it('obejście bramki na produkcji BLOKUJE start', () => {
      expect(
        adminEnvProblems(
          env({ NODE_ENV: 'production', ADMIN_ACCESS_DEV_EMAIL: 'x@y.z' }),
        ).violations,
      ).toEqual([expect.stringContaining('ADMIN_ACCESS_DEV_EMAIL')]);
    });

    it('panel wyłączony (brak zmiennych) — ani słowa: merge bez konfiguracji', () => {
      expect(adminEnvProblems(env({ NODE_ENV: 'production' }))).toEqual({
        violations: [],
        warnings: [],
      });
    });

    it('niekompletny panel to tylko ostrzeżenia, nigdy blokada startu', () => {
      const report = adminEnvProblems(
        env({
          NODE_ENV: 'production',
          ADMIN_ACCESS_TEAM_DOMAIN: 'scoffie.cloudflareaccess.com',
          ADMIN_ACCESS_AUD: 'aud',
          ADMIN_WEBAUTHN_ORIGIN: 'http://dashboard.scoffie.app',
        }),
      );
      expect(report.violations).toEqual([]);
      expect(report.warnings.join('\n')).toMatch(/ADMIN_WEBAUTHN_RP_ID/);
      expect(report.warnings.join('\n')).toMatch(/https/);
      expect(report.warnings.join('\n')).toMatch(/ADMIN_TOTP_ENCRYPTION_KEY/);
      expect(report.warnings.join('\n')).toMatch(/ADMIN_BOOTSTRAP_EMAIL/);
    });

    it('tylko jedna z pary ADMIN_ACCESS_* — ostrzeżenie, panel zamknięty', () => {
      expect(
        adminEnvProblems(
          env({ ADMIN_ACCESS_TEAM_DOMAIN: 'x.cloudflareaccess.com' }),
        ).warnings,
      ).toEqual([expect.stringContaining('zamknięty')]);
    });

    it('kompletny panel — bez uwag', () => {
      expect(
        adminEnvProblems(
          env({
            NODE_ENV: 'production',
            ADMIN_ACCESS_TEAM_DOMAIN: 'scoffie.cloudflareaccess.com',
            ADMIN_ACCESS_AUD: 'aud',
            ADMIN_WEBAUTHN_RP_ID: 'dashboard.scoffie.app',
            ADMIN_WEBAUTHN_ORIGIN: 'https://dashboard.scoffie.app',
            ADMIN_TOTP_ENCRYPTION_KEY: KEY,
            ADMIN_BOOTSTRAP_EMAIL: 'rafal@example.com',
            ADMIN_PROXY_SECRET: 'x'.repeat(32),
          }),
        ),
      ).toEqual({ violations: [], warnings: [] });
    });

    it('ADMIN_PROXY_SECRET: za krótki — ignorowany z ostrzeżeniem; brak na produkcji — ostrzeżenie', () => {
      expect(
        readAdminProxySecret(env({ ADMIN_PROXY_SECRET: 'x'.repeat(31) })),
      ).toBeNull();
      expect(
        readAdminProxySecret(
          env({ ADMIN_PROXY_SECRET: ` ${'x'.repeat(32)} ` }),
        ),
      ).toBe('x'.repeat(32));
      expect(
        adminEnvProblems(env({ ADMIN_PROXY_SECRET: 'krotki' })).warnings,
      ).toEqual([expect.stringContaining('ADMIN_PROXY_SECRET krótszy')]);
      expect(
        adminEnvProblems(
          env({
            NODE_ENV: 'production',
            ADMIN_ACCESS_TEAM_DOMAIN: 'scoffie.cloudflareaccess.com',
            ADMIN_ACCESS_AUD: 'aud',
            ADMIN_WEBAUTHN_RP_ID: 'dashboard.scoffie.app',
            ADMIN_WEBAUTHN_ORIGIN: 'https://dashboard.scoffie.app',
            ADMIN_TOTP_ENCRYPTION_KEY: KEY,
            ADMIN_BOOTSTRAP_EMAIL: 'rafal@example.com',
          }),
        ).warnings,
      ).toEqual([expect.stringContaining('brak ADMIN_PROXY_SECRET')]);
    });
  });
});
