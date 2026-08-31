-- Pamięć asystenta (Faza 1, hartowanie): krótkie notatki gospodarstwa, które
-- przeżywają koniec rozmowy.
--
-- Historia rozmowy idzie do modelu tylko w obrębie JEDNEJ rozmowy, więc bez
-- tej tabeli każda nowa rozmowa zaczynała od zera. Zakres to gospodarstwo, nie
-- użytkownik: plan i lista zakupów też są wspólne. `createdByUserId` bez klucza
-- obcego z kaskadą na użytkownika — notatka ma przeżyć odejście autora
-- z gospodarstwa, a `ON DELETE SET NULL` załatwia to bez utraty treści.
--
-- Idempotentny SQL (IF NOT EXISTS), bo safe-migrate może powtórzyć plik po
-- nieudanym deployu.

CREATE TABLE IF NOT EXISTS "AgentMemory" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentMemory_householdId_createdAt_idx"
    ON "AgentMemory"("householdId", "createdAt");

ALTER TABLE "AgentMemory"
    DROP CONSTRAINT IF EXISTS "AgentMemory_householdId_fkey";
ALTER TABLE "AgentMemory"
    ADD CONSTRAINT "AgentMemory_householdId_fkey"
    FOREIGN KEY ("householdId") REFERENCES "Household"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
