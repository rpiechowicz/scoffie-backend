import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveGoldenContent,
  type GoldenScenarioFile,
} from '../cook-scenario.golden';
import type { CookScenarioContent } from '../cook-scenario.types';
import { parseCookScenarioContent } from '../cook-scenario.validate';
import type { WriterExample } from './writer.prompt';
import type { WriterRecipe } from './writer.types';

/**
 * Kotlet de volaille z pliku katalogu + jego wzorzec — bez bazy. Id
 * składnika = nazwa (jak w teście złotym): liczą się referencje i sumy.
 */
const CATALOG_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'prisma',
  'catalog',
);

type CatalogRecipe = {
  id: string;
  title: string;
  description: string | null;
  mealType: string;
  difficulty: string;
  prepTimeMinutes: number;
  servings: number;
  dishType: string | null;
  equipment: string[];
  steps: Array<{ step: number; instruction: string }>;
  ingredients: Array<{ ingredientName: string; amount: number; unit: string }>;
};

const golden = JSON.parse(
  readFileSync(join(CATALOG_DIR, 'cook-scenarios-pl-v1.json'), 'utf8'),
) as GoldenScenarioFile;
const catalog = JSON.parse(
  readFileSync(join(CATALOG_DIR, 'recipes-catalog-full-v2.json'), 'utf8'),
) as { recipes: CatalogRecipe[] };

export function catalogRecipe(id: string): WriterRecipe {
  const row = catalog.recipes.find((recipe) => recipe.id === id);
  if (!row) throw new Error(`brak przepisu ${id} w katalogu`);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    servings: row.servings,
    mealType: row.mealType,
    difficulty: row.difficulty,
    prepTimeMinutes: row.prepTimeMinutes,
    dishType: row.dishType,
    equipment: row.equipment ?? [],
    instructions: row.steps.map((step) => step.instruction),
    ingredients: row.ingredients.map((item) => ({
      ingredientId: item.ingredientName,
      name: item.ingredientName,
      amount: item.amount,
      unit: item.unit,
    })),
  };
}

export function kotletExample(): WriterExample {
  const entry = golden.scenarios[0];
  const recipe = catalogRecipe(entry.recipeId);
  const names = new Set(recipe.ingredients.map((row) => row.name));
  const resolved = resolveGoldenContent(entry.content, (name) =>
    names.has(name) ? name : undefined,
  );
  const parsed = parseCookScenarioContent(resolved.content);
  if (!parsed.content) throw new Error(parsed.errors.join('; '));
  return { recipe, content: parsed.content };
}

/** Kopia do mutowania w teście. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export type Content = CookScenarioContent;
