'use strict';

/**
 * Strażnik zapisu w `scripts/reset-accounts.ts` — ten sam wzorzec, co
 * `rebuild-guard.js`, bo to ta sama klasa operacji: nieodwracalne kasowanie
 * na bazie, którą wskazuje zmienna środowiskowa, a nie człowiek.
 *
 * Do tej pory zapis włączała sama zmienna `RESET_ACCOUNTS_WRITE=true`.
 * Zmienna ustawiona w Railway Variables przeżywa restarty i dziedziczy ją
 * `railway run` — więc każde kolejne „pokaż raport" (`pnpm accounts:reset`
 * bez flagi) kasowałoby produkcję. Nowe reguły:
 *
 *  - zapis żąda `--write` albo `RESET_ACCOUNTS_WRITE=true` (jak dotąd),
 *  - potwierdzenie to DZISIEJSZA data UTC w `RESET_ACCOUNTS_CONFIRM` —
 *    samowygasające; zapomniana zmienna jutro nic nie robi,
 *  - dla bazy spoza tej maszyny (host inny niż localhost) dodatkowo
 *    `RESET_ACCOUNTS_ALLOW_HOST` musi równać się hostowi z `DATABASE_URL`.
 *    NIE `NODE_ENV=production`: `railway run` odpala skrypt lokalnie ze
 *    zmiennymi produkcji, a NODE_ENV ustawia obraz Dockera, nie Railway —
 *    lokalnie byłby pusty i strażnik po NODE_ENV przepuściłby prod.
 *  - host wraca do logu PRZED kasowaniem.
 *
 * Czysta funkcja bez efektów ubocznych — test w
 * `src/config/reset-accounts-guard.spec.ts`.
 */

const { hostOf, todayUtc } = require('./rebuild-guard');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'db']);

function isLocalHost(host) {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '');
  return LOCAL_HOSTS.has(name);
}

/**
 * @param {{ env: NodeJS.ProcessEnv, argv?: string[], now?: Date }} input
 * @returns {{ requested: boolean, allowed: boolean, host: string | null, reason: string }}
 */
function decideResetAccounts({ env, argv = [], now = new Date() }) {
  const host = hostOf(env.DATABASE_URL);
  const requested =
    argv.includes('--write') || env.RESET_ACCOUNTS_WRITE === 'true';

  if (!requested) {
    return { requested: false, allowed: false, host, reason: 'dry-run' };
  }

  const today = todayUtc(now);
  const confirm = env.RESET_ACCOUNTS_CONFIRM;
  if (confirm !== today) {
    return {
      requested: true,
      allowed: false,
      host,
      reason: `RESET_ACCOUNTS_CONFIRM musi równać się dzisiejszej dacie UTC "${today}" (jest "${confirm ?? ''}")`,
    };
  }

  if (!host) {
    return {
      requested: true,
      allowed: false,
      host,
      reason: 'nie umiem odczytać hosta z DATABASE_URL — odmawiam',
    };
  }

  if (!isLocalHost(host) && env.RESET_ACCOUNTS_ALLOW_HOST !== host) {
    return {
      requested: true,
      allowed: false,
      host,
      reason: `baza spoza tej maszyny: RESET_ACCOUNTS_ALLOW_HOST musi równać się hostowi z DATABASE_URL "${host}"`,
    };
  }

  return { requested: true, allowed: true, host, reason: 'potwierdzone' };
}

module.exports = { decideResetAccounts, isLocalHost };
