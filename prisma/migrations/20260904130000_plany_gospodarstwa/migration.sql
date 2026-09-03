-- Plany gospodarstwa: nadanie operatora + subskrypcja PRO (App Store).
CREATE TYPE "HouseholdTier" AS ENUM ('TRIAL', 'PRO');
CREATE TYPE "SubscriptionProvider" AS ENUM ('APPLE', 'MANUAL');
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'GRACE', 'EXPIRED', 'REVOKED');

ALTER TABLE "Household" ADD COLUMN "tierOverride" "HouseholdTier";

CREATE TABLE "HouseholdSubscription" (
    "householdId" UUID NOT NULL,
    "provider" "SubscriptionProvider" NOT NULL,
    "productId" TEXT NOT NULL,
    "originalTransactionId" TEXT,
    "status" "SubscriptionStatus" NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "environment" TEXT,
    "lastNotificationAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HouseholdSubscription_pkey" PRIMARY KEY ("householdId")
);

CREATE UNIQUE INDEX "HouseholdSubscription_originalTransactionId_key" ON "HouseholdSubscription"("originalTransactionId");

ALTER TABLE "HouseholdSubscription" ADD CONSTRAINT "HouseholdSubscription_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Zwrot kwoty do okresu, z którego zeszła (pula próbna nie ma miesiąca).
ALTER TABLE "AgentTurn" ADD COLUMN "quotaPeriodKey" TEXT;
