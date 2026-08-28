/**
 * Wgrywa tagi składników (alergeny + tagi dietetyczne) z katalogu do bazy
 * i przelicza tagi przepisów jako unię tagów ich składników.
 *
 * Źródłem prawdy jest `prisma/catalog/ingredient-tags-pl-v1.json` —
 * kuratorowany ręcznie, wersjonowany w gicie; baza jest jego odbiciem.
 * Skrypt jest idempotentny: po każdej korekcie pliku puszcza się go ponownie,
 * a zmieniają się tylko te przepisy, których unia faktycznie się różni.
 *
 * Dopasowanie po `normalizedName` (jak w `load-ingredient-nutrition.ts`),
 * zapis parametryzowanym SQL-em, żeby działał także przed `prisma generate`
 * po migracji `20260828150000_tagi_skladnikow_i_przepisow`.
 *
 * Kolejność w bootstrapie: PO `load-ingredient-nutrition`, PRZED importem
 * przepisów — import liczy unię z wierszy `Ingredient`, więc bez tagów
 * składników wszedłby z pustymi tagami przepisów.
 *
 * Uruchomienie:
 *   pnpm catalog:ingredients:tags
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ALLERGEN_ID_VALUES } from '../src/common/allergens';
import {
  deriveRecipeTags,
  sameTags,
  validateIngredientTagEntry,
  type IngredientTagEntry,
} from '../src/common/diet-tags';

const prisma = new PrismaClient();

const TAGS_FILE =
  process.env.INGREDIENT_TAGS_FILE ??
  'prisma/catalog/ingredient-tags-pl-v1.json';

type TagCatalog = {
  version: string;
  convention?: unknown;
  ingredients: IngredientTagEntry[];
};

async function loadIngredientTags(catalog: TagCatalog): Promise<{
  updated: number;
  missing: string[];
}> {
  let updated = 0;
  const missing: string[] = [];

  for (const entry of catalog.ingredients) {
    const count = await prisma.$executeRaw`
      UPDATE "Ingredient"
      SET "allergens" = ${entry.allergens}::text[],
          "dietTags"  = ${entry.dietTags}::text[],
          "updatedAt" = now()
      WHERE "normalizedName" = ${entry.normalizedName}
    `;
    if (count === 0) missing.push(entry.normalizedName);
    else updated += count;
  }
  return { updated, missing };
}

/**
 * Tagi przepisu = unia tagów składników (`deriveRecipeTags`). Przepisy bez
 * składników dostają puste listy. Zapis tylko przy realnej zmianie, żeby
 * `updatedAt` przepisów nie skakało przy każdym przebiegu.
 */
async function recomputeRecipeTags(): Promise<{
  checked: number;
  changed: number;
}> {
  const recipes = await prisma.$queryRaw<
    Array<{ id: string; allergens: string[]; dietTags: string[] }>
  >`SELECT id, "allergens", "dietTags" FROM "Recipe"`;

  const rows = await prisma.$queryRaw<
    Array<{ recipeId: string; allergens: string[]; dietTags: string[] }>
  >`
    SELECT ri."recipeId" AS "recipeId", i."allergens", i."dietTags"
    FROM "RecipeIngredient" ri
    JOIN "Ingredient" i ON i.id = ri."ingredientId"
  `;

  const byRecipe = new Map<
    string,
    Array<{ allergens: string[]; dietTags: string[] }>
  >();
  for (const row of rows) {
    const list = byRecipe.get(row.recipeId) ?? [];
    list.push({ allergens: row.allergens, dietTags: row.dietTags });
    byRecipe.set(row.recipeId, list);
  }

  let changed = 0;
  for (const recipe of recipes) {
    const derived = deriveRecipeTags(byRecipe.get(recipe.id) ?? []);
    if (
      sameTags(derived.allergens, recipe.allergens) &&
      sameTags(derived.dietTags, recipe.dietTags)
    ) {
      continue;
    }
    await prisma.$executeRaw`
      UPDATE "Recipe"
      SET "allergens" = ${derived.allergens}::text[],
          "dietTags"  = ${derived.dietTags}::text[],
          "updatedAt" = now()
      WHERE id = ${recipe.id}::uuid
    `;
    changed += 1;
  }
  return { checked: recipes.length, changed };
}

async function main(): Promise<void> {
  const raw = await readFile(join(process.cwd(), TAGS_FILE), 'utf8');
  const catalog = JSON.parse(raw) as TagCatalog;

  const seen = new Set<string>();
  const problems: string[] = [];
  for (const entry of catalog.ingredients) {
    if (seen.has(entry.normalizedName)) {
      problems.push(`${entry.normalizedName}: duplikat wpisu`);
    }
    seen.add(entry.normalizedName);
    for (const problem of validateIngredientTagEntry(
      entry,
      ALLERGEN_ID_VALUES,
    )) {
      problems.push(`${entry.normalizedName}: ${problem}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Plik tagów jest niespójny (${problems.length}):\n  ${problems.join('\n  ')}`,
    );
  }

  const { updated, missing } = await loadIngredientTags(catalog);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[tags] brak w bazie (${missing.length}): ${missing.join(', ')}`,
    );
  }

  // Składniki realnie używane w przepisach, których plik nie zna — to one
  // dałyby przepisowi fałszywie „czyste” tagi, więc raportujemy je głośno.
  const used = await prisma.$queryRaw<Array<{ normalizedName: string }>>`
    SELECT DISTINCT i."normalizedName"
    FROM "Ingredient" i
    JOIN "RecipeIngredient" ri ON ri."ingredientId" = i.id
    ORDER BY i."normalizedName"
  `;
  const uncovered = used
    .map((row) => row.normalizedName)
    .filter((name) => !seen.has(name));

  const recipes = await recomputeRecipeTags();

  // eslint-disable-next-line no-console
  console.log(
    `[tags] done. version=${catalog.version}, wpisow=${catalog.ingredients.length}, skladnikow zaktualizowanych=${updated}, przepisow sprawdzonych=${recipes.checked}, zmienionych=${recipes.changed}`,
  );

  if (uncovered.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[tags] UWAGA: ${uncovered.length} skladnikow uzywanych w przepisach bez wpisu w pliku tagow: ${uncovered.join(', ')}`,
    );
  }
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Ingredient tags load failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
