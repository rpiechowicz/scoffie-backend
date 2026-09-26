-- Synchronizacja publicznego katalogu (workstream, Etap 4A): trwały,
-- monotoniczny log zmian przepisów KATALOGU (`isCatalog = true`).
--
-- Log wypełniają TRIGGERY na "Recipe" i "RecipeIngredient", a nie kod
-- aplikacji: katalog zmienia panel admina, import JSON, loader tagów,
-- skrypty zdjęć i ręczny SQL — każda z tych dróg musi przesunąć rewizję,
-- a trigger jest jedynym miejscem, którego żadna z nich nie ominie.
-- Przepisy gospodarstw (`isCatalog = false`) i ulubione ("RecipeFavorite")
-- NIE trafiają do logu.
--
-- Addytywnie: nowe tabele, funkcje i triggery; istniejące dane bez zmian.
-- Rollback: DROP TRIGGER ×2, DROP FUNCTION ×2, DROP TABLE ×2 (klienci wracają
-- do pełnego `recipes:findAll`, który zostaje bez zmian).

CREATE TABLE "CatalogChange" (
    "revision" BIGSERIAL NOT NULL,
    "recipeId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogChange_pkey" PRIMARY KEY ("revision"),
    CONSTRAINT "CatalogChange_kind_check" CHECK ("kind" IN ('UPSERT', 'DELETE'))
);

CREATE INDEX "CatalogChange_recipeId_revision_idx" ON "CatalogChange"("recipeId", "revision");

-- Jeden wiersz: epoka (zmienia się przy odtworzeniu/wyczyszczeniu logu —
-- klient ze starą epoką dostaje RESET_REQUIRED) i najniższa rewizja, od której
-- delta jest kompletna (podnoszona przy ewentualnym czyszczeniu historii).
CREATE TABLE "CatalogSyncState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "epoch" UUID NOT NULL DEFAULT gen_random_uuid(),
    "minRevision" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogSyncState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CatalogSyncState_single_row" CHECK ("id" = 1)
);

INSERT INTO "CatalogSyncState" ("id") VALUES (1);

CREATE FUNCTION catalog_change_from_recipe() RETURNS trigger
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

CREATE FUNCTION catalog_change_from_recipe_ingredient() RETURNS trigger
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

-- Etap 4D: wiadomości tury (`getTurn` DONE, anulowanie, poprawka pytania)
-- szły seq scanem po całej tabeli — 11,5 ms przy 200 tys. wierszy (EXPLAIN
-- w raporcie 04), liniowo z historią wszystkich rozmów.
CREATE INDEX "AgentMessage_turnId_idx" ON "AgentMessage"("turnId");
