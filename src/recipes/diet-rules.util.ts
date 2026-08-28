/**
 * Reguły diet i alergenów po stronie serwera — parytet 1:1 z
 * `RecipeDietProfile.satisfies(_:recipe:)` i `avoids(_:)` w iOS
 * (`Models/Components/RecipeDietProfile.swift`). Walidator asystenta
 * (Faza 0) ma czytać TE funkcje, a nie własną kopię; iOS dostaje tagi
 * z serwera, więc obie strony oceniają ten sam przepis tak samo.
 *
 * Zasada asymetrii (jak w iOS): alergen odrzuca przy każdym śladzie, dieta
 * blokuje tylko na dowodzie — przepis bez składników nie może „nie być
 * wegetariański”, bo nie ma z czego tego wywnioskować. Keto i wysokobiałkowa
 * idą po makrach na porcję, nie po składnikach, i bez makr są odrzucane
 * (nie da się obiecać ≤20 g węgli bez liczb).
 */
import { DietPreferenceValue } from '@prisma/client';

/** Próg wspólny z chipem „Niskowęglowodanowe” w iOS (`RecipeFilterOptions.swift`). */
export const KETO_MAX_CARBS_PER_SERVING = 20;
/** ≥ 20 % energii z białka (rozp. UE 1924/2006 „źródło białka”). */
export const HIGH_PROTEIN_MIN_ENERGY_SHARE = 0.2;

export type NutritionPerServing = {
  kcal: number;
  protein: number;
  carbs: number;
};

export type DietSubject = {
  /** `Recipe.dietTags` — unia tagów składników. */
  dietTags: readonly string[];
  /** `false`, gdy przepis nie ma składników — wtedy diety składnikowe przepuszczają. */
  hasIngredientData: boolean;
  /** Makra na porcję albo `null`, gdy przepis nie ma makr. */
  perServing: NutritionPerServing | null;
};

const has = (tags: readonly string[], id: string): boolean => tags.includes(id);

export function satisfiesDiet(
  diet: DietPreferenceValue,
  subject: DietSubject,
): boolean {
  const { dietTags, hasIngredientData, perServing } = subject;
  switch (diet) {
    case 'NONE':
      return true;
    case 'VEGETARIAN':
      if (!hasIngredientData) return true;
      return (
        !has(dietTags, 'MEAT') &&
        !has(dietTags, 'FISH') &&
        !has(dietTags, 'CRUSTACEAN')
      );
    case 'VEGAN':
      if (!hasIngredientData) return true;
      return (
        !has(dietTags, 'MEAT') &&
        !has(dietTags, 'FISH') &&
        !has(dietTags, 'CRUSTACEAN') &&
        !has(dietTags, 'DAIRY') &&
        !has(dietTags, 'EGG') &&
        !has(dietTags, 'ANIMAL_OTHER')
      );
    case 'PESCATARIAN':
      if (!hasIngredientData) return true;
      return !has(dietTags, 'MEAT');
    case 'KETO':
      if (!perServing) return false;
      return perServing.carbs <= KETO_MAX_CARBS_PER_SERVING;
    case 'PALEO':
      if (!hasIngredientData) return true;
      return (
        !has(dietTags, 'GRAIN') &&
        !has(dietTags, 'GLUTEN_GRAIN') &&
        !has(dietTags, 'LEGUME') &&
        !has(dietTags, 'DAIRY') &&
        !has(dietTags, 'PROCESSED')
      );
    case 'HIGH_PROTEIN':
      if (!perServing || perServing.kcal <= 0) return false;
      return (
        (perServing.protein * 4) / perServing.kcal >=
        HIGH_PROTEIN_MIN_ENERGY_SHARE
      );
    default: {
      const unreachable: never = diet;
      return unreachable;
    }
  }
}

/**
 * Alergeny przepisu, których unika użytkownik (przecięcie zbiorów, posortowane).
 * Puste = przepis bezpieczny dla tej listy.
 */
export function conflictingAllergens(
  recipeAllergens: readonly string[],
  avoided: readonly string[],
): string[] {
  if (avoided.length === 0 || recipeAllergens.length === 0) return [];
  const avoidedSet = new Set(avoided);
  return Array.from(new Set(recipeAllergens))
    .filter((id) => avoidedSet.has(id))
    .sort();
}

/** Makra na porcję z sum przepisu; `null`, gdy przepis nie ma makr (jak `hasNutritionData` w iOS). */
export function nutritionPerServing(recipe: {
  servings: number;
  nutritionKcal: number;
  nutritionProtein: number;
  nutritionCarbs: number;
  nutritionFat: number;
}): NutritionPerServing | null {
  const hasNutrition =
    recipe.nutritionKcal > 0 ||
    recipe.nutritionProtein > 0 ||
    recipe.nutritionCarbs > 0 ||
    recipe.nutritionFat > 0;
  if (!hasNutrition) return null;
  const servings = Math.max(1, recipe.servings);
  return {
    kcal: recipe.nutritionKcal / servings,
    protein: recipe.nutritionProtein / servings,
    carbs: recipe.nutritionCarbs / servings,
  };
}
