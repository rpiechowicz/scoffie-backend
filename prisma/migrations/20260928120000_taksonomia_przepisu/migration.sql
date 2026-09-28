-- Taksonomia przepisu (katalog 1000, 28.09.2026): kuchnia, rodzaj dania, pory
-- roku, okazje, sprzęt i cechy dla planera. Słowniki i reguły w
-- `src/recipes/recipe-taxonomy.ts`. Same kolumny ze stałymi domyślnymi — w PG
-- 11+ bez przepisywania tabeli i bez wyzwalaczy `CatalogChange` (DDL nie
-- odpala wyzwalaczy wierszy). Wartości katalogu wpisuje OSOBNA migracja
-- danych, bo DDL i DML katalogu nie mogą iść w jednej transakcji
-- (ADR `docs/adr/catalog-change-commit-order.md`, warunek 3).
ALTER TABLE "Recipe"
  ADD COLUMN "cuisine" TEXT NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "dishType" TEXT,
  ADD COLUMN "seasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "occasions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "equipment" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
