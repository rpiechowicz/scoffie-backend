-- Ocena odpowiedzi asystenta (kciuk w górę / w dół) — jedna na osobę i wiadomość,
-- kaskada z wiadomością (retencja rozmów i „usuń moje rozmowy” zabierają ją razem z nią).
--
-- Addytywnie: nowa tabela, istniejące dane bez zmian.
-- Rollback: DROP TABLE "AgentMessageFeedback" (klienci bez ocen działają jak dotąd).

-- CreateTable
CREATE TABLE "AgentMessageFeedback" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "turnId" UUID,
    "rating" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMessageFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentMessageFeedback_messageId_idx" ON "AgentMessageFeedback"("messageId");

-- CreateIndex
CREATE INDEX "AgentMessageFeedback_createdAt_idx" ON "AgentMessageFeedback"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMessageFeedback_userId_messageId_key" ON "AgentMessageFeedback"("userId", "messageId");

-- AddForeignKey
ALTER TABLE "AgentMessageFeedback" ADD CONSTRAINT "AgentMessageFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AgentMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

