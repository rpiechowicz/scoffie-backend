-- Integracja Cookidoo (Thermomix): poświadczenia gospodarstwa do konta Cookidoo.
-- E-mail i hasło zaszyfrowane AES-256-GCM (format "v1:<iv>:<tag>:<ct>") — klucz
-- żyje wyłącznie w env COOKIDOO_ENCRYPTION_KEY, nigdy w bazie. Jedna integracja
-- na gospodarstwo (unikat na householdId), bo plan i lista zakupów też są wspólne.
CREATE TABLE IF NOT EXISTS "CookidooIntegration" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "emailEncrypted" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    -- CONNECTED | AUTH_FAILED. Tekst, nie enum — defensywna migracja enuma
    -- wymaga bloków DO $$, a wartości i tak waliduje serwis.
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "connectedById" UUID,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CookidooIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CookidooIntegration_householdId_key"
    ON "CookidooIntegration"("householdId");

-- Kasowanie gospodarstwa zabiera integrację (creds nie mogą przeżyć domu);
-- kasowanie użytkownika zostawia integrację działającą (SetNull) — łączył
-- ją domownik, ale należy do gospodarstwa.
ALTER TABLE "CookidooIntegration"
    DROP CONSTRAINT IF EXISTS "CookidooIntegration_householdId_fkey";
ALTER TABLE "CookidooIntegration"
    ADD CONSTRAINT "CookidooIntegration_householdId_fkey"
    FOREIGN KEY ("householdId") REFERENCES "Household"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CookidooIntegration"
    DROP CONSTRAINT IF EXISTS "CookidooIntegration_connectedById_fkey";
ALTER TABLE "CookidooIntegration"
    ADD CONSTRAINT "CookidooIntegration_connectedById_fkey"
    FOREIGN KEY ("connectedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
