-- AlterTable
ALTER TABLE "RecipeIngredient"
ADD COLUMN "normalizedAmount" DOUBLE PRECISION,
ADD COLUMN "normalizedUnit" TEXT;

-- Backfill existing rows (if any)
UPDATE "RecipeIngredient"
SET
  "normalizedAmount" = "amount",
  "normalizedUnit" = "unit"
WHERE "normalizedAmount" IS NULL OR "normalizedUnit" IS NULL;

-- Enforce required fields
ALTER TABLE "RecipeIngredient"
ALTER COLUMN "normalizedAmount" SET NOT NULL,
ALTER COLUMN "normalizedUnit" SET NOT NULL;
