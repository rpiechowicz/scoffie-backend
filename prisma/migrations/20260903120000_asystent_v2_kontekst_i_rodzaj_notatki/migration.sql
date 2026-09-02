-- Asystent v2 (3.09.2026): „Uwzględniłem: …" pod odpowiedzią i grupy notatek.
ALTER TABLE "AgentMessage" ADD COLUMN "context" JSONB;
ALTER TABLE "AgentMemory" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'PREFERENCE';
