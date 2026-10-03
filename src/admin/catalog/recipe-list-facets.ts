import type { DietPreferenceValue, MealType, Prisma } from '@prisma/client';
import {
  RECIPE_PROTEIN_TAGS,
  recipeSearchTags,
  type RecipeProteinTag,
} from '../../recipes/recipe-facets.util';
import {
  canonicalTaxonomy,
  EMPTY_RECIPE_TAXONOMY,
} from '../../recipes/recipe-taxonomy';
import {
  nutritionPerServing,
  satisfiesDiet,
} from '../../recipes/diet-rules.util';
import type { RecipeDietFilter, RecipeListFacets } from '../contract';
import { gramsPerServing } from './catalog-math';

/**
 * Filtry listy katalogu w panelu — te same, co arkusz filtrów w aplikacji
 * (`RecipeFilterSheet` + filtry kategorii w iOS): taksonomia redakcji
 * (kuchnia, rodzaj dania, okazje, pory roku, sprzęt, cechy), mięso i smak
 * ze składników (`recipeSearchTags`, ta sama heurystyka co wyszukiwarka
 * asystenta) i diety z kafelków „Dieta”.
 *
 * Tylko lista katalogu: szczegół ma pełną taksonomię osobno, a wyszukiwarka
 * ⌘K czyta wiersze surowym SQL-em i filtrów nie potrzebuje.
 */
export const recipeFacetsSelect = {
  cuisine: true,
  dishType: true,
  seasons: true,
  occasions: true,
  equipment: true,
  features: true,
  dietTags: true,
  nutritionFiber: true,
  nutritionSalt: true,
  ingredients: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { name: true, department: true },
  },
} satisfies Prisma.RecipeSelect;

export type RecipeFacetsRow = {
  title: string;
  mealType: MealType;
  prepTimeMinutes: number;
  servings: number;
  nutritionKcal: number;
  nutritionProtein: number;
  nutritionFat: number;
  nutritionCarbs: number;
  nutritionFiber: number;
  nutritionSalt: number;
  allergens: string[];
  dietTags: string[];
  cuisine: string | null;
  dishType: string | null;
  seasons: string[];
  occasions: string[];
  equipment: string[];
  features: string[];
  ingredients: { name: string; department: string }[];
};

const PROTEINS = new Set<string>(RECIPE_PROTEIN_TAGS);

export function toRecipeListFacets(row: RecipeFacetsRow): RecipeListFacets {
  const perServing = nutritionPerServing(row);
  const tags = recipeSearchTags({
    title: row.title,
    mealType: row.mealType,
    prepTimeMinutes: row.prepTimeMinutes,
    perServing: perServing
      ? { kcal: perServing.kcal, protein: perServing.protein }
      : null,
    ingredients: row.ingredients,
  });
  const taxonomy = canonicalTaxonomy({
    cuisine: row.cuisine ?? EMPTY_RECIPE_TAXONOMY.cuisine,
    dishType: row.dishType ?? EMPTY_RECIPE_TAXONOMY.dishType,
    seasons: row.seasons,
    occasions: row.occasions,
    equipment: row.equipment,
    features: row.features,
  });
  return {
    ...taxonomy,
    proteins: tags.filter((tag): tag is RecipeProteinTag => PROTEINS.has(tag)),
    taste: tags.includes('sweet') ? 'sweet' : 'savory',
    diets: dietsOf(row, perServing),
    fiberPerServing: gramsPerServing(row.nutritionFiber, row.servings),
    saltPerServing: gramsPerServing(row.nutritionSalt, row.servings),
    // „Wyklucz składniki” jak w aplikacji: nazwa i dział sklepu.
    ingredients: row.ingredients.map(({ name, department }) => ({
      name,
      department,
    })),
  };
}

/**
 * Kafelki „Dieta” z aplikacji (`RecipeDietFilter.matches` w iOS): ostrzej
 * niż profil — dieta składnikowa tylko na dowodzie, przepis bez danych nie
 * jest ani wege, ani bezglutenowy.
 */
function dietsOf(
  row: RecipeFacetsRow,
  perServing: ReturnType<typeof nutritionPerServing>,
): RecipeDietFilter[] {
  // Jak `RecipeDietProfile.fromServerTags` w iOS: tagi i alergeny też są
  // dowodem, że było na czym pracować.
  const hasIngredientData =
    row.ingredients.length > 0 ||
    row.dietTags.length > 0 ||
    row.allergens.length > 0;
  const subject = { dietTags: row.dietTags, hasIngredientData, perServing };
  const diet = (value: DietPreferenceValue) =>
    hasIngredientData && satisfiesDiet(value, subject);
  const diets: RecipeDietFilter[] = [];
  if (hasIngredientData && !row.allergens.includes('lactose')) {
    diets.push('LACTOSE_FREE');
  }
  if (diet('VEGETARIAN')) diets.push('VEGETARIAN');
  if (diet('VEGAN')) diets.push('VEGAN');
  if (row.dietTags.includes('FISH') || row.dietTags.includes('CRUSTACEAN')) {
    diets.push('WITH_FISH');
  }
  if (hasIngredientData && !row.allergens.includes('gluten')) {
    diets.push('GLUTEN_FREE');
  }
  if (satisfiesDiet('KETO', subject)) diets.push('KETO');
  return diets;
}
