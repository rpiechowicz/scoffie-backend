-- Karty w wiadomościach asystenta i propozycje czekające na zatwierdzenie.
--
-- Do tej pory odpowiedź asystenta była wyłącznie tekstem, a zapis planu
-- dziełem modelu w trakcie tury. Od tej migracji wiadomość może nieść treść
-- strukturalną (`card`), a zmiana planu przechodzi przez propozycję, którą
-- zatwierdza CZŁOWIEK. Obie kolumny są nullowalne i nikt ich jeszcze nie
-- czyta — migracja jest addytywna i bezpieczna do puszczenia przed kodem.

ALTER TABLE "AgentMessage"
    ADD COLUMN IF NOT EXISTS "card" JSONB;

CREATE TABLE IF NOT EXISTS "AgentProposal" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "conversationId"  UUID         NOT NULL,
    "turnId"          UUID         NOT NULL,
    "userId"          UUID         NOT NULL,
    "householdId"     UUID         NOT NULL,
    "kind"            TEXT         NOT NULL,
    "weekStart"       DATE         NOT NULL,
    "action"          JSONB        NOT NULL,
    "card"            JSONB        NOT NULL,
    "baselineHash"    TEXT         NOT NULL,
    "appliedHash"     TEXT,
    "status"          TEXT         NOT NULL DEFAULT 'PENDING',
    "messageId"       UUID,
    "undoSnapshot"    JSONB,
    "appliedAt"       TIMESTAMP(3),
    "appliedByUserId" UUID,
    "undoneAt"        TIMESTAMP(3),
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentProposal_pkey" PRIMARY KEY ("id")
);

-- Nazwy indeksów takie, jakie nadaje Prisma, żeby `migrate diff` był czysty.
CREATE UNIQUE INDEX IF NOT EXISTS "AgentProposal_messageId_key"
    ON "AgentProposal"("messageId");
CREATE INDEX IF NOT EXISTS "AgentProposal_conversationId_createdAt_idx"
    ON "AgentProposal"("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentProposal_householdId_status_idx"
    ON "AgentProposal"("householdId", "status");
CREATE INDEX IF NOT EXISTS "AgentProposal_turnId_idx"
    ON "AgentProposal"("turnId");

-- Kaskada z rozmowy: „usuń moje rozmowy" ma zabrać też propozycje.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'AgentProposal_conversationId_fkey'
    ) THEN
        ALTER TABLE "AgentProposal"
            ADD CONSTRAINT "AgentProposal_conversationId_fkey"
            FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
