-- Audyt 2 (3.09.2026), asystent: kwota planu wraca tylko tam, gdzie zeszła;
-- rozkład zużycia liczy tury, które nie oddały kwoty.
ALTER TABLE "AgentProposal" ADD COLUMN "quotaPeriodKey" TEXT;
ALTER TABLE "AgentProposal" ADD COLUMN "changedCount" INTEGER;
ALTER TABLE "AgentTurn" ADD COLUMN "quotaRefunded" BOOLEAN NOT NULL DEFAULT false;
