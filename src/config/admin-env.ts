import { parseEncryptionKey } from '../common/crypto.util';

/**
 * Konfiguracja panelu administratora (`/admin/*`).
 *
 * Czytana PER ŻĄDANIE, jak `readAgentEnv` i limity throttlera: testy
 * przełączają tryby bez przebudowy modułu, a zmiana na Railwayu działa po
 * restarcie bez nowego builda.
 *
 * BEZPIECZNY STAN DOMYŚLNY. Brak `ADMIN_ACCESS_TEAM_DOMAIN` albo
 * `ADMIN_ACCESS_AUD` znaczy „panelu nie ma": każde `/admin/*` odpowiada
 * tak samo jak nieistniejąca trasa (404). Merge tego kodu nie wymaga więc
 * ustawiania czegokolwiek na produkcji.
 */
export type AdminEnv = {
  /** Domena zespołu Cloudflare Access bez schematu, np. `scoffie.cloudflareaccess.com`. */
  accessTeamDomain: string | null;
  /** Tag AUD aplikacji Access (jeden albo kilka po przecinku). */
  accessAud: string[];
  /** Adres, który może założyć PIERWSZE konto admina (bootstrap). */
  bootstrapEmail: string | null;
  /** RP ID WebAuthn — domena panelu, np. `dashboard.scoffie.app`; lokalnie `localhost`. */
  webauthnRpId: string | null;
  /** Pochodzenie panelu, np. `https://dashboard.scoffie.app` (kilka po przecinku). */
  webauthnOrigins: string[];
  /** Adres z obejścia bramki do pracy lokalnej — `null`, gdy obejście jest niedozwolone. */
  devEmail: string | null;
};

const lower = (value: string | undefined): string =>
  (value ?? '').trim().toLowerCase();

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** `https://Zespol.cloudflareaccess.com/` → `zespol.cloudflareaccess.com`. */
export function normalizeTeamDomain(raw: string | undefined): string | null {
  const value = lower(raw)
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return value || null;
}

/**
 * Czy wolno obejść bramkę Access adresem z `ADMIN_ACCESS_DEV_EMAIL`.
 *
 * Trzy warunki naraz, bo to jest dosłownie „wejdź jako admin bez logowania do
 * Google": `NODE_ENV` inny niż `production` (bez względu na wielkość liter),
 * ŻADNEJ zmiennej `RAILWAY_ENVIRONMENT*` (Railway ustawia je każdemu
 * wdrożeniu, więc na żadnym środowisku Railwaya obejście nie ruszy, nawet
 * przy pomyłce w `NODE_ENV`) i jawnie ustawiony adres. Dodatkowo
 * `assert-env` odmawia startu produkcji z tą zmienną.
 */
export function adminDevBypassEmail(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (lower(env.NODE_ENV) === 'production') return null;
  if (Object.keys(env).some((key) => key.startsWith('RAILWAY_ENVIRONMENT'))) {
    return null;
  }
  const email = lower(env.ADMIN_ACCESS_DEV_EMAIL);
  return email || null;
}

export function readAdminEnv(env: NodeJS.ProcessEnv = process.env): AdminEnv {
  return {
    accessTeamDomain: normalizeTeamDomain(env.ADMIN_ACCESS_TEAM_DOMAIN),
    accessAud: list(env.ADMIN_ACCESS_AUD),
    bootstrapEmail: lower(env.ADMIN_BOOTSTRAP_EMAIL) || null,
    webauthnRpId: lower(env.ADMIN_WEBAUTHN_RP_ID) || null,
    webauthnOrigins: list(env.ADMIN_WEBAUTHN_ORIGIN).map((origin) =>
      origin.replace(/\/+$/, ''),
    ),
    devEmail: adminDevBypassEmail(env),
  };
}

/** Czy bramka Access jest skonfigurowana (bez tego `/admin` to 404). */
export function accessGateConfigured(env: AdminEnv): boolean {
  return env.accessTeamDomain !== null && env.accessAud.length > 0;
}

/**
 * Klucz AES-256-GCM sekretów TOTP (i, przez HKDF, kluczy do HMAC kodów
 * odzyskiwania). `null` = TOTP i kody odzyskiwania niedostępne (503),
 * passkeye działają dalej.
 *
 * OSOBNY KLUCZ, NIE `COOKIDOO_ENCRYPTION_KEY`: wyciek klucza integracji nie
 * może oddawać drugiego składnika logowania do panelu.
 */
export function readAdminTotpKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  if (!(env.ADMIN_TOTP_ENCRYPTION_KEY ?? '').trim()) return null;
  try {
    return parseEncryptionKey(
      env.ADMIN_TOTP_ENCRYPTION_KEY,
      'ADMIN_TOTP_ENCRYPTION_KEY',
    );
  } catch {
    return null;
  }
}

/** Minimalna długość `ADMIN_PROXY_SECRET` — krótszy sekret jest ignorowany. */
export const ADMIN_PROXY_SECRET_MIN_LENGTH = 32;

/**
 * Wspólny sekret Workera panelu (`ADMIN_PROXY_SECRET`) albo `null`.
 *
 * Worker dokłada go w nagłówku `X-Admin-Proxy-Secret` razem z
 * `CF-Connecting-IP` / `CF-IPCountry`. `api.scoffie.app` stoi na Railwayu
 * bez proxy Cloudflare (DNS-only), więc te nagłówki może podać KAŻDY, kto
 * zapuka prosto do backendu — bez sekretu nie wolno im wierzyć (IP w liczniku
 * blokady i w dzienniku). Sekret krótszy niż 32 znaki traktujemy jak brak:
 * lepiej stracić kraj w dzienniku niż ufać zgadywalnej wartości.
 */
export function readAdminProxySecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = (env.ADMIN_PROXY_SECRET ?? '').trim();
  return value.length >= ADMIN_PROXY_SECRET_MIN_LENGTH ? value : null;
}

/**
 * Problemy konfiguracji do `assert-env`.
 *
 * `violations` blokują start produkcji, `warnings` idą do logu. Blokuje
 * WYŁĄCZNIE obejście bramki na produkcji — to jedyna pomyłka, która otwiera
 * panel obcym. Niekompletna konfiguracja panelu to ostrzeżenie: panel bez
 * passkeyów jest zamknięty, a zablokowany deploy położyłby aplikację.
 */
export function adminEnvProblems(env: NodeJS.ProcessEnv = process.env): {
  violations: string[];
  warnings: string[];
} {
  const violations: string[] = [];
  const warnings: string[] = [];
  const production = lower(env.NODE_ENV) === 'production';

  if (production && lower(env.ADMIN_ACCESS_DEV_EMAIL)) {
    violations.push(
      'ADMIN_ACCESS_DEV_EMAIL na produkcji — obejście bramki Access panelu jest tylko do pracy lokalnej',
    );
  }

  const proxySecret = (env.ADMIN_PROXY_SECRET ?? '').trim();
  if (proxySecret && proxySecret.length < ADMIN_PROXY_SECRET_MIN_LENGTH) {
    warnings.push(
      `Panel admina: ADMIN_PROXY_SECRET krótszy niż ${ADMIN_PROXY_SECRET_MIN_LENGTH} znaki — ignorowany, IP i kraj z nagłówków Cloudflare nie są przyjmowane`,
    );
  }

  const admin = readAdminEnv(env);
  const teamSet = admin.accessTeamDomain !== null;
  const audSet = admin.accessAud.length > 0;
  if (teamSet !== audSet) {
    warnings.push(
      'Panel admina: ustawiona tylko jedna z ADMIN_ACCESS_TEAM_DOMAIN / ADMIN_ACCESS_AUD — /admin zostaje zamknięty (404)',
    );
  }
  if (teamSet && audSet) {
    if (!admin.webauthnRpId || admin.webauthnOrigins.length === 0) {
      warnings.push(
        'Panel admina: brak ADMIN_WEBAUTHN_RP_ID / ADMIN_WEBAUTHN_ORIGIN — passkeye nie zadziałają (503)',
      );
    }
    if (
      production &&
      admin.webauthnOrigins.some((origin) => !origin.startsWith('https://'))
    ) {
      warnings.push(
        'Panel admina: ADMIN_WEBAUTHN_ORIGIN bez https:// na produkcji — przeglądarka odrzuci passkey',
      );
    }
    if ((env.ADMIN_TOTP_ENCRYPTION_KEY ?? '').trim()) {
      try {
        parseEncryptionKey(
          env.ADMIN_TOTP_ENCRYPTION_KEY,
          'ADMIN_TOTP_ENCRYPTION_KEY',
        );
      } catch (error) {
        warnings.push(
          `Panel admina: ${error instanceof Error ? error.message : 'zły ADMIN_TOTP_ENCRYPTION_KEY'} — TOTP i kody odzyskiwania niedostępne`,
        );
      }
    } else {
      warnings.push(
        'Panel admina: brak ADMIN_TOTP_ENCRYPTION_KEY — TOTP i kody odzyskiwania niedostępne (zostają passkeye)',
      );
    }
    if (production && !readAdminProxySecret(env)) {
      warnings.push(
        'Panel admina: brak ADMIN_PROXY_SECRET — CF-Connecting-IP / CF-IPCountry od Workera są ignorowane (IP = adres połączenia, kraj pusty)',
      );
    }
    if (!admin.bootstrapEmail) {
      warnings.push(
        'Panel admina: brak ADMIN_BOOTSTRAP_EMAIL — jeśli w bazie nie ma jeszcze admina, pierwszego konta nie da się założyć',
      );
    }
  }
  return { violations, warnings };
}
