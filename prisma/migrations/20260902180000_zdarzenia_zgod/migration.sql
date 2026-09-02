-- Zdarzenia zgód (regulamin, polityka, asystent AI, Cookidoo, deklaracja
-- wieku) — tylko dopisywanie. Do tej pory jedynym „mechanizmem zgody" był
-- napis pod przyciskiem logowania; nic nie było zapisywane, więc nie dało
-- się wykazać ani zgody na dane o zdrowiu wysyłane do modelu (art. 9 RODO),
-- ani przyjęcia regulaminu. Wersja dokumentu to data z kodu
-- (src/common/legal-documents.ts), nie zmienna środowiskowa.
CREATE TABLE IF NOT EXISTS "ConsentEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "documentVersion" TEXT NOT NULL,
  "source" TEXT,
  "appVersion" TEXT,
  "householdId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConsentEvent_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ConsentEvent_userId_kind_createdAt_idx"
  ON "ConsentEvent"("userId", "kind", "createdAt");
