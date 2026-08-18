-- Replace strict slot uniqueness with recipe-aware uniqueness so a single
-- (week, day, mealType) slot can hold multiple PlanItems, one per recipe.
-- This unlocks per-user meals: e.g. Gaba's salad and Rafal's burger can both
-- live on Tuesday lunch as two PlanItem rows that differ only by recipeId.
ALTER TABLE "PlanItem" DROP CONSTRAINT IF EXISTS "PlanItem_weeklyPlanId_dayOfWeek_mealType_key";

CREATE UNIQUE INDEX "PlanItem_weeklyPlanId_dayOfWeek_mealType_recipeId_key"
    ON "PlanItem"("weeklyPlanId", "dayOfWeek", "mealType", "recipeId");

CREATE INDEX "PlanItem_weeklyPlanId_dayOfWeek_mealType_idx"
    ON "PlanItem"("weeklyPlanId", "dayOfWeek", "mealType");

-- Junction table linking each PlanItem to a subset of household members.
-- Empty participant set = "everyone in the household eats this", which keeps
-- existing rows valid without a backfill.
CREATE TABLE "PlanItemParticipant" (
    "planItemId" UUID NOT NULL,
    "userId"     UUID NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanItemParticipant_pkey" PRIMARY KEY ("planItemId", "userId")
);

CREATE INDEX "PlanItemParticipant_planItemId_idx"
    ON "PlanItemParticipant"("planItemId");

CREATE INDEX "PlanItemParticipant_userId_idx"
    ON "PlanItemParticipant"("userId");

ALTER TABLE "PlanItemParticipant"
    ADD CONSTRAINT "PlanItemParticipant_planItemId_fkey"
    FOREIGN KEY ("planItemId") REFERENCES "PlanItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlanItemParticipant"
    ADD CONSTRAINT "PlanItemParticipant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
