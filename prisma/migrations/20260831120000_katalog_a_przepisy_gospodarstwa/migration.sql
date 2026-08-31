-- Rozdzielenie KATALOGU od przepisów gospodarstwa (Faza 0, krok 3: „zawężenie
-- katalogu / isCatalog"; audyt 3.3, „Przepisy globalne między gospodarstwami").
--
-- Do tej pory `Recipe` nie miał żadnego pojęcia widoczności: `findAll` czytał
-- bez `householdId`, a katalog rozpoznawało się po magicznym id gospodarstwa
-- `22222222-…`. Dopóki przepisy tworzył wyłącznie bot importu, nikomu to nie
-- przeszkadzało. Z chwilą, gdy pisać zacznie asystent, pierwszy `recipes:create`
-- dla domu A trafiłby na listę domu B — nieodwracalnie, bo nie ma czym tego
-- odróżnić po fakcie.
--
-- Backfill przez DEFAULT przy ADD COLUMN, a nie osobnym UPDATE-em: wiersze,
-- które istnieją TERAZ, są dziś widoczne dla wszystkich, więc stają się
-- katalogiem — zero regresji widoczności. Nowe wiersze mają już `false`.
-- Zapis jest przy tym idempotentny: ponowne uruchomienie nie oznaczy
-- katalogiem przepisów, które gospodarstwa utworzą po tej migracji (osobny
-- UPDATE właśnie to by zrobił).
ALTER TABLE "Recipe"
  ADD COLUMN IF NOT EXISTS "isCatalog" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Recipe"
  ALTER COLUMN "isCatalog" SET DEFAULT false;

-- Zapytania o widoczność filtrują po `householdId` (druga gałąź OR); katalog
-- osobnego indeksu nie potrzebuje, bo `isCatalog` jest niskoselektywne.
CREATE INDEX IF NOT EXISTS "Recipe_householdId_idx" ON "Recipe"("householdId");
