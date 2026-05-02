-- CreateEnum
CREATE TYPE "UserGoal" AS ENUM ('HEALTHY', 'LOSE', 'GAIN', 'MAINTAIN', 'PLAN');

-- AlterTable
ALTER TABLE "User"
    ADD COLUMN     "yearOfBirth" INTEGER,
    ADD COLUMN     "heightCm" INTEGER,
    ADD COLUMN     "weightKg" INTEGER,
    ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3);

-- Backfill onboardingCompletedAt for existing users so they don't see the
-- welcome flow on next launch — they've been using the app already.
UPDATE "User"
SET "onboardingCompletedAt" = COALESCE("lastLoginAt", "createdAt")
WHERE "onboardingCompletedAt" IS NULL;

-- AlterTable
ALTER TABLE "UserPreference"
    ADD COLUMN     "goal" "UserGoal" NOT NULL DEFAULT 'HEALTHY',
    ADD COLUMN     "activityLevel" INTEGER NOT NULL DEFAULT 2;
