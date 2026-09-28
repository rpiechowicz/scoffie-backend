import {
  allergenConflicts,
  audienceConstraintsOf,
  audienceReason,
  checkRecipe,
  ConstraintSetV1,
  ConstraintSubject,
  excludedIngredientHits,
} from './recipe-constraints';

function subject(over: Partial<ConstraintSubject> = {}): ConstraintSubject {
  return {
    id: 'r1',
    active: true,
    slots: ['DINNER'],
    prepTimeMinutes: 20,
    allergens: [],
    ingredientIds: ['i1', 'i2'],
    ingredientNames: ['piers z kurczaka', 'ryz'],
    dietTags: [],
    tags: [],
    perServing: { kcal: 500, protein: 30, carbs: 50 },
    ...over,
  };
}

function set(over: Partial<ConstraintSetV1['request']> = {}): ConstraintSetV1 {
  return {
    v: 1,
    audience: { allergens: [], excludedIngredientIds: [], diets: [] },
    request: {
      mealType: 'DINNER',
      excludeRecipeIds: [],
      maxPrepMinutes: null,
      requestDiet: null,
      requiredTags: [],
      avoidIngredients: [],
      requireNutrition: true,
      ...over,
    },
  };
}

describe('recipe-constraints', () => {
  it('suma audytorium: bez powtórek, w kolejności pierwszego wystąpienia', () => {
    expect(
      audienceConstraintsOf([
        {
          allergens: ['gluten', 'milk'],
          excludedIngredientIds: ['a'],
          diet: 'NONE',
        },
        {
          allergens: ['milk', 'eggs'],
          excludedIngredientIds: ['a', 'b'],
          diet: 'VEGAN',
        },
        { allergens: [], excludedIngredientIds: [], diet: 'NONE' },
      ]),
    ).toEqual({
      allergens: ['gluten', 'milk', 'eggs'],
      excludedIngredientIds: ['a', 'b'],
      diets: ['NONE', 'VEGAN'],
    });
    expect(audienceConstraintsOf([])).toEqual({
      allergens: [],
      excludedIngredientIds: [],
      diets: [],
    });
  });

  it('alergeny: przecięcie dokładnych identyfikatorów, posortowane', () => {
    expect(
      allergenConflicts(
        { allergens: ['milk', 'gluten', 'milk'] },
        { allergens: ['milk', 'gluten', 'nuts'] },
      ),
    ).toEqual(['gluten', 'milk']);
    expect(
      allergenConflicts({ allergens: ['milk'] }, { allergens: ['lactose'] }),
    ).toEqual([]);
  });

  it('wykluczenia: trafione składniki w kolejności przepisu', () => {
    expect(
      excludedIngredientHits(
        { ingredientIds: ['i3', 'i1', 'i2'] },
        { excludedIngredientIds: ['i2', 'i3'] },
      ),
    ).toEqual(['i3', 'i2']);
  });

  it('audytorium: alergen wygrywa z wykluczeniem, wykluczenie z dietą', () => {
    const meatWithMilk = subject({
      allergens: ['milk'],
      ingredientIds: ['i1'],
      dietTags: ['MEAT'],
    });
    expect(
      audienceReason(meatWithMilk, {
        allergens: ['milk'],
        excludedIngredientIds: ['i1'],
        diets: ['VEGETARIAN'],
      }),
    ).toBe('ALLERGEN');
    expect(
      audienceReason(meatWithMilk, {
        allergens: [],
        excludedIngredientIds: ['i1'],
        diets: ['VEGETARIAN'],
      }),
    ).toBe('EXCLUDED_INGREDIENT');
    expect(
      audienceReason(meatWithMilk, {
        allergens: [],
        excludedIngredientIds: [],
        diets: ['VEGETARIAN'],
      }),
    ).toBe('DIET');
  });

  it('dieta bez danych o składnikach przepuszcza wegetariańską (asymetria jak w iOS)', () => {
    expect(
      audienceReason(subject({ ingredientIds: [], dietTags: ['MEAT'] }), {
        allergens: [],
        excludedIngredientIds: [],
        diets: ['VEGETARIAN'],
      }),
    ).toBeNull();
  });

  it('mealType null nie sprawdza pory; requireNutrition=false przepuszcza przepis bez makr', () => {
    const lunchOnly = subject({ slots: ['LUNCH'], perServing: null });
    expect(checkRecipe(lunchOnly, set())).toBe('MEAL_TYPE');
    expect(checkRecipe(lunchOnly, set({ mealType: null }))).toBe(
      'NO_NUTRITION',
    );
    expect(
      checkRecipe(lunchOnly, set({ mealType: null, requireNutrition: false })),
    ).toBeNull();
  });

  it('twardy limit czasu: równy limitowi przechodzi, dłuższy odpada, 0 min przechodzi', () => {
    expect(
      checkRecipe(
        subject({ prepTimeMinutes: 10 }),
        set({ maxPrepMinutes: 10 }),
      ),
    ).toBeNull();
    expect(
      checkRecipe(
        subject({ prepTimeMinutes: 11 }),
        set({ maxPrepMinutes: 10 }),
      ),
    ).toBe('PREP_TIME');
    expect(
      checkRecipe(subject({ prepTimeMinutes: 0 }), set({ maxPrepMinutes: 0 })),
    ).toBeNull();
  });

  it('„bez X” to podciąg znormalizowanej nazwy', () => {
    expect(checkRecipe(subject(), set({ avoidIngredients: ['kurcz'] }))).toBe(
      'AVOIDED_INGREDIENT',
    );
    expect(
      checkRecipe(subject(), set({ avoidIngredients: ['wolowina'] })),
    ).toBeNull();
  });
});
