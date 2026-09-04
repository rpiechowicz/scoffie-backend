# Implementation Spec — WP: kill the diverged normalizer copy in `RecipesService` + compute nutrition on create

**Audit refs:** `catalog-data.md` D3 (P1, FIX-BEFORE-PHASE-0), `tests-ci.md` T3 (P0). **Scope:** backend only. **No iOS work** — verified: `grep -rn "recipes:create|createRecipe" --include=*.swift` over `/Users/rafi/Desktop/Scoffie App/scoffie-ios` returns **0 hits**; the only WS recipe calls from iOS are `recipes:findAll` / `findById` / `setFavorite` (`scoffie-ios/Scoffie/Networking/Recipes/WebSocketRecipeTransportClient.swift`). `RecipesService.create` currently has **no client at all**; its only future caller is the AI-agent path. That fact drives decision D-3 below.

**Current-state deltas vs. the audit text (Plaster A already landed — I read the files):**

- `prisma/schema.prisma:459` now has `@@unique([recipeId, ingredientId])` on `RecipeIngredient` → duplicate `ingredientId` in a create DTO is now a **P2002 → 500**, not a silent duplicate row. New guard needed (§5.1).
- `scripts/import-recipes-from-json.ts` is id-based, `RECIPE_IMPORT_FILE` required, servings 1..8, `CLEAR_EXISTING` scoped. Line numbers moved: `normalizeIngredientAmount` call is now at `:358-363`, `resolveSuitableMealTypes` at `:422-430`, unit gate at `:224`.
- `canonicalizeIngredientName` is **gone** from `src/weekly-plans/utils/department-classifier.util.ts` (0 hits repo-wide) — shopping list uses verbatim names. Irrelevant to this WP except that `normalizeText` in `text-normalization.util.ts` now has only 2 consumers (`department-classifier.util.ts:3`, `shopping-items.util.ts:7`).
- `RecipesService` has **no `update` method**. `src/recipes/recipes.service.ts:573` is the _only_ `prisma.recipe.create` in `src/` (grep `recipe.create|recipe.update|recipeIngredient.create` over `src` → 1 hit). Nothing to fix on an update path; §9 lists it as a follow-up when the agent gets `recipes:update`.
- `scripts/recompute-recipe-nutrition.ts:240-267` **reads** `ri."normalizedAmount"` from the DB and never rewrites it — T3's suspicion confirmed. Recompute alone does **not** repair a bad `normalizedAmount`; §7 gives the SQL that must run first.

---

## 0. Decisions (make these explicit in the commit message)

| #       | Decision                                                                                                                                                                                                                                                                                                       | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-1** | Canonical `normalizeText` = the **whitespace-collapsing** variant (`prisma/seed.ts:5-21` / `scripts/load-ingredient-catalog.ts:27-43`), moved to `src/common/normalize-text.util.ts`.                                                                                                                          | `Ingredient.normalizedName` is _written_ by the collapsing copy (`load-ingredient-catalog.ts:68`) and _read_ by the non-collapsing copy (`import-recipes-from-json.ts:352`, `recompute-recipe-nutrition.ts:110`). Today they agree only because no catalog name has a double space (audit D11). Picking the collapsing variant makes writer == reader. The non-collapsing copies are used on units, categories and names only — collapsing is a strict superset, no persisted key changes (`normalizeProductKey` does **not** call `normalizeText`; it does its own `trim().toLowerCase()`, `text-normalization.util.ts:3-5`).                                                                                                                                                                                                                                                                                                                                |
| **D-2** | `src/recipes/ingredient-amount.util.ts` and `src/weekly-plans/utils/text-normalization.util.ts` **re-export** the common one instead of being deleted.                                                                                                                                                         | `scripts/import-recipes-from-json.ts:9` and `scripts/recompute-recipe-nutrition.ts:21` import `normalizeText` from `../src/recipes/ingredient-amount.util`; `scripts/**` is outside `tsconfig.json:26` include and outside the lint glob (T7), so a broken import there fails only at runtime in prod. Re-export = zero script churn, zero runtime risk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **D-3** | **The server always computes nutrition when the recipe has ingredients; client-sent `nutrition*` are ignored (except `nutritionSalt`).** Fallback to `data.nutrition* ?? 0` only when `ingredients` is empty/absent. Missing per-100 data or missing `gramsPerPiece` → **reject**, do not store a partial sum. | (a) There is no client today, so "client values win" protects nobody. (b) The future AI-agent path is exactly the case where a model-typed 520 kcal must not become truth — audit D3: _"nutrition is whatever the model typed (or 0), which the validator then trusts."_ (c) Cookidoo/Thermomix recipes with `sourceNutrition` never come through this path — they arrive via `scripts/import-recipes-from-json.ts` (only 1 cookidoo recipe in the catalog, `Leczo…`/r56899), and `Recipe.sourceNutrition` has **0 writers in `src/`** (grep: only `src/recipes/dto/recipe.dto.ts:89` reads it). If a provider-import path is later added to the service, it gets its own method with `sourceNutrition` as the trusted source — not a client-trust switch on `create`. (d) `nutritionSalt` stays client-supplied: `Ingredient` has no sodium-per-100 column (`schema.prisma:184-191`) and `recompute-recipe-nutrition.ts:217` deliberately leaves salt alone. |
| **D-4** | Rounding for storage: `Math.round` on all five totals, extracted into **one** exported helper `roundTotalsForStorage` in `recipe-nutrition.util.ts`, used by both the service and `scripts/recompute-recipe-nutrition.ts`.                                                                                     | If `create` used `roundTotals` (`recipe-nutrition.util.ts:127-137`, 1 decimal on macros) and the recompute script used `forStorage` (`recompute-recipe-nutrition.ts:71-74`, integer), running recompute after create would move every macro — the same divergence class as D3, one layer up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **D-5** | `resolveSuitableMealTypes` on create, fed with the **computed** total kcal, replacing the hand-rolled union at `recipes.service.ts:581-586`.                                                                                                                                                                   | `effectiveSuitableMealTypes` (`src/common/meal-types.ts:69-77`) always `set.add(recipe.mealType)`, so the base-slot guarantee the current block provides is preserved exactly; the classifier only adds. Matches the importer (`import-recipes-from-json.ts:422-430`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

---

## 1. New file: `src/common/normalize-text.util.ts`

Create with exactly this body (the `\u0300-\u036f` **escape** form, not the literal combining-mark form used in `text-normalization.util.ts:13` — that file stores raw combining marks in source, which is encoding-fragile):

```ts
/**
 * Jedna definicja normalizacji tekstu dla całego repo.
 *
 * Kopie tej funkcji żyły w pięciu miejscach i już się rozjechały o
 * `\s+` (loader katalogu zwijał białe znaki, czytelnicy nie), przez co
 * `Ingredient.normalizedName` mógł być zapisany innym kluczem niż ten,
 * którym import go szuka. Zwijanie zostaje — to wariant nadrzędny.
 */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ł]/g, 'l')
    .replace(/[ą]/g, 'a')
    .replace(/[ć]/g, 'c')
    .replace(/[ę]/g, 'e')
    .replace(/[ń]/g, 'n')
    .replace(/[ó]/g, 'o')
    .replace(/[ś]/g, 's')
    .replace(/[ź]/g, 'z')
    .replace(/[ż]/g, 'z')
    .trim()
    .replace(/\s+/g, ' ');
}
```

### 1.1 Every copy — enumerated (grep `function normalizeText` = 5 definitions)

| File                                                | Current lines                                  | Action                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/recipes/ingredient-amount.util.ts`             | `63-78` (`export function normalizeText`)      | Delete body. Add at top, after the doc block: `import { normalizeText } from '../common/normalize-text.util';` and, on its own line, `export { normalizeText };` (value re-export — legal under `tsconfig.json:7 isolatedModules: true`). Internal call sites `:86, :107, :116` unchanged. |
| `src/weekly-plans/utils/text-normalization.util.ts` | `7-24` (doc + `export function normalizeText`) | Replace with `export { normalizeText } from '../../common/normalize-text.util';`. Consumers unchanged: `department-classifier.util.ts:3`, `shopping-items.util.ts:7`. `shopping-list.service.ts:13-16` imports only `normalizeProductKey`/`toTitleCase` — untouched.                       |
| `src/recipes/recipes.service.ts`                    | `218-233` (`private normalizeText`)            | **Delete** (see §2).                                                                                                                                                                                                                                                                       |
| `prisma/seed.ts`                                    | `5-21`                                         | Delete; add `import { normalizeText } from '../src/common/normalize-text.util';` after line 1. Call sites `:171, :179` unchanged. Runs under `tsx prisma/seed.ts` (`package.json` `prisma:seed`), which resolves `../src/**` fine — same pattern as the scripts.                           |
| `scripts/load-ingredient-catalog.ts`                | `27-43`                                        | Delete; add `import { normalizeText } from '../src/common/normalize-text.util';`. Call site `:68`.                                                                                                                                                                                         |
| `scripts/normalize-ingredients-polish.ts`           | `135-151`                                      | **5th copy, not in the audit list** — delete; same import. Call sites `:163, :183, :188`. This one writes `Ingredient.normalizedName` / `IngredientAlias.normalizedAlias`, so leaving it behind would re-open exactly the writer/reader split D-1 closes.                                  |

**Behaviour delta:** only for inputs containing `\t`, `\n`, or runs of ≥2 spaces. Audit D11 computed: no such name exists in `prisma/catalog/*` today, and no persisted key is derived from a non-collapsing `normalizeText`. **No data migration.**

---

## 2. `RecipesService` — delete the private normalizer, import the util

**File:** `/Users/rafi/Desktop/Scoffie App/scoffie-backend/src/recipes/recipes.service.ts`

### 2.1 Deletions (exact block boundaries)

**(a) lines 64-67** — the local type shadowing the util's:

```
64	type NormalizedIngredient = {
65	  normalizedAmount: number;
66	  normalizedUnit: 'g' | 'ml' | 'szt';
67	};
```

Delete (only reference is `:240`, deleted below).

**(b) lines 105-141** — the three diverged static tables. Boundaries:

```
105	  private static readonly LIQUID_SPOON_UNITS_IN_ML: Record<
...
131	    'cukier brazowy': 4,
132	  };
133	  private static readonly LIQUID_CONDIMENTS = new Set<string>([
...
140	    'sos sojowy',
141	  ]);
```

Delete all of 105-141. **This is the divergence**: `SPICE_GRAMS_PER_TEASPOON_BY_NAME` here ends at `'cukier brazowy': 4` and lacks `'przyprawa uniwersalna': 4`, present in `ingredient-amount.util.ts:51`. Confirmed 1 łyżeczka _przyprawa uniwersalna_ → **4 g** via scripts, **2.5 g** (the `?? 2.5` default at `:282`) via `recipes:create`.

**(c) lines 218-287** — `private normalizeText` + `private normalizeIngredientAmount`. Boundaries:

```
218	  private normalizeText(value: string): string {
...
233	  }
234
235	  private normalizeIngredientAmount(
...
286	    };
287	  }
```

Delete all of 218-287.

### 2.2 Import edits

- Line `2`: remove `BadRequestException,` from the `@nestjs/common` import — after (c) it has **0 remaining uses** (grep confirmed: only `:263`). Add `HttpStatus` (needed by `AppException`).
- Line `10`: remove `MEAL_TYPES_IN_DAY_ORDER,` from the `../common/meal-types` import — after §4 it has 0 remaining uses (grep: only `:581`). Keep `effectiveSuitableMealTypes` (`:499, :534`) and `isMealType` (`:407`).
- Add:

```ts
import { AppException } from '../common/app-exception';
import {
  ALLOWED_UNITS,
  normalizeIngredientAmount,
  normalizeText,
} from './ingredient-amount.util';
import {
  computeRecipeNutrition,
  roundTotalsForStorage,
  type IngredientNutritionPer100,
  type NutritionInputItem,
} from './recipe-nutrition.util';
import { resolveSuitableMealTypes } from './suitable-meal-types.util';
```

### 2.3 Error translation

`normalizeIngredientAmount` throws a plain `Error` (`ingredient-amount.util.ts:109-112`) with the ingredient name already in the message:
`Unit "${unit}" is allowed only for category "Przyprawy i sosy" (ingredient: ${ingredientName})`.

A plain `Error` escaping the service becomes `{ ok:false, code:'INTERNAL_ERROR', status:500 }` in `wsRespond` (`src/common/ws-response.ts:70-71`) — wrong class of error for a client mistake. Wrap it (§3.2 `resolveRecipeIngredients`). Do **not** change the util's throw type: `scripts/import-recipes-from-json.ts` and `recompute-recipe-nutrition.ts` rely on a plain `Error` aborting the script, and `src/common/app-exception` must not become a script dependency.

---

## 3. New private helpers + rewritten `create()`

### 3.1 `recipe-nutrition.util.ts` — add the shared storage rounding (D-4)

Append after `roundTotals` (current file ends at `:137`):

```ts
/**
 * Zaokrąglenie do zapisu w bazie i w plikach katalogu: gramy do liczby
 * całkowitej — dokładniej niż źródło i tak nie jest. Jedna definicja dla
 * serwisu i dla `scripts/recompute-recipe-nutrition.ts`, żeby przeliczenie
 * po utworzeniu przepisu nie ruszało żadnej wartości.
 */
export function roundTotalsForStorage(
  totals: RecipeNutritionTotals,
): RecipeNutritionTotals {
  return {
    kcal: Math.round(totals.kcal),
    protein: Math.round(totals.protein),
    carbs: Math.round(totals.carbs),
    fat: Math.round(totals.fat),
    fiber: Math.round(totals.fiber),
  };
}
```

Then in `scripts/recompute-recipe-nutrition.ts`: delete `forStorage` (`:71-74`) and replace its 10 call sites (`:212-216` object literal, `:317-321` object literal) with one `roundTotalsForStorage(totals)` spread each. Import it at `:23-27`. Salt handling at `:217` unchanged.

### 3.2 New private method `resolveRecipeIngredients`

Insert into `RecipesService` (suggested position: right after `ensureMembership`, i.e. where the deleted block used to start, ~line 218):

```ts
/** Wiersz `RecipeIngredient` gotowy do zapisu + makra źródła do policzenia sumy. */
private type-free shape:
  {
    ingredientId, name, amount, unit,
    normalizedAmount, normalizedUnit, department,
    nutrition: IngredientNutritionPer100 | null,
  }
```

Behaviour, in order:

1. `if (!items?.length) return [];`
2. **Unit gate** (new — WS payloads are never class-validated; documented at `weekly-plans.service.ts:688-696`): for each item, `if (!ALLOWED_UNITS.has(item.unit))` → `throw new AppException('VALIDATION_ERROR', \`Unit "${item.unit}" is not supported (ingredient index ${i}).\`, HttpStatus.BAD_REQUEST)`. Use the **raw** unit against `ALLOWED_UNITS`, exactly like `import-recipes-from-json.ts:224`(the set holds both`'łyżeczka'`and`'lyzeczka'`, `ingredient-amount.util.ts:14-25`). *Why this is not optional:* without it, `unit: 'garść'`on a`Przyprawy i sosy`ingredient falls straight through`normalizeIngredientAmount`'s g/kg/ml/l/szt ladder, passes the category gate, gets `spoonFactor = 1`and`gramsPerTeaspoon = 2.5` (`:115, :124`) and returns **silent garbage grams**. For any other category it throws the misleading "allowed only for Przyprawy i sosy".
3. **Amount gate** (new, same reason): `if (!(Number.isFinite(item.amount) && item.amount > 0))` → `VALIDATION_ERROR` (mirrors `import-recipes-from-json.ts:219-223`).
4. **Duplicate gate** (new, required by `schema.prisma:459`): build the id list; if `new Set(ids).size !== ids.length` → `throw new AppException('VALIDATION_ERROR', \`Duplicate ingredientId in recipe payload: ${dupes.join(', ')}\`, HttpStatus.BAD_REQUEST)`. Today the existing code at `:549-551`de-dupes into`uniqueIds`for the lookup and then emits one`create` row per DTO item (`:601`), so two identical ids reach Postgres and hit the composite unique → `PrismaClientKnownRequestError P2002`→ not an`HttpException`→`INTERNAL_ERROR / 500` (`ws-response.ts:70-71`).
5. `prisma.ingredient.findMany` — replace the select at `:557-561`:

```
557	        select: {
558	          id: true,
559	          name: true,
560	          category: true,
561	        },
```

with

```ts
        select: {
          id: true,
          name: true,
          category: true,
          nutritionKcalPer100: true,
          nutritionProteinPer100: true,
          nutritionCarbsPer100: true,
          nutritionFatPer100: true,
          nutritionFiberPer100: true,
          gramsPerPiece: true,
        },
```

Keep the `isActive: true` filter (`:555`) and the `NotFoundException` at `:566-570`. 6. For each DTO item: `normalizeIngredientAmount(ingredient.name, ingredient.category, item.amount, item.unit)` inside `try/catch (error) { throw new AppException('VALIDATION_ERROR', error instanceof Error ? error.message : 'Cannot normalize ingredient amount', HttpStatus.BAD_REQUEST); }`. 7. Map to the row, `normalizedAmount: Number(normalized.normalizedAmount.toFixed(4))` (identical to `import-recipes-from-json.ts:370` and to the current `:614-616`), `department: ingredient.category`, plus:

```ts
        nutrition:
          ingredient.nutritionKcalPer100 === null
            ? null
            : {
                kcal: ingredient.nutritionKcalPer100,
                protein: ingredient.nutritionProteinPer100 ?? 0,
                carbs: ingredient.nutritionCarbsPer100 ?? 0,
                fat: ingredient.nutritionFatPer100 ?? 0,
                fiber: ingredient.nutritionFiberPer100 ?? 0,
                gramsPerPiece: ingredient.gramsPerPiece,
              },
```

The `kcalPer100 === null ⇒ null` rule is byte-for-byte the reference behaviour in `recompute-recipe-nutrition.ts:285-295`.

### 3.3 New private method `resolveRecipeNutrition`

```ts
/**
 * Makra liczy serwer, nie klient (D-3).
 *
 * Wartości przysłane w DTO są ignorowane, gdy przepis ma składniki: jedyny
 * przyszły wołający tej metody to agent, a jego liczby są dokładnie tym,
 * czego walidator nie może brać na wiarę. `nutritionSalt` zostaje z DTO —
 * `Ingredient` nie ma sodu na 100 g, więc nie ma z czego go policzyć
 * (patrz `recompute-recipe-nutrition.ts:217`).
 */
```

- `rows.length === 0` → return `{ nutritionKcal: data.nutritionKcal ?? 0, ... , nutritionSalt: data.nutritionSalt ?? 0 }` (today's behaviour at `:591-596`, preserved for the ingredient-less case only).
- else: `const { totals, missingNutrition, missingPieceWeight } = computeRecipeNutrition(rows)` (rows already satisfy `NutritionInputItem`: `name`, `normalizedAmount`, `normalizedUnit`, `nutrition`).
- `if (missingNutrition.length || missingPieceWeight.length)`:

```ts
throw new AppException(
  'VALIDATION_ERROR',
  'Cannot compute recipe nutrition from ingredients.',
  HttpStatus.BAD_REQUEST,
  { missingNutrition, missingPieceWeight },
);
```

(`AppException` already carries `details`, `app-exception.ts:9`; `wsRespond` surfaces `code` + `message` — the names land in server logs and in the agent's tool error.)

- else: `const stored = roundTotalsForStorage(totals);` → `{ nutritionKcal: stored.kcal, nutritionProtein: stored.protein, nutritionFat: stored.fat, nutritionCarbs: stored.carbs, nutritionFiber: stored.fiber, nutritionSalt: data.nutritionSalt ?? 0 }`.

### 3.4 Rewritten `create()` (replaces current `:540-632`)

```ts
  async create(userIdentifier: string, data: CreateRecipeDto) {
    const userId = await this.resolveUserId(userIdentifier);
    await this.ensureMembership(userIdentifier, data.householdId);

    const ingredientRows = await this.resolveRecipeIngredients(data.ingredients);
    const nutrition = this.resolveRecipeNutrition(data, ingredientRows);

    const created = await this.prisma.recipe.create({
      data: {
        title: data.title,
        description: data.description,
        mealType: data.mealType,
        // Ta sama reguła co w imporcie: JSON/klient może podać sloty wprost,
        // resztę dokłada klasyfikator. Slot bazowy wchodzi zawsze —
        // `effectiveSuitableMealTypes` go dopisuje.
        suitableMealTypes: resolveSuitableMealTypes({
          title: data.title,
          description: data.description,
          mealType: data.mealType,
          prepTimeMinutes: data.prepTimeMinutes,
          servings: data.servings,
          nutritionKcal: nutrition.nutritionKcal,
          suitableMealTypes: data.suitableMealTypes,
        }),
        difficulty: data.difficulty,
        prepTimeMinutes: data.prepTimeMinutes,
        servings: data.servings,
        imageUrl: data.imageUrl,
        ...nutrition,
        householdId: data.householdId,
        authorId: userId,
        ingredients: ingredientRows.length
          ? {
              create: ingredientRows.map(
                ({ nutrition: _ignored, ...row }) => row,
              ),
            }
          : undefined,
      },
      include: {
        ingredients: { orderBy: { createdAt: 'asc' } },
      },
    });
    this.recipesCache.invalidateRecipesList();
    return created;
  }
```

Key ordering property: **all validation happens before `prisma.recipe.create`**. Today the `.map()` with the throwing normalizer is inlined into the `create({ data })` argument (`:601-620`), so it throws while building args — accidentally correct, but it also means a normalizer failure and a nutrition failure can't be reported together. Hoisting makes it explicit.

`this.recipesCache.invalidateRecipesList()` (`:630`) stays and must stay: `findAll` caches under the `userId:'global'` key (`:445-451, :457-463`) with a 90 s TTL (`recipes-cache.service.ts:16-19`), so a new recipe is invisible for up to 90 s without it.

---

## 4. `suitableMealTypes` on create

Deleted by §3.4. For the record, the block being replaced:

```
581	        suitableMealTypes: MEAL_TYPES_IN_DAY_ORDER.filter((type) =>
582	          new Set<MealType>([
583	            data.mealType,
584	            ...(data.suitableMealTypes ?? []),
585	          ]).has(type),
586	        ),
```

`resolveSuitableMealTypes` (`suitable-meal-types.util.ts:324-330`) = `effectiveSuitableMealTypes(input)` ∪ `suggestExtraMealTypes(input)`, re-sorted by `MEAL_TYPES_IN_DAY_ORDER`. Since `effectiveSuitableMealTypes` unconditionally `set.add(recipe.mealType)` (`meal-types.ts:75`), the base-slot invariant of the old code is preserved; the only change is the classifier's additions. Thresholds are **per serving** (`suitable-meal-types.util.ts:277-280`) and read `nutritionKcal` — hence it must run _after_ nutrition is computed, not before.

---

## 5. Also worth pinning while in here

**5.1** `CreateRecipeIngredientDto.unit` (`src/recipes/dto/create-recipe.dto.ts:21-33, :46-48`) hard-codes the same 10 strings as `ALLOWED_UNITS` (`ingredient-amount.util.ts:14-25`). They are identical today. Either derive the DTO list (`const ingredientUnits = [...ALLOWED_UNITS] as const;` — note this loses the literal-union type for `@IsIn`, so prefer keeping the literal) **or** add the parity assertion to the new util spec (§6.1, cheaper, no type churn). Spec below assumes the assertion.

**5.2** No change to `recipes.gateway.ts` — `RecipesCreatePayload` (`:30-33`) already forwards `data: CreateRecipeDto` untouched, and `wsRespond` already maps `AppException` → `{ ok:false, code:'VALIDATION_ERROR', status:400 }` via `extractCode` (`ws-response.ts:38-51, :62-67`).

---

## 6. Tests

Both files are new. Repo pattern to follow: `src/recipes/recipe-nutrition.util.spec.ts` (table-driven pure util) and `src/weekly-plans/weekly-plans.service.spec.ts:92-201` (`makePrismaMock()` of `jest.fn()` delegates + `$transaction` mock calling the callback with the same mock + `Test.createTestingModule({ providers: [Service, { provide: PrismaService, useValue: prisma }] })`).

### 6.1 `src/recipes/ingredient-amount.util.spec.ts` (new)

```ts
import {
  ALLOWED_UNITS,
  normalizeIngredientAmount,
  normalizeText,
} from './ingredient-amount.util';
```

`describe('normalizeIngredientAmount')` — table-driven via `it.each`, columns `[name, category, amount, unit, expectedAmount, expectedUnit]`:

| #   | name                          | category             | amount | unit         | → normalizedAmount | → normalizedUnit              |
| --- | ----------------------------- | -------------------- | ------ | ------------ | ------------------ | ----------------------------- |
| 1   | `'mąka pszenna'`              | `'Zboża i makarony'` | 300    | `'g'`        | 300                | `'g'`                         |
| 2   | `'mąka pszenna'`              | `'Zboża i makarony'` | 1.5    | `'kg'`       | 1500               | `'g'`                         |
| 3   | `'mleko'`                     | `'Nabiał'`           | 250    | `'ml'`       | 250                | `'ml'`                        |
| 4   | `'mleko'`                     | `'Nabiał'`           | 2      | `'l'`        | 2000               | `'ml'`                        |
| 5   | `'jajko'`                     | `'Nabiał'`           | 3      | `'szt'`      | 3                  | `'szt'`                       |
| 6   | `'sól'`                       | `'Przyprawy i sosy'` | 1      | `'łyżeczka'` | 6                  | `'g'`                         |
| 7   | `'sól'`                       | `'Przyprawy i sosy'` | 1      | `'łyżka'`    | 18                 | `'g'` (6 × 3)                 |
| 8   | `'sól'`                       | `'Przyprawy i sosy'` | 1      | `'szczypta'` | 0.375              | `'g'` (6 / 16)                |
| 9   | `'sól'`                       | `'Przyprawy i sosy'` | 2      | `'lyzeczka'` | 12                 | `'g'` (ASCII alias)           |
| 10  | **`'przyprawa uniwersalna'`** | `'Przyprawy i sosy'` | 1      | `'łyżeczka'` | **4**              | `'g'`                         |
| 11  | `'ketchup'`                   | `'Przyprawy i sosy'` | 1      | `'łyżka'`    | 15                 | `'ml'`                        |
| 12  | `'sos sojowy'`                | `'Przyprawy i sosy'` | 1      | `'łyżeczka'` | 5                  | `'ml'`                        |
| 13  | `'musztarda'`                 | `'Przyprawy i sosy'` | 1      | `'szczypta'` | 0.5                | `'ml'`                        |
| 14  | `'zioła prowansalskie'`       | `'Przyprawy i sosy'` | 1      | `'łyżeczka'` | 2.5                | `'g'` (unknown-spice default) |
| 15  | `'zioła prowansalskie'`       | `'Przyprawy i sosy'` | 1      | `'łyżka'`    | 7.5                | `'g'` (default × 3)           |

Use `toBeCloseTo(expected, 4)` for rows 8/13/14/15 (float).

**Row 10 is the regression test for D3/T3** — add the comment `// D3: ta pozycja żyła tylko w utilu; kopia w RecipesService dawała 2.5 g.`

`describe('category gate')`:

- `it('odrzuca łyżeczkę poza kategorią "Przyprawy i sosy"')` → `expect(() => normalizeIngredientAmount('mleko', 'Nabiał', 1, 'łyżeczka')).toThrow(/only for category "Przyprawy i sosy"/)`; also assert the ingredient name is in the message: `.toThrow(/mleko/)`.
- `it('nie bramkuje g/ml/szt/kg/l')` → the five base units for `'Nabiał'` must not throw.
- `it('rozpoznaje kategorię po diakrytykach')` → `'PRZYPRAWY I SOSY'` and `'Przyprawy i sosy '` both pass (proves the `normalizeText(category)` path at `:107`).

`describe('normalizeText')` (new canonical behaviour, D-1):

- `normalizeText('Mąka Pszenna')` → `'maka pszenna'`
- `normalizeText('  Sól   morska \n')` → `'sol morska'` ← **collapsing assertion; this fails today**
- `normalizeText('Łyżeczka')` → `'lyzeczka'`
- `normalizeText('Żurek żółty')` → `'zurek zolty'`

`describe('ALLOWED_UNITS')`:

- `it('pokrywa się z listą jednostek w CreateRecipeIngredientDto')` — import nothing from the DTO (it pulls `@nestjs/swagger`); instead assert the literal set: `expect([...ALLOWED_UNITS].sort()).toEqual(['g','kg','l','lyzeczka','lyzka','ml','szczypta','szt','ł+yżeczka','łyżka'].sort())` with the real Polish strings, and add a comment pointing at `dto/create-recipe.dto.ts:21-33` as the twin that must be edited together.

### 6.2 `src/recipes/recipes.service.spec.ts` (new)

Mock shape (copy `weekly-plans.service.spec.ts:92-182` structure):

```ts
const mockUserId = 'user-1';
const mockHouseholdId = 'hh-1';

const oats = {
  id: 'ing-oats', name: 'płatki owsiane', category: 'Zboża i makarony',
  nutritionKcalPer100: 379, nutritionProteinPer100: 13.2,
  nutritionCarbsPer100: 57.6, nutritionFatPer100: 6.9,
  nutritionFiberPer100: 10.1, gramsPerPiece: null,
};
const milk = {
  id: 'ing-milk', name: 'mleko', category: 'Nabiał',
  nutritionKcalPer100: 61, nutritionProteinPer100: 3.3,
  nutritionCarbsPer100: 4.7, nutritionFatPer100: 3.3,
  nutritionFiberPer100: 0, gramsPerPiece: null,
};
const banana = { ...same shape..., id: 'ing-banana', name: 'banan',
  nutritionKcalPer100: 89, ..., gramsPerPiece: 120 };
const bananaNoPiece = { ...banana, id: 'ing-banana-np', gramsPerPiece: null };
const spice = { id: 'ing-spice', name: 'przyprawa uniwersalna',
  category: 'Przyprawy i sosy', nutritionKcalPer100: 0, ...zeros,
  gramsPerPiece: null };
const noMacros = { id: 'ing-x', name: 'tajemniczy proszek', category: 'Inne',
  nutritionKcalPer100: null, ...nulls, gramsPerPiece: null };

const makePrismaMock = (ingredients: any[]) => {
  const mock: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: mockUserId }) },
    membership: { findUnique: jest.fn().mockResolvedValue({ id: 'mem-1' }) },
    ingredient: { findMany: jest.fn().mockResolvedValue(ingredients) },
    recipe: {
      create: jest.fn().mockImplementation((args: any) =>
        Promise.resolve({ id: 'recipe-1', ...args.data, ingredients: [] })),
    },
    $transaction: jest.fn().mockImplementation((cbOrOps: any) =>
      typeof cbOrOps === 'function' ? cbOrOps(mock) : Promise.all(cbOrOps)),
  };
  return mock;
};
const cache = { invalidateRecipesList: jest.fn(), get: jest.fn(), set: jest.fn(),
  buildRecipesListKey: jest.fn() };
```

Providers: `[RecipesService, { provide: PrismaService, useValue: prisma }, { provide: RecipesCacheService, useValue: cache }]`.
`resolveUserId` hits `user.findUnique` first (`recipes.service.ts:190-194`) → one mock is enough. `ensureMembership` needs `membership.findUnique` non-null (`:210-215`).

Base DTO helper:

```ts
const baseDto = (over = {}) =>
  ({
    title: 'Owsianka z bananem',
    description: 'Płatki na mleku',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    householdId: mockHouseholdId,
    ...over,
  }) as any;
```

`describe('RecipesService.create')`:

1. **`it('liczy makra ze składników i ignoruje wartości z DTO')`**
   Ingredients `[{ingredientId:'ing-oats',amount:100,unit:'g'},{ingredientId:'ing-milk',amount:300,unit:'ml'}]`, DTO also sends `nutritionKcal: 9999, nutritionProtein: 1`.
   Expected on `prisma.recipe.create.mock.calls[0][0].data`:
   `nutritionKcal: 562` (379 + 3×61 = 562), `nutritionProtein: 23` (13.2 + 9.9 = 23.1 → 23), `nutritionCarbs: 72` (57.6 + 14.1 = 71.7 → 72), `nutritionFat: 17` (6.9 + 9.9 = 16.8 → 17), `nutritionFiber: 10` (10.1 → 10). `nutritionSalt: 0`.

2. **`it('przelicza sztuki przez gramsPerPiece')`**
   `[{ingredientId:'ing-banana',amount:2,unit:'szt'}]` → `nutritionKcal: 214` (2 × 120 g = 240 g; 89 × 2.4 = 213.6 → 214).

3. **`it('odrzuca przepis ze składnikiem bez makr')`**
   `[{ingredientId:'ing-x',amount:50,unit:'g'}]` → `await expect(service.create(...)).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR', details: { missingNutrition: ['tajemniczy proszek'] } } })` and `expect(prisma.recipe.create).not.toHaveBeenCalled()`.

4. **`it('odrzuca sztuki bez gramsPerPiece')`**
   `[{ingredientId:'ing-banana-np',amount:2,unit:'szt'}]` → `details.missingPieceWeight === ['banan']`, `recipe.create` not called.

5. **`it('normalizuje łyżeczkę przyprawy tak samo jak import')`** ← D3 regression at the service level
   ingredients `[{ingredientId:'ing-spice',amount:1,unit:'łyżeczka'}]` →
   `data.ingredients.create[0]` = `{ normalizedAmount: 4, normalizedUnit: 'g', department: 'Przyprawy i sosy', name: 'przyprawa uniwersalna', ingredientId: 'ing-spice', amount: 1, unit: 'łyżeczka' }`.
   Comment: _fails on the pre-fix code with 2.5._

6. **`it('uzupełnia suitableMealTypes klasyfikatorem')`**
   Same ingredients as case 1 (562 kcal / 2 servings = 281 kcal/porcja, prep 10 min, title "Owsianka z bananem", no `suitableMealTypes` in DTO) →
   `data.suitableMealTypes` **exactly** `['BREAKFAST','SECOND_BREAKFAST','AFTERNOON_SNACK','SNACK']`.
   Derivation (`suitable-meal-types.util.ts:222-248, 296-315`): no `DISQUALIFIER_MARKERS` hit; SECOND_BREAKFAST ≤480 kcal & ≤20 min & `'owsiank'` ∈ `PORTABLE_MARKERS`; AFTERNOON_SNACK ≤420 & ≤25 & `'owsiank'/'banan'` ∈ `SWEET_MARKERS`, no `SAVORY_MARKERS` in title/description; SNACK ≤350 & ≤15 & markers hit.
   Second case: DTO with `suitableMealTypes: ['LUNCH']` → result contains `BREAKFAST` and `LUNCH`, in day order.

7. **`it('unieważnia cache listy przepisów')`** → `expect(cache.invalidateRecipesList).toHaveBeenCalledTimes(1)`; and on a rejected create (case 3) → `not.toHaveBeenCalled()`.

8. **`it('odrzuca zduplikowany ingredientId')`**
   `[{ingredientId:'ing-oats',amount:100,unit:'g'},{ingredientId:'ing-oats',amount:50,unit:'g'}]` → `VALIDATION_ERROR`, message contains `ing-oats`, `recipe.create` not called. _(Guards `schema.prisma:459`.)_

9. **`it('odrzuca nieznaną jednostkę')`**
   `[{ingredientId:'ing-spice',amount:1,unit:'garść'}]` → `VALIDATION_ERROR` mentioning `garść`; `ingredient.findMany` may or may not have been called, but `recipe.create` must not be.

10. **`it('tłumaczy błąd bramki kategorii na VALIDATION_ERROR')`**
    `[{ingredientId:'ing-milk',amount:1,unit:'łyżeczka'}]` → rejects with `response.code === 'VALIDATION_ERROR'`, `response.message` matching `/mleko/` and `/Przyprawy i sosy/`, HTTP status 400 (`err.getStatus()`).

11. **`it('bez składników zostawia makra z DTO')`**
    DTO without `ingredients`, `nutritionKcal: 520` → `data.nutritionKcal === 520`, `data.ingredients === undefined`, `ingredient.findMany` not called. _(Pins the D-3 fallback so a later refactor does not turn "no ingredients" into a rejection.)_

12. **`it('odrzuca nie-członka gospodarstwa')`** — `membership.findUnique → null` → `ForbiddenException`, `recipe.create` not called. (Cheap regression on the ordering: membership is checked before any ingredient work.)

### 6.3 Existing specs

None assert on `RecipesService.create` (no `recipes.service.spec.ts` exists). `recipe-nutrition.util.spec.ts` is unaffected by the additive `roundTotalsForStorage`; optionally add one case there: `roundTotalsForStorage({kcal:562.4,protein:23.1,carbs:71.7,fat:16.8,fiber:10.1})` → `{kcal:562,protein:23,carbs:72,fat:17,fiber:10}`.

---

## 7. Data: migrations, SQL, rollback

**No schema migration.** No Prisma model changes; `roundTotalsForStorage` and the normalizer moves are code-only.

### 7.1 Blast radius on existing rows

Only rows written by `RecipesService.create` with a **spoon/pinch unit on an ingredient whose grams-per-teaspoon differs between the two tables** are wrong. Today the tables differ by exactly one entry — `'przyprawa uniwersalna': 4` (`ingredient-amount.util.ts:51`) missing from the service copy → service wrote `amount × 2.5 × spoonFactor`.

**Step 1 — is there anything to fix?** (import bot user id `11111111-1111-4111-8111-111111111111`, `import-recipes-from-json.ts:66-68`):

```sql
SELECT r.id, r.title, r."authorId", r."householdId", r."createdAt",
       r."nutritionKcal", count(ri.id) AS ingredient_count
FROM "Recipe" r
LEFT JOIN "RecipeIngredient" ri ON ri."recipeId" = r.id
WHERE r."authorId" <> '11111111-1111-4111-8111-111111111111'
GROUP BY r.id
ORDER BY r."createdAt";
```

If this returns 0 rows, **skip 7.2–7.4 entirely** and note it in the PR. (Expected on prod: the recipe list is global and iOS has no create UI, so the realistic count is 0.)

**Step 2 — the actually-wrong normalizedAmount rows:**

```sql
SELECT ri.id, ri."recipeId", r.title, ri.name, ri.amount, ri.unit,
       ri."normalizedAmount", ri."normalizedUnit"
FROM "RecipeIngredient" ri
JOIN "Recipe" r      ON r.id = ri."recipeId"
JOIN "Ingredient" i  ON i.id = ri."ingredientId"
WHERE r."authorId" <> '11111111-1111-4111-8111-111111111111'
  AND lower(ri.unit) IN ('łyżeczka','łyżka','szczypta','lyzeczka','lyzka')
ORDER BY r.title;
```

**Step 3 — the precise divergence (the only one today):**

```sql
SELECT ri.id, ri.name, ri.amount, ri.unit, ri."normalizedAmount",
       ri.amount * 4 * CASE lower(ri.unit)
         WHEN 'łyżka' THEN 3 WHEN 'lyzka' THEN 3
         WHEN 'szczypta' THEN 1.0/16 ELSE 1 END AS expected
FROM "RecipeIngredient" ri
JOIN "Ingredient" i ON i.id = ri."ingredientId"
WHERE i."normalizedName" = 'przyprawa uniwersalna'
  AND lower(ri.unit) IN ('łyżeczka','łyżka','szczypta','lyzeczka','lyzka')
  AND ri."normalizedAmount" IS DISTINCT FROM round((ri.amount * 4 * CASE lower(ri.unit)
        WHEN 'łyżka' THEN 3 WHEN 'lyzka' THEN 3
        WHEN 'szczypta' THEN 1.0/16 ELSE 1 END)::numeric, 4);
```

### 7.2 Repair — `normalizedAmount` first, nutrition second (order matters)

`scripts/recompute-recipe-nutrition.ts` **reads** `ri."normalizedAmount"` (`:258`) and never rewrites it. Running it on a bad `normalizedAmount` produces confidently-wrong macros. So:

```sql
BEGIN;
CREATE TABLE "RecipeIngredient_backup_d3" AS SELECT * FROM "RecipeIngredient";
UPDATE "RecipeIngredient" ri
SET "normalizedAmount" = round((ri.amount * 4 * CASE lower(ri.unit)
      WHEN 'łyżka' THEN 3 WHEN 'lyzka' THEN 3
      WHEN 'szczypta' THEN 1.0/16 ELSE 1 END)::numeric, 4)
FROM "Ingredient" i
WHERE i.id = ri."ingredientId"
  AND i."normalizedName" = 'przyprawa uniwersalna'
  AND lower(ri.unit) IN ('łyżeczka','łyżka','szczypta','lyzeczka','lyzka');
-- inspect the row count, then:
COMMIT;
```

Then, in the api container: `pnpm recipes:recompute:nutrition -- --db-only` (dry run, read the diff), then `-- --write --db-only`. `--db-only` because the catalog JSONs are not affected by this bug (they were always produced by the util path).

**Rollback:**

```sql
UPDATE "RecipeIngredient" ri
SET "normalizedAmount" = b."normalizedAmount"
FROM "RecipeIngredient_backup_d3" b WHERE b.id = ri.id;
DROP TABLE "RecipeIngredient_backup_d3";
```

Nutrition rollback: re-run `recipes:recompute:nutrition --write --db-only` after the amount rollback (it is idempotent and derives everything). For pre-existing hand-typed `nutritionKcal` on API recipes there is no backup — `pg_dump -t '"Recipe"' -t '"RecipeIngredient"'` before starting if step 7.1 returned any rows.

**Note:** API-created recipes also carry `nutritionKcal: 0` (the `?? 0` at `:591-596`) whenever the client omitted macros. The recompute run above fixes them too, or warns and skips them if any ingredient lacks per-100 data (`recompute-recipe-nutrition.ts:305-311`).

### 7.3 Not a data migration

Changing `normalizeText` to collapse whitespace does not alter any stored `normalizedName`/`normalizedAlias`, because no existing catalog name contains a whitespace run (audit D11, computed over `prisma/catalog/*`). Optional one-off check in the container:

```sql
SELECT id, name, "normalizedName" FROM "Ingredient" WHERE name ~ '\s\s|\t|\n';
```

Expected: 0 rows. If non-zero, run `pnpm catalog:ingredients:normalize:pl` **after** deploying the unified normalizer.

---

## 8. Verification (nothing runs on the developer Mac)

No `tsc`, `jest`, `prisma`, or `pnpm install` locally. The runner image carries full `node_modules` (Dockerfile `:32` copies from the `deps` stage, which ran `pnpm install --frozen-lockfile` before `NODE_ENV=production`), so jest and tsc exist inside `scoffie-api`. `jest.config.js` is **not** in the image (`Dockerfile:33-43`) — copy it.

```bash
cd "/Users/rafi/Desktop/Scoffie App/scoffie-backend"
docker compose up -d api

# sources + jest config into the container (note the trailing /app/ — merges into /app/src)
docker cp ./src            scoffie-api:/app/
docker cp ./scripts        scoffie-api:/app/
docker cp ./prisma         scoffie-api:/app/
docker cp ./jest.config.js scoffie-api:/app/jest.config.js

# unit tests for this WP
docker exec -w /app scoffie-api npx jest src/recipes --runInBand
# full suite (catches collateral from the normalizeText move)
docker exec -w /app scoffie-api npx jest --runInBand

# type check — specs are transpile-only otherwise (T2); this is the only gate that
# catches the deleted `NormalizedIngredient` type / removed imports
docker exec -w /app scoffie-api npx tsc -p tsconfig.json --noEmit

# data steps (only if §7.1 returned rows)
docker exec -w /app scoffie-api npx tsx scripts/recompute-recipe-nutrition.ts --db-only
docker exec -w /app scoffie-api npx tsx scripts/recompute-recipe-nutrition.ts --write --db-only

# SQL from §7 — psql in the db container
docker exec -i scoffie-db psql -U scoffie -d scoffie -c "<query>"
```

Runtime smoke for the changed path (no HTTP DTO validation is applied on WS, so this exercises the new guards too): `pnpm ws:smoke` is a `tsx` script — run it in the container: `docker exec -w /app scoffie-api npx tsx scripts/ws-smoke.ts` (check it covers `recipes:create`; if not, a 15-line ad-hoc socket.io call is enough to confirm `{ok:false, code:'VALIDATION_ERROR', status:400}` on a bad unit).

**iOS: no build required.** Nothing in the Swift target references `recipes:create` (grep = 0). `xcodebuild` is not part of this WP's verification.

---

## 9. Ordered steps with effort

| #     | Step                                                                                                                                                                                                                      | Files                  | Effort                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------- |
| 1     | Create `src/common/normalize-text.util.ts` (D-1 body).                                                                                                                                                                    | 1 new                  | 10 min                                               |
| 2     | Re-point all 5 copies (§1.1): `ingredient-amount.util.ts:63-78`, `text-normalization.util.ts:7-24`, `prisma/seed.ts:5-21`, `scripts/load-ingredient-catalog.ts:27-43`, `scripts/normalize-ingredients-polish.ts:135-151`. | 5                      | 20 min                                               |
| 3     | Add `roundTotalsForStorage` to `recipe-nutrition.util.ts`; swap `forStorage` out of `scripts/recompute-recipe-nutrition.ts` (`:71-74, :212-216, :317-321`).                                                               | 2                      | 15 min                                               |
| 4     | Delete the private copy in `recipes.service.ts` — blocks `64-67`, `105-141`, `218-287` — and fix imports (`:2`, `:10`, new imports §2.2).                                                                                 | 1                      | 15 min                                               |
| 5     | Add `resolveRecipeIngredients` (§3.2, incl. the three new guards) and `resolveRecipeNutrition` (§3.3); rewrite `create()` (§3.4), widening the `ingredient.findMany` select (`:557-561`).                                 | 1                      | 60 min                                               |
| 6     | `src/recipes/ingredient-amount.util.spec.ts` — 15 table rows + gate + `normalizeText` + `ALLOWED_UNITS` parity.                                                                                                           | 1 new                  | 45 min                                               |
| 7     | `src/recipes/recipes.service.spec.ts` — 12 cases, mock per §6.2.                                                                                                                                                          | 1 new                  | 75 min                                               |
| 8     | Verification loop in the container (§8): jest `src/recipes` → full jest → `tsc --noEmit`.                                                                                                                                 | —                      | 20 min                                               |
| 9     | Prod data: run §7.1 queries; if 0 rows, stop and record it. Otherwise §7.2 UPDATE + recompute + spot-check.                                                                                                               | —                      | 15 min (0 rows) / 45 min (rows)                      |
| **Σ** |                                                                                                                                                                                                                           | **11 touched + 3 new** | **≈ 4 h** (audit budgeted 2 h for D3 and 2 h for T3) |

Commit split (keeps `git bisect` useful): **C1** = steps 1-2 (`refactor: single normalizeText in src/common`), **C2** = steps 3-5 (`fix(recipes): create uses the shared amount normalizer + computes nutrition (D3)`), **C3** = steps 6-7 (`test(recipes): ingredient-amount + create coverage (T3)`).

---

## 10. Out of scope / explicit follow-ups

- **No `update` path exists** on `RecipesService`. When `recipes:update` lands (agent tool "replace ingredient X in recipe Y"), it must reuse `resolveRecipeIngredients` + `resolveRecipeNutrition` + `resolveSuitableMealTypes` verbatim — otherwise this exact bug reappears. Leave a `// TODO(update): reuse resolveRecipeNutrition` next to `resolveRecipeNutrition`.
- `create()` returns the raw Prisma row (`:631`) — unlike `findAll`/`findById` it does not run `resolveRecipeImageUrl` or `effectiveSuitableMealTypes`. Harmless today (stored `suitableMealTypes` is now always non-empty after §4), but a caller comparing `create` output to `findById` output will see a different `imageUrl`. Separate 15-min fix.
- `nutritionSalt` remains untrusted client input (D-3 rationale). The assistant's validator **must not** validate on salt — same conclusion as audit D11.
- `jest.config.js:22-25` `moduleNameMapper` (T1) is untouched here; it does not intercept anything under `src/recipes`.
- Adding `scripts/**/*.ts` to lint/typecheck (T7) would have caught the `forStorage` duplication in step 3 automatically — separate WP.
