-- Pozycje dopisane do listy zakupów spoza planu („brakuje mi" ze szczegółu
-- przepisu). Drugie źródło listy obok `PlanItem`, sumowane pod tym samym
-- `productKey`. Nowa tabela, nic istniejącego się nie zmienia — stara wersja
-- aplikacji jej nie widzi i działa dalej (rollback bez migracji w dół).

CREATE TABLE "ShoppingListExtra" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "recipeId" UUID NOT NULL,
    "productKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShoppingListExtra_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShoppingListExtra_householdId_weekStart_recipeId_productKey_key" ON "ShoppingListExtra"("householdId", "weekStart", "recipeId", "productKey");
CREATE INDEX "ShoppingListExtra_householdId_weekStart_idx" ON "ShoppingListExtra"("householdId", "weekStart");
CREATE INDEX "ShoppingListExtra_recipeId_idx" ON "ShoppingListExtra"("recipeId");

ALTER TABLE "ShoppingListExtra"
ADD CONSTRAINT "ShoppingListExtra_householdId_fkey"
FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShoppingListExtra"
ADD CONSTRAINT "ShoppingListExtra_recipeId_fkey"
FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;
