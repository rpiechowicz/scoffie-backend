-- Udostępnianie przepisów linkiem (29.09.2026, docs/plans/udostepnianie-przepisow).
--
-- 1. `Recipe.slug` — adres przepisu KATALOGU na stronie
--    (`scoffie.app/przepis/<slug>`). Nadaje go TRIGGER, nie kod: katalog
--    zapisują import JSON, panel admina, skrypty zdjęć i ręczny SQL, a każda
--    z tych dróg ma dać przepis z adresem (ta sama zasada co log katalogu,
--    20260926200000_catalog_sync_log). Slug liczy się z tytułu RAZ — zmiana
--    tytułu go nie rusza, bo wysłane linki mają działać. Świadoma zmiana
--    slugu (panel) zostawia stary w "RecipeSlugAlias" → strona robi 301.
-- 2. "RecipeShare" — link do przepisu GOSPODARSTWA (`/przepis/u/<token>`),
--    jeden aktywny na (przepis, dom).
-- 3. "RecipeShareEvent" — liczniki dla panelu, bez osób i domów.
-- 4. `Recipe.copiedFromRecipeId` — kopia „Zapisz u siebie”.
--
-- Nadanie slugów istniejącym przepisom katalogu przesuwa rewizję katalogu
-- (trigger logu widzi zmianę wiersza) — telefony dociągną adresy zwykłą deltą.
-- Rollback: DROP TRIGGER "Recipe_assign_slug", DROP FUNCTION ×2, DROP TABLE ×3,
-- DROP TYPE, DROP COLUMN ×2.

-- CreateEnum
CREATE TYPE "RecipeShareEventKind" AS ENUM ('SHARED', 'OPENED', 'SAVED');

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN     "copiedFromRecipeId" UUID,
ADD COLUMN     "slug" TEXT;

-- CreateTable
CREATE TABLE "RecipeSlugAlias" (
    "slug" TEXT NOT NULL,
    "recipeId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeSlugAlias_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "RecipeShare" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "recipeId" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RecipeShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeShareEvent" (
    "id" UUID NOT NULL,
    "recipeId" UUID NOT NULL,
    "kind" "RecipeShareEventKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeShareEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_slug_key" ON "Recipe"("slug");

-- CreateIndex
CREATE INDEX "Recipe_copiedFromRecipeId_householdId_idx" ON "Recipe"("copiedFromRecipeId", "householdId");

-- CreateIndex
CREATE INDEX "RecipeSlugAlias_recipeId_idx" ON "RecipeSlugAlias"("recipeId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeShare_token_key" ON "RecipeShare"("token");

-- CreateIndex
CREATE INDEX "RecipeShare_recipeId_householdId_idx" ON "RecipeShare"("recipeId", "householdId");

-- CreateIndex
CREATE INDEX "RecipeShare_householdId_idx" ON "RecipeShare"("householdId");

-- CreateIndex
CREATE INDEX "RecipeShareEvent_recipeId_kind_idx" ON "RecipeShareEvent"("recipeId", "kind");

-- CreateIndex
CREATE INDEX "RecipeShareEvent_createdAt_idx" ON "RecipeShareEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_copiedFromRecipeId_fkey" FOREIGN KEY ("copiedFromRecipeId") REFERENCES "Recipe"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeSlugAlias" ADD CONSTRAINT "RecipeSlugAlias_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeShare" ADD CONSTRAINT "RecipeShare_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeShare" ADD CONSTRAINT "RecipeShare_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeShare" ADD CONSTRAINT "RecipeShare_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeShareEvent" ADD CONSTRAINT "RecipeShareEvent_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Jeden AKTYWNY link na (przepis, dom): ponowne „Udostępnij” (też z telefonu
-- innego domownika) oddaje ten sam adres, a wyścig dwóch pierwszych kliknięć
-- kończy się jednym wierszem, nie dwoma linkami. Wyłączone zostają w historii.
CREATE UNIQUE INDEX "RecipeShare_active_key" ON "RecipeShare"("recipeId", "householdId") WHERE "revokedAt" IS NULL;

-- Slug z tytułu: polskie (i najczęstsze zachodnie) litery → ASCII, wszystko
-- poza [a-z0-9] → „-”, najwyżej 80 znaków (dłuższy tytuł ucina się na
-- granicy słowa). `translate` PRZED `lower`, żeby wynik nie zależał od
-- ustawień locale bazy (lower('Ą') w locale C to 'Ą'). Pusty wynik (tytuł
-- z samych znaków spoza alfabetu) → „przepis”.
CREATE FUNCTION recipe_slug_base(title TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  WITH full_slug AS (
    SELECT trim(BOTH '-' FROM regexp_replace(
      lower(translate(
        title,
        'ąćęłńóśźżĄĆĘŁŃÓŚŹŻàáâäãåèéêëìíîïòôöõùúûüýÿçñšžčřďťňůőűÀÁÂÄÃÅÈÉÊËÌÍÎÏÒÔÖÕÙÚÛÜÝÇÑŠŽČŘĎŤŇŮŐŰ',
        'acelnoszzACELNOSZZaaaaaaeeeeiiiioooouuuuyycnszcrdtnuouAAAAAAEEEEIIIIOOOOUUUUYCNSZCRDTNUOU'
      )),
      '[^a-z0-9]+', '-', 'g'
    )) AS v
  )
  SELECT COALESCE(
    NULLIF(
      CASE
        WHEN length(v) <= 80 THEN v
        ELSE trim(BOTH '-' FROM left(regexp_replace(left(v, 81), '-[^-]*$', ''), 80))
      END,
      ''
    ),
    'przepis'
  )
  FROM full_slug
$$;

-- BEFORE INSERT/UPDATE na "Recipe":
--  * slug zmieniony z niepustego → stary trafia do aliasów tego przepisu;
--  * slug podany wprost nie może być aliasem INNEGO przepisu (23505, jak
--    naruszenie unikalności); powrót do własnego starego adresu zdejmuje alias;
--  * przepis katalogu bez slugu dostaje go z tytułu, z sufiksem -2, -3…,
--    gdy adres jest zajęty (przez przepis albo cudzy alias).
-- Wiersze wcześniej przetworzone w tym samym poleceniu są widoczne dla
-- zapytań triggera BEFORE, więc wsadowe nadanie nie daje duplikatów.
CREATE FUNCTION recipe_assign_slug() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  base TEXT;
  candidate TEXT;
  n INTEGER := 1;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."slug" IS NOT NULL
     AND NEW."slug" IS DISTINCT FROM OLD."slug" THEN
    INSERT INTO "RecipeSlugAlias" ("slug", "recipeId")
    VALUES (OLD."slug", NEW."id")
    ON CONFLICT ("slug") DO NOTHING;
  END IF;

  IF NEW."slug" IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM "RecipeSlugAlias"
      WHERE "slug" = NEW."slug" AND "recipeId" <> NEW."id"
    ) THEN
      RAISE EXCEPTION 'Recipe slug "%" is an alias of another recipe', NEW."slug"
        USING ERRCODE = 'unique_violation';
    END IF;
    DELETE FROM "RecipeSlugAlias"
    WHERE "slug" = NEW."slug" AND "recipeId" = NEW."id";
    RETURN NEW;
  END IF;

  IF NOT NEW."isCatalog" THEN
    RETURN NEW;
  END IF;

  base := recipe_slug_base(NEW."title");
  candidate := base;
  WHILE EXISTS (
          SELECT 1 FROM "Recipe" WHERE "slug" = candidate AND "id" <> NEW."id"
        )
     OR EXISTS (
          SELECT 1 FROM "RecipeSlugAlias"
          WHERE "slug" = candidate AND "recipeId" <> NEW."id"
        ) LOOP
    n := n + 1;
    candidate := trim(BOTH '-' FROM left(base, 80 - length(n::TEXT) - 1)) || '-' || n;
  END LOOP;
  DELETE FROM "RecipeSlugAlias"
  WHERE "slug" = candidate AND "recipeId" = NEW."id";
  NEW."slug" := candidate;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Recipe_assign_slug"
BEFORE INSERT OR UPDATE OF "slug", "isCatalog", "title" ON "Recipe"
FOR EACH ROW EXECUTE FUNCTION recipe_assign_slug();

-- Istniejący katalog: po kolei (najstarsze pierwsze), żeby przy dwóch
-- przepisach o tym samym tytule sufiks -2 dostał młodszy — tak samo, jak
-- przy imporcie na czystą bazę.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT "id" FROM "Recipe"
    WHERE "isCatalog" AND "slug" IS NULL
    ORDER BY "createdAt", "id"
  LOOP
    UPDATE "Recipe" SET "slug" = NULL WHERE "id" = r."id";
  END LOOP;
END;
$$;
