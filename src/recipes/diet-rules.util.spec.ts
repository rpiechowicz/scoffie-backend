import {
  conflictingAllergens,
  nutritionPerServing,
  satisfiesDiet,
} from './diet-rules.util';

const subject = (
  dietTags: string[],
  perServing: { kcal: number; protein: number; carbs: number } | null = {
    kcal: 500,
    protein: 20,
    carbs: 50,
  },
  hasIngredientData = true,
) => ({ dietTags, hasIngredientData, perServing });

describe('satisfiesDiet — parytet z RecipeDietProfile.satisfies (iOS)', () => {
  it('NONE przepuszcza wszystko', () => {
    expect(satisfiesDiet('NONE', subject(['MEAT', 'PROCESSED']))).toBe(true);
  });

  it.each([
    ['VEGETARIAN', ['MEAT'], false],
    ['VEGETARIAN', ['FISH'], false],
    ['VEGETARIAN', ['CRUSTACEAN'], false],
    ['VEGETARIAN', ['DAIRY', 'EGG', 'GRAIN'], true],
    ['VEGAN', ['DAIRY'], false],
    ['VEGAN', ['EGG'], false],
    ['VEGAN', ['ANIMAL_OTHER'], false],
    ['VEGAN', ['GRAIN', 'LEGUME', 'PROCESSED'], true],
    ['PESCATARIAN', ['FISH', 'DAIRY'], true],
    ['PESCATARIAN', ['MEAT'], false],
    ['PALEO', ['GRAIN'], false],
    ['PALEO', ['GLUTEN_GRAIN', 'GRAIN'], false],
    ['PALEO', ['LEGUME'], false],
    ['PALEO', ['DAIRY'], false],
    ['PALEO', ['PROCESSED'], false],
    ['PALEO', ['MEAT', 'EGG', 'FISH'], true],
  ] as const)('%s przy tagach %p → %p', (diet, tags, expected) => {
    expect(satisfiesDiet(diet, subject([...tags]))).toBe(expected);
  });

  it('diety składnikowe przepuszczają przepis bez składników (brak dowodu)', () => {
    for (const diet of [
      'VEGETARIAN',
      'VEGAN',
      'PESCATARIAN',
      'PALEO',
    ] as const) {
      expect(satisfiesDiet(diet, subject([], null, false))).toBe(true);
    }
  });

  it('KETO: ≤ 20 g węgli na porcję, bez makr odrzuca', () => {
    expect(
      satisfiesDiet(
        'KETO',
        subject(['MEAT'], { kcal: 600, protein: 40, carbs: 20 }),
      ),
    ).toBe(true);
    expect(
      satisfiesDiet(
        'KETO',
        subject(['MEAT'], { kcal: 600, protein: 40, carbs: 20.5 }),
      ),
    ).toBe(false);
    expect(satisfiesDiet('KETO', subject(['MEAT'], null))).toBe(false);
  });

  it('HIGH_PROTEIN: ≥ 20 % energii z białka, bez makr lub 0 kcal odrzuca', () => {
    expect(
      satisfiesDiet(
        'HIGH_PROTEIN',
        subject([], { kcal: 400, protein: 20, carbs: 10 }),
      ),
    ).toBe(true); // 80/400
    expect(
      satisfiesDiet(
        'HIGH_PROTEIN',
        subject([], { kcal: 400, protein: 19, carbs: 10 }),
      ),
    ).toBe(false); // 76/400
    expect(
      satisfiesDiet(
        'HIGH_PROTEIN',
        subject([], { kcal: 0, protein: 0, carbs: 0 }),
      ),
    ).toBe(false);
    expect(satisfiesDiet('HIGH_PROTEIN', subject([], null))).toBe(false);
  });
});

describe('conflictingAllergens', () => {
  it('zwraca przecięcie posortowane i bez duplikatów', () => {
    expect(
      conflictingAllergens(
        ['lactose', 'gluten', 'gluten', 'eggs'],
        ['gluten', 'lactose', 'soy'],
      ),
    ).toEqual(['gluten', 'lactose']);
  });

  it('pusta lista unikanych = brak konfliktu', () => {
    expect(conflictingAllergens(['fish'], [])).toEqual([]);
    expect(conflictingAllergens([], ['fish'])).toEqual([]);
  });
});

describe('nutritionPerServing', () => {
  it('dzieli sumy przez porcje (min. 1)', () => {
    expect(
      nutritionPerServing({
        servings: 4,
        nutritionKcal: 2000,
        nutritionProtein: 80,
        nutritionCarbs: 200,
        nutritionFat: 60,
      }),
    ).toEqual({ kcal: 500, protein: 20, carbs: 50 });
    expect(
      nutritionPerServing({
        servings: 0,
        nutritionKcal: 100,
        nutritionProtein: 1,
        nutritionCarbs: 1,
        nutritionFat: 1,
      }),
    ).toEqual({ kcal: 100, protein: 1, carbs: 1 });
  });

  it('bez makr zwraca null', () => {
    expect(
      nutritionPerServing({
        servings: 2,
        nutritionKcal: 0,
        nutritionProtein: 0,
        nutritionCarbs: 0,
        nutritionFat: 0,
      }),
    ).toBeNull();
  });
});
