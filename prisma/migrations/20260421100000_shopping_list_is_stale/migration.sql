-- AlterTable: add isStale flag to defer rebuild of shopping list snapshot until it's actually read
ALTER TABLE "ShoppingList" ADD COLUMN "isStale" BOOLEAN NOT NULL DEFAULT false;
