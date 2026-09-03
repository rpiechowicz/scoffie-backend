-- Sól liczona ze składników jak inne makro: sód na 100 g w tabeli składników
-- i osobno sól dodana na przepisie. Dotychczasowa "nutritionSalt" zostaje jako
-- suma (backfill robi recompute przy starcie).
ALTER TABLE "Ingredient" ADD COLUMN "nutritionSodiumMgPer100" DOUBLE PRECISION;
ALTER TABLE "Recipe" ADD COLUMN "nutritionSaltAdded" DOUBLE PRECISION NOT NULL DEFAULT 0;
