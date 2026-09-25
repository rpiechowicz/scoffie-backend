-- CreateTable
CREATE TABLE "GdprRequest" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "extendedAt" TIMESTAMP(3),
    "extensionReason" TEXT,
    "requesterEmail" TEXT NOT NULL,
    "userId" UUID,
    "channel" TEXT NOT NULL,
    "notes" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "resolution" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GdprRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GdprRequest_status_dueAt_idx" ON "GdprRequest"("status", "dueAt");

-- CreateIndex
CREATE INDEX "GdprRequest_closedAt_idx" ON "GdprRequest"("closedAt");

-- CreateIndex
CREATE INDEX "GdprRequest_userId_idx" ON "GdprRequest"("userId");

-- AddForeignKey
ALTER TABLE "GdprRequest" ADD CONSTRAINT "GdprRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
