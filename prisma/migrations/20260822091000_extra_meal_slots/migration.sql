-- Dodatkowe sloty posiłków — część druga: kolumny, backfill, indeks.
-- Wartości enuma dodaje poprzednia migracja; tutaj wolno ich już użyć.

-- Recipe.suitableMealTypes — wszystkie sloty, w których danie ma sens.
ALTER TABLE "Recipe"
    ADD COLUMN IF NOT EXISTS "suitableMealTypes" "MealType"[] NOT NULL DEFAULT ARRAY[]::"MealType"[];

-- Backfill zachowawczy: każdy istniejący przepis pasuje (na razie) wyłącznie
-- do swojego slotu bazowego. Rozszerzenie o „ta owsianka nadaje się też na
-- II śniadanie" robi osobny, powtarzalny skrypt
-- (`scripts/backfill-suitable-meal-types.ts`) — klasyfikacja to heurystyka,
-- a heurystyka ma siedzieć w kodzie, który da się obejrzeć i puścić
-- ponownie, nie w nieodwracalnej migracji.
UPDATE "Recipe"
   SET "suitableMealTypes" = ARRAY["mealType"]
 WHERE cardinality("suitableMealTypes") = 0;

-- Zapytania o katalog dla slotu idą przez `suitableMealTypes @> ARRAY[...]`.
CREATE INDEX IF NOT EXISTS "Recipe_suitableMealTypes_idx"
    ON "Recipe" USING GIN ("suitableMealTypes");

-- Household.enabledMealTypes — które sloty gospodarstwo planuje.
-- Domyślnie klasyczna trójka, czyli dokładnie to, co aplikacja pokazywała
-- do tej pory: po wdrożeniu nikt nie zobaczy zmiany, dopóki sam nie włączy
-- dodatkowego posiłku.
ALTER TABLE "Household"
    ADD COLUMN IF NOT EXISTS "enabledMealTypes" "MealType"[] NOT NULL
    DEFAULT ARRAY['BREAKFAST', 'LUNCH', 'DINNER']::"MealType"[];

UPDATE "Household"
   SET "enabledMealTypes" = ARRAY['BREAKFAST', 'LUNCH', 'DINNER']::"MealType"[]
 WHERE cardinality("enabledMealTypes") = 0;
