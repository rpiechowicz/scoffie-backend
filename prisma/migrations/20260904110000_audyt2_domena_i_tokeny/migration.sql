-- Audyt 2 (3.09.2026): indeksy pod najgorętsze zapytania i wersja tokenów dostępu.
CREATE INDEX "Membership_householdId_idx" ON "Membership"("householdId");
CREATE INDEX "PlanItem_recipeId_idx" ON "PlanItem"("recipeId");
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
