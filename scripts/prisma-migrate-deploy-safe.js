/* eslint-disable no-console */
const { spawnSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const TARGET_FAILED_MIGRATION = '20260216094429_ingredient_catalog_v1';
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const UNKNOWN_INGREDIENT_ID = '00000000-0000-0000-0000-000000000001';
const UNKNOWN_INGREDIENT_NAME = '__unknown_ingredient__';

function run(command, args, allowedStatuses = [0]) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  const status = typeof result.status === 'number' ? result.status : 1;
  if (!allowedStatuses.includes(status)) {
    process.exit(result.status);
  }

  return status;
}

async function getFailedMigrations(prisma) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT migration_name, started_at
      FROM "_prisma_migrations"
      WHERE finished_at IS NULL
        AND rolled_back_at IS NULL
      ORDER BY started_at ASC
    `;

    if (!Array.isArray(rows)) {
      return [];
    }

    const names = rows
      .map((row) => row?.migration_name)
      .filter((name) => typeof name === 'string' && name.length > 0);

    return Array.from(new Set(names));
  } catch (error) {
    // On fresh databases the table may not exist yet.
    return [];
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
  let failedMigrations = [];

  try {
    failedMigrations = await getFailedMigrations(prisma);

    if (failedMigrations.length > 0) {
      console.log(
        `[safe-migrate] Failed migrations detected: ${failedMigrations.join(', ')}`,
      );
    }

    if (failedMigrations.includes(TARGET_FAILED_MIGRATION)) {
      let ingredientCatalogApplied = await isIngredientCatalogAlreadyPresent(prisma);

      if (!ingredientCatalogApplied) {
        await repairIncompleteIngredientCatalogMigration(prisma);
        ingredientCatalogApplied = await isIngredientCatalogAlreadyPresent(prisma);
      }

      if (!ingredientCatalogApplied) {
        console.error(
          `[safe-migrate] Migration ${TARGET_FAILED_MIGRATION} is failed and schema is still incomplete after auto-repair.`,
        );
        process.exit(1);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  if (failedMigrations.length > 0) {
    const unknownFailedMigrations = failedMigrations.filter(
      (name) => name !== TARGET_FAILED_MIGRATION,
    );

    if (unknownFailedMigrations.length === 0) {
      // We have already verified/repaired the known ingredient catalog failure above.
      console.log(
        `[safe-migrate] Marking failed migration as applied: ${TARGET_FAILED_MIGRATION}`,
      );
      run(PNPM_BIN, ['prisma', 'migrate', 'resolve', '--applied', TARGET_FAILED_MIGRATION]);
    } else {
      if (!process.env.DATABASE_URL) {
        console.error('[safe-migrate] DATABASE_URL is required to validate schema drift.');
        process.exit(1);
      }

      console.log(
        `[safe-migrate] Unknown failed migrations detected: ${unknownFailedMigrations.join(', ')}`,
      );
      console.log('[safe-migrate] Verifying database schema against current Prisma schema...');

      const diffStatus = run(
        PNPM_BIN,
        [
          'prisma',
          'migrate',
          'diff',
          '--from-url',
          process.env.DATABASE_URL,
          '--to-schema-datamodel',
          'prisma/schema.prisma',
          '--exit-code',
        ],
        [0, 2],
      );

      if (diffStatus !== 0) {
        console.error(
          '[safe-migrate] Database schema differs from prisma/schema.prisma. Not auto-resolving unknown failed migrations.',
        );
        process.exit(1);
      }

      for (const migrationName of failedMigrations) {
        console.log(`[safe-migrate] Marking failed migration as applied: ${migrationName}`);
        run(PNPM_BIN, ['prisma', 'migrate', 'resolve', '--applied', migrationName]);
      }
    }
  }

  console.log('[safe-migrate] Running prisma migrate deploy');
  run(PNPM_BIN, ['prisma', 'migrate', 'deploy']);
}

main().catch((error) => {
  console.error('[safe-migrate] Unexpected error:', error);
  process.exit(1);
});
