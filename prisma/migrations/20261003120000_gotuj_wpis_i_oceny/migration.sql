-- Gotuj (3.10.2026): danie ugotowane spoza planu i oceny gotowania.
--
-- `PlanItem.cookedOffPlan` — pozycja dopisana po „Zjedzone” w trybie Gotuj
-- (`weeklyPlans:logCookedMeal`, docs iOS Gotuj D21/D28). Lista zakupów jej nie
-- liczy (składniki już zużyte). Kolumna z wartością domyślną = bez przepisywania
-- tabeli (Postgres 11+).
--
-- `CookFeedback` — kciuk, powody, zdanie i „+min” z sesji (jedna ocena na sesję).

-- AlterTable
ALTER TABLE "PlanItem" ADD COLUMN     "cookedOffPlan" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CookFeedback" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "recipeId" UUID NOT NULL,
    "scenarioVersion" INTEGER NOT NULL,
    "rating" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "comment" TEXT,
    "extensions" JSONB NOT NULL DEFAULT '{}',
    "servings" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CookFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CookFeedback_recipeId_idx" ON "CookFeedback"("recipeId");

-- CreateIndex
CREATE INDEX "CookFeedback_updatedAt_idx" ON "CookFeedback"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CookFeedback_userId_sessionId_key" ON "CookFeedback"("userId", "sessionId");

-- AddForeignKey
ALTER TABLE "CookFeedback" ADD CONSTRAINT "CookFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CookFeedback" ADD CONSTRAINT "CookFeedback_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

