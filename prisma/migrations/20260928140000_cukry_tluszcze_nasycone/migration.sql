-- Cukry i tłuszcze nasycone (katalog 1000, 28.09.2026) — dwie brakujące
-- pozycje etykiety UE („w tym cukry”, „w tym nasycone”). Składnik: na 100 g/ml,
-- nullable jak reszta makro (brak = nieznane). Przepis: cały przepis, 0
-- domyślnie. Same kolumny ze stałymi domyślnymi — bez przepisywania tabeli
-- i bez wyzwalaczy `CatalogChange`; wartości wpisuje osobna migracja danych.
ALTER TABLE "Ingredient"
  ADD COLUMN "nutritionSugarsPer100" DOUBLE PRECISION,
  ADD COLUMN "nutritionSaturatedFatPer100" DOUBLE PRECISION;

ALTER TABLE "Recipe"
  ADD COLUMN "nutritionSugars" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "nutritionSaturatedFat" DOUBLE PRECISION NOT NULL DEFAULT 0;
