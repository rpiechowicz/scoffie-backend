-- Indeksy pod zapytania panelu administratora (pulpit, rentowność, lista osób).
-- Zwykłe CREATE INDEX (nie CONCURRENTLY): Prisma puszcza migrację w transakcji,
-- a tabele są na tyle małe, że krótka blokada zapisu przy wdrożeniu nie boli.

-- CreateIndex
CREATE INDEX "AgentProposal_createdAt_idx" ON "AgentProposal"("createdAt");

-- CreateIndex
CREATE INDEX "AgentTurn_createdAt_idx" ON "AgentTurn"("createdAt");

-- CreateIndex
CREATE INDEX "AiUsage_turnId_idx" ON "AiUsage"("turnId");

-- CreateIndex
CREATE INDEX "PlanItem_createdAt_idx" ON "PlanItem"("createdAt");

-- CreateIndex
CREATE INDEX "RefreshToken_revokedReason_revokedAt_idx" ON "RefreshToken"("revokedReason", "revokedAt");

-- CreateIndex
CREATE INDEX "User_lastLoginAt_idx" ON "User"("lastLoginAt");
