import { normalizePrivateKey } from './integration-fetch';

/**
 * Klucze zewnętrznych serwisów panelu (ROADMAPA §1 pkt 5: sekrety integracji
 * żyją w backendzie, przeglądarka pyta backend).
 *
 * Czytane PER ŻĄDANIE jak `readAdminEnv` — nowy token na Railwayu działa po
 * restarcie bez builda. Prefiks `ADMIN_`, bo `SENTRY_AUTH_TOKEN` czyta
 * sentry-cli przy buildzie, a `RAILWAY_*` ustawia sam Railway — te klucze
 * służą wyłącznie panelowi i mają najwęższe możliwe uprawnienia (tylko odczyt).
 *
 * Brak zmiennej = integracja `off`: panel pokazuje, czego brakuje, reszta
 * działa. Żadna z nich nie blokuje startu.
 */
export type SentryEnv = {
  token: string;
  org: string;
  /** Region organizacji — Scoffie jest w DE. */
  apiUrl: string;
  projects: string[];
};

export type AscEnv = {
  keyId: string;
  issuerId: string;
  privateKey: string;
  bundleId: string;
};

const text = (value: string | undefined): string => (value ?? '').trim();
const list = (value: string | undefined): string[] =>
  text(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export function readSentryEnv(env: NodeJS.ProcessEnv = process.env): SentryEnv {
  const projects = list(env.ADMIN_SENTRY_PROJECTS);
  return {
    token: text(env.ADMIN_SENTRY_TOKEN),
    org: text(env.ADMIN_SENTRY_ORG) || 'scoffie',
    apiUrl: (text(env.ADMIN_SENTRY_API_URL) || 'https://de.sentry.io').replace(
      /\/+$/,
      '',
    ),
    projects:
      projects.length > 0
        ? projects
        : ['scoffie-ios', 'scoffie-backend', 'scoffie-dashboard'],
  };
}

/** Token PROJEKTU Railway (środowisko production) — nagłówek `Project-Access-Token`. */
export function readRailwayToken(env: NodeJS.ProcessEnv = process.env): string {
  return text(env.ADMIN_RAILWAY_TOKEN);
}

/**
 * Klucz App Store Connect API — INNY niż `APPLE_BILLING_KEY_ID` (tamten to
 * klucz In-App Purchase do App Store Server API). Issuer ID jest jeden na
 * zespół, więc domyślnie ten sam `APPLE_ISSUER_ID`.
 */
export function readAscEnv(env: NodeJS.ProcessEnv = process.env): AscEnv {
  return {
    keyId: text(env.ADMIN_ASC_KEY_ID),
    issuerId: text(env.ADMIN_ASC_ISSUER_ID) || text(env.APPLE_ISSUER_ID),
    privateKey: normalizePrivateKey(env.ADMIN_ASC_PRIVATE_KEY),
    bundleId: text(env.APPLE_BUNDLE_ID) || 'app.scoffie.ios',
  };
}

/** Nazwy brakujących zmiennych — panel pokazuje je w stanie `off`. */
export function missingSentry(env: SentryEnv): string[] {
  return env.token ? [] : ['ADMIN_SENTRY_TOKEN'];
}

export function missingAsc(env: AscEnv): string[] {
  return [
    ...(env.keyId ? [] : ['ADMIN_ASC_KEY_ID']),
    ...(env.privateKey ? [] : ['ADMIN_ASC_PRIVATE_KEY']),
    ...(env.issuerId ? [] : ['APPLE_ISSUER_ID']),
  ];
}
