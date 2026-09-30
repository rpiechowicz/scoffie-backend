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
--
-- Rollback: DROP TABLE "RecipeCookScenario", DROP TYPE "CookScenarioStatus",
-- ALTER TABLE "Recipe" DROP COLUMN "cookScenarioVersion".

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
