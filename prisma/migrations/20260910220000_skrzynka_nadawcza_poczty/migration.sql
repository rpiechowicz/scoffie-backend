-- Skrzynka nadawcza poczty transakcyjnej.
-- MailMessage: jeden wiersz = jeden mail do wyslania, z kluczem idempotencji.
-- MailSuppression: adresy po twardym odrzucie i skargach — nigdy wiecej.
-- FK na User jest SET NULL, bo mail pozegnalny musi przezyc skasowanie konta.

-- CreateEnum
CREATE TYPE "MailStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "MailMessage" (
    "id" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "userId" UUID,
    "payload" JSONB NOT NULL,
    "status" "MailStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "subject" TEXT,
    "sentAt" TIMESTAMP(3),
    "scrubbedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailSuppression" (
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailSuppression_pkey" PRIMARY KEY ("email")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_dedupeKey_key" ON "MailMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "MailMessage_status_nextAttemptAt_idx" ON "MailMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "MailMessage_userId_idx" ON "MailMessage"("userId");

-- CreateIndex
CREATE INDEX "MailMessage_sentAt_idx" ON "MailMessage"("sentAt");

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

