const { spawnSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { decideRebuild } = require('./lib/rebuild-guard');
const {
  decideBootstrap,
  decideIngredientTagsLoad,
} = require('./lib/bootstrap-decision');

const TARGET_FAILED_MIGRATION = '20260216094429_ingredient_catalog_v1';
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const UNKNOWN_INGREDIENT_ID = '00000000-0000-0000-0000-000000000001';
const UNKNOWN_INGREDIENT_NAME = '__unknown_ingredient__';

function run(command, args, allowedStatuses = [0]) {
  const result = spawnSync(command, args, {
    // Node ≥ 20.12 odmawia uruchamiania `pnpm.cmd` bez powłoki (EINVAL) —
    // na Windows wrapper padał przed migracją.
    shell: process.platform === 'win32',
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  const status = typeof result.status === 'number' ? result.status : 1;
  if (!allowedStatuses.includes(status)) {
    // Dziecko zabite sygnałem ma status null — bez `?? 1` start kończyłby
    // się kodem 0 mimo przerwanego kroku.
    process.exit(result.status ?? 1);
  }

  return status;
}

function runWithEnv(command, args, extraEnv = {}, allowedStatuses = [0]) {
  const result = spawnSync(command, args, {
    // Node ≥ 20.12 odmawia uruchamiania `pnpm.cmd` bez powłoki (EINVAL) —
    // na Windows wrapper padał przed migracją.
    shell: process.platform === 'win32',
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  if (result.error) {
    throw result.error;
  }

  const status = typeof result.status === 'number' ? result.status : 1;
  if (!allowedStatuses.includes(status)) {
    // Dziecko zabite sygnałem ma status null — bez `?? 1` start kończyłby
    // się kodem 0 mimo przerwanego kroku.
    process.exit(result.status ?? 1);
  }

  return status;
}

function runSoft(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    // Node ≥ 20.12 odmawia uruchamiania `pnpm.cmd` bez powłoki (EINVAL) —
    // na Windows wrapper padał przed migracją.
    shell: process.platform === 'win32',
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  if (result.error) {
    console.warn(
      '[safe-migrate] Optional command failed to start:',
      result.error.message,
    );
    return 1;
  }

  return typeof result.status === 'number' ? result.status : 1;
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
  } catch {
    // On fresh databases the table may not exist yet.
    return [];
  }
}

async function isIngredientCatalogAlreadyPresent(prisma) {
  const [ingredientTable, aliasTable, recipeIngredientColumn] =
    await Promise.all([
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

  const ingredientOk = Boolean(
    Array.isArray(ingredientTable) && ingredientTable[0]?.value,
  );
  const aliasOk = Boolean(Array.isArray(aliasTable) && aliasTable[0]?.value);
  const recipeIngredientColumnOk = Boolean(
    Array.isArray(recipeIngredientColumn) && recipeIngredientColumn[0]?.value,
  );

  if (!ingredientOk || !aliasOk || !recipeIngredientColumnOk) {
    return false;
  }

  const [recipeIngredientColumnNotNull, recipeIngredientNullCount] =
    await Promise.all([
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
    Array.isArray(recipeIngredientColumnNotNull) &&
    recipeIngredientColumnNotNull[0]?.value,
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

  console.log(
    `[safe-migrate] Automatic repair for ${TARGET_FAILED_MIGRATION} completed.`,
  );
}

async function rebuildDatabaseFromScratch(prisma) {
  console.log(
    '[safe-migrate] Rebuild mode enabled. Dropping and recreating public schema...',
  );
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS public CASCADE;`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA public;`);
  await prisma.$executeRawUnsafe(`GRANT ALL ON SCHEMA public TO CURRENT_USER;`);
  console.log('[safe-migrate] Public schema recreated.');
}

/**
 * Pusta baza = brak przepisów I brak składników. Oba naraz, bo sam katalog
 * składników bez przepisów to stan przejściowy przerwanego bootstrapu, a nie
 * baza, którą wolno zasiać od nowa. Wołane PO `migrate deploy`, inaczej tabel
 * jeszcze nie ma.
 */
async function isDatabaseEmpty() {
  const prisma = new PrismaClient();
  try {
    const [recipes, ingredients] = await Promise.all([
      prisma.recipe.count(),
      prisma.ingredient.count(),
    ]);
    return recipes === 0 && ingredients === 0;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Ile składników jest w katalogu i ile z nich niesie jakikolwiek tag.
 * Surowy SQL, nie `prisma.ingredient.count({ where })`: kolumny
 * `allergens`/`dietTags` istnieją dopiero po migracji z 28.08, a wygenerowany
 * klient Prismy w obrazie bywa starszy niż schemat (patrz
 * `docs/handover/memory/project_stale_local_prisma_client.md`). Wołane PO
 * `migrate deploy`.
 */
async function countIngredientTags() {
  const prisma = new PrismaClient();
  try {
    const [row] = await prisma.$queryRaw`
      SELECT
        count(*)::int AS "ingredientCount",
        count(*) FILTER (
          WHERE cardinality("allergens") > 0 OR cardinality("dietTags") > 0
        )::int AS "taggedIngredientCount"
      FROM "Ingredient"
    `;
    return {
      ingredientCount: row?.ingredientCount ?? 0,
      taggedIngredientCount: row?.taggedIngredientCount ?? 0,
    };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Jednorazowe wgranie tagów składników na bazie, która dostała kolumny
 * z migracji, ale nigdy nie przeszła przez loader (decyzja:
 * `decideIngredientTagsLoad`). Błąd loadera kończy start kodem 1 — plik tagów
 * jest wersjonowany i sprawdzany w CI (`ingredient-tags.golden.spec.ts`), więc
 * porażka tutaj oznacza problem z bazą, nie z danymi; Railway trzyma stary
 * deployment, dopóki `/ops/health` nowego nie odpowie.
 */
async function runOptionalIngredientTagsLoad({ bootstrapRan }) {
  const counts = await countIngredientTags();
  const decision = decideIngredientTagsLoad({
    env: process.env,
    bootstrapRan,
    ...counts,
  });
  console.log(
    `[safe-migrate] Ingredient tags load ${decision.run ? 'enabled' : 'skipped'}: ${decision.reason}.`,
  );
  if (!decision.run) return;

  run(PNPM_BIN, ['exec', 'tsx', 'scripts/load-ingredient-tags.ts']);
}

function runOptionalBootstrap() {
  const recipeImportFile =
    process.env.RECIPE_IMPORT_FILE ??
    'prisma/catalog/recipes-catalog-full-v2.json';

  console.log('[safe-migrate] Bootstrapping ingredient catalog...');
  run(PNPM_BIN, ['exec', 'tsx', 'scripts/load-ingredient-catalog.ts']);

  console.log('[safe-migrate] Normalizing ingredient aliases...');
  run(PNPM_BIN, ['exec', 'tsx', 'scripts/normalize-ingredients-polish.ts']);

  // Bez wartości odżywczych składników import przepisów wchodzi z zerowym
  // makro i dopiero ręczny recompute by je naprawił — bootstrap ma zostawiać
  // bazę kompletną od razu.
  console.log('[safe-migrate] Loading ingredient nutrition table...');
  run(PNPM_BIN, ['exec', 'tsx', 'scripts/load-ingredient-nutrition.ts']);

  // Tagi (alergeny/diety) PRZED importem: import liczy unię tagów składników
  // z wierszy Ingredient, więc bez tego przepisy weszłyby „czyste".
  console.log('[safe-migrate] Loading ingredient tags table...');
  run(PNPM_BIN, ['exec', 'tsx', 'scripts/load-ingredient-tags.ts']);

  console.log(`[safe-migrate] Importing recipes from ${recipeImportFile}...`);
  runWithEnv(PNPM_BIN, ['exec', 'tsx', 'scripts/import-recipes-from-json.ts'], {
    RECIPE_IMPORT_CLEAR_EXISTING:
      process.env.RECIPE_IMPORT_CLEAR_EXISTING ?? 'true',
    RECIPE_IMPORT_FILE: recipeImportFile,
  });
}

/**
 * Jednorazowe dociągnięcie sodu (3.09.2026): składniki z makro, ale bez
 * sodu, dostają go z tabeli, a sól przepisów jest przeliczana ze składników
 * + soli dodanej. Bootstrap świeżej bazy ma to już z importu.
 */
async function runOptionalSodiumBackfill({ bootstrapRan }) {
  if (bootstrapRan) return;
  const prisma = new PrismaClient();
  let missing = 0;
  try {
    const rows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS value FROM "Ingredient"
      WHERE "nutritionKcalPer100" IS NOT NULL AND "nutritionSodiumMgPer100" IS NULL
    `;
    missing = Array.isArray(rows) ? Number(rows[0]?.value ?? 0) : 0;
  } catch (error) {
    console.warn(
      `[safe-migrate] sodium check skipped: ${error?.message ?? error}`,
    );
    return;
  } finally {
    await prisma.$disconnect();
  }
  if (missing === 0) return;
  console.log(
    `[safe-migrate] ${missing} ingredients without sodium — loading nutrition table and recomputing salt...`,
  );
  run(PNPM_BIN, ['exec', 'tsx', 'scripts/load-ingredient-nutrition.ts']);
  run(PNPM_BIN, [
    'exec',
    'tsx',
    'scripts/recompute-recipe-nutrition.ts',
    '--db-only',
    '--write',
  ]);
}

function runOptionalR2ImageBackfill() {
  // Opt-in. Dawniej domyślnie włączony: każdy start kontenera robił jeden
  // HEAD do R2 na przepis i rozszerzenie, zanim /ops/health w ogóle odpowiedział.
  // Jednorazowo: `pnpm exec tsx scripts/backfill-recipe-image-urls-from-r2.ts`.
  const enabled = process.env.SAFE_MIGRATE_BACKFILL_R2_IMAGE_URLS === 'true';
  if (!enabled) {
    console.log(
      '[safe-migrate] R2 image URL backfill skipped (set SAFE_MIGRATE_BACKFILL_R2_IMAGE_URLS=true to run it at startup).',
    );
    return;
  }

  console.log(
    '[safe-migrate] Syncing recipe image URLs from existing R2 objects...',
  );

  const status = runSoft(PNPM_BIN, [
    'exec',
    'tsx',
    'scripts/backfill-recipe-image-urls-from-r2.ts',
  ]);
  if (status !== 0) {
    console.warn(
      '[safe-migrate] R2 image URL backfill failed. Continuing startup without blocking deploy.',
    );
  }
}

async function main() {
  const prisma = new PrismaClient();
  let failedMigrations = [];

  // Strażnik rebuildu — patrz `scripts/lib/rebuild-guard.js`. Odmowa jest
  // głośna i kończy start: zapomniana flaga nie może po cichu przejść do
  // zwykłego `migrate deploy` ani, tym bardziej, do `DROP SCHEMA`.
  const rebuild = decideRebuild({ env: process.env, now: new Date() });
  if (rebuild.requested && !rebuild.allowed) {
    console.error(`[safe-migrate] Rebuild REFUSED: ${rebuild.reason}`);
    process.exit(1);
  }

  try {
    if (rebuild.allowed) {
      console.warn(
        `[safe-migrate] Rebuild CONFIRMED for database host "${rebuild.host ?? 'unknown'}" — dropping public schema.`,
      );
      await rebuildDatabaseFromScratch(prisma);
    }

    failedMigrations = await getFailedMigrations(prisma);

    if (failedMigrations.length > 0) {
      console.log(
        `[safe-migrate] Failed migrations detected: ${failedMigrations.join(', ')}`,
      );
    }

    if (failedMigrations.includes(TARGET_FAILED_MIGRATION)) {
      let ingredientCatalogApplied =
        await isIngredientCatalogAlreadyPresent(prisma);

      if (!ingredientCatalogApplied) {
        await repairIncompleteIngredientCatalogMigration(prisma);
        ingredientCatalogApplied =
          await isIngredientCatalogAlreadyPresent(prisma);
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
      run(PNPM_BIN, [
        'prisma',
        'migrate',
        'resolve',
        '--applied',
        TARGET_FAILED_MIGRATION,
      ]);
    } else {
      if (!process.env.DATABASE_URL) {
        console.error(
          '[safe-migrate] DATABASE_URL is required to validate schema drift.',
        );
        process.exit(1);
      }

      console.log(
        `[safe-migrate] Unknown failed migrations detected: ${unknownFailedMigrations.join(', ')}`,
      );
      console.log(
        '[safe-migrate] Verifying database schema against current Prisma schema...',
      );

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
        console.log(
          `[safe-migrate] Marking failed migration as applied: ${migrationName}`,
        );
        run(PNPM_BIN, [
          'prisma',
          'migrate',
          'resolve',
          '--applied',
          migrationName,
        ]);
      }
    }
  }

  console.log('[safe-migrate] Running prisma migrate deploy');
  run(PNPM_BIN, ['prisma', 'migrate', 'deploy']);

  // Po rebuildzie baza jest z definicji pusta — nie ma po co jej odpytywać.
  const bootstrap = decideBootstrap({
    env: process.env,
    rebuilt: rebuild.allowed,
    databaseEmpty: rebuild.allowed || (await isDatabaseEmpty()),
  });
  console.log(
    `[safe-migrate] Bootstrap ${bootstrap.run ? 'enabled' : 'skipped'}: ${bootstrap.reason}.`,
  );
  if (bootstrap.run) {
    runOptionalBootstrap();
  }

  // Baza z danymi, która właśnie dostała kolumny tagów z migracji, bez tego
  // kroku zostawałaby „czysta” dla walidatora diet do ręcznego loadera.
  await runOptionalIngredientTagsLoad({ bootstrapRan: bootstrap.run });
  await runOptionalSodiumBackfill({ bootstrapRan: bootstrap.run });

  runOptionalR2ImageBackfill();
}

main().catch((error) => {
  console.error('[safe-migrate] Unexpected error:', error);
  process.exit(1);
});
