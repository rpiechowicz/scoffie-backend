import { DietPreferenceValue, MealType } from '@prisma/client';
import { ALLERGEN_IDS } from '../../common/allergens';
import { DIET_TAG_IDS } from '../../common/diet-tags';

/**
 * Losowe, ale DETERMINISTYCZNE dane do testów równoważności silników
 * ograniczeń (N8A). Rozkłady celowo trzymają się progów reguł: keto przy
 * 20 g węgli, wysokobiałkowa przy 20 % energii, czas 0 przy limicie, podciągi
 * nazw („ser” w „serwatce”), przepisy bez składników i bez makr — tam, gdzie
 * dwie implementacje najłatwiej się rozjeżdżają.
 */

export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) =>
    lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  const chance = (p: number) => next() < p;
  const subset = <T>(items: readonly T[], max: number): T[] => {
    const count = int(0, Math.min(max, items.length));
    const pool = [...items];
    const out: T[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(pool.splice(int(0, pool.length - 1), 1)[0]);
    }
    return out;
  };
  return { next, int, pick, chance, subset };
}

export type Rng = ReturnType<typeof prng>;

export const MEALS: MealType[] = [
  'BREAKFAST',
  'SECOND_BREAKFAST',
  'LUNCH',
  'AFTERNOON_SNACK',
  'DINNER',
  'SNACK',
];

export const DIETS: DietPreferenceValue[] = [
  'NONE',
  'VEGETARIAN',
  'VEGAN',
  'PESCATARIAN',
  'KETO',
  'PALEO',
  'HIGH_PROTEIN',
];

/** Alergeny słownika + jeden spoza (stare dane w `String[]`). */
export const ALLERGENS: string[] = [...ALLERGEN_IDS, 'nieznany-alergen'];

const INGREDIENTS: { id: string; name: string }[] = [
  { id: 'i-ser', name: 'ser zolty' },
  { id: 'i-serwatka', name: 'serwatka' },
  { id: 'i-kurczak', name: 'piers z kurczaka' },
  { id: 'i-maslo', name: 'maslo' },
  { id: 'i-mleko', name: 'mleko' },
  { id: 'i-pomidor', name: 'pomidor' },
  { id: 'i-makaron', name: 'makaron pszenny' },
  { id: 'i-jajko', name: 'jajko' },
  { id: 'i-losos', name: 'losos' },
  { id: 'i-tofu', name: 'tofu' },
];
export const INGREDIENT_IDS = INGREDIENTS.map((ingredient) => ingredient.id);
/** Fragmenty „bez X” — część trafia podciągiem w środku słowa. */
export const AVOIDED = [
  'ser',
  'kurczak',
  'mleko',
  'jajka',
  'pomidory',
  'ryby',
  'miesa',
  'makaron',
  'xyz',
  'o',
];
export const TAGS = ['soup', 'poultry', 'quick', 'salad', 'fish', 'pasta'];

const NUTRIENT_STEPS = [0, 5, 10, 19.9, 20, 20.1, 30, 45, 80];
const KCAL_STEPS = [0, 1, 80, 100, 250, 400, 600, 900];

export type RandomRecipe = {
  id: string;
  active: boolean;
  slots: MealType[];
  prepTimeMinutes: number;
  allergens: string[];
  ingredientIds: string[];
  ingredientNames: string[];
  dietTags: string[];
  tags: string[];
  perServing: {
    kcal: number;
    protein: number;
    fat: number;
    carbs: number;
  } | null;
};

export function randomRecipe(r: Rng, id: string): RandomRecipe {
  // 15 % przepisów bez składników: diety składnikowe mają je przepuszczać.
  const ingredients = r.chance(0.15) ? [] : r.subset(INGREDIENTS, 5);
  return {
    id,
    active: r.chance(0.92),
    slots: r.subset(MEALS, 4),
    prepTimeMinutes: r.pick([0, 0, 5, 10, 15, 30, 45, 90]),
    allergens: r.subset(ALLERGENS, 3),
    ingredientIds: ingredients.map((ingredient) => ingredient.id),
    ingredientNames: ingredients.map((ingredient) => ingredient.name),
    dietTags: r.subset(DIET_TAG_IDS, 4),
    tags: r.subset(TAGS, 3),
    perServing: r.chance(0.12)
      ? null
      : {
          kcal: r.pick(KCAL_STEPS),
          protein: r.pick(NUTRIENT_STEPS),
          fat: r.pick(NUTRIENT_STEPS),
          carbs: r.pick(NUTRIENT_STEPS),
        },
  };
}

export type RandomMember = {
  userId: string;
  allergens: string[];
  excludedIngredientIds: string[];
  diet: DietPreferenceValue;
};

export function randomMember(r: Rng, userId: string): RandomMember {
  return {
    userId,
    // Rzadziej niż w przepisach, żeby nie każdy przypadek kończył się na ALLERGEN.
    allergens: r.chance(0.6) ? [] : r.subset(ALLERGENS, 2),
    excludedIngredientIds: r.chance(0.6) ? [] : r.subset(INGREDIENT_IDS, 2),
    diet: r.chance(0.5) ? 'NONE' : r.pick(DIETS),
  };
}

export function randomMembers(r: Rng, max = 4): RandomMember[] {
  return Array.from({ length: r.int(0, max) }, (_, i) =>
    randomMember(r, `u${i + 1}`),
  );
}
