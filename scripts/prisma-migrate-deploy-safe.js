/* eslint-disable no-console */
const { spawnSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const TARGET_FAILED_MIGRATION = '20260216094429_ingredient_catalog_v1';
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const UNKNOWN_INGREDIENT_ID = '00000000-0000-0000-0000-000000000001';
const UNKNOWN_INGREDIENT_NAME = '__unknown_ingredient__';

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

async function hasFailedTargetMigration(prisma) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT migration_name, finished_at, rolled_back_at
      FROM "_prisma_migrations"
      WHERE migration_name = ${TARGET_FAILED_MIGRATION}
      ORDER BY started_at DESC
      LIMIT 1
    `;

    if (!Array.isArray(rows) || rows.length === 0) {
      return false;
    }

    const row = rows[0];
    return !row.finished_at && !row.rolled_back_at;
  } catch (error) {
    // On fresh databases the table may not exist yet.
    return false;
  }
}

async function isIngredientCatalogAlreadyPresent(prisma) {
  const [ingredientTable, aliasTable, recipeIngredientColumn] = await Promise.all([
    prisma.$queryRaw`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'Ingredient'
      ) AS value
    `,
    prisma.$queryRaw`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'IngredientAlias'
      ) AS value
    `,
    prisma.$queryRaw`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'RecipeIngredient'
          AND column_name = 'ingredientId'
      ) AS value
    `,
  ]);

  const ingredientOk = Boolean(Array.isArray(ingredientTable) && ingredientTable[0]?.value);
  const aliasOk = Boolean(Array.isArray(aliasTable) && aliasTable[0]?.value);
  const recipeIngredientColumnOk = Boolean(
    Array.isArray(recipeIngredientColumn) && recipeIngredientColumn[0]?.value,
  );

  if (!ingredientOk || !aliasOk || !recipeIngredientColumnOk) {
    return false;
  }

  const [recipeIngredientColumnNotNull, recipeIngredientNullCount] = await Promise.all([
    prisma.$queryRaw`
      SELECT CASE WHEN is_nullable = 'NO' THEN true ELSE false END AS value
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'RecipeIngredient'
        AND column_name = 'ingredientId'
      LIMIT 1
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::bigint AS value
      FROM "RecipeIngredient"
      WHERE "ingredientId" IS NULL
    `,
  ]);

  const notNullOk = Boolean(
    Array.isArray(recipeIngredientColumnNotNull) && recipeIngredientColumnNotNull[0]?.value,
  );
  const nullCount = Array.isArray(recipeIngredientNullCount)
    ? Number(recipeIngredientNullCount[0]?.value ?? 0)
    : Number.NaN;

  return notNullOk && Number.isFinite(nullCount) && nullCount === 0;
}

async function tableExists(prisma, tableName) {
  const rows = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    ) AS value
  `;

  return Boolean(Array.isArray(rows) && rows[0]?.value);
}

async function ensureRecipeIngredientBaseTable(prisma) {
  const exists = await tableExists(prisma, 'RecipeIngredient');
  if (exists) {
    return;
  }

  console.log(
    '[safe-migrate] Table "RecipeIngredient" is missing. Recreating base table for migration recovery...',
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "RecipeIngredient" (
      "id" UUID NOT NULL,
      "recipeId" UUID NOT NULL,
      "name" TEXT NOT NULL,
      "amount" DOUBLE PRECISION NOT NULL,
      "unit" TEXT NOT NULL,
      "department" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "RecipeIngredient_pkey" PRIMARY KEY ("id")
    );
  `);

  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "RecipeIngredient_recipeId_idx" ON "RecipeIngredient"("recipeId");`,
  );

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'Recipe'
      ) AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'RecipeIngredient_recipeId_fkey'
      ) THEN
        ALTER TABLE "RecipeIngredient"
          ADD CONSTRAINT "RecipeIngredient_recipeId_fkey"
          FOREIGN KEY ("recipeId")
          REFERENCES "Recipe"("id")
          ON DELETE CASCADE
          ON UPDATE CASCADE;
      END IF;
    END
    $$;
  `);
}

async function repairIncompleteIngredientCatalogMigration(prisma) {
  console.log(
    `[safe-migrate] Attempting automatic repair for ${TARGET_FAILED_MIGRATION}...`,
  );

  await ensureRecipeIngredientBaseTable(prisma);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Ingredient" (
      "id" UUID NOT NULL,
      "name" TEXT NOT NULL,
      "category" TEXT NOT NULL,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "Ingredient_name_key" ON "Ingredient"("name");`,
  );

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "IngredientAlias" (
      "id" UUID NOT NULL,
      "ingredientId" UUID NOT NULL,
      "alias" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "IngredientAlias_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "IngredientAlias_alias_key" ON "IngredientAlias"("alias");`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "IngredientAlias_ingredientId_idx" ON "IngredientAlias"("ingredientId");`,
  );
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'IngredientAlias_ingredientId_fkey'
      ) THEN
        ALTER TABLE "IngredientAlias"
          ADD CONSTRAINT "IngredientAlias_ingredientId_fkey"
          FOREIGN KEY ("ingredientId")
          REFERENCES "Ingredient"("id")
          ON DELETE CASCADE
          ON UPDATE CASCADE;
      END IF;
    END
    $$;
  `);

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "RecipeIngredient" ADD COLUMN IF NOT EXISTS "ingredientId" UUID;`,
  );

  await prisma.$executeRawUnsafe(`
    INSERT INTO "Ingredient" ("id", "name", "category", "isActive", "createdAt", "updatedAt")
    SELECT
      (
        substr(md5('ingredient:' || lower(src.name)), 1, 8) || '-' ||
        substr(md5('ingredient:' || lower(src.name)), 9, 4) || '-' ||
        substr(md5('ingredient:' || lower(src.name)), 13, 4) || '-' ||
        substr(md5('ingredient:' || lower(src.name)), 17, 4) || '-' ||
        substr(md5('ingredient:' || lower(src.name)), 21, 12)
      )::uuid,
      src.name,
      'Inne',
      true,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM (
      SELECT DISTINCT btrim("name") AS name
      FROM "RecipeIngredient"
      WHERE btrim("name") <> ''
    ) AS src
    ON CONFLICT ("name") DO NOTHING;
  `);

  await prisma.$executeRawUnsafe(`
    UPDATE "RecipeIngredient" ri
    SET "ingredientId" = i."id"
    FROM "Ingredient" i
    WHERE ri."ingredientId" IS NULL
      AND i."name" = btrim(ri."name");
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "Ingredient" ("id", "name", "category", "isActive", "createdAt", "updatedAt")
    VALUES (
      '${UNKNOWN_INGREDIENT_ID}'::uuid,
      '${UNKNOWN_INGREDIENT_NAME}',
      'Inne',
      true,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("name") DO NOTHING;
  `);

  await prisma.$executeRawUnsafe(`
    UPDATE "RecipeIngredient"
    SET "ingredientId" = '${UNKNOWN_INGREDIENT_ID}'::uuid
    WHERE "ingredientId" IS NULL;
  `);

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "RecipeIngredient" ALTER COLUMN "ingredientId" SET NOT NULL;`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "RecipeIngredient_ingredientId_idx" ON "RecipeIngredient"("ingredientId");`,
  );
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'RecipeIngredient_ingredientId_fkey'
      ) THEN
        ALTER TABLE "RecipeIngredient"
          ADD CONSTRAINT "RecipeIngredient_ingredientId_fkey"
          FOREIGN KEY ("ingredientId")
          REFERENCES "Ingredient"("id")
          ON DELETE RESTRICT
          ON UPDATE CASCADE;
      END IF;
    END
    $$;
  `);

  console.log(`[safe-migrate] Automatic repair for ${TARGET_FAILED_MIGRATION} completed.`);
}

async function main() {
  const prisma = new PrismaClient();

  try {
    const failed = await hasFailedTargetMigration(prisma);

    if (failed) {
      let alreadyApplied = await isIngredientCatalogAlreadyPresent(prisma);

      if (!alreadyApplied) {
        await repairIncompleteIngredientCatalogMigration(prisma);
        alreadyApplied = await isIngredientCatalogAlreadyPresent(prisma);
      }

      if (!alreadyApplied) {
        console.error(
          `[safe-migrate] Migration ${TARGET_FAILED_MIGRATION} is failed and schema is still incomplete after auto-repair. Manual intervention required.`,
        );
        process.exit(1);
      }

      console.log(
        `[safe-migrate] Marking failed migration as applied: ${TARGET_FAILED_MIGRATION}`,
      );
      run(PNPM_BIN, ['prisma', 'migrate', 'resolve', '--applied', TARGET_FAILED_MIGRATION]);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log('[safe-migrate] Running prisma migrate deploy');
  run(PNPM_BIN, ['prisma', 'migrate', 'deploy']);
}

main().catch((error) => {
  console.error('[safe-migrate] Unexpected error:', error);
  process.exit(1);
});
