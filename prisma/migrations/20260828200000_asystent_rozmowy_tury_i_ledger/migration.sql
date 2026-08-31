-- Asystent AI (Faza 0, krok 3): rozmowy, wiadomości, tury i księga użycia.
--
-- Dotąd jedynym prymitywem idempotencji była 60-sekundowa Map w pamięci
-- (Cookidoo), a limitów użycia nie było wcale — każdy deploy zerowałby
-- licznik. Płatna, metered funkcja potrzebuje trwałych rekordów:
--
-- AgentConversation — rozmowa per użytkownik w zakresie gospodarstwa.
-- AgentMessage      — wiadomość USER/ASSISTANT; `clientMessageId` z telefonu
--                     jest kluczem idempotencji (retry oddaje tę samą turę),
--                     `apiContent` = dokładne bloki API do odtworzenia prefiksu
--                     (puste, dopóki nie ma prawdziwego dostawcy).
-- AgentTurn         — jedno przetworzenie wiadomości: status RUNNING/DONE/
--                     FAILED/LIMITED, postęp, tokeny i koszt w mikrodolarach
--                     (INTEGER, bez sumowania floatów); lease „jedna tura naraz”
--                     liczy się po statusie w transakcji.
-- AiUsage           — jeden wiersz na żądanie do API dostawcy (model, effort,
--                     tokeny z cache, koszt, latencja) — surowiec do kalibracji
--                     modelu kosztów.
-- AiUsageCounter    — liczniki atomowe na Postgresie (bez Redis): scopeId =
--                     gospodarstwo albo 'global', periodKey = miesiąc/dzień,
--                     kind = messages | plans | costMicroUsd. Kwoty liczą się
--                     STĄD, nie z pamięci.
--
-- Statusy jako TEXT (jak CookidooIntegration.status): wartości waliduje kod,
-- a migracja enuma wymagałaby bloków DO $$. Wszystkie FK z ON DELETE CASCADE —
-- users:delete kasuje czaty użytkownika (RODO), zniknięcie gospodarstwa
-- zabiera jego rozmowy. Idempotentny SQL (IF NOT EXISTS), bo safe-migrate
-- może powtórzyć plik po nieudanym deployu.

CREATE TABLE IF NOT EXISTS "AgentConversation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "title" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AgentConversation_userId_lastMessageAt_idx"
    ON "AgentConversation"("userId", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "AgentConversation_householdId_idx"
    ON "AgentConversation"("householdId");

ALTER TABLE "AgentConversation"
    DROP CONSTRAINT IF EXISTS "AgentConversation_userId_fkey";
ALTER TABLE "AgentConversation"
    ADD CONSTRAINT "AgentConversation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentConversation"
    DROP CONSTRAINT IF EXISTS "AgentConversation_householdId_fkey";
ALTER TABLE "AgentConversation"
    ADD CONSTRAINT "AgentConversation_householdId_fkey"
    FOREIGN KEY ("householdId") REFERENCES "Household"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "AgentMessage" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TEXT',
    "text" TEXT NOT NULL,
    "apiContent" JSONB,
    "clientMessageId" UUID,
    "turnId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- Idempotencja: ta sama wiadomość z telefonu (retry) = ten sam wiersz.
-- NULL-e (wiadomości asystenta) nie kolidują w indeksie unikalnym Postgresa.
CREATE UNIQUE INDEX IF NOT EXISTS "AgentMessage_conversationId_clientMessageId_key"
    ON "AgentMessage"("conversationId", "clientMessageId");
CREATE INDEX IF NOT EXISTS "AgentMessage_conversationId_createdAt_idx"
    ON "AgentMessage"("conversationId", "createdAt");

ALTER TABLE "AgentMessage"
    DROP CONSTRAINT IF EXISTS "AgentMessage_conversationId_fkey";
ALTER TABLE "AgentMessage"
    ADD CONSTRAINT "AgentMessage_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "AgentTurn" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "userMessageId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "progress" JSONB NOT NULL DEFAULT '[]',
    "errorCode" TEXT,
    "requestId" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTurn_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentTurn_userMessageId_key"
    ON "AgentTurn"("userMessageId");
CREATE INDEX IF NOT EXISTS "AgentTurn_conversationId_status_idx"
    ON "AgentTurn"("conversationId", "status");
CREATE INDEX IF NOT EXISTS "AgentTurn_userId_createdAt_idx"
    ON "AgentTurn"("userId", "createdAt");

ALTER TABLE "AgentTurn"
    DROP CONSTRAINT IF EXISTS "AgentTurn_conversationId_fkey";
ALTER TABLE "AgentTurn"
    ADD CONSTRAINT "AgentTurn_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "AgentConversation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "AiUsage" (
    "id" UUID NOT NULL,
    "turnId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "householdId" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "stopReason" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AiUsage_userId_createdAt_idx"
    ON "AiUsage"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AiUsage_createdAt_idx"
    ON "AiUsage"("createdAt");

ALTER TABLE "AiUsage"
    DROP CONSTRAINT IF EXISTS "AiUsage_turnId_fkey";
ALTER TABLE "AiUsage"
    ADD CONSTRAINT "AiUsage_turnId_fkey"
    FOREIGN KEY ("turnId") REFERENCES "AgentTurn"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "AiUsageCounter" (
    "scopeId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageCounter_pkey" PRIMARY KEY ("scopeId", "periodKey", "kind")
);
