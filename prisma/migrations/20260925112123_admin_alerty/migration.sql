-- CreateTable
CREATE TABLE "AdminAlert" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,

    CONSTRAINT "AdminAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminAlert_key_key" ON "AdminAlert"("key");

-- CreateIndex
CREATE INDEX "AdminAlert_resolvedAt_idx" ON "AdminAlert"("resolvedAt");

-- CreateIndex
CREATE INDEX "AdminAlert_lastAt_idx" ON "AdminAlert"("lastAt");
