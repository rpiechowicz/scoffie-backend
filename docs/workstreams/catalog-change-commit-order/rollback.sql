-- PROCEDURA AWARYJNA / REFERENCYJNA dla 20260927090000_catalog_change_commit_order
-- (N2-1). To NIE jest standardowy rollback produkcyjny.
--
-- Migracje produkcyjne są forward-only. Zwykłe wycofanie po deployu = NOWA
-- migracja korygująca z późniejszym znacznikiem czasu (np. ten sam DDL co niżej
-- w `prisma/migrations/<późniejszy_znacznik>_…/migration.sql`), wdrożona zwykłym
-- deployem — Prisma i obiekty bazy zostają zgodne.
--
-- Ręczne uruchomienie tego pliku rozjeżdża stan: Prisma nadal widzi migrację
-- jako zastosowaną, a triggery/funkcje w bazie są z poprzedniej wersji. Nie
-- poprawiać tego edycją "_prisma_migrations". Tylko w awarii, gdy nie da się
-- szybko wdrożyć migracji korygującej — a potem i tak ją wdrożyć.
--
-- Przywraca stan z 20260926200000_catalog_sync_log: funkcje bez zamka i zwykłe
-- triggery AFTER ... FOR EACH ROW (numer w chwili DML — WRACA wyścig N2-1).
-- Jedna transakcja; dane logu bez zmian.
BEGIN;
DROP TRIGGER "Recipe_catalog_change" ON "Recipe";
DROP TRIGGER "RecipeIngredient_catalog_change" ON "RecipeIngredient";

CREATE OR REPLACE FUNCTION catalog_change_from_recipe() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."isCatalog" THEN
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
  INSERT INTO "CatalogChange" ("recipeId", "kind")
  VALUES (
    NEW."id",
    CASE WHEN NEW."isCatalog" AND NEW."isActive" THEN 'UPSERT' ELSE 'DELETE' END
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Recipe_catalog_change"
AFTER INSERT OR UPDATE OR DELETE ON "Recipe"
FOR EACH ROW EXECUTE FUNCTION catalog_change_from_recipe();

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
    INSERT INTO "CatalogChange" ("recipeId", "kind")
    VALUES (target, CASE WHEN active THEN 'UPSERT' ELSE 'DELETE' END);
  END IF;
  -- Składnik przeniesiony do innego przepisu (rzadkie) — stary też się zmienił.
  IF TG_OP = 'UPDATE' AND OLD."recipeId" <> NEW."recipeId" THEN
    SELECT "isCatalog", "isActive" INTO catalog, active FROM "Recipe" WHERE "id" = OLD."recipeId";
    IF catalog IS TRUE THEN
      INSERT INTO "CatalogChange" ("recipeId", "kind")
      VALUES (OLD."recipeId", CASE WHEN active THEN 'UPSERT' ELSE 'DELETE' END);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "RecipeIngredient_catalog_change"
AFTER INSERT OR UPDATE OR DELETE ON "RecipeIngredient"
FOR EACH ROW EXECUTE FUNCTION catalog_change_from_recipe_ingredient();

DROP FUNCTION catalog_change_revision_lock();
COMMIT;
