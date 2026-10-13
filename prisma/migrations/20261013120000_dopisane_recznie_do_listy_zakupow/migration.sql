-- Produkty dopisane do listy zakupów RĘCZNIE (arkusz „Dodaj produkty”): z katalogu
-- albo pod własną nazwą. Trzecie źródło listy obok `PlanItem` i `ShoppingListExtra`,
-- sumowane pod tym samym `productKey`. Nowa tabela, nic istniejącego się nie zmienia —
-- stara wersja aplikacji jej nie wywołuje i działa dalej (rollback bez migracji w dół).

CREATE TABLE "ShoppingListManualItem" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "nameKey" TEXT NOT NULL,
    "ingredientId" UUID,
    "name" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "amount" DOUBLE PRECISION,
    "unit" TEXT,
    "addedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingListManualItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShoppingListManualItem_householdId_weekStart_nameKey_key" ON "ShoppingListManualItem"("householdId", "weekStart", "nameKey");
CREATE INDEX "ShoppingListManualItem_householdId_updatedAt_idx" ON "ShoppingListManualItem"("householdId", "updatedAt");
CREATE INDEX "ShoppingListManualItem_ingredientId_idx" ON "ShoppingListManualItem"("ingredientId");
CREATE INDEX "ShoppingListManualItem_addedById_idx" ON "ShoppingListManualItem"("addedById");

ALTER TABLE "ShoppingListManualItem"
ADD CONSTRAINT "ShoppingListManualItem_householdId_fkey"
FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShoppingListManualItem"
ADD CONSTRAINT "ShoppingListManualItem_ingredientId_fkey"
FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ShoppingListManualItem"
ADD CONSTRAINT "ShoppingListManualItem_addedById_fkey"
FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Wykonane dopisania po identyfikatorze operacji z telefonu — ponowienie po
-- zgubionym ACK oddaje poprzedni wynik zamiast dokładać ilość drugi raz.
CREATE TABLE "ShoppingListAddRequest" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "added" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShoppingListAddRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShoppingListAddRequest_householdId_createdAt_idx" ON "ShoppingListAddRequest"("householdId", "createdAt");

ALTER TABLE "ShoppingListAddRequest"
ADD CONSTRAINT "ShoppingListAddRequest_householdId_fkey"
FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
