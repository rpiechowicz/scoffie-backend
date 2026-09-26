-- Księga kosztu asystenta: jeden wiersz na WYWOŁANIE dostawcy, zapisany zaraz
-- po nim (workstream assistant-backend-optimization, Etap 1). Kolumna jest
-- nullable, więc stare wiersze (jeden na fazę) i podgrzewanie cache zostają
-- bez zmian; w Postgresie NULL-e nie kolidują w indeksie unikalnym.
ALTER TABLE "AiUsage" ADD COLUMN "callIndex" INTEGER;

CREATE UNIQUE INDEX "AiUsage_turnId_callIndex_key" ON "AiUsage"("turnId", "callIndex");

-- Sprzątanie tur osieroconych przez restart procesu.
CREATE INDEX "AgentTurn_status_updatedAt_idx" ON "AgentTurn"("status", "updatedAt");
