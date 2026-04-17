-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('GOOGLE', 'APPLE', 'DEV');

-- AlterTable: make googleId nullable so users can come from Apple without a googleId
ALTER TABLE "User" ALTER COLUMN "googleId" DROP NOT NULL;

-- AlterTable: add Apple / provenance columns
ALTER TABLE "User"
  ADD COLUMN "appleSub" TEXT,
  ADD COLUMN "authProvider" "AuthProvider" NOT NULL DEFAULT 'GOOGLE',
  ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastLoginAt" TIMESTAMP(3);

-- Backfill authProvider for existing rows based on googleId prefix (dev: rows)
UPDATE "User" SET "authProvider" = 'DEV' WHERE "googleId" LIKE 'dev:%';

-- CreateIndex
CREATE UNIQUE INDEX "User_appleSub_key" ON "User"("appleSub");
