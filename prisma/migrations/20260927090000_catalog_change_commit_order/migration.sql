-- Kolejność rewizji `CatalogChange` = kolejność commitów (workstream N2-1,
-- ADR `docs/adr/catalog-change-commit-order.md`).
--
-- Problem: rewizja (BIGSERIAL) była nadawana w chwili DML, a wiersz logu
-- stawał się widoczny w chwili COMMIT. Transakcja z NIŻSZYM numerem, która
-- zatwierdziła się PÓŹNIEJ, lądowała poniżej kursora zapisanego już przez
-- klienta — delta `revision > kursor` gubiła ją na zawsze.
--
-- Poprawka: triggery logu stają się ODROCZONE do COMMIT (constraint trigger
-- DEFERRABLE INITIALLY DEFERRED), a funkcje przed nadaniem numeru biorą zamek
-- doradczy transakcji. Numer powstaje więc w fazie commitu, pod zamkiem
-- trzymanym do końca commitu — kolejność numerów = kolejność widoczności.
-- Zamek bierze wyłącznie transakcja, która zmieniła wiersz KATALOGU (przepisy
-- domów wychodzą z funkcji wcześniej). W fazie commitu posiadacz zamka nie
-- czeka na blokady wierszy innych transakcji (tylko INSERT do logu i odczyt
-- MVCC przepisu) — cykl „wiersz ↔ zamek” jest niemożliwy (ADR §6).
--
-- Reguła operacyjna: NIE łączyć w jednej transakcji DDL / LOCK TABLE /
-- TRUNCATE na "Recipe", "RecipeIngredient", "CatalogChange" ze zmianami
-- wierszy katalogu. Nie używać `SET CONSTRAINTS ... IMMEDIATE` dla tych
-- triggerów.
--
-- Bez zmian tabel, danych, API ani formatu kursora.
-- Rollback: funkcje z 20260926200000_catalog_sync_log (bez zamka) i zwykłe
-- triggery AFTER ... FOR EACH ROW (SQL w raporcie workstreamu).

-- Zamek numerowania: klucz dwuczęściowy w przestrzeni 0x63617473 ('cats'),
-- rozłącznej z kluczami logowania panelu ('adm1', 'adm2'). Czekanie powyżej
-- 100 ms trafia do logu serwera Postgres (sama liczba ms, bez danych).
CREATE OR REPLACE FUNCTION catalog_change_revision_lock() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  started timestamptz := clock_timestamp();
  waited_ms numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(1667331187, 1);
  waited_ms := extract(epoch FROM clock_timestamp() - started) * 1000;
  IF waited_ms > 100 THEN
    RAISE LOG 'catalog_change: czekanie na zamek rewizji % ms', round(waited_ms);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION catalog_change_from_recipe() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isCatalog" THEN
      PERFORM catalog_change_revision_lock();
      INSERT INTO "CatalogChange" ("recipeId", "kind") VALUES (OLD."id", 'DELETE');
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NOT (OLD."isCatalog" OR NEW."isCatalog") THEN
      RETURN NEW;
    END IF;
    -- Zapis bez zmiany treści (sam `updatedAt`) nie przesuwa rewizji.
    IF (to_jsonb(NEW) - 'updatedAt') = (to_jsonb(OLD) - 'updatedAt') THEN
      RETURN NEW;
    END IF;
  ELSIF NOT NEW."isCatalog" THEN
    RETURN NEW;
  END IF;
  PERFORM catalog_change_revision_lock();
  INSERT INTO "CatalogChange" ("recipeId", "kind")
  VALUES (
    NEW."id",
    CASE WHEN NEW."isCatalog" AND NEW."isActive" THEN 'UPSERT' ELSE 'DELETE' END
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION catalog_change_from_recipe_ingredient() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target UUID;
  catalog BOOLEAN;
  active BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'updatedAt') = (to_jsonb(OLD) - 'updatedAt') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    target := OLD."recipeId";
  ELSE
    target := NEW."recipeId";
  END IF;
  SELECT "isCatalog", "isActive" INTO catalog, active FROM "Recipe" WHERE "id" = target;
  IF catalog IS TRUE THEN
    PERFORM catalog_change_revision_lock();
    INSERT INTO "CatalogChange" ("recipeId", "kind")
    VALUES (target, CASE WHEN active THEN 'UPSERT' ELSE 'DELETE' END);
  END IF;
  -- Składnik przeniesiony do innego przepisu (rzadkie) — stary też się zmienił.
  IF TG_OP = 'UPDATE' AND OLD."recipeId" <> NEW."recipeId" THEN
    SELECT "isCatalog", "isActive" INTO catalog, active FROM "Recipe" WHERE "id" = OLD."recipeId";
    IF catalog IS TRUE THEN
      PERFORM catalog_change_revision_lock();
      INSERT INTO "CatalogChange" ("recipeId", "kind")
      VALUES (OLD."recipeId", CASE WHEN active THEN 'UPSERT' ELSE 'DELETE' END);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER "Recipe_catalog_change" ON "Recipe";
DROP TRIGGER "RecipeIngredient_catalog_change" ON "RecipeIngredient";

CREATE CONSTRAINT TRIGGER "Recipe_catalog_change"
AFTER INSERT OR UPDATE OR DELETE ON "Recipe"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION catalog_change_from_recipe();

CREATE CONSTRAINT TRIGGER "RecipeIngredient_catalog_change"
AFTER INSERT OR UPDATE OR DELETE ON "RecipeIngredient"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION catalog_change_from_recipe_ingredient();
