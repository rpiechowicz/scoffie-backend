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

/**
 * Decyzja „czy wgrać tagi składników (alergeny/diety) po migracji”.
 *
 * Migracja `20260828150000_tagi_skladnikow_i_przepisow` dodaje kolumny
 * `allergens`/`dietTags` z `DEFAULT '{}'` i NIE robi backfillu — tagi wgrywa
 * `scripts/load-ingredient-tags.ts`. Ten loader był wołany wyłącznie w
 * bootstrapie, a bootstrap chodzi tylko na pustej bazie, więc każda baza
 * z danymi (prod, dev po `migrate deploy`) zostawała z pustymi tagami do
 * ręcznego `pnpm catalog:ingredients:tags`. Puste tagi nie są „brakiem
 * danych” — `diet-rules.util.ts` czyta je jako fakt: żaden alergen, każda
 * dieta spełniona. Walidator asystenta odziedziczyłby fałszywe „czyste”.
 *
 * Reguła: loader biegnie raz — gdy katalog składników istnieje, a ŻADEN
 * składnik nie niesie tagów (kolumny nigdy nie zostały zasilone). Po pierwszym
 * przebiegu warunek nie zachodzi, więc kolejne starty go nie powtarzają;
 * korekty pliku tagów nadal wgrywa się ręcznie (`pnpm catalog:ingredients:tags`,
 * idempotentny). Po bootstrapie nie ma czego robić — bootstrap sam wgrywa tagi
 * przed importem przepisów.
 *
 * @param {{
 *   env: NodeJS.ProcessEnv,
 *   bootstrapRan: boolean,
 *   ingredientCount: number,
 *   taggedIngredientCount: number,
 * }} input
 * @returns {{ run: boolean, reason: string }}
 */
function decideIngredientTagsLoad({
  env,
  bootstrapRan,
  ingredientCount,
  taggedIngredientCount,
}) {
  if (env.SAFE_MIGRATE_LOAD_INGREDIENT_TAGS === 'false') {
    return {
      run: false,
      reason: 'disabled (SAFE_MIGRATE_LOAD_INGREDIENT_TAGS=false)',
    };
  }

  if (bootstrapRan) {
    return { run: false, reason: 'bootstrap already loaded ingredient tags' };
  }

  if (ingredientCount === 0) {
    return { run: false, reason: 'no ingredient catalog to tag' };
  }

  if (taggedIngredientCount > 0) {
    return {
      run: false,
      reason: `ingredient tags already loaded (${taggedIngredientCount}/${ingredientCount} tagged; corrections go through \`pnpm catalog:ingredients:tags\`)`,
    };
  }

  return {
    run: true,
    reason: `ingredient catalog has ${ingredientCount} rows and none carries tags (columns never loaded)`,
  };
}

module.exports = { decideBootstrap, decideIngredientTagsLoad };
