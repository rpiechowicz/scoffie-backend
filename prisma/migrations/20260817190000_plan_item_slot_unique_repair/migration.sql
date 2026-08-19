-- Repairs the state left behind by 20260430120000_plan_item_participants.
--
-- That migration dropped the strict per-slot unique constraint so a
-- (week, day, mealType) slot could hold one PlanItem per recipe, but
-- schema.prisma was never updated to match. A later `prisma migrate dev` run
-- therefore saw the missing constraint as drift and recreated it, which put
-- the database back to one-recipe-per-slot while PlanItemParticipant sat
-- unused. schema.prisma is now the recipe-aware version, so drop the stale
-- constraint (and any index left under the same name) for good.

ALTER TABLE "PlanItem"
    DROP CONSTRAINT IF EXISTS "PlanItem_weeklyPlanId_dayOfWeek_mealType_key";

DROP INDEX IF EXISTS "PlanItem_weeklyPlanId_dayOfWeek_mealType_key";

-- Both were already created by 20260430120000, but that migration may not have
-- been the last writer — recreate defensively so the schema matches
-- schema.prisma regardless of the order things ran in.
CREATE UNIQUE INDEX IF NOT EXISTS "PlanItem_weeklyPlanId_dayOfWeek_mealType_recipeId_key"
    ON "PlanItem"("weeklyPlanId", "dayOfWeek", "mealType", "recipeId");

CREATE INDEX IF NOT EXISTS "PlanItem_weeklyPlanId_dayOfWeek_mealType_idx"
    ON "PlanItem"("weeklyPlanId", "dayOfWeek", "mealType");
