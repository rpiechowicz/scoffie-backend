import { DayOfWeek, MealType } from '@prisma/client';
import {
  PlannerEater,
  PlannerRecipe,
  PlanningRequest,
} from './meal-planner.types';

/**
 * Syntetyczny katalog do testów planera — deterministyczny, bez bazy.
 *
 * Makra każdego dania mają ten sam rozkład energii (25 % białko, 30 %
 * tłuszcz, 45 % węglowodany), co cele osób z `eater()`, więc trafienie
 * w kcal oznacza też trafienie w makro — testy kcal nie mieszają się z testami
 * makro, dopóki któryś test świadomie tego nie zmieni.
 */
export const DAYS: DayOfWeek[] = [
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
  'SUN',
];

export const PROTEIN_TAG_ROTATION = [
  'poultry',
  'pork',
  'beef',
  'fish',
  'meatless',
] as const;
const DISH_ROTATION = ['soup', 'pasta', 'grains', 'salad', 'bake', 'stew'];

export function macrosFor(kcal: number) {
  return {
    kcal,
    protein: (kcal * 0.25) / 4,
    fat: (kcal * 0.3) / 9,
    carbs: (kcal * 0.45) / 4,
  };
}

export function recipe(
  id: string,
  over: Partial<PlannerRecipe> & { kcal?: number } = {},
): PlannerRecipe {
  const { kcal = 500, ...rest } = over;
  return {
    id,
    title: `Danie ${id}`,
    slots: ['DINNER'],
    servings: 2,
    prepTimeMinutes: 30,
    perServing: macrosFor(kcal),
    allergens: [],
    dietTags: [],
    ingredientIds: [`${id}-a`, `${id}-b`],
    ingredientNames: [`skladnik ${id}`],
    sharedIngredientIds: [`${id}-a`],
    tags: [],
    active: true,
    ...rest,
  };
}

/**
 * Katalog: dla każdej pory `perMeal` dań o kcal porcji rozłożonych równo od
 * `minKcal` do `maxKcal`, z rotacją białka i rodzaju dania. Białko mięsne
 * dostaje tag diety `MEAT`, ryba `FISH`, co piąte danie ma gluten.
 */
export function catalog(
  params: {
    perMeal?: number;
    meals?: MealType[];
    minKcal?: number;
    maxKcal?: number;
  } = {},
): PlannerRecipe[] {
  const {
    perMeal = 20,
    meals = ['BREAKFAST', 'LUNCH', 'DINNER'],
    minKcal = 250,
    maxKcal = 900,
  } = params;
  const recipes: PlannerRecipe[] = [];
  meals.forEach((meal, mealIndex) => {
    for (let i = 0; i < perMeal; i += 1) {
      const protein = PROTEIN_TAG_ROTATION[(i + mealIndex) % 5];
      const kcal = Math.round(
        minKcal + ((maxKcal - minKcal) * i) / Math.max(1, perMeal - 1),
      );
      const id = `${meal.toLowerCase()}-${String(i).padStart(3, '0')}`;
      recipes.push(
        recipe(id, {
          kcal,
          slots: [meal],
          tags: [protein, DISH_ROTATION[i % DISH_ROTATION.length]],
          dietTags:
            protein === 'fish'
              ? ['FISH']
              : protein === 'meatless'
                ? []
                : ['MEAT'],
          allergens: i % 5 === 0 ? ['GLUTEN'] : [],
          prepTimeMinutes: 15 + ((i * 7) % 50),
          ingredientIds: [`${id}-a`, `shared-${i % 4}`],
          sharedIngredientIds: [`${id}-a`, `shared-${i % 4}`],
          ingredientNames: [
            protein === 'fish' ? 'losos' : `skladnik ${id}`,
            'cebula',
          ],
        }),
      );
    }
  });
  return recipes;
}

export function eater(
  userId: string,
  over: Partial<PlannerEater> = {},
): PlannerEater {
  const kcalTarget = over.kcalTarget ?? 2000;
  const macros = macrosFor(kcalTarget);
  return {
    userId,
    allergens: [],
    excludedIngredientIds: [],
    diet: 'NONE',
    kcalTarget,
    macros: {
      proteinG: macros.protein,
      fatG: macros.fat,
      carbsG: macros.carbs,
    },
    ...over,
  };
}

export function request(over: Partial<PlanningRequest> = {}): PlanningRequest {
  return {
    days: ['MON'],
    mealTypes: ['BREAKFAST', 'LUNCH', 'DINNER'],
    scope: 'FULL_DAY',
    members: [eater('ania')],
    participantIds: [],
    fixed: [],
    constraints: {
      diet: null,
      requiredTags: [],
      avoidIngredients: [],
      excludeRecipeIds: [],
    },
    preferences: {
      preferredTags: [],
      maxPrepMinutes: null,
      favoriteRecipeIds: [],
      recentRecipeIds: [],
      popularity: {},
    },
    seed: 'test',
    ...over,
  };
}
