# Plaster D — tagi składników: alergeny i diety po stronie serwera (28.08.2026)

Zamyka ostatnie punkty „przed Fazą 0” z audytu 27.08: **A1** (P0, tagi po stronie
serwera), **A2** (P0, luki glutenu: granola/musli/zakwas), **A3** (seler/gorczyca/sezam —
Rafał odłożył je „na później, razem z tagami”), **D6** (tagi na `Ingredient`).
Plus `railway.json` z healthcheckiem (osobna gałąź `fix/railway-healthcheck`, `3a2d7a0`).

## Słownik
- **Alergeny** (`src/common/allergens.ts`, kontrakt z iOS `enum Allergen`): gluten, lactose, eggs,
  nuts, peanuts, fish, soy + **celery, mustard, sesame**. `lactose` = nabiał zawierający laktozę
  (bez laktozy/ghee → DAIRY bez lactose); `fish` obejmuje owoce morza. Oznaczane nadmiarowo.
- **dietTags** (`src/common/diet-tags.ts`): MEAT, FISH, CRUSTACEAN, DAIRY, EGG, ANIMAL_OTHER,
  GLUTEN_GRAIN, GRAIN, LEGUME, PROCESSED, ALCOHOL, NON_FOOD. Spójność: gluten⇒GLUTEN_GRAIN⇒GRAIN,
  lactose⇒DAIRY, eggs⇒EGG, fish⇒FISH, CRUSTACEAN⇒FISH+fish, soy/peanuts⇒LEGUME, NON_FOOD sam.
- **Reguły diet** (`src/recipes/diet-rules.util.ts`) — parytet 1:1 z `RecipeDietProfile.satisfies`:
  VEGETARIAN !MEAT/FISH/CRUSTACEAN; VEGAN + !DAIRY/EGG/ANIMAL_OTHER; PESCATARIAN !MEAT;
  PALEO !GRAIN/GLUTEN_GRAIN/LEGUME/DAIRY/PROCESSED; KETO ≤20 g węgli/porcję (bez makr → false);
  HIGH_PROTEIN ≥20 % energii z białka. Przepis bez składników przepuszcza diety składnikowe.

## Dane
`prisma/catalog/ingredient-tags-pl-v1.json` — 403 wpisy (= wszystkie `ingredients-*-pl-v1.txt`),
klucz `normalizedName`, pola `allergens[]`, `dietTags[]`, `note?`. Kuracja: workflow 6 klasyfikatorów
(po grupach plików) + 3 weryfikatorów adwersaryjnych (5 poprawek) + mój przegląd 131 nazw
z przepisów i 272 pozostałych. Parytet z audytem: liczności diet z unii tagów (wegetariańska 44,
pescetariańska 52, keto 7, paleo 6, wegańska 1, wysokobiałkowa 48) identyczne z portem klasyfikatora
Swift; gluten 54 vs 50 = dokładnie A2. Nowe: celery 13 przepisów, mustard 5, sesame 3.

## Backend (`fix/fundamenty-d`)
- schema + migracja `20260828150000_tagi_skladnikow_i_przepisow`: `Ingredient.allergens/dietTags`,
  `Recipe.allergens/dietTags` (TEXT[] default {}), GIN `Recipe_allergens_idx`, `Recipe_dietTags_idx`.
- `deriveRecipeTags` (unia, sort, dedup) w TRZECH miejscach zapisu: import (`import-recipes-from-json.ts`,
  z wierszy Ingredient), `RecipesService.create`, loader (`scripts/load-ingredient-tags.ts` → składniki
  + recompute przepisów, zapis tylko przy zmianie, raport „uncovered”).
- `recipeListSelect` i `detailSelect` + `allergens`, `dietTags`; `RecipeDto` + oba pola.
- `UsersService.getPreferencesForUsers(ids)` (unia preferencji domowników — pod walidator Fazy 0).
- Bootstrap (`prisma-migrate-deploy-safe.js`): tagi PO nutrition, PRZED importem (tylko rebuild).
  `pnpm catalog:ingredients:tags`; `commands.txt`.
- Testy: `diet-tags.spec` (7), `diet-rules.util.spec` (~24), `ingredient-tags.golden.spec`
  (pokrycie 403/403, spójność, 6 przepisów z dokładną unią, dolne granice diet), recipes.service
  (unia + brak tagów w wierszach składników), users (getPreferencesForUsers), allergens (10 id).

## iOS (`fix/fundamenty-d`, `7bd2949`)
`Recipe`/`BackendRecipeDTO` + `allergens: [String]?`, `dietTags: [String]?` (nil = brak z serwera,
[] = fakt); `RecipeDietProfile.fromServerTags` (parytet z diet-rules), heurystyka tylko fallback;
`Allergen` + celery/mustard/sesame; `hasIngredientCoverage` liczy tagi; cache katalogu v12.

## Kolejność wdrożenia (nośna)
1. Backend → `develop` → `main`. Migracja idzie sama przy starcie. **Zaraz po deployu**:
   `pnpm catalog:ingredients:tags` na prod z lokalnego kontenera z `$PROD_DB` (kolumny są puste
   do pierwszego przebiegu → do tego czasu nowy iOS widziałby „brak alergenów” jako fakt!).
   Zobacz PROD-RUNBOOK.md.
2. iOS → `develop` → `main` → TestFlight — DOPIERO po kroku 1 (loader), bo `[]` z serwera =
   „nic nie wykryto”.
3. Stary iOS na nowym backendzie: bez zmian (dalej heurystyka). Nowy iOS na starym backendzie:
   `nil` → heurystyka.

## Poza zakresem (LATER / Faza 0)
A4 walidacja zagnieżdżona WS, A6 (keto/paleo/vegan niedostępne w UI), A7 udziały kcal per slot,
A8 cele makro na serwerze, D8 (tortilla/awokado dwie jednostki), D9 aliasy w pliku, D11.
Follow-upy z B (stub `getSavedPlan`, DROP `SharedMealPlan*`, gałąź `SAVE_PLAN`) — po adopcji
buildu B/C na obu telefonach.
