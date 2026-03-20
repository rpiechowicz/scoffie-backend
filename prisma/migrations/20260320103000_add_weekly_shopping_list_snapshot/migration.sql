CREATE TABLE "ShoppingList" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingList_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShoppingListItem" (
    "id" UUID NOT NULL,
    "shoppingListId" UUID NOT NULL,
    "productKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "isChecked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingListItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShoppingList_householdId_weekStart_key" ON "ShoppingList"("householdId", "weekStart");
CREATE INDEX "ShoppingList_householdId_updatedAt_idx" ON "ShoppingList"("householdId", "updatedAt");

CREATE UNIQUE INDEX "ShoppingListItem_shoppingListId_productKey_key" ON "ShoppingListItem"("shoppingListId", "productKey");
CREATE INDEX "ShoppingListItem_shoppingListId_idx" ON "ShoppingListItem"("shoppingListId");

ALTER TABLE "ShoppingList"
ADD CONSTRAINT "ShoppingList_householdId_fkey"
FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShoppingListItem"
ADD CONSTRAINT "ShoppingListItem_shoppingListId_fkey"
FOREIGN KEY ("shoppingListId") REFERENCES "ShoppingList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
