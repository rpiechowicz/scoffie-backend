-- Księga kosztów (AiUsage) przeżywa kasowanie rozmów.
--
-- Do tej pory `AiUsage.turnId` kasował kaskadą: porządki użytkownika
-- (DELETE /agent/conversations) i retencja rozmów wycinały wiersze
-- rozliczeniowe, więc rachunek za miesiąc „malał" z każdym sprzątaniem.
-- Wiersz bez tury nadal niesie userId, householdId, tokeny i koszt.
ALTER TABLE "AiUsage" ALTER COLUMN "turnId" DROP NOT NULL;
ALTER TABLE "AiUsage" DROP CONSTRAINT IF EXISTS "AiUsage_turnId_fkey";
ALTER TABLE "AiUsage"
    ADD CONSTRAINT "AiUsage_turnId_fkey"
    FOREIGN KEY ("turnId") REFERENCES "AgentTurn"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
