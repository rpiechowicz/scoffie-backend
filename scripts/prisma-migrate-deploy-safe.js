/* eslint-disable no-console */
const { spawnSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');

const TARGET_FAILED_MIGRATION = '20260216094429_ingredient_catalog_v1';
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

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
    prisma.$queryRaw`SELECT to_regclass('public."Ingredient"')::text AS value`,
    prisma.$queryRaw`SELECT to_regclass('public."IngredientAlias"')::text AS value`,
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
  const recipeIngredientOk = Boolean(
    Array.isArray(recipeIngredientColumn) && recipeIngredientColumn[0]?.value,
  );

  return ingredientOk && aliasOk && recipeIngredientOk;
}

async function main() {
  const prisma = new PrismaClient();

  try {
    const failed = await hasFailedTargetMigration(prisma);

    if (failed) {
      const alreadyApplied = await isIngredientCatalogAlreadyPresent(prisma);

      if (!alreadyApplied) {
        console.error(
          `[safe-migrate] Migration ${TARGET_FAILED_MIGRATION} is failed and schema is incomplete. Manual intervention required.`,
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
