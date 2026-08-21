/**
 * Przelicza makro przepisów ze składników i zapisuje wynik.
 *
 * Dwa cele, bo jedno bez drugiego nie ma sensu: baza jest tym, co widzi
 * aplikacja, a pliki w `prisma/catalog/` są tym, z czego odtwarza się bazę.
 * Poprawka tylko w bazie zniknęłaby przy najbliższym `recipes:import:json`.
 *
 * Domyślnie dry-run — pokazuje różnice i nic nie zapisuje. Zapis wymaga
 * jawnego `--write`.
 *
 * Uruchomienie:
 *   pnpm recipes:recompute:nutrition                 # podgląd zmian
 *   pnpm recipes:recompute:nutrition -- --write      # zapis do JSON-ów i bazy
 *   pnpm recipes:recompute:nutrition -- --write --db-only
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  normalizeIngredientAmount,
  normalizeText,
} from '../src/recipes/ingredient-amount.util';
import {
  computeRecipeNutrition,
  type IngredientNutritionPer100,
  type NutritionInputItem,
} from '../src/recipes/recipe-nutrition.util';

const prisma = new PrismaClient();

const CATALOG_DIR = 'prisma/catalog';
const NUTRITION_FILE =
  process.env.INGREDIENT_NUTRITION_FILE ??
  join(CATALOG_DIR, 'ingredient-nutrition-pl-v1.json');

type CatalogEntry = {
  normalizedName: string;
  unit: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  gramsPerPiece?: number;
};

type RecipeJson = {
  title: string;
  servings: number;
  nutrition: {
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber: number;
    salt: number;
  };
  ingredients: Array<{ ingredientName: string; amount: number; unit: string }>;
};

type Options = { write: boolean; dbOnly: boolean; jsonOnly: boolean };

function parseArgs(argv: string[]): Options {
  return {
    write: argv.includes('--write'),
    dbOnly: argv.includes('--db-only'),
    jsonOnly: argv.includes('--json-only'),
  };
}

/** Zaokrąglenie do zapisu: gramy do liczby całkowitej — dokładniej niż źródło i tak nie jest. */
function forStorage(value: number): number {
  return Math.round(value);
}

async function loadNutritionTable(): Promise<Map<string, CatalogEntry>> {
  const raw = await readFile(join(process.cwd(), NUTRITION_FILE), 'utf8');
  const parsed = JSON.parse(raw) as { ingredients: CatalogEntry[] };
  return new Map(
    parsed.ingredients.map((entry) => [entry.normalizedName, entry]),
  );
}

function toPer100(entry: CatalogEntry): IngredientNutritionPer100 {
  return {
    kcal: entry.kcal,
    protein: entry.protein,
    carbs: entry.carbs,
    fat: entry.fat,
    fiber: entry.fiber,
    gramsPerPiece: entry.gramsPerPiece ?? null,
  };
}

/**
 * Zamienia listę składników z pliku JSON na wejście kalkulatora.
 *
 * Kategoria jest potrzebna, bo `normalizeIngredientAmount` dopuszcza łyżeczki
 * i szczypty tylko dla przypraw — bierzemy ją z bazy, żeby nie zgadywać.
 */
function toNutritionItems(
  recipe: RecipeJson,
  table: Map<string, CatalogEntry>,
  categories: Map<string, string>,
): { items: NutritionInputItem[]; unknown: string[] } {
  const items: NutritionInputItem[] = [];
  const unknown: string[] = [];

  for (const ingredient of recipe.ingredients) {
    const key = normalizeText(ingredient.ingredientName);
    const entry = table.get(key);

    if (!entry) {
      unknown.push(ingredient.ingredientName);
      continue;
    }

    const normalized = normalizeIngredientAmount(
      ingredient.ingredientName,
      categories.get(key) ?? 'Przyprawy i sosy',
      ingredient.amount,
      ingredient.unit,
    );

    items.push({
      name: ingredient.ingredientName,
      normalizedAmount: normalized.normalizedAmount,
      normalizedUnit: normalized.normalizedUnit,
      nutrition: toPer100(entry),
    });
  }

  return { items, unknown };
}

/**
 * Podmienia w surowym tekscie pliku same wartosci `nutrition`, zostawiajac
 * reszte bajt w bajt.
 *
 * Ponowna serializacja calego JSON-a byla kuszaca, ale gubi formatowanie:
 * jeden katalog trzyma `nutrition` w jednej linii, inny rozpisuje, a
 * `JSON.stringify` zamienia zapisane `100.0` na `100`. Diff mial pokazywac
 * poprawione makro, a nie 2000 linii szumu.
 *
 * Bloki `nutrition` nie zawieraja zagniezdzonych obiektow, wiec `[^{}]*`
 * dopasowuje je bezpiecznie, a kolejnosc wystapien odpowiada kolejnosci
 * przepisow w sparsowanej tablicy.
 */
function patchNutritionInText(
  raw: string,
  values: Array<RecipeJson['nutrition'] | null>,
): string {
  let index = -1;

  return raw.replace(
    /("nutrition"\s*:\s*)(\{[^{}]*\})/g,
    (match, prefix: string, body: string) => {
      index += 1;
      const next = values[index];
      if (!next) return match;

      const keys = [...body.matchAll(/"([a-zA-Z]+)"\s*:/g)].map(
        (entry) => entry[1],
      );
      const rendered = keys
        .map((key) => `"${key}": ${next[key as keyof RecipeJson['nutrition']]}`)
        .filter((entry) => !entry.endsWith('undefined'));

      if (!body.includes('\n')) {
        return `${prefix}{ ${rendered.join(', ')} }`;
      }

      const indent = /\n(\s*)"/.exec(body)?.[1] ?? '        ';
      const closingIndent = indent.slice(0, Math.max(indent.length - 2, 0));
      return `${prefix}{\n${rendered.map((entry) => indent + entry).join(',\n')}\n${closingIndent}}`;
    },
  );
}

async function recomputeCatalogFiles(
  table: Map<string, CatalogEntry>,
  categories: Map<string, string>,
  options: Options,
): Promise<void> {
  const files = (await readdir(join(process.cwd(), CATALOG_DIR)))
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name.startsWith('recipe'));

  for (const file of files) {
    const path = join(process.cwd(), CATALOG_DIR, file);
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as RecipeJson[] | { recipes: RecipeJson[] };
    const recipes = Array.isArray(parsed) ? parsed : parsed.recipes;

    if (!Array.isArray(recipes) || recipes.length === 0) continue;

    let changed = 0;
    const skipped: string[] = [];
    const patched: Array<RecipeJson['nutrition'] | null> = [];

    for (const recipe of recipes) {
      const { items, unknown } = toNutritionItems(recipe, table, categories);

      if (unknown.length > 0) {
        skipped.push(`${recipe.title} (brak w tabeli: ${unknown.join(', ')})`);
        patched.push(null);
        continue;
      }

      const { totals } = computeRecipeNutrition(items);
      const next = {
        kcal: forStorage(totals.kcal),
        protein: forStorage(totals.protein),
        carbs: forStorage(totals.carbs),
        fat: forStorage(totals.fat),
        fiber: forStorage(totals.fiber),
        salt: recipe.nutrition.salt, // poza zakresem audytu — zostaje bez zmian
      };

      if (next.kcal !== recipe.nutrition.kcal) changed += 1;
      patched.push(next);
    }

    for (const entry of skipped) {
      // eslint-disable-next-line no-console
      console.warn(`[recompute] pominiete w ${file}: ${entry}`);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[recompute] ${file}: przeliczonych ${recipes.length - skipped.length}/${recipes.length}, zmienionych kcal ${changed}`,
    );

    if (options.write) {
      await writeFile(path, patchNutritionInText(raw, patched), 'utf8');
    }
  }
}

async function recomputeDatabase(options: Options): Promise<void> {
  const rows = await prisma.$queryRaw<
    Array<{
      recipeId: string;
      title: string;
      storedKcal: number;
      ingredientName: string;
      normalizedAmount: number;
      normalizedUnit: string;
      kcalPer100: number | null;
      proteinPer100: number | null;
      carbsPer100: number | null;
      fatPer100: number | null;
      fiberPer100: number | null;
      gramsPerPiece: number | null;
    }>
  >`
    SELECT r.id AS "recipeId", r.title AS "title", r."nutritionKcal" AS "storedKcal",
           ri.name AS "ingredientName", ri."normalizedAmount" AS "normalizedAmount",
           ri."normalizedUnit" AS "normalizedUnit",
           i."nutritionKcalPer100" AS "kcalPer100", i."nutritionProteinPer100" AS "proteinPer100",
           i."nutritionCarbsPer100" AS "carbsPer100", i."nutritionFatPer100" AS "fatPer100",
           i."nutritionFiberPer100" AS "fiberPer100", i."gramsPerPiece" AS "gramsPerPiece"
    FROM "Recipe" r
    JOIN "RecipeIngredient" ri ON ri."recipeId" = r.id
    JOIN "Ingredient" i ON i.id = ri."ingredientId"
    ORDER BY r.title
  `;

  const byRecipe = new Map<
    string,
    { title: string; storedKcal: number; items: NutritionInputItem[] }
  >();

  for (const row of rows) {
    let entry = byRecipe.get(row.recipeId);
    if (!entry) {
      entry = { title: row.title, storedKcal: row.storedKcal, items: [] };
      byRecipe.set(row.recipeId, entry);
    }

    entry.items.push({
      name: row.ingredientName,
      normalizedAmount: row.normalizedAmount,
      normalizedUnit: row.normalizedUnit,
      nutrition:
        row.kcalPer100 === null
          ? null
          : {
              kcal: row.kcalPer100,
              protein: row.proteinPer100 ?? 0,
              carbs: row.carbsPer100 ?? 0,
              fat: row.fatPer100 ?? 0,
              fiber: row.fiberPer100 ?? 0,
              gramsPerPiece: row.gramsPerPiece,
            },
    });
  }

  let updated = 0;

  for (const [recipeId, entry] of byRecipe) {
    const { totals, missingNutrition, missingPieceWeight } =
      computeRecipeNutrition(entry.items);

    if (missingNutrition.length > 0 || missingPieceWeight.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[recompute] pomijam "${entry.title}" — brak danych dla: ${[...missingNutrition, ...missingPieceWeight].join(', ')}`,
      );
      continue;
    }

    if (options.write) {
      await prisma.recipe.update({
        where: { id: recipeId },
        data: {
          nutritionKcal: forStorage(totals.kcal),
          nutritionProtein: forStorage(totals.protein),
          nutritionCarbs: forStorage(totals.carbs),
          nutritionFat: forStorage(totals.fat),
          nutritionFiber: forStorage(totals.fiber),
        },
      });
    }

    updated += 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[recompute] baza: ${options.write ? 'zaktualizowanych' : 'do aktualizacji'} ${updated}/${byRecipe.size} przepisow`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const table = await loadNutritionTable();
  const ingredients = await prisma.ingredient.findMany({
    select: { normalizedName: true, category: true },
  });
  const categories = new Map(
    ingredients.map((row) => [row.normalizedName, row.category]),
  );

  if (!options.dbOnly) {
    await recomputeCatalogFiles(table, categories, options);
  }

  if (!options.jsonOnly) {
    await recomputeDatabase(options);
  }

  if (!options.write) {
    // eslint-disable-next-line no-console
    console.log(
      '\n[recompute] DRY-RUN — nic nie zapisano. Dodaj --write, zeby zapisac.',
    );
  }
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Recipe nutrition recompute failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
