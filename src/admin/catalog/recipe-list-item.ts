import type { Difficulty, MealType, Prisma } from '@prisma/client';
import { effectiveSuitableMealTypes } from '../../common/meal-types';
import { isRecipeImagePlaceholder } from '../../recipes/recipe-image-placeholder';
import type { RecipeListItem } from '../contract';
import { gramsPerServing, kcalPerServing } from './catalog-math';

/**
 * Kolumny `Recipe`, z których powstaje wiersz listy katalogu — JEDNO
 * miejsce dla listy katalogu, szczegółu i wyszukiwarki ⌘K (ta ostatnia czyta
 * je surowym SQL-em, więc typ wiersza jest zwykły, nie z `select`).
 */
export const recipeListSelect = {
  id: true,
  title: true,
  imageUrl: true,
  isActive: true,
  mealType: true,
  suitableMealTypes: true,
  difficulty: true,
  prepTimeMinutes: true,
  servings: true,
  nutritionKcal: true,
  nutritionProtein: true,
  nutritionFat: true,
  nutritionCarbs: true,
  allergens: true,
  updatedAt: true,
} satisfies Prisma.RecipeSelect;

export type RecipeListRow = {
  id: string;
  title: string;
  imageUrl: string | null;
  isActive: boolean;
  mealType: MealType;
  suitableMealTypes: MealType[] | null;
  difficulty: Difficulty;
  prepTimeMinutes: number;
  servings: number;
  nutritionKcal: number;
  nutritionProtein: number;
  nutritionFat: number;
  nutritionCarbs: number;
  allergens: string[];
  updatedAt: Date;
};

export function toRecipeListItem(
  row: RecipeListRow,
  inPlans: number,
  favorites: number,
): RecipeListItem {
  const imageUrl = row.imageUrl ?? '';
  return {
    id: row.id,
    title: row.title,
    // Katalog ma zdjęcia pod img.scoffie.app; przepis bez zdjęcia dostaje
    // pusty adres (panel rysuje wtedy zastępnik), a nie wygenerowany URL.
    imageUrl,
    // Zaślepka `recipe-placeholder.png` to też „brak zdjęcia”.
    hasImage: imageUrl.trim() !== '' && !isRecipeImagePlaceholder(imageUrl),
    isActive: row.isActive,
    mealType: row.mealType,
    // Pusta lista = wiersz sprzed backfillu; czytający dokładają slot
    // bazowy — ta sama reguła, co w aplikacji.
    suitableMealTypes: effectiveSuitableMealTypes(row),
    difficulty: row.difficulty,
    prepTimeMinutes: row.prepTimeMinutes,
    servings: row.servings,
    // Kolumny `nutrition*` to CAŁY przepis — na porcję dzielimy przez
    // `servings`, jak aplikacja (`Recipe.nutritionPerServing`).
    kcalPerServing: kcalPerServing(row.nutritionKcal, row.servings),
    proteinPerServing: gramsPerServing(row.nutritionProtein, row.servings),
    fatPerServing: gramsPerServing(row.nutritionFat, row.servings),
    carbsPerServing: gramsPerServing(row.nutritionCarbs, row.servings),
    allergens: row.allergens,
    inPlans,
    favorites,
    updatedAt: row.updatedAt.toISOString(),
  };
}
