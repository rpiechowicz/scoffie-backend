CREATE TABLE "ShoppingListArchive" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "weekLabel" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingListArchive_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShoppingListArchiveItem" (
    "id" UUID NOT NULL,
    "archiveId" UUID NOT NULL,
    "productKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "isChecked" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingListArchiveItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShoppingListArchiveState" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "currentArchiveId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingListArchiveState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShoppingListArchive_householdId_weekStart_revision_key" ON "ShoppingListArchive"("householdId", "weekStart", "revision");
CREATE UNIQUE INDEX "ShoppingListArchive_householdId_weekStart_signature_key" ON "ShoppingListArchive"("householdId", "weekStart", "signature");
CREATE INDEX "ShoppingListArchive_householdId_archivedAt_idx" ON "ShoppingListArchive"("householdId", "archivedAt");
CREATE INDEX "ShoppingListArchive_householdId_weekStart_idx" ON "ShoppingListArchive"("householdId", "weekStart");

CREATE UNIQUE INDEX "ShoppingListArchiveItem_archiveId_productKey_key" ON "ShoppingListArchiveItem"("archiveId", "productKey");
CREATE INDEX "ShoppingListArchiveItem_archiveId_idx" ON "ShoppingListArchiveItem"("archiveId");

CREATE UNIQUE INDEX "ShoppingListArchiveState_householdId_weekStart_key" ON "ShoppingListArchiveState"("householdId", "weekStart");
CREATE INDEX "ShoppingListArchiveState_householdId_currentArchiveId_idx" ON "ShoppingListArchiveState"("householdId", "currentArchiveId");

ALTER TABLE "ShoppingListArchive"
ADD CONSTRAINT "ShoppingListArchive_householdId_fkey"
FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShoppingListArchiveItem"
ADD CONSTRAINT "ShoppingListArchiveItem_archiveId_fkey"
FOREIGN KEY ("archiveId") REFERENCES "ShoppingListArchive"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShoppingListArchiveState"
ADD CONSTRAINT "ShoppingListArchiveState_householdId_fkey"
FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShoppingListArchiveState"
ADD CONSTRAINT "ShoppingListArchiveState_currentArchiveId_fkey"
FOREIGN KEY ("currentArchiveId") REFERENCES "ShoppingListArchive"("id") ON DELETE SET NULL ON UPDATE CASCADE;
