# Recipe & ingredient catalog — data/pipeline audit

Paths: `B=/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend`, `I=/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals`. All numbers computed with python3 over `B/prisma/catalog/*` (read-only).

## Findings

**D1 — Shopping list rewrites catalog names through a lossy pre-catalog canonicalizer: beans become "Sól", 32/131 names mangled or merged** — **P0**

- Evidence: `B/src/weekly-plans/services/shopping-list.service.ts:150-154` `canonicalizeIngredientName(ingredient.name, baseUnit)` → `productKey = normalizeProductKey(canonicalName, baseUnit)`. `B/src/weekly-plans/utils/department-classifier.util.ts:35` `let raw = normalizeText(name)` (strips diacritics), `:142` `if (/sol/.test(raw)) return 'Sól';`, `:111` `/bavette|wołowin|wolowin/ → 'Wołowina bavette'`, `:133` `/seler/ → 'Seler naciowy'`, `:145` fallback `toTitleCase(toPolishDisplayText(raw))` whose token list (`text-normalization.util.ts:73-102`) lacks `maka/bulka/borowka/twarog/tunczyk/...`.
- Computed over the 131 ingredients used in `recipes-catalog-full-v2.json`: 32 display differently. `fasola biała z puszki` + `fasola czerwona z puszki` (3 recipes) → **"Sól"** and merge with real salt under key `sól::g`; `seler korzeniowy` → "Seler naciowy" (2); `wołowina` / `wieprzowina i wołowina mielona` → "Wołowina bavette"; `mąka pszenna` (14 recipes) → "Maka pszenna"; `tuńczyk w puszce` (4) → "Tunczyk puszce"; `ser twaróg półtłusty` (4) → "Ser twarog poltlusty"; `filet z kurczaka`+`noga z kurczaka` → "Kurczak"; `kiełbasa biała`+`kiełbasa śląska` → "Kiełbasa". Across all 403 catalog names: 48 renamed; 6 collapse into "Sól" (incl. `fasolka szparagowa`, `fasola sucha`).
- Escalation: any assistant tool reading the list/productKey ("what do we still need", pantry balance) inherits these names; users already see them.
- Fix (backend only): use `RecipeIngredient.name` verbatim and key by `ingredientId`+`normalizedUnit` (add `ingredientId` to the select at `:66-73`); delete `canonicalizeIngredientName` and the name-regex branch of `resolveDepartment` (`Ingredient.category` already equals the enum, see FINE). Update `shopping-list.service.spec.ts` fixtures. Old `ShoppingListItem`/archive rows are snapshots — regenerate on next plan change, no migration.
- Effort: 2–3 h. **FIX-BEFORE-PHASE-0**

**D2 — Importer pins `servings === 2`; ~8 recipes are 4-serving batches → 956–1287 kcal "per serving"** — **P1** (borders P0: numbers users see)

- Evidence: `B/scripts/import-recipes-from-json.ts:305-307` `if (recipe.servings !== 2) throw new Error(...must have servings=2)`; full-v2 89/89 `servings: 2`. `Pierogi z mięsem z okrasą cebulową`: 300 g mąka, 2 jajka, 350 g wieprzowina mielona, 200 g cebula, 30 g masło → `kcal: 2574` = **1287 kcal/serving**. Also Zapiekanka makaronowa 1200 (DINNER), Pierogi ruskie 1174, Kotlety mielone 1129, Gulasz 1037, Fasolka po bretońsku 981, Rosół 978, Gołąbki 956. Totals are correct for the amounts (computed drift <10 % on all 89) — the yield is wrong. Schema default `servings 1` (`schema.prisma:144`) never applies (import forces 2, `create-recipe.dto.ts:101-102` `@Min(1)` required).
- Escalation: per-person kcal = `kcal/servings`, classifier thresholds (`suitable-meal-types.util.ts:277-280`), shopping scaling `plannedServings / recipe.servings` (`shopping-list.service.ts:104`) and the assistant's kcal validator all divide by this. A 2-person household "cooks 2 servings" of pierogi = a 4-person batch and the day is over-counted ~2×.
- Fix: relax importer to `1 ≤ servings ≤ 8`; set `servings: 4` on the heavy recipes in `recipes-catalog-full-v2.json` (whole-recipe macros unchanged) or halve amounts + `recipes:recompute:nutrition --write`; re-import (idempotent by id). Grep iOS for a hard-coded 2 before shipping (I found none in the reviewed backend code).
- Effort: 1.5 h. **FIX-BEFORE-PHASE-0**

**D3 — `RecipesService` keeps a private, already-diverged copy of the amount normalizer and never derives nutrition from ingredients** — **P1**

- Evidence: `B/src/recipes/recipes.service.ts:215-285` duplicates `normalizeText`/`normalizeIngredientAmount`; its spice table `:97-113` ends at `'cukier brazowy': 4` and lacks `'przyprawa uniwersalna': 4` present in `B/src/recipes/ingredient-amount.util.ts:51` (ingredient is in `ingredients-przyprawy-i-sosy-pl-v1.txt:22` and used at `recipes-catalog-full-v2.json:3618`). The util header `:4-6` exists precisely to prevent this. `computeRecipeNutrition` is imported by scripts only (no `src/` consumer) although `recipe-nutrition.util.ts:4-6` claims "walidacja przy tworzeniu przepisu"; `create` stores `nutritionKcal: data.nutritionKcal ?? 0` (`:588-593`) and skips the slot classifier (`:578-583`).
- Escalation: the assistant will create/edit recipes through this service → `normalizedAmount` differs from imported rows for identical input, and nutrition is whatever the model typed (or 0), which the validator then trusts.
- Fix: delete the private copy, import from `./ingredient-amount.util`; in `create` (and the future update path) compute totals with `computeRecipeNutrition` from `Ingredient.*Per100` when the client omits them, and reject when `missingNutrition`/`missingPieceWeight` is non-empty. Backend only.
- Effort: 2 h. **FIX-BEFORE-PHASE-0**

**D4 — Catalog household resolved by NAME `'Home'`; recipe list is global** — **P1**

- Evidence: `B/scripts/import-recipes-from-json.ts:350-354` `household.findFirst({ where: { name: 'Home' }, orderBy: { createdAt: 'asc' } })` then `:366-379` upserts the bot as **OWNER** of it; users pick household names freely (`B/src/households/households.service.ts:89-92` `name: dto.name`). Same lookup in `recipes.service.ts:86-87,160-163` (env-gated recovery). `findAll` `whereBase` (`recipes.service.ts:409-425`) has no `householdId` → every user recipe from every household is in the "catalog".
- Escalation: on a fresh env a user household named "Home" created before the first import becomes the catalog owner with the bot as OWNER; the assistant's catalog digest has no stable "catalog vs household" boundary.
- Fix: fixed `RECIPE_IMPORT_HOUSEHOLD_ID` (create with explicit UUID) or lookup by `createdById = bot`; add `isCatalog`/`sourceProvider` filter for the digest. Importer part 30 min; scoping belongs with auth.
- Effort: 1 h + Phase-0 scoping. **FOLD-INTO-PHASE-0** (do the importer lookup now).

**D5 — `RECIPE_IMPORT_CLEAR_EXISTING` deletes globally** — **P1**

- Evidence: `import-recipes-from-json.ts:445-447` `planItem.deleteMany()`, `weeklyPlan.deleteMany()`, `recipeIngredient.deleteMany()` unscoped; only `:448` `recipe.deleteMany({ where: { householdId } })` is scoped. Prod command (`commands.txt:71`) passes `false`.
- Escalation: one env typo wipes every household's plans and strips ingredients from user recipes (recipes survive with 0 ingredients but stale macros).
- Fix: scope via `recipe: { householdId }`. **20 min. FIX-BEFORE-PHASE-0**

**D6 — No allergen / diet / family data on `Ingredient`; all diet logic is iOS keyword heuristics** — **P1**

- Evidence: `Ingredient` = name/normalizedName/category/nutrition only (`schema.prisma`); `UserPreference.allergens String[]` free text. `I/Models/Components/RecipeDietProfile.swift:143-268` + `Keywords` `:320-420` infer meat/fish/dairy/eggs/grains/legumes and allergens (fish, lactose, eggs, gluten, peanuts, nuts, soy) from name stems + department. Category cannot substitute: `Nabiał` contains `jajko`; gluten spans Piekarnia/Zboża (ryż, kasza gryczana are gluten-free)/Przekąski; nuts sit in `Przekąski i słodycze`. Families exist only as name patterns (22 `ser*`, 13 pork cuts, 5 kurczak, 4 indyk, 7 kiełbasa, 7 jogurt/kefir/skyr…). `IngredientAlias` is a 1:1 resolver (`import-recipes-from-json.ts:416-423`, unique `normalizedAlias`) — it cannot express groups without breaking import resolution.
- Escalation: the deterministic allergen/diet validator has nothing server-side to run on; it would have to re-port the Swift heuristics and drift from iOS.
- Fix: new `prisma/catalog/ingredient-tags-pl-v1.json` `{normalizedName, family, allergens[], dietFlags[]}`; columns `Ingredient.family String?`, `allergens String[] @default([])`, `dietFlags String[] @default([])` (migration); extend `load-ingredient-catalog.ts`; seed from the Swift `Keywords` lists, curate the 131 used names first. iOS can later read server flags instead of guessing.
- Effort: 4–6 h (curation dominates). **FOLD-INTO-PHASE-0** (schema now, curation in parallel; blocks the validator, not auth).

**D7 — Default import file + id-pool-by-index + orphan images** — **P2**

- Evidence: `import-recipes-from-json.ts:60-61` default file `recipes-batch-test-v1.json` (20 id-less recipes); `:77-79` default pool `recipes-approved-30-image-ids.txt` (30 UUIDs, all owned by full-v2 recipes); `:482` `recipe.id?.trim() || recipeIdPool[index]`; `:170-190` fallback pool from `public/recipe-images` (36 files: 5 UUID orphans not in full-v2 + `serek-wiejski-z-owocem.png`). Computed: a bare `pnpm recipes:import:json` pairs test[i]↔pool[i]; 18/20 are caught by the RETITLE guard (`:508-520`), 2 title-coincident recipes would be silently downgraded to the old test-batch version.
- Fix: make `RECIPE_IMPORT_FILE` required, remove index-pool assignment (every real file has ids now), delete orphan PNGs. **30 min. FIX-BEFORE-PHASE-0** (cheap).

**D8 — Same ingredient represented in two units (`tortilla pszenna` 2 szt vs 160 g; `awokado` szt vs 140 g)** — **P2**

- Evidence: nutrition JSON `tortilla pszenna` `unit: szt, gramsPerPiece: 60`, used `2 szt` in 2 recipes and `160 g` in 3 (implies 80 g/piece); `awokado` `szt/150 g` used as `140 g` (2). Math is right (`recipe-nutrition.util.ts:66-73` treats g as g) but the list shows "Tortilla pszenna (g)" and "(szt)" rows (`shopping-items.util.ts:71-76`) and the assistant must unit-convert. Only other multi-unit uses: `sól`/`cukier` szczypta vs łyżeczka/g (fine).
- Fix: one unit per ingredient in the catalog (szt, `gramsPerPiece: 70`), edit 3 recipes, add "used with >1 unit" check to `audit-recipe-nutrition.ts`. **1 h. LATER** (bundle with D2 re-import).

**D9 — Merges/aliases exist only in the DB; loader never deactivates** — **P2**

- Evidence: `load-ingredient-catalog.ts:74-93` upserts with `isActive: true`, alias only when diacritics differ; no removal path. Memory note: duplicates merged by hand (alias + `isActive=false` + txt edit). A DB rebuilt from files has no aliases. Harmless today: all 131 used names and every other batch JSON resolve (computed).
- Fix: `ingredient-aliases-pl-v1.txt` (`alias -> canonical`) consumed by the loader; deactivate ingredients absent from txt. **1 h. LATER**

**D10 — No `@@unique([recipeId, ingredientId])`; title fallback nondeterministic** — **P2**

- Evidence: `schema.prisma:443-461` indexes only; `import-recipes-from-json.ts:496-502` `findFirst({ householdId, title })` without `orderBy`/`isActive`. No duplicates in catalog today (computed).
- Fix: unique migration so assistant "replace ingredient X in recipe Y" tools are well-defined. **30 min. FOLD-INTO-PHASE-0**

**D11 — Hygiene: `normalizeText` variants, kakao Atwater, salt** — **P2**

- `load-ingredient-catalog.ts:42` collapses `\s+`; `ingredient-amount.util.ts:63-78`, `recipes.service.ts:215-230`, `text-normalization.util.ts:9-24` do not (no double-space names exist today). `kakao` kcal 228 vs Atwater 359 (+58 %) — USDA-consistent, loader only warns (`load-ingredient-nutrition.ts:71-80`), used in 1 recipe. `nutritionSalt` is hand-typed, never recomputed (`recompute-recipe-nutrition.ts:217`), no sodium per-100 on Ingredient → the assistant must not validate on salt. **LATER**

## suitableMealTypes coverage (computed, classifier replicated)

59/89 explicit, all contain own `mealType`, all in day order; 4 explicit lists are just `[mealType]`. Classifier adds to 10 recipes (SECOND_BREAKFAST +9, SNACK +4, AFTERNOON_SNACK +1; e.g. `Owsianka z bananem i borówką`, `Kanapka z twarożkiem i ogórkiem`, `Sałatka grecka z pieczywem`). Final plannable coverage: BREAKFAST 19, SECOND_BREAKFAST 28, LUNCH 48, AFTERNOON_SNACK 14, DINNER 52, SNACK 18. 42 explicit lists carry manual slots the classifier would not add → JSON is the source of truth; import writes `resolveSuitableMealTypes(json)` (`:537-545`) so re-import replaces correctly. Note: `RecipesService.create` does not run the classifier (D3).

## Checked and FINE

- All 131 ingredients used in full-v2 exist in `ingredients-*.txt` (import cannot fail on names) and in `ingredient-nutrition-pl-v1.json` (0 ingredients without macros, 0 `szt` without `gramsPerPiece`); stored vs recomputed kcal drift <10 % for 89/89.
- Nutrition table: 135 entries, all keys normalized, no duplicates, all present in txt; `gramsPerPiece` only on the 5 `szt` entries; 11 `ml` entries are all liquids; no g↔ml cross-use in recipes.
- full-v2: no duplicate titles (raw or normalized), no duplicate/missing ids, 89 UUIDs, `recipes-approved-30-image-ids.txt` ⊂ full-v2 ids, all `imageUrl` = R2 `.../recipe-images/<id>.png`; only 1 cookidoo recipe (`Leczo…`, r56899) carries `sourceProvider` (report's "2" was wrong).
- Department strings: `CATEGORY_BY_FILE` (17) == `ShoppingDepartment` values (17) == iOS `ProductConstants.Department` (17), byte-identical; every label round-trips through `mapDepartmentLabel` to itself (rule order checked).
- Units in catalog (`g/ml/szt/łyżeczka/szczypta`) ⊂ `ALLOWED_UNITS`; spoon units only on `Przyprawy i sosy` ingredients (0 normalize errors).
- Other batch JSONs (12 files): all ingredient names resolve to txt and nutrition; no names with double/edge spaces; no recipe lists an ingredient twice.
- RETITLE guard (`:508-520`) correctly aborts on id↔title mismatch; `awokado` is in `Owoce` and backend keyword rule agrees (iOS map says Warzywa but that map only serves manual products).
