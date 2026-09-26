-- Trwałe wykonywanie tur asystenta (workstream, Etap 5).
--
-- Tura przestaje żyć wyłącznie w pamięci procesu: `AgentTurn` staje się
-- zadaniem z lease (właściciel, fencing token, termin ważności), licznikiem
-- prób, trwałym „Stop" i twardym terminem całej tury. Nowy proces przejmuje
-- turę po wygaśnięciu lease zamiast oznaczać ją FAILED.
--
-- ADDYTYWNIE: nowe kolumny (nullable albo z domyślną), nowa tabela, nowe
-- indeksy. Istniejące DONE/FAILED bez zmian. Tury RUNNING z chwili deployu
-- mają `execution = NULL` = nieodzyskiwalne — domyka je sprzątanie dokładnie
-- tak jak przed Etapem 5 (brak znaku życia 60 s → AI_PROVIDER_ERROR).
--
-- Rollback kodu: stary kod nie czyta nowych kolumn; tury przyjęte przez nowy
-- kod, a niedokończone, stary kod domknie sprzątaniem po `updatedAt`
-- (AI_PROVIDER_ERROR). Kolumny i tabela mogą zostać.

ALTER TABLE "AgentTurn"
    ADD COLUMN "execution" JSONB,
    ADD COLUMN "deadlineAt" TIMESTAMP(3),
    ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "leaseOwner" TEXT,
    ADD COLUMN "leaseToken" UUID,
    ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
    ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
    ADD COLUMN "failureDetail" TEXT;

CREATE INDEX "AgentTurn_status_leaseExpiresAt_idx" ON "AgentTurn"("status", "leaseExpiresAt");

-- Odpowiedź asystenta ma klucz wyjścia `final`: druga odpowiedź tej samej
-- tury (odzyskanie, ponowienie domknięcia) trafia w unikat.
ALTER TABLE "AgentMessage" ADD COLUMN "outputKey" TEXT;
CREATE UNIQUE INDEX "AgentMessage_turnId_outputKey_key" ON "AgentMessage"("turnId", "outputKey");

-- Próba, w której padło wywołanie dostawcy (klucz księgi niesie ją od 2. próby).
ALTER TABLE "AiUsage" ADD COLUMN "attempt" INTEGER;

CREATE TABLE "AgentTurnEffect" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "turnId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "card" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTurnEffect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentTurnEffect_turnId_key_key" ON "AgentTurnEffect"("turnId", "key");

ALTER TABLE "AgentTurnEffect" ADD CONSTRAINT "AgentTurnEffect_turnId_fkey"
    FOREIGN KEY ("turnId") REFERENCES "AgentTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
