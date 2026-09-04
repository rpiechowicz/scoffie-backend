-- Subskrypcja przestaje należeć do gospodarstwa i zaczyna należeć do osoby.
--
-- `HouseholdSubscription` (dodana dzień wcześniej migracją
-- `20260904130000_plany_gospodarstwa`) nie ma w kodzie ANI JEDNEGO zapisu, więc
-- na każdym środowisku jest pusta. Gdyby jednak gdzieś nie była, ta migracja ma
-- się zatrzymać, a nie skasować czyjeś opłacone PRO — stąd twarda asercja
-- zamiast cichego `DROP TABLE`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "HouseholdSubscription") THEN
    RAISE EXCEPTION 'HouseholdSubscription nie jest pusta - przenies wiersze do Subscription recznie przed ta migracja';
  END IF;
END $$;

-- Hasz tożsamości zakupowej: jedyny ślad, który ma przeżyć skasowanie konta.
ALTER TABLE "User" ADD COLUMN "identityHash" TEXT;
CREATE INDEX "User_identityHash_idx" ON "User"("identityHash");

CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "identityHash" TEXT NOT NULL,
    "purchaserUserId" UUID,
    "provider" "SubscriptionProvider" NOT NULL,
    "productId" TEXT NOT NULL,
    "originalTransactionId" TEXT,
    "latestTransactionId" TEXT,
    "status" "SubscriptionStatus" NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "graceExpiresAt" TIMESTAMP(3),
    "neverExpires" BOOLEAN NOT NULL DEFAULT false,
    "autoRenewStatus" BOOLEAN,
    "autoRenewProductId" TEXT,
    "environment" TEXT,
    "ownershipType" TEXT,
    "revokedAt" TIMESTAMP(3),
    "messagesLimitSnapshot" INTEGER,
    "plansLimitSnapshot" INTEGER,
    "lastNotificationAt" TIMESTAMP(3),
    "lastNotificationType" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_originalTransactionId_key" ON "Subscription"("originalTransactionId");
CREATE INDEX "Subscription_identityHash_idx" ON "Subscription"("identityHash");
CREATE INDEX "Subscription_purchaserUserId_idx" ON "Subscription"("purchaserUserId");
CREATE INDEX "Subscription_status_expiresAt_idx" ON "Subscription"("status", "expiresAt");

-- SET NULL, nie CASCADE: subskrypcja musi przeżyć usunięcie konta płatnika,
-- bo Apple pobiera pieniądze niezależnie od tego, czy konto u nas istnieje.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_purchaserUserId_fkey"
    FOREIGN KEY ("purchaserUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AppleNotification" (
    "notificationUuid" TEXT NOT NULL,
    "notificationType" TEXT NOT NULL,
    "subtype" TEXT,
    "originalTransactionId" TEXT,
    "environment" TEXT,
    "signedPayload" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "AppleNotification_pkey" PRIMARY KEY ("notificationUuid")
);

CREATE INDEX "AppleNotification_processedAt_receivedAt_idx" ON "AppleNotification"("processedAt", "receivedAt");
CREATE INDEX "AppleNotification_originalTransactionId_idx" ON "AppleNotification"("originalTransactionId");

-- Zakres licznika, z którego zeszła kwota. Bez tego zwrot po nieudanej turze
-- trafiał do zakresu wyliczonego w chwili ZWROTU, a nie w chwili pobrania.
ALTER TABLE "AgentTurn" ADD COLUMN "quotaScopeId" TEXT;
ALTER TABLE "AgentProposal" ADD COLUMN "quotaScopeId" TEXT;

DROP TABLE "HouseholdSubscription";
