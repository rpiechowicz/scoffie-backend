-- Per-user "I ate this" marks on planned meals.
--
-- A row per (planItem, user) rather than a boolean on PlanItem: a shared item
-- ("Wspólne", no participant rows) is eaten by each member on their own
-- schedule, so a single flag could not answer "did *I* eat this?". Presence of
-- the row means eaten; unmarking deletes it. `eatenAt` comes free with the row
-- and lets a later feature show when the meal was logged.
CREATE TABLE "PlanItemConsumption" (
    "planItemId" UUID NOT NULL,
    "userId"     UUID NOT NULL,
    "eatenAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanItemConsumption_pkey" PRIMARY KEY ("planItemId", "userId")
);

CREATE INDEX "PlanItemConsumption_planItemId_idx"
    ON "PlanItemConsumption"("planItemId");

CREATE INDEX "PlanItemConsumption_userId_idx"
    ON "PlanItemConsumption"("userId");

ALTER TABLE "PlanItemConsumption"
    ADD CONSTRAINT "PlanItemConsumption_planItemId_fkey"
    FOREIGN KEY ("planItemId") REFERENCES "PlanItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlanItemConsumption"
    ADD CONSTRAINT "PlanItemConsumption_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
