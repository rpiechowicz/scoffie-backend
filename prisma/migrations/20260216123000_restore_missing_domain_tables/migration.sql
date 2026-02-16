-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('IOS');

-- AlterTable
ALTER TABLE "Recipe" DROP COLUMN "isFavorite";

-- CreateTable
CREATE TABLE "RecipeFavorite" (
    "id" UUID NOT NULL,
    "recipeId" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedMealPlan" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedMealPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedMealPlanItem" (
    "id" UUID NOT NULL,
    "sharedMealPlanId" UUID NOT NULL,
    "recipeId" UUID NOT NULL,
    "mealType" "MealType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedMealPlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDevice" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceToken" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "appBundleId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecipeFavorite_householdId_idx" ON "RecipeFavorite"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeFavorite_recipeId_householdId_key" ON "RecipeFavorite"("recipeId", "householdId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedMealPlan_householdId_weekStart_key" ON "SharedMealPlan"("householdId", "weekStart");

-- CreateIndex
CREATE INDEX "SharedMealPlanItem_sharedMealPlanId_mealType_idx" ON "SharedMealPlanItem"("sharedMealPlanId", "mealType");

-- CreateIndex
CREATE UNIQUE INDEX "SharedMealPlanItem_sharedMealPlanId_mealType_recipeId_key" ON "SharedMealPlanItem"("sharedMealPlanId", "mealType", "recipeId");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_deviceToken_key" ON "PushDevice"("deviceToken");

-- CreateIndex
CREATE INDEX "PushDevice_userId_isActive_idx" ON "PushDevice"("userId", "isActive");

-- AddForeignKey
ALTER TABLE "RecipeFavorite" ADD CONSTRAINT "RecipeFavorite_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeFavorite" ADD CONSTRAINT "RecipeFavorite_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedMealPlan" ADD CONSTRAINT "SharedMealPlan_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedMealPlanItem" ADD CONSTRAINT "SharedMealPlanItem_sharedMealPlanId_fkey" FOREIGN KEY ("sharedMealPlanId") REFERENCES "SharedMealPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedMealPlanItem" ADD CONSTRAINT "SharedMealPlanItem_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
