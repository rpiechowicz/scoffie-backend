-- Scenariusze trybu Gotuj (30.09.2026, scoffie-ios docs/workstreams/gotuj/README.md, Etap E2).
--
-- 1. "RecipeCookScenario" — przepis rozpisany na kroki z ilościami, timerami
--    i radami. Wersje rosną w obrębie przepisu; telefon czyta tylko PUBLISHED.
-- 2. Częściowy indeks unikalny: najwyżej JEDEN opublikowany scenariusz na
--    przepis (Prisma nie umie go wyrazić w schemacie — ta sama droga co
--    "RecipeShare_active_key").
-- 3. `Recipe.cookScenarioVersion` — kopia wersji opublikowanego scenariusza.
--    Tabela scenariuszy nie przesuwa logu katalogu, ta kolumna tak (trigger
--    `Recipe_catalog_change` widzi zmianę wiersza), więc telefon dowiaduje się
--    o trybie Gotuj zwykłą deltą. Kolumna startuje jako NULL dla wszystkich
--    przepisów — migracja NIE przesuwa rewizji katalogu.
-- 4. Unieważnianie przy zmianie przepisu (review Codexa, 30.09.2026): telefon
--    trzyma scenariusz offline i pyta ponownie dopiero, gdy zmieni się
--    `cookScenarioVersion` — samo „nie wydawaj nieaktualnego” przy odczycie
--    zostawiało w telefonie stare ilości. Dlatego BAZA, na każdej ścieżce
--    zapisu (aplikacja, panel, import, ręczny SQL — ta sama zasada co log
--    katalogu): gdy podpis treści przepisu (`recipe_content_signature`) różni
--    się od podpisu opublikowanego scenariusza, scenariusz dostaje STALE,
--    a `cookScenarioVersion` wraca do NULL → delta „Gotuj zniknął”.
--    Triggery są ODROCZONE do COMMIT: liczy się stan końcowy transakcji, więc
--    import, który kasuje i wstawia te same składniki, niczego nie unieważnia.
--    Nazwy `…_a_cook_scenario_staleness` sortują się PRZED `…_catalog_change`,
--    więc w obrębie zdarzenia ten trigger działa, zanim transakcja weźmie zamek
--    rewizji katalogu — ewentualne czekanie na wiersz przepisu przypada przed
--    zamkiem (ADR catalog-change-commit-order §6). Żadnego DDL/LOCK w DML.
--
-- Rollback: DROP TRIGGER ×3, DROP FUNCTION ×3, DROP TABLE "RecipeCookScenario",
-- DROP TYPE "CookScenarioStatus", ALTER TABLE "Recipe" DROP COLUMN "cookScenarioVersion".

-- CreateEnum
CREATE TYPE "CookScenarioStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED', 'RETIRED', 'REJECTED', 'STALE', 'SKIPPED');

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN     "cookScenarioVersion" INTEGER;

-- CreateTable
CREATE TABLE "RecipeCookScenario" (
    "id" UUID NOT NULL,
    "recipeId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CookScenarioStatus" NOT NULL,
    "recipeContentHash" TEXT NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "content" JSONB,
    "skipReason" TEXT,
    "generator" JSONB,
    "validationReport" JSONB,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeCookScenario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecipeCookScenario_recipeId_status_idx" ON "RecipeCookScenario"("recipeId", "status");

-- CreateIndex
CREATE INDEX "RecipeCookScenario_status_idx" ON "RecipeCookScenario"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeCookScenario_recipeId_version_key" ON "RecipeCookScenario"("recipeId", "version");

-- AddForeignKey
ALTER TABLE "RecipeCookScenario" ADD CONSTRAINT "RecipeCookScenario_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Najwyżej jeden opublikowany scenariusz na przepis. Dwie publikacje naraz
-- (panel + skrypt) kończą się błędem unikalności zamiast dwóch „obowiązujących”.
CREATE UNIQUE INDEX "RecipeCookScenario_published_key" ON "RecipeCookScenario"("recipeId") WHERE "status" = 'PUBLISHED';

-- Podpis TREŚCI przepisu, na której opiera się scenariusz: tytuł, porcje,
-- kroki (jsonb — kanoniczna kolejność kluczy) i składniki (id, ilość,
-- jednostka; posortowane, bo kolejność wierszy nie jest treścią). Zdjęcie,
-- makro, tagi i taksonomia nie wchodzą — ich zmiana nie unieważnia kroków.
-- NULL = przepisu nie ma. Liczy go też publikacja (`publishCookScenario`),
-- więc porównanie odbywa się jedną definicją.
CREATE OR REPLACE FUNCTION recipe_content_signature(p_recipe UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT 'md5:' || md5(concat_ws(
    E'\x1f',
    r."title",
    r."servings"::text,
    coalesce(r."sourceInstructions"::text, 'null'),
    coalesce(
      (SELECT string_agg(
          concat_ws(':', ri."ingredientId"::text, ri."amount"::text, ri."unit"),
          ',' ORDER BY ri."ingredientId", ri."amount", ri."unit")
         FROM "RecipeIngredient" ri
        WHERE ri."recipeId" = r."id"),
      '')
  ))
  FROM "Recipe" r
  WHERE r."id" = p_recipe
$$;

-- Sprawdzenie JEDNEGO przepisu: opublikowany scenariusz z innym podpisem niż
-- bieżący → STALE i `cookScenarioVersion` = NULL.
CREATE OR REPLACE FUNCTION cook_scenario_check(target UUID) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  published TEXT;
  current_signature TEXT;
BEGIN
  -- NAJPIERW blokada wiersza przepisu, dopiero potem odczyt (review Codexa,
  -- runda 3). Bez niej pierwsza publikacja (`publishCookScenario` trzyma
  -- `FOR UPDATE` i czyta stare składniki) i zmiana składnika zatwierdzana
  -- w tym samym czasie mijały się: ten trigger nie widział jeszcze
  -- niezatwierdzonego scenariusza, a publikacja nie widziała nowych ilości —
  -- scenariusz ze starymi ilościami zostawał opublikowany na stałe. Z blokadą
  -- czekamy na publikację i porównujemy już z nią. Kolejne instrukcje
  -- (READ COMMITTED) widzą to, co zatwierdziła.
  PERFORM 1 FROM "Recipe" WHERE "id" = target FOR NO KEY UPDATE;

  SELECT s."recipeContentHash" INTO published
    FROM "RecipeCookScenario" s
   WHERE s."recipeId" = target AND s."status" = 'PUBLISHED';
  IF published IS NULL THEN
    RETURN;
  END IF;
  current_signature := recipe_content_signature(target);
  -- Przepis skasowany w tej transakcji (kaskada) — scenariusze odejdą z nim.
  IF current_signature IS NULL OR current_signature = published THEN
    RETURN;
  END IF;

  -- Kolejność blokad jak w `publishCookScenario`: wiersz przepisu, potem
  -- scenariusze.
  UPDATE "Recipe"
     SET "cookScenarioVersion" = NULL
   WHERE "id" = target AND "cookScenarioVersion" IS NOT NULL;
  UPDATE "RecipeCookScenario"
     SET "status" = 'STALE', "updatedAt" = CURRENT_TIMESTAMP
   WHERE "recipeId" = target AND "status" = 'PUBLISHED';
END;
$$;

CREATE OR REPLACE FUNCTION cook_scenario_staleness() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Recipe' THEN
    PERFORM cook_scenario_check(NEW."id");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM cook_scenario_check(OLD."recipeId");
  ELSE
    PERFORM cook_scenario_check(NEW."recipeId");
    -- Składnik przeniesiony do innego przepisu zmienia OBA — jak w
    -- `catalog_change_from_recipe_ingredient` (review Codexa, 30.09.2026).
    IF TG_OP = 'UPDATE' AND OLD."recipeId" IS DISTINCT FROM NEW."recipeId" THEN
      PERFORM cook_scenario_check(OLD."recipeId");
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Przepis: tylko pola z podpisu i tylko gdy ma opublikowany scenariusz.
-- Sama publikacja (zmiana `cookScenarioVersion`) warunku nie spełnia.
CREATE CONSTRAINT TRIGGER "Recipe_a_cook_scenario_staleness"
AFTER UPDATE ON "Recipe"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  NEW."cookScenarioVersion" IS NOT NULL
  AND (
    OLD."title" IS DISTINCT FROM NEW."title"
    OR OLD."servings" IS DISTINCT FROM NEW."servings"
    OR OLD."sourceInstructions" IS DISTINCT FROM NEW."sourceInstructions"
  )
)
EXECUTE FUNCTION cook_scenario_staleness();

-- Składniki: dodanie i usunięcie zawsze; zmiana tylko wtedy, gdy dotyka
-- podpisu (przepis, składnik, ilość, jednostka) — hurtowa poprawka nazw
-- (`normalize-ingredients-polish`) nie blokuje wierszy przepisów.
CREATE CONSTRAINT TRIGGER "RecipeIngredient_a_cook_scenario_staleness"
AFTER INSERT OR DELETE ON "RecipeIngredient"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION cook_scenario_staleness();

CREATE CONSTRAINT TRIGGER "RecipeIngredient_a_cook_scenario_staleness_upd"
AFTER UPDATE ON "RecipeIngredient"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD."recipeId" IS DISTINCT FROM NEW."recipeId"
  OR OLD."ingredientId" IS DISTINCT FROM NEW."ingredientId"
  OR OLD."amount" IS DISTINCT FROM NEW."amount"
  OR OLD."unit" IS DISTINCT FROM NEW."unit"
)
EXECUTE FUNCTION cook_scenario_staleness();
