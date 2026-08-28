# Allergens / diet / personalization — findings

Scope verified against source: `weekly-meals-ios/.../Models/Components/{DietPreference,RecipeDietProfile,RecipePersonalization,RecipeFilterOptions,MealSlot,BodyMetrics,UserGoal}.swift`, `SettingsView.swift`, `WelcomeView.swift`, `SessionStore.swift`; backend `src/users/*`, `src/main.ts`, `prisma/schema.prisma`, `prisma/catalog/recipes-catalog-full-v2.json` (89 recipes, 131 distinct ingredient names) + 17 `ingredients-*-pl-v1.txt`. The Swift classifier was ported 1:1 to python3 (same stems, prefix/word/phrase matching, department constants) and run over the catalog; numbers below come from that run.

---

## A1 — Allergen/diet knowledge exists only as a Swift heuristic; backend has no notion at all — **P0**

**Evidence**
- `RecipeDietProfile.swift:4-9`: "Backend nie trzyma tagów dietetycznych na przepisie — jedyne, co mamy, to lista składników … Profil wylicza się więc po stronie klienta".
- `grep -rn allergen|dietPreference src --include=*.ts | grep -v src/users/` → **0 hits**. `Recipe` in `schema.prisma` has no allergen/diet columns; `sourceDietary` appears only in `src/recipes/dto/recipe.dto.ts:68` and is never written.
- Personalization is applied only in `RecipesView.swift:94-108` and `PlanSlotPickerSheet.swift:108-128`; `weekly-plans.service.ts` upsert path performs no allergen/diet check. There is also no `userPreference.findMany` anywhere (only `findUnique` at `users.service.ts:234`) — nothing can fetch the preference set of a household's participants.

**Why it escalates**: the validator must be server-side and deterministic. Without materialized flags you either port ~120 stems to TS (two dictionaries that will diverge — A9 shows they are already wrong) or the assistant validates nothing. Whatever flags exist on day one become the contract in the prompt digest.

**Fix (both repos + script)**: curated `prisma/catalog/ingredient-tags-pl-v1.json` (403 rows: `allergens[]`, `dietTags[]` ∈ MEAT/FISH/CRUSTACEAN/DAIRY/EGG/ANIMAL_OTHER/GLUTEN_GRAIN/GRAIN/LEGUME/PROCESSED) → loader `catalog:ingredients:tags` (pattern of `load-ingredient-nutrition.ts`) → `Ingredient.allergens String[]`, `Ingredient.dietTags String[]` → derived `Recipe.allergens String[]`, `Recipe.dietTags String[]` (GIN) written by `import-recipes-from-json.ts` and `recompute-recipe-nutrition.ts`, exposed in `recipeListSelect` (`recipes.service.ts:47-58`). iOS: `Recipe` reads `allergens/dietTags` from DTO and uses `RecipeDietClassifier` only when both are absent. Add `UsersService.getPreferencesForUsers(ids)` for the participant union (empty `PlanItemParticipant` = whole household, per schema).
**Effort**: ~8–10 h (curation of 403 names ≈ 3 h is the long pole). **Verdict: FIX-BEFORE-PHASE-0.**

---

## A2 — Gluten false negatives in 4 catalog recipes (granola, musli, zakwas) — **P0**

**Evidence**
- `RecipeDietProfile.swift:382-389` `glutenGrainStems` has `owsian`, `owies` but no `granol`, `musli`, `zakwas`. Design rule at lines 11-13: "alergen wykrywamy nadmiarowo … przeoczenie może zaszkodzić".
- Python run: `granola` (dept "Zboża i makarony") → `grains` only, **no gluten** → "Skyr z granolą i malinami", "Twarożek na słodko z brzoskwinią i granolą"; `baton musli` → `processed` only → "Jogurt naturalny z musli, truskawkami i borówkami"; `zakwas na żurek` (rye starter) → **nothing** → "Żurek z białą kiełbasą i jajkiem". All four pass a gluten-avoiding user's filter today, and would pass the validator if the dictionaries are ported as-is.

**Fix**: add stems `granol`, `musli`, `muesli`, `zakwas` (+ `containsGrains`) in Swift now (10 min); make the curated tag file (A1) the real fix. **Effort** 0.5 h. **Verdict: FIX-BEFORE-PHASE-0.**

---

## A3 — 7-value `Allergen` enum cannot express celery/mustard/sesame though the catalog uses them; "lactose" ≠ EU "milk" — **P1**

**Evidence**
- `DietPreference.swift:118-126`: `gluten, lactose, eggs, nuts, peanuts, fish, soy`. Comment 108-110 says seler/sezam were dropped for "zero przepisów" — no longer true in the 89-recipe catalog:
  - `seler korzeniowy` → "Rosół z makaronem", "Krupnik z kaszą jęczmienną"
  - `sezam` → "Kurczak teriyaki z makaronem i warzywami", "Hummus z warzywami do maczania"; `hummus` (tahini) → "Wrap z indykiem, hummusem i warzywami"
  - `musztarda` → "Burgery z mielonego indyka…"; `majonez` (3 recipes) typically contains mustard
  - `bulion drobiowy/warzywny` (10 recipes) and `przyprawa uniwersalna` (Leczo) — bouillon cubes/Vegeta are celery carriers; `bulion warzywny` classifies as nothing.
- EU-14 missing: celery, mustard, sesame, sulphites, lupin, molluscs; crustaceans folded into `fish` (`RecipeDietProfile.swift:186-195`; `krewetka` is in `ingredients-ryby-owoce-morza-pl-v1.txt:3`).
- Lactose semantics: `RecipeDietProfile.swift:203-206` removes the allergen for "bez laktozy" → the chip means intolerance, not milk-protein allergy; an LLM reading "laktoza" in the digest will assume milk allergy. (`mleko bez laktozy` exists in the nabiał txt, not yet in recipes.)

**Cost of adding values later**: iOS = enum case + title + stems (chips auto-render via `ForEach(Allergen.allCases)` in `WelcomeStep3PreferencesView.swift:139` and Settings) ≈ 0.5 h; backend = whitelist entry + tag rows ≈ 0.5 h; DB none (`String[]`). The real cost is A5 (older clients delete unknown values) and the prompt/validator contract.
**Fix**: add `celery`, `mustard`, `sesame` together with A1 curation; keep crustaceans folded (1 ingredient) but tag it separately in the ingredient file so the split is free later; document `lactose` = "dairy containing lactose" in the digest or rename to `milk` with a one-line data migration. **Effort** 2 h. **Verdict: FIX-BEFORE-PHASE-0 (bundle with A1).**

---

## A4 — Backend stores any string in `allergens`; `UpdatePreferencesDto` validators never run on the only transport (WS) — **P1**

**Evidence**
- `users.service.ts:278-286`: `data.allergens.map((a) => a.trim().toLowerCase()).filter(Boolean)` — no whitelist.
- `update-preferences.dto.ts:46-52`: `@IsString({each:true}) @MaxLength(64)` — no `@IsIn`.
- `users.gateway.ts:29-32`: `class UsersPreferencesUpdatePayload { userId: string; data: UpdatePreferencesDto; }` — no `@ValidateNested()`/`@Type()`; the developer's own comment at `weekly-plans.service.ts:688-696`: "`ValidationPipe` owszem jest globalny … ale na ścieżce WebSocketu nie ma czego zwalidować … `@Min/@Max` na DTO nigdy się nie uruchamiają". No users REST controller exists (`@Controller` only in auth/ops/integrations).
- Consequence today: `proteinG: -50`/`99999`, `allergens: ["anything"]` persist (only `calorieGoal`, `activityLevel`, `timeZone` are clamped in the service, lines 269-300, 341). Invalid `dietPreference` fails at Prisma (safe).

**Fix**: `src/common/allergens.ts` → `export const ALLERGEN_IDS = ['gluten','lactose','eggs','nuts','peanuts','fish','soy', /*+celery,mustard,sesame*/] as const`; in `updatePreferences` reject unknown ids with `AppException('VALIDATION_ERROR', 400)` (don't silently drop — the client must learn); clamp `proteinG/fatG/carbsG` to 0..400/300/800 in the service like `calorieGoal`; add `@ValidateNested() @Type(() => UpdatePreferencesDto)` to the payload class (pattern for all gateways). **Effort** 1 h whitelist+clamps, 1 h nested validation. **Verdict: FIX-BEFORE-PHASE-0 (whitelist + clamps); FOLD-INTO-PHASE-0 (nested WS validation).**

---

## A5 — iOS drops unknown allergen ids on read and writes back the reduced set → adding enum values deletes allergens from older app versions — **P1**

**Evidence**
- `SessionStore.swift:1794-1800` keeps all server strings in `settings.diet.allergens` (good), but `SettingsView.swift:316-319` `selectedAllergens = … .compactMap { Allergen(rawValue:) }`, `toggleAllergen` 366-375 writes `current.map(\.rawValue)…joined(",")`, and the debounced sync at 1265-1273 sends `allergens: selectedAllergens.map(\.rawValue)` (full replace, per `saveUserPreferences` doc 1830-1832). `WelcomeView.swift:107-113` + `320-327` identical.
- Scenario: user sets `celery` on an updated phone; partner's/old phone toggles `gluten` → sends `["gluten"]` → `celery` gone server-side, silently.

**Fix**: split `allergensRaw` into known + unknown tokens; write back the union; same in Welcome. **Effort** 1 h. **Verdict: FIX-BEFORE-PHASE-0 if A3 lands (it will), otherwise FOLD-INTO-PHASE-0.**

---

## A6 — Catalog cannot serve KETO / PALEO / VEGAN: 7 / 6 / 1 recipes — **P1**

**Evidence** (classifier port, per-serving = whole-recipe ÷ `servings`): vegetarian 44, pescatarian 52, highProtein 48, **keto 7** (BREAKFAST 4, LUNCH 1, DINNER 2, extra slots 0), **paleo 6** (B1/L4/D1), **vegan 1** ("Hummus z warzywami do maczania"; `miód` alone blocks 11 recipes via `otherAnimalStems`, `RecipeDietProfile.swift:377`). Keto rule `carbs <= 20` g/serving at `RecipeDietProfile.swift:72-74`.
**Why it escalates**: the assistant asked for a keto week has 1 lunch; it will repeat or violate. **Fix**: product decision — mark KETO/PALEO/VEGAN "niedostępne w katalogu" in the picker until ≥ ~25 recipes spread over slots, and make the validator return a "catalog cannot satisfy" reason. **Effort** 1 h UI hint. **Verdict: LATER (but decide before assistant design; feeds the recipe backlog).**

---

## A7 — Per-slot kcal share covers 4 categories (not 6 slots), keyed by the recipe's base category, sums to 140% — **P1**

**Evidence**: `RecipePersonalization.swift:152-160` `.breakfast .25 / .lunch .40 / .dinner .30 / .snacks .15 / .all,.favourite .33`; SECOND_BREAKFAST/AFTERNOON_SNACK/SNACK collapse to `.snacks` via `MealSlot.baseCategory` (`MealSlot.swift:46-53`); `goalScore` (line 177) uses `recipe.category`, i.e. a LUNCH recipe placed in DINNER is scored against 40%. Comment 146-151 admits shares "nie muszą sumować się do 100 %" (all six enabled = 1.40). Calendar uses only the daily total (`CalendarView.swift:15, 209`). Backend has no equivalent.
**Why**: the validator has no defined per-slot budget for extra slots. **Fix**: one backend constant `MEAL_SLOT_CALORIE_SHARE` over all 6 `MealType`s, normalized over `Household.enabledMealTypes`; mirror in iOS. **Effort** 2 h. **Verdict: LATER (design input for the assistant; ranking-only today, no user-visible wrong numbers).**

---

## A8 — Macro targets are `null` for most users; the formula lives only in Swift — **P2**

**Evidence**: `schema.prisma:66-72` ("dopóki użytkownik ich nie tknie, klient liczy je"); `BodyMetrics.swift:134-198` (Mifflin-St Jeor, TDEE ×1.20/1.375/1.55/1.725, ±15%/+12%), `260-319` (`proteinPerKilogram`, `fatEnergyShare`, 5 g snapping). Backend only knows `calorieGoal`.
**Fix**: port to `src/common/nutrition-targets.util.ts` with a spec asserting parity against a few Swift-computed vectors; validator uses stored override ?? computed. **Effort** 2 h. **Verdict: LATER (assistant phase).**

---

## A9 — Concrete ingredient classifications that are wrong or ambiguous (≥10) — **P2** (input for A1 curation)

| # | catalog name | today | problem |
|---|---|---|---|
| 1 | `granola` | grains, no gluten | FN gluten (oat-based) — A2 |
| 2 | `baton musli` | processed | FN gluten (+ often nuts/peanuts) — A2 |
| 3 | `zakwas na żurek` | nothing | FN gluten + grains (rye) — A2 |
| 4 | `seler korzeniowy` | nothing | celery unrepresentable — A3 |
| 5 | `sezam` | `processed` (dept "Przekąski i słodycze") | sesame unrepresentable; paleo FP |
| 6 | `pestki dyni` | `processed` (dept) | paleo FP → "Krem z dyni z prażonymi pestkami" excluded |
| 7 | `musztarda` | nothing | mustard unrepresentable |
| 8 | `bulion drobiowy` / `bulion warzywny` | meat / nothing | celery (+gluten/lactose traces in cubes) unrepresentable; 10 recipes |
| 9 | `przyprawa uniwersalna` | nothing | celery (Vegeta) |
| 10 | `płatki owsiane` | gluten | policy choice (4 recipes); must be stated in the digest or model/validator disagree |
| 11 | `szynka`, `boczek` | meat, not processed | inconsistent with `wędlina drobiowa`/`kiełbasa` → processed (paleo) |
| 12 | `kakao` (dept Cukiernia) | processed | paleo FP |
| 13 | `hummus` | legumes | sesame unrepresentable |
| 14 | `kukurydza z puszki` | grains | paleo exclusion, debatable |
| 15 | not yet in recipes: `białko w proszku` → no lactose (whey); `piwo*` → no gluten (barley); `orzech laskowy/włoski` → `processed` by dept; a future "ser tofu" → lactose FP via `ser` stem (`RecipeDietProfile.swift:357`); "makadamia" → gluten FP via `maka` stem (line 383) |

Verified correct: `mleko kokosowe z puszki` (not dairy), `masło orzechowe` (peanuts, not dairy/nuts), `sos sojowy` (gluten+soy), `majonez` (eggs), `jajko` in dept "Nabiał" (eggs, not dairy), `tuńczyk w puszce` (fish), `ser feta`/`mozzarella`/`śmietana 18`/`skyr` (lactose), `kasza gryczana`/`jaglana` (grains, no gluten), `kasza jęczmienna`/`kuskus` (gluten), `tortilla pszenna`, `bułka tarta`, `noga z kurczaka`, `wieprzowina i wołowina mielona`. Recipe counts per allergen: lactose 65, gluten 50, eggs 30, fish 8, peanuts 2, soy 1, nuts 0.

---

## Checked and found FINE
- `DietPreference` ↔ `DietPreferenceValue`: 7 = 7, explicit mapping `DietPreference.swift:62-80`, schema `664-672`; unknown server value keeps local (`SessionStore.swift:1790`).
- `UserGoal` 5 = 5 (`UserGoal.swift:8-14` vs schema `674-680`), case-translated at the boundary (`SessionStore.swift:1801, 1875`).
- `ActivityLevel` raw 1..4 (`UserGoal.swift:86-90`) = backend clamp 1..4 (`users.service.ts:16-17`).
- `calorieGoal` 1200..3500 on both sides (`SettingsView.swift:86-87`, DTO `38-39`, service `13-14`), suggestions clamped by `BodyMetrics.snapped` (`195-198`); default 2000 both.
- `proteinG/fatG/carbsG` `null` ↔ `-1` sentinel translated only in `SessionStore.swift:1805-1807, 1883-1900`; `clearMacroOverrides` sends explicit `NSNull`; server passes `null` through (`users.service.ts:302-315`).
- `timeZone`: empty → `null` (`users.service.ts:341`); `quiet-hours.util.ts:47-56` falls back to `Europe/Warsaw` for null/invalid via try/catch; `notifications.service.ts:456` `?? null`.
- Third parties: cookidoo client sends only `recipeId`/credentials (`cookidoo-service.client.ts:43-58`); notifications select only push flags + timeZone (`notifications.service.ts:432-438`). No allergen/diet data leaves the backend.
- Department strings: iOS `Department` (`RecipeDietProfile.swift:301-308`) == normalized `CATEGORY_BY_FILE` (`load-ingredient-catalog.ts:7-25`); `RecipeIngredient.department` set at import (`import-recipes-from-json.ts:478`) and create (`recipes.service.ts:615`); list select exposes it (`recipes.service.ts:55`).
- All 131 ingredient names in the 89 recipes resolve to a txt-catalog department (0 missing); all 89 have kcal/salt/fiber > 0 → `hasNutritionData` never false for catalog rows.
- Allergen storage format consistent: server lowercases/dedups/sorts (`users.service.ts:279-283`), iOS lowercases/sorts/joins "," (`SessionStore.swift:1865-1872`).
- Keto threshold (20 g) equals the `lowCarb` chip (`RecipeFilterOptions.swift:61` vs `RecipeDietProfile.swift:74`); `highProtein` diet (20 % kcal) intentionally differs from the chip (≥20 g) and is documented (`RecipeDietProfile.swift:81-90`).
- Peanuts vs tree nuts kept separate (EU-correct), ordering guard at `RecipeDietProfile.swift:245-250`.
- `PlanSlotPickerSheet` applies the same diet/allergen filter as Recipes (`108-128`), so manual planning is covered client-side.