-- CreateEnum
CREATE TYPE "DietPreferenceValue" AS ENUM ('NONE', 'VEGETARIAN', 'VEGAN', 'PESCATARIAN', 'KETO', 'PALEO');

-- CreateTable
CREATE TABLE "UserPreference" (
    "userId" UUID NOT NULL,
    "dietPreference" "DietPreferenceValue" NOT NULL DEFAULT 'NONE',
    "calorieGoal" INTEGER NOT NULL DEFAULT 2000,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "UserPreference"
    ADD CONSTRAINT "UserPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
