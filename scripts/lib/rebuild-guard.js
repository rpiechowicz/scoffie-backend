'use strict';

/**
 * Strażnik trybu „przebuduj bazę od zera” w `prisma-migrate-deploy-safe.js`.
 *
 * Skrypt biegnie w CMD kontenera przy KAŻDYM starcie, a zmienne platformy
 * (Railway, compose) przeżywają restarty. Dawniej wystarczyły dwie zmienne
 * (`SAFE_MIGRATE_REBUILD_DB=true` + `CONFIRM=YES_I_UNDERSTAND`), żeby każdy
 * kolejny restart — także po OOM — robił `DROP SCHEMA public CASCADE`.
 *
 * Nowe reguły:
 *  - potwierdzenie to DZISIEJSZA data UTC (`YYYY-MM-DD`) — samowygasające,
 *    zapomniana flaga przestaje działać jutro;
 *  - na produkcji dodatkowo `SAFE_MIGRATE_ALLOW_PROD_REBUILD` musi równać się
 *    hostowi z `DATABASE_URL` — nie da się „włączyć” rebuildu, nie wiedząc,
 *    którą bazę się kasuje;
 *  - host jest zwracany do logu PRZED kasowaniem.
 *
 * Czysta funkcja bez efektów ubocznych — test w `src/config/rebuild-guard.spec.ts`.
 */

function todayUtc(now) {
  return now.toISOString().slice(0, 10);
}

function hostOf(databaseUrl) {
  if (!databaseUrl) return null;
  try {
    return new URL(databaseUrl).host || null;
  } catch {
    return null;
  }
}

/**
 * @param {{ env: NodeJS.ProcessEnv, now?: Date }} input
 * @returns {{ requested: boolean, allowed: boolean, host: string | null, reason: string }}
 */
function decideRebuild({ env, now = new Date() }) {
  const host = hostOf(env.DATABASE_URL);

  if (env.SAFE_MIGRATE_REBUILD_DB !== 'true') {
    return {
      requested: false,
      allowed: false,
      host,
      reason: 'SAFE_MIGRATE_REBUILD_DB is not "true"',
    };
  }

  const today = todayUtc(now);
  const confirm = env.SAFE_MIGRATE_REBUILD_CONFIRM;
  if (confirm !== today) {
    return {
      requested: true,
      allowed: false,
      host,
      reason: `SAFE_MIGRATE_REBUILD_CONFIRM must equal today's UTC date "${today}" (got "${confirm ?? ''}")`,
    };
  }

  if (env.NODE_ENV === 'production') {
    if (!host) {
      return {
        requested: true,
        allowed: false,
        host,
        reason:
          'NODE_ENV=production: cannot determine DATABASE_URL host, refusing to rebuild',
      };
    }
    if (env.SAFE_MIGRATE_ALLOW_PROD_REBUILD !== host) {
      return {
        requested: true,
        allowed: false,
        host,
        reason: `NODE_ENV=production: SAFE_MIGRATE_ALLOW_PROD_REBUILD must equal the DATABASE_URL host "${host}"`,
      };
    }
  }

  return { requested: true, allowed: true, host, reason: 'confirmed' };
}

module.exports = { decideRebuild, hostOf, todayUtc };
