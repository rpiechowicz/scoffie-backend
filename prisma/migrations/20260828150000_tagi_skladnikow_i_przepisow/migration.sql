-- Tagi składników i przepisów (alergeny + tagi dietetyczne) liczone po
-- stronie serwera. Dotąd jedyna wiedza „czy przepis ma gluten / mięso”
-- żyła jako heurystyka po nazwach składników w kliencie iOS
-- (RecipeDietProfile.swift) — walidator asystenta nie ma się na czym oprzeć,
-- a dwie kopie słownika już się rozjechały (granola bez glutenu).
--
-- Ingredient.allergens / dietTags — z kuratorowanego pliku
-- prisma/catalog/ingredient-tags-pl-v1.json (loader scripts/load-ingredient-tags.ts).
-- Recipe.allergens / dietTags — unia tagów składników; liczona przy imporcie,
-- przy recipes:create i w przebiegu recompute loadera. Kolumny są puste do
-- pierwszego przebiegu loadera — czytający rozróżniają „brak składników”
-- po liczbie składników, nie po pustych tagach.
ALTER TABLE "Ingredient"
    ADD COLUMN IF NOT EXISTS "allergens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Ingredient"
    ADD COLUMN IF NOT EXISTS "dietTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Recipe"
    ADD COLUMN IF NOT EXISTS "allergens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Recipe"
    ADD COLUMN IF NOT EXISTS "dietTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Zapytania katalogu „bez alergenu X” / „bez tagu Y” idą po zawieraniu w
-- tablicy — B-tree tego nie obsłuży. Nazwy jak nadaje Prisma dla
-- @@index([...], type: Gin), żeby `migrate diff` był czysty.
CREATE INDEX IF NOT EXISTS "Recipe_allergens_idx"
    ON "Recipe" USING GIN ("allergens");
CREATE INDEX IF NOT EXISTS "Recipe_dietTags_idx"
    ON "Recipe" USING GIN ("dietTags");
