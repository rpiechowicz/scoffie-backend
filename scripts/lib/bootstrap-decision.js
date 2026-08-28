'use strict';

/**
 * Decyzja „czy zasiać katalog składników i przepisy” w
 * `prisma-migrate-deploy-safe.js`.
 *
 * Dawniej `runOptionalBootstrap()` był wołany WYŁĄCZNIE wewnątrz
 * `if (rebuild.allowed)`, mimo że `SAFE_MIGRATE_BOOTSTRAP_RECIPES=true` jest
 * domyślne. Świeża baza (nowy wolumen w composie, nowy serwis na Railway)
 * dostawała więc sam schemat i zero danych — API wstawało z pustym katalogiem,
 * co wygląda jak zepsuty import, a nie jak pominięty krok.
 *
 * Reguła: bootstrap chodzi na PUSTEJ bazie (albo po rebuildzie, który pustkę
 * właśnie zrobił). Nigdy na bazie z danymi — `runOptionalBootstrap()` puszcza
 * import z `RECIPE_IMPORT_CLEAR_EXISTING` domyślnie `true`, więc na
 * zapełnionej bazie byłby to cichy reset katalogu przy każdym restarcie
 * kontenera.
 *
 * Czysta funkcja bez efektów ubocznych — test w
 * `src/config/bootstrap-decision.spec.ts`.
 */

/**
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   rebuilt: boolean,
 *   databaseEmpty: boolean,
 * }} input
 * @returns {{ run: boolean, reason: string }}
 */
function decideBootstrap({ env, rebuilt, databaseEmpty }) {
  if (env.SAFE_MIGRATE_BOOTSTRAP_RECIPES === 'false') {
    return {
      run: false,
      reason: 'disabled (SAFE_MIGRATE_BOOTSTRAP_RECIPES=false)',
    };
  }

  if (rebuilt) {
    return { run: true, reason: 'database was rebuilt from scratch' };
  }

  if (databaseEmpty) {
    return { run: true, reason: 'fresh database (no recipes, no ingredients)' };
  }

  return {
    run: false,
    reason: 'database already has data (bootstrap only runs on an empty one)',
  };
}

module.exports = { decideBootstrap };
