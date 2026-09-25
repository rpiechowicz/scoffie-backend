-- CreateEnum
CREATE TYPE "AnnouncementSeverity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('all', 'ios', 'android', 'households');

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "FeatureFlagHousehold" (
    "flagKey" TEXT NOT NULL,
    "householdId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "FeatureFlagHousehold_pkey" PRIMARY KEY ("flagKey","householdId")
);

-- CreateTable
CREATE TABLE "AppAnnouncement" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" "AnnouncementSeverity" NOT NULL DEFAULT 'info',
    "audience" "AnnouncementAudience" NOT NULL DEFAULT 'all',
    "householdIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "dismissible" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeatureFlagHousehold_householdId_idx" ON "FeatureFlagHousehold"("householdId");

-- CreateIndex
CREATE INDEX "AppAnnouncement_startsAt_endsAt_idx" ON "AppAnnouncement"("startsAt", "endsAt");

-- AddForeignKey
ALTER TABLE "FeatureFlagHousehold" ADD CONSTRAINT "FeatureFlagHousehold_flagKey_fkey" FOREIGN KEY ("flagKey") REFERENCES "FeatureFlag"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureFlagHousehold" ADD CONSTRAINT "FeatureFlagHousehold_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rollout to odsetek domów (0–100); baza pilnuje zakresu niezależnie od DTO.
ALTER TABLE "FeatureFlag" ADD CONSTRAINT "FeatureFlag_rolloutPercent_check" CHECK ("rolloutPercent" BETWEEN 0 AND 100);
