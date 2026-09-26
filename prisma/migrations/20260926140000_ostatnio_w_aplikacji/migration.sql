-- Ostatnio w aplikacji: ostatnie uwierzytelnione żądanie (UserActivityService).
ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- Wypełnienie: najlepsza znana chwila to ostatnie logowanie. Godziny z
-- UserActivityDay nie zgadujemy (ma tylko datę) — pierwsze żądanie po
-- wdrożeniu i tak ustawi prawdziwą wartość.
UPDATE "User" SET "lastSeenAt" = "lastLoginAt" WHERE "lastLoginAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "User_lastSeenAt_idx" ON "User"("lastSeenAt");
