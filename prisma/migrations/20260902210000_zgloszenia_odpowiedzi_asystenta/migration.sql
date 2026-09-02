-- „Zgłoś odpowiedź" asystenta (App Store 1.2 / 4.7 — mechanizm zgłaszania
-- treści generowanych). Bez kluczy obcych do wiadomości i rozmowy: retencja
-- kasuje rozmowy po 90 dniach, a zgłoszenie ma przeżyć z migawką treści.
CREATE TABLE IF NOT EXISTS "AgentReport" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "conversationId" UUID,
  "messageId" UUID,
  "turnId" UUID,
  "reason" TEXT NOT NULL,
  "comment" TEXT,
  "messageText" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AgentReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentReport_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AgentReport_createdAt_idx" ON "AgentReport"("createdAt");
