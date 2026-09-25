/**
 * Import katalogu przepisów z pliku JSON do bazy.
 *
 * Od decyzji D1 (25.09.2026) źródłem prawdy katalogu jest BAZA, a plik
 * `prisma/catalog/recipes-catalog-full-v2.json` jej eksportem (`pnpm
 * catalog:export`, co noc PR z serwisu `catalog-sync`). Import zostaje do
 * bootstrapu pustej bazy (safe-migrate, CI) i do świadomego wgrania pliku —
 * dlatego na NIEPUSTYM katalogu najpierw liczy różnice baza ↔ plik i odmawia,
 * gdy baza ma zmiany, których plik nie ma (edycja w panelu, wycofanie,
 * przeliczone makro), chyba że `RECIPE_IMPORT_FROM_JSON_CONFIRM=<dzisiejsza
 * data>`. Nowe przepisy w pliku (brak w bazie) przechodzą bez potwierdzenia.
 *
 * Kolumny liczy `src/recipes/catalog/catalog-recipe.ts` — ta sama funkcja,
 * co zapis z panelu (`PUT /admin/catalog/recipes/:id`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { isRecipeImagePlaceholder } from '../src/recipes/recipe-image-placeholder';
import {
  catalogEntryFromColumns,
  catalogEntryFromRow,
  catalogExportSelect,
  describeCatalogDiff,
  diffCatalog,
  importGuard,
  summarizeCatalogDiff,
  type CatalogDiff,
} from '../src/recipes/catalog/catalog-export';
import {
  catalogRecipeColumns,
  ingredientCreateRows,
  loadCatalogIngredientLookup,
  overLimitManualSlots,
  resolveCatalogIngredients,
  validateCatalogRecipe,
  type CatalogIngredientLookup,
  type CatalogRecipeInput,
} from '../src/recipes/catalog/catalog-recipe';

const prisma = new PrismaClient();

type RecipeInput = CatalogRecipeInput;

type RecipeBatchInput = {
  version?: string;
  recipes: RecipeInput[];
};

// Plik importu jest WYMAGANY: domyślna partia testowa wgrana przez pomyłkę
// podmieniała katalog (id sparowane po indeksie z pulą). Każdy przepis w
// pliku musi mieć jawne `id`.
const RECIPE_IMPORT_FILE = (process.env.RECIPE_IMPORT_FILE ?? '').trim();
const RECIPE_IMPORT_CLEAR_EXISTING =
  process.env.RECIPE_IMPORT_CLEAR_EXISTING === 'true';
const RECIPE_IMPORT_OWNER_USER_ID =
  process.env.RECIPE_IMPORT_OWNER_USER_ID ??
  '11111111-1111-4111-8111-111111111111';
const RECIPE_IMPORT_OWNER_LEGACY_SUB =
  process.env.RECIPE_IMPORT_OWNER_LEGACY_SUB ??
  `legacy-${RECIPE_IMPORT_OWNER_USER_ID}`;
const RECIPE_IMPORT_OWNER_DISPLAY_NAME =
  process.env.RECIPE_IMPORT_OWNER_DISPLAY_NAME ?? 'Recipe Import Bot';
const RECIPE_IMPORT_OWNER_EMAIL =
  process.env.RECIPE_IMPORT_OWNER_EMAIL ?? 'import-bot@example.com';
// Gospodarstwo katalogu wskazywane po ID, nie po nazwie: „Home” to domyślna
// nazwa domu każdego użytkownika, więc na świeżej bazie katalog mógł wylądować
// w cudzym gospodarstwie (z botem importu jako OWNER). Na istniejącej bazie
// ustaw ID gospodarstwa, które już trzyma katalog; na świeżej importer
// utworzy gospodarstwo o tym ID.
const RECIPE_IMPORT_HOUSEHOLD_ID =
  process.env.RECIPE_IMPORT_HOUSEHOLD_ID ??
  '22222222-2222-4222-8222-222222222222';
const RECIPE_IMPORT_HOUSEHOLD_NAME =
  process.env.RECIPE_IMPORT_HOUSEHOLD_NAME ?? 'Katalog Scoffie';
// Import trafia w istniejący wiersz PO ID, więc plik z id sparowanym z innym
// daniem nie dodaje przepisu — on go PODMIENIA. Wszystko, co trzyma samo id
// (pozycje planu, ulubione, cache katalogu w aplikacji, obrazek w R2 nazwany
// id-em), zostaje wtedy przy starym daniu, a wiersz pod spodem jest już inny:
// użytkownik stuka kafelek A, a do planu wchodzi B. Dokładnie to zrobił
// `recipes-catalog-full-v2.json` z posortowaną pulą id nałożoną po indeksie na
// listę w kolejności tytułów. Zmiana tytułu istniejącego id musi więc być
// świadoma i głośna, a nie skutkiem ubocznym re-importu.
const RECIPE_IMPORT_ALLOW_RETITLE =
  process.env.RECIPE_IMPORT_ALLOW_RETITLE === 'true';
const RECIPE_IMPORT_BUILD_R2_IMAGE_URLS =
  process.env.RECIPE_IMPORT_BUILD_R2_IMAGE_URLS !== 'false';
const RECIPE_IMPORT_IMAGE_EXTENSION = (
  process.env.RECIPE_IMPORT_IMAGE_EXTENSION ?? 'webp'
)
  .trim()
  .replace(/^\./, '')
  .toLowerCase();
const IMAGE_GENERATOR_PROVIDER = (
  process.env.IMAGE_GENERATOR_PROVIDER ?? 'pollinations'
).toLowerCase();
const IMAGE_GENERATOR_BASE_URL =
  process.env.IMAGE_GENERATOR_BASE_URL ??
  'https://image.pollinations.ai/prompt';
const IMAGE_GENERATOR_QUERY =
  process.env.IMAGE_GENERATOR_QUERY ?? 'width=1200&height=800&nologo=true';
const IMAGE_GENERATOR_STYLE =
  process.env.IMAGE_GENERATOR_STYLE ??
  'ultra realistic food photography, natural light, 50mm lens, shallow depth of field';
const IMAGE_GENERATOR_SEED_PREFIX =
  process.env.IMAGE_GENERATOR_SEED_PREFIX ?? 'scoffie';
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL ?? '')
  .trim()
  .replace(/\/+$/g, '');
const R2_KEY_PREFIX = (process.env.R2_KEY_PREFIX ?? 'recipe-images')
  .trim()
  .replace(/^\/+|\/+$/g, '');

function buildR2ImageUrl(recipeId: string): string | null {
  if (!RECIPE_IMPORT_BUILD_R2_IMAGE_URLS) return null;
  if (!R2_PUBLIC_BASE_URL) return null;
  return `${R2_PUBLIC_BASE_URL}/${R2_KEY_PREFIX}/${recipeId}.${RECIPE_IMPORT_IMAGE_EXTENSION}`;
}

/**
 * Zaślepka z pliku nie nadpisuje zdjęcia, które już jest w bazie. Zdjęcia
 * z Recrafta trafiają do bazy backfillem z R2, zanim ktokolwiek poprawi
 * plik katalogu, więc ponowny import z zaślepką cofnąłby je do zaślepki.
 * Obrazek z generatora (pollinations) zdjęciem nie jest — ten zaślepka
 * zastępuje celowo.
 */
function keepsUploadedImage(
  existingImageUrl: string | null,
  incomingImageUrl: string | null,
): existingImageUrl is string {
  if (!existingImageUrl?.trim()) return false;
  if (!isRecipeImagePlaceholder(incomingImageUrl)) return false;
  if (isRecipeImagePlaceholder(existingImageUrl)) return false;
  return !existingImageUrl.startsWith(IMAGE_GENERATOR_BASE_URL);
}

function buildGeneratedImageUrl(
  recipeId: string,
  recipe: RecipeInput,
): string | null {
  if (IMAGE_GENERATOR_PROVIDER !== 'pollinations') return null;

  const prompt =
    recipe.image?.prompt?.trim() ||
    [
      'professional food photo',
      recipe.title,
      recipe.description,
      IMAGE_GENERATOR_STYLE,
      'no text, no watermark, plated dish, appetizing',
    ]
      .filter(Boolean)
      .join(', ');

  if (!prompt) return null;

  const encodedPrompt = encodeURIComponent(prompt);
  const query = IMAGE_GENERATOR_QUERY ? `&${IMAGE_GENERATOR_QUERY}` : '';
  const seed = `${IMAGE_GENERATOR_SEED_PREFIX}-${recipeId}`;
  return `${IMAGE_GENERATOR_BASE_URL}/${encodedPrompt}?seed=${encodeURIComponent(seed)}${query}`;
}

function validateBatch(input: RecipeBatchInput): void {
  if (!Array.isArray(input.recipes) || input.recipes.length === 0) {
    throw new Error('Invalid input: "recipes" must be a non-empty array.');
  }
  const problems = input.recipes.flatMap(validateCatalogRecipe);
  if (problems.length > 0) {
    throw new Error(`Plik importu ma błędy:
${problems.join(String.fromCharCode(10))}`);
  }
}

async function ensureImportContext() {
  const user = await prisma.user.upsert({
    where: { id: RECIPE_IMPORT_OWNER_USER_ID },
    update: {
      displayName: RECIPE_IMPORT_OWNER_DISPLAY_NAME,
      email: RECIPE_IMPORT_OWNER_EMAIL,
    },
    create: {
      id: RECIPE_IMPORT_OWNER_USER_ID,
      googleId: RECIPE_IMPORT_OWNER_LEGACY_SUB,
      displayName: RECIPE_IMPORT_OWNER_DISPLAY_NAME,
      email: RECIPE_IMPORT_OWNER_EMAIL,
    },
    select: { id: true },
  });

  const household = await prisma.household.upsert({
    where: { id: RECIPE_IMPORT_HOUSEHOLD_ID },
    update: {},
    create: {
      id: RECIPE_IMPORT_HOUSEHOLD_ID,
      name: RECIPE_IMPORT_HOUSEHOLD_NAME,
      createdById: user.id,
    },
    select: { id: true, name: true },
  });

  await prisma.membership.upsert({
    where: {
      userId_householdId: {
        userId: user.id,
        householdId: household.id,
      },
    },
    update: { role: 'OWNER' },
    create: {
      userId: user.id,
      householdId: household.id,
      role: 'OWNER',
    },
  });

  return {
    userId: user.id,
    householdId: household.id,
    householdName: household.name,
  };
}

/**
 * Zdjęcie, które import zapisze dla przepisu: z pliku, z generatora albo
 * z R2; zaślepka z pliku nie nadpisuje zdjęcia już wgranego do bazy.
 */
function importImageUrl(
  recipe: RecipeInput,
  recipeId: string,
  existing: { imageUrl: string | null } | null,
): string | null {
  const incoming =
    recipe.image?.imageUrl?.trim() ||
    buildGeneratedImageUrl(recipeId, recipe) ||
    buildR2ImageUrl(recipeId);
  if (!existing) return incoming;
  return keepsUploadedImage(existing.imageUrl, incoming)
    ? existing.imageUrl
    : (incoming ?? existing.imageUrl ?? null);
}

/**
 * Różnice baza ↔ plik w kształcie eksportu: plik przepuszczony przez te same
 * funkcje, co zapis (czyli „co byłoby w bazie po imporcie”), baza — przez
 * eksport. Kolejność składników się nie liczy: przed 25.09.2026 zapis dawał
 * wszystkim liniom ten sam `createdAt`, więc kolejność w bazie była losowa,
 * a import ją właśnie porządkuje.
 */
async function diffDatabaseAgainstFile(
  input: RecipeBatchInput,
  lookup: CatalogIngredientLookup,
): Promise<CatalogDiff> {
  const dbRows = await prisma.recipe.findMany({
    where: { isCatalog: true },
    select: catalogExportSelect,
  });
  const dbImage = new Map(dbRows.map((row) => [row.id, row.imageUrl]));
  const fileEntries = input.recipes.map((recipe) => {
    const id = (recipe.id ?? '').trim();
    const rows = resolveCatalogIngredients(recipe, lookup);
    const columns = catalogRecipeColumns(recipe, rows);
    const existing = dbImage.has(id)
      ? { imageUrl: dbImage.get(id) ?? null }
      : null;
    return catalogEntryFromColumns(
      id,
      columns,
      rows,
      importImageUrl(recipe, id, existing),
    );
  });
  return diffCatalog(fileEntries, dbRows.map(catalogEntryFromRow), {
    ignoreIngredientOrder: true,
  });
}

/**
 * Strażnik D1: import na niepustym katalogu nie nadpisuje po cichu zmian,
 * które istnieją TYLKO w bazie. „Tylko w bazie” = przepis, którego plik nie
 * zna, wycofanie/przywrócenie i każda różnica treści (nie da się odróżnić, po
 * której stronie zaszła, więc zakładamy gorszy wariant). Przepisy z pliku,
 * których baza nie ma, to zwykłe dodanie — bez pytania.
 */
async function assertNoDatabaseOnlyChanges(
  input: RecipeBatchInput,
  lookup: CatalogIngredientLookup,
): Promise<void> {
  const catalogSize = await prisma.recipe.count({
    where: { isCatalog: true },
  });
  if (catalogSize === 0) {
    console.log('[recipes-import] pusty katalog — bootstrap bez porównania.');
    return;
  }
  const diff = await diffDatabaseAgainstFile(input, lookup);
  const guard = importGuard(diff, process.env.RECIPE_IMPORT_FROM_JSON_CONFIRM);
  console.log(
    `[recipes-import] baza ↔ plik: nowe z pliku ${diff.removed.length}, różnice po stronie bazy ${guard.count} (${summarizeCatalogDiff(guard.databaseOnly)}).`,
  );
  if (guard.count === 0) return;
  const details = describeCatalogDiff(guard.databaseOnly, { limit: 20 });
  if (!guard.allowed) {
    throw new Error(
      `Baza ma zmiany katalogu, których plik nie ma — import by je nadpisał.\n${details}\n` +
        `Źródłem prawdy katalogu jest baza (D1): odśwież plik \`pnpm catalog:export\`, ` +
        `a jeśli nadpisanie jest zamierzone, ustaw RECIPE_IMPORT_FROM_JSON_CONFIRM=${guard.today} (dzisiejsza data). Nic nie zapisano.`,
    );
  }
  console.warn(
    `[recipes-import] RECIPE_IMPORT_FROM_JSON_CONFIRM=${guard.today} — nadpisuję zmiany z bazy:\n${details}`,
  );
}

async function main(): Promise<void> {
  if (!RECIPE_IMPORT_FILE) {
    throw new Error(
      'RECIPE_IMPORT_FILE is required (e.g. prisma/catalog/recipes-catalog-full-v2.json).',
    );
  }
  const { userId, householdId, householdName } = await ensureImportContext();
  const filePath = join(process.cwd(), RECIPE_IMPORT_FILE);
  const raw = await readFile(filePath, 'utf8');
  const input = JSON.parse(raw) as RecipeBatchInput;
  validateBatch(input);

  const ids = new Set<string>();
  for (const recipe of input.recipes) {
    const id = (recipe.id ?? '').trim();
    if (ids.has(id)) {
      throw new Error(`Duplicate recipe id "${id}" detected in import input.`);
    }
    ids.add(id);
  }

  // Strażnik PRZED czyszczeniem: `RECIPE_IMPORT_CLEAR_EXISTING` niszczy
  // zmiany z bazy jeszcze skuteczniej niż zwykły upsert.
  await assertNoDatabaseOnlyChanges(
    input,
    await loadCatalogIngredientLookup(prisma),
  );

  if (RECIPE_IMPORT_CLEAR_EXISTING) {
    // Kasowanie katalogu zabiera z planów WSZYSTKICH domów pozycje wskazujące
    // na jego przepisy. Dlatego: najpierw liczby, a zapis tylko z dzisiejszą
    // datą w `RECIPE_IMPORT_CLEAR_CONFIRM` (ten sam wzorzec, co reset kont).
    const [planItems, recipes] = await Promise.all([
      prisma.planItem.count({ where: { recipe: { householdId } } }),
      prisma.recipe.count({ where: { householdId } }),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    console.log(
      `Czyszczenie katalogu: przepisów ${recipes}, pozycji planów do skasowania ${planItems}.`,
    );
    // Potwierdzenie datą tylko wtedy, gdy NAPRAWDĘ coś zniknie. Bootstrap
    // pustej bazy (CI, świeże środowisko) czyści zero wierszy i nie ma kogo
    // pytać — bez tego wyjątku każdy przebieg CI padał na tym strażniku.
    const hasSomethingToDelete = planItems > 0 || recipes > 0;
    if (
      hasSomethingToDelete &&
      (process.env.RECIPE_IMPORT_CLEAR_CONFIRM ?? '').trim() !== today
    ) {
      throw new Error(
        `RECIPE_IMPORT_CLEAR_EXISTING=true wymaga RECIPE_IMPORT_CLEAR_CONFIRM=${today} (dzisiejsza data). Nic nie skasowano.`,
      );
    }
    // Tylko katalog: dawniej `deleteMany()` bez `where` kasował pozycje planu
    // i składniki WSZYSTKICH gospodarstw. Pozycje planu wskazujące na
    // przepisy katalogu i tak by spadły kaskadą przy usunięciu przepisu.
    await prisma.planItem.deleteMany({
      where: { recipe: { householdId } },
    });
    await prisma.recipeIngredient.deleteMany({
      where: { recipe: { householdId } },
    });
    await prisma.recipe.deleteMany({ where: { householdId } });
  }

  const lookup = await loadCatalogIngredientLookup(prisma);

  let created = 0;
  let updated = 0;
  for (const recipe of input.recipes) {
    // `validateBatch` gwarantuje, że każdy przepis ma jawne UUID.
    const recipeId = (recipe.id ?? '').trim();
    // Tagi przepisu = unia tagów składników z bazy (plik ich nie ma). Wymaga
    // wgranych tagów składników PRZED importem — patrz bootstrap.
    const rows = resolveCatalogIngredients(recipe, lookup);
    const existing = await prisma.recipe.findUnique({
      where: { id: recipeId },
      select: { id: true, title: true, imageUrl: true },
    });

    // Bramka na podmianę dania pod istniejącym id — patrz komentarz przy
    // `RECIPE_IMPORT_ALLOW_RETITLE`. Przerywamy CAŁY import, nie pomijamy
    // wiersza: plik z rozjechaną pulą id psuje zwykle kilkadziesiąt pozycji
    // naraz, a import w połowie zostawiłby katalog w stanie gorszym niż przed.
    if (
      existing &&
      existing.title !== recipe.title &&
      !RECIPE_IMPORT_ALLOW_RETITLE
    ) {
      throw new Error(
        `Recipe id "${recipeId}" already belongs to "${existing.title}", ` +
          `import wants to overwrite it with "${recipe.title}". ` +
          `Popraw id w pliku importu albo ustaw RECIPE_IMPORT_ALLOW_RETITLE=true, ` +
          `jeśli podmiana dania pod tym id jest zamierzona.`,
      );
    }

    const overLimit = overLimitManualSlots(recipe);
    if (overLimit.length > 0) {
      console.warn(
        `[import] "${recipe.title}": ${Math.round(recipe.nutrition.kcal / Math.max(1, recipe.servings))} kcal/porcja ponad limit slotów ${overLimit.join(', ')} — pominięte.`,
      );
    }
    const data = {
      ...catalogRecipeColumns(recipe, rows),
      householdId,
      authorId: userId,
      imageUrl: importImageUrl(recipe, recipeId, existing),
    };

    if (existing) {
      await prisma.recipe.update({
        where: { id: existing.id },
        data: {
          ...data,
          ingredients: {
            deleteMany: {},
            create: ingredientCreateRows(rows),
          },
        },
      });
      updated += 1;
    } else {
      await prisma.recipe.create({
        data: {
          id: recipeId,
          ...data,
          ingredients: { create: ingredientCreateRows(rows) },
        },
      });
      created += 1;
    }
  }

  console.log(
    `[recipes-import] done. household="${householdName}" created=${created} updated=${updated} totalInput=${input.recipes.length}`,
  );
}

main()
  .catch((error) => {
    console.error('Recipes JSON import failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
