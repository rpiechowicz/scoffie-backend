-- AlterTable
ALTER TABLE "Recipe"
ADD COLUMN "sourceProvider" TEXT,
ADD COLUMN "sourceRecipeId" TEXT,
ADD COLUMN "sourceCategory" TEXT,
ADD COLUMN "sourceCuisine" TEXT,
ADD COLUMN "sourceTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "sourceMeta" JSONB,
ADD COLUMN "sourceDietary" JSONB,
ADD COLUMN "sourceStorage" JSONB,
ADD COLUMN "sourceEquipment" JSONB,
ADD COLUMN "sourceInstructions" JSONB,
ADD COLUMN "sourceTroubleshooting" JSONB,
ADD COLUMN "sourceChefNotes" JSONB,
ADD COLUMN "sourceCulturalContext" TEXT,
ADD COLUMN "sourceNutrition" JSONB,
ADD COLUMN "sourceRaw" JSONB;
