/**
 * Luki w danych przepisu katalogu (ROADMAPA §5.7 „Jakość”) — czyste reguły
 * bez Prismy, sprawdzane w `catalog-insights.spec.ts`.
 */
import type { MealType as PrismaMealType } from '@prisma/client';
import { atwaterKcal } from '../../recipes/recipe-nutrition.util';
import type {
  CatalogGapKind,
  CatalogGapRecipe,
  CatalogRankItem,
} from '../contract';
import { stepsFromInstructions } from './catalog-math';

export const CATALOG_GAP_KINDS: readonly CatalogGapKind[] = [
  'no-image',
  'zero-macros',
  'kcal-mismatch',
  'ingredient-no-nutrition',
  'piece-no-grams',
  'no-meal-types',
  'no-steps',
  'no-ingredients',
];

/** Rozjazd kcal z makro powyżej tego progu to błąd danych, nie zaokrąglenie. */
export const KCAL_MISMATCH_THRESHOLD = 0.25;
/** Suma B + T + W poniżej tylu gramów na cały przepis = „makro ≈ 0”. */
export const ZERO_MACROS_GRAMS = 0.5;

export type GapInputRow = {
  id: string;
  title: string;
  imageUrl: string | null;
  isActive: boolean;
  mealType: PrismaMealType;
  suitableMealTypes: PrismaMealType[];
  nutritionKcal: number;
  nutritionProtein: number;
  nutritionFat: number;
  nutritionCarbs: number;
  nutritionFiber: number;
  sourceInstructions: unknown;
  ingredients: {
    normalizedUnit: string;
    ingredient: {
      name: string;
      nutritionKcalPer100: number | null;
      nutritionProteinPer100: number | null;
      nutritionCarbsPer100: number | null;
      nutritionFatPer100: number | null;
      gramsPerPiece: number | null;
    };
  }[];
};

/** Luki jednego przepisu; `null`, gdy żadnej. */
export function recipeGaps(row: GapInputRow): CatalogGapRecipe | null {
  const gaps: CatalogGapKind[] = [];
  const names = new Set<string>();

  if (!row.imageUrl?.trim()) gaps.push('no-image');

  const macros = row.nutritionProtein + row.nutritionFat + row.nutritionCarbs;
  const kcalFromMacros = Math.round(
    atwaterKcal({
      protein: row.nutritionProtein,
      carbs: row.nutritionCarbs,
      fat: row.nutritionFat,
      fiber: row.nutritionFiber,
    }),
  );
  if (row.nutritionKcal <= 0 || macros < ZERO_MACROS_GRAMS) {
    gaps.push('zero-macros');
  } else {
    const larger = Math.max(row.nutritionKcal, kcalFromMacros);
    if (
      larger > 0 &&
      Math.abs(row.nutritionKcal - kcalFromMacros) / larger >
        KCAL_MISMATCH_THRESHOLD
    ) {
      gaps.push('kcal-mismatch');
    }
  }

  let noNutrition = false;
  let noPieceWeight = false;
  for (const line of row.ingredients) {
    const i = line.ingredient;
    if (
      i.nutritionKcalPer100 === null ||
      i.nutritionProteinPer100 === null ||
      i.nutritionCarbsPer100 === null ||
      i.nutritionFatPer100 === null
    ) {
      noNutrition = true;
      names.add(i.name);
    }
    if (line.normalizedUnit === 'szt' && !i.gramsPerPiece) {
      noPieceWeight = true;
      names.add(i.name);
    }
  }
  if (noNutrition) gaps.push('ingredient-no-nutrition');
  if (noPieceWeight) gaps.push('piece-no-grams');
  if (row.suitableMealTypes.length === 0) gaps.push('no-meal-types');
  if (stepsFromInstructions(row.sourceInstructions).length === 0) {
    gaps.push('no-steps');
  }
  if (row.ingredients.length === 0) gaps.push('no-ingredients');

  if (gaps.length === 0) return null;
  return {
    id: row.id,
    title: row.title,
    imageUrl: row.imageUrl ?? '',
    isActive: row.isActive,
    mealType: row.mealType,
    gaps,
    ingredients: [...names].sort((a, b) => a.localeCompare(b, 'pl')),
    kcal: Math.round(row.nutritionKcal),
    kcalFromMacros,
  };
}

/** Liczniki wg rodzaju — każdy rodzaj obecny, także z zerem. */
export function countGaps(
  recipes: readonly CatalogGapRecipe[],
): Record<CatalogGapKind, number> {
  const counts = Object.fromEntries(
    CATALOG_GAP_KINDS.map((kind) => [kind, 0]),
  ) as Record<CatalogGapKind, number>;
  for (const recipe of recipes) {
    for (const gap of recipe.gaps) counts[gap] += 1;
  }
  return counts;
}

/** Aktywne pierwsze, potem więcej luk, potem tytuł. */
export function compareGapRecipes(
  a: CatalogGapRecipe,
  b: CatalogGapRecipe,
): number {
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  if (a.gaps.length !== b.gaps.length) return b.gaps.length - a.gaps.length;
  return a.title.localeCompare(b.title, 'pl') || a.id.localeCompare(b.id);
}

/** Ranking: liczby z zapytania + metadane przepisu; brakujący przepis odpada. */
export function rank(
  counts: readonly { recipeId: string; count: number }[],
  recipes: ReadonlyMap<
    string,
    { title: string; imageUrl: string | null; isActive: boolean }
  >,
  limit: number,
  { keepZero = false }: { keepZero?: boolean } = {},
): CatalogRankItem[] {
  return counts
    .flatMap((row): CatalogRankItem[] => {
      const recipe = recipes.get(row.recipeId);
      if (!recipe || (!keepZero && row.count <= 0)) return [];
      return [
        {
          id: row.recipeId,
          title: recipe.title,
          imageUrl: recipe.imageUrl ?? '',
          isActive: recipe.isActive,
          count: row.count,
        },
      ];
    })
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.title.localeCompare(b.title, 'pl') ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}
