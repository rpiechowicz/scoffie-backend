-- Gramy łyżeczki przypraw spoza dawnej tabeli (30.09.2026).
--
-- `SPICE_GRAMS_PER_TEASPOON_BY_NAME` (src/recipes/ingredient-amount.util.ts)
-- dostał masy łyżeczki WSZYSTKICH przypraw katalogu, bo od teraz służy też
-- wyświetlaniu (`kitchenMeasure`: „½ łyżeczki” zamiast „1 g”). Trzy
-- przyprawy podawane w katalogu łyżeczkami liczyły się dotąd domyślnymi
-- 2,5 g/łyżeczkę — „2 łyżeczki majeranku” to było 5 g zamiast 1,2 g, a lista
-- zakupów pokazałaby je teraz jako „8 łyżeczek”.
--
-- Poprawiamy tylko `normalizedAmount` tych wierszy (13 w katalogu z prod),
-- dokładnie tym, co liczy `normalizeIngredientAmount`: ilość × (łyżka 3,
-- szczypta 1/16, łyżeczka 1) × masa łyżeczki. Podpis treści przepisu
-- (Gotuj) liczy się z `amount`/`unit`, więc scenariusze nie tracą ważności;
-- trigger logu katalogu wyśle zmienione przepisy telefonom.
--
-- Kcal tych przepisów (różnica kilku kcal na całe danie) odświeża potem
-- `pnpm recipes:recompute:nutrition -- --write --db-only`.

UPDATE "RecipeIngredient" AS ri
SET "normalizedAmount" = ri."amount"
  * CASE lower(ri."unit")
      WHEN 'łyżka' THEN 3
      WHEN 'lyzka' THEN 3
      WHEN 'szczypta' THEN 1.0 / 16
      ELSE 1
    END
  * CASE i."normalizedName"
      WHEN 'majeranek' THEN 0.6
      WHEN 'kmin rzymski' THEN 2.1
      WHEN 'curry' THEN 2
    END,
    "updatedAt" = now()
FROM "Ingredient" AS i
WHERE ri."ingredientId" = i."id"
  AND i."normalizedName" IN ('majeranek', 'kmin rzymski', 'curry')
  AND lower(ri."unit") IN ('łyżeczka', 'lyzeczka', 'łyżka', 'lyzka', 'szczypta')
  AND ri."normalizedUnit" = 'g';
