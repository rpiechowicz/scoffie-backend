-- Add normalized keys for canonical ingredient and alias matching.
ALTER TABLE "Ingredient" ADD COLUMN "normalizedName" TEXT;

UPDATE "Ingredient"
SET "normalizedName" = btrim(
  regexp_replace(
    translate(lower(name), 'ąćęłńóśźż', 'acelnoszz'),
    '\s+',
    ' ',
    'g'
  )
);

ALTER TABLE "Ingredient" ALTER COLUMN "normalizedName" SET NOT NULL;
CREATE UNIQUE INDEX "Ingredient_normalizedName_key" ON "Ingredient"("normalizedName");

ALTER TABLE "IngredientAlias" ADD COLUMN "normalizedAlias" TEXT;

UPDATE "IngredientAlias"
SET "normalizedAlias" = btrim(
  regexp_replace(
    translate(lower(alias), 'ąćęłńóśźż', 'acelnoszz'),
    '\s+',
    ' ',
    'g'
  )
);

-- Keep one alias per normalized key before creating unique index.
DELETE FROM "IngredientAlias" a
USING "IngredientAlias" b
WHERE a.id > b.id
  AND a."normalizedAlias" = b."normalizedAlias";

ALTER TABLE "IngredientAlias" ALTER COLUMN "normalizedAlias" SET NOT NULL;
CREATE UNIQUE INDEX "IngredientAlias_normalizedAlias_key" ON "IngredientAlias"("normalizedAlias");

CREATE TABLE "ManualShoppingItem" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "createdById" UUID,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "productKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualShoppingItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManualShoppingItem_householdId_weekStart_productKey_key" ON "ManualShoppingItem"("householdId", "weekStart", "productKey");
CREATE INDEX "ManualShoppingItem_householdId_weekStart_idx" ON "ManualShoppingItem"("householdId", "weekStart");
CREATE INDEX "ManualShoppingItem_createdById_idx" ON "ManualShoppingItem"("createdById");

ALTER TABLE "ManualShoppingItem" ADD CONSTRAINT "ManualShoppingItem_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ManualShoppingItem" ADD CONSTRAINT "ManualShoppingItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
