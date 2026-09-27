import { effectiveSuitableMealTypes } from '../../common/meal-types';
import { normalizeText } from '../../common/normalize-text.util';
import {
  ingredientMatches,
  passesAudience,
  SearchableRecipe,
} from './catalog-search';
import {
  conflictingAllergens,
  satisfiesDiet,
} from '../../recipes/diet-rules.util';
import { hardFilterReason } from '../../meal-planner/meal-plan-scoring';
import {
  eater,
  recipe,
  request,
} from '../../meal-planner/planner-fixtures.spec-helper';

/**
 * TESTY CHARAKTERYZUJĄCE (noc 26/27.09, N8A) — przypinają DZISIEJSZĄ
 * semantykę ograniczeń w trzech silnikach:
 *   A planer (`hardFilterReason`), B walidator zapisu (`collectPlanViolations`,
 *   tu przez jego reguły: `effectiveSuitableMealTypes`, dokładne alergeny),
 *   C wyszukiwarka `find_recipes` (`passesAudience`, `ingredientMatches`).
 *
 * To NIE są testy „tak ma być”. Każdy przypadek oznaczony [RÓŻNICA] opisuje
 * rozjazd, który przyszły `ConstraintSet v1` ma albo ujednolicić (świadoma
 * zmiana + zmiana tego testu), albo utrzymać (test równoważności). Zmiana
 * zachowania bez zmiany tego pliku = cicha zmiana semantyki domeny.
 */
function searchable(over: Partial<SearchableRecipe> = {}): SearchableRecipe {
  return {
    id: 'r1',
    ref: 'R001',
    title: 'Danie',
    mealType: 'DINNER',
    slots: ['DINNER'],
    servings: 2,
    prepTimeMinutes: 20,
    perServing: { kcal: 500, protein: 30, fat: 15, carbs: 50 },
    allergens: [],
    dietTags: [],
    ingredients: [
      {
        id: 'i1',
        name: 'Serwatka',
        department: 'nabiał',
        grams: 100,
        pantry: false,
      },
    ],
    mainIngredients: [],
    tags: [],
    household: false,
    words: { title: [], tags: [], ingredients: [], description: [] },
    ...over,
  };
}

describe('Semantyka ograniczeń — charakteryzacja (N8A)', () => {
  it('[RÓŻNICA] pora: walidator zapisu (B) dopuszcza bazowy mealType spoza suitableMealTypes, planer (A) nie', () => {
    const dbRecipe = {
      mealType: 'DINNER' as const,
      suitableMealTypes: ['LUNCH' as const],
    };
    // B: `effectiveSuitableMealTypes` = suitable ∪ {mealType}.
    expect(effectiveSuitableMealTypes(dbRecipe)).toEqual(['LUNCH', 'DINNER']);
    // A/C: sloty = suitableMealTypes (pusta lista → [mealType]); bez bazowego.
    const planner = recipe('x', { slots: ['LUNCH'] });
    expect(hardFilterReason(planner, 'DINNER', [eater('a')], request())).toBe(
      'MEAL_TYPE',
    );
  });

  it('alergeny: wszystkie silniki porównują identyfikatory DOKŁADNIE (bez hierarchii lactose→milk)', () => {
    expect(conflictingAllergens(['milk'], ['lactose'])).toEqual([]);
    expect(conflictingAllergens(['lactose', 'milk'], ['lactose'])).toEqual([
      'lactose',
    ]);
    const planner = recipe('x', { allergens: ['milk'] });
    expect(
      hardFilterReason(
        planner,
        'DINNER',
        [eater('a', { allergens: ['lactose'] })],
        request(),
      ),
    ).toBeNull();
    expect(
      passesAudience(searchable({ allergens: ['milk'] }), {
        allergens: ['lactose'],
        excludedIngredientIds: [],
        diets: [],
      }),
    ).toBe(true);
  });

  it('[RÓŻNICA] dieta bez danych o składnikach: wegetariańska/wegańska/peskatariańska/paleo PRZECHODZĄ, keto/wysokobiałkowa NIE', () => {
    const subject = {
      dietTags: [],
      hasIngredientData: false,
      perServing: null,
    };
    expect(satisfiesDiet('VEGETARIAN', subject)).toBe(true);
    expect(satisfiesDiet('VEGAN', subject)).toBe(true);
    expect(satisfiesDiet('PESCATARIAN', subject)).toBe(true);
    expect(satisfiesDiet('PALEO', subject)).toBe(true);
    expect(satisfiesDiet('KETO', subject)).toBe(false);
    expect(satisfiesDiet('HIGH_PROTEIN', subject)).toBe(false);
  });

  it('„bez X” (S6, 28.09): planer (A) = wyszukiwarka (C) = rdzeń słowa — „ser” nie trafia „serwatki”, „jajka” trafia „jajko”', () => {
    const planner = recipe('x', {
      ingredientNames: [normalizeText('Serwatka')],
    });
    const req = request({
      constraints: {
        diet: null,
        requiredTags: [],
        avoidIngredients: [normalizeText('ser')],
        excludeRecipeIds: [],
      },
    });
    // Do 28.09 planer brał podciąg i tu było AVOIDED_INGREDIENT.
    expect(hardFilterReason(planner, 'DINNER', [eater('a')], req)).toBeNull();
    expect(ingredientMatches('Serwatka', 'ser')).toBe(false);
    expect(ingredientMatches('Ser żółty', 'ser')).toBe(true);
    const eggs = recipe('x', { ingredientNames: [normalizeText('Jajko')] });
    const noEggs = request({
      constraints: {
        diet: null,
        requiredTags: [],
        avoidIngredients: [normalizeText('jajka')],
        excludeRecipeIds: [],
      },
    });
    expect(hardFilterReason(eggs, 'DINNER', [eater('a')], noEggs)).toBe(
      'AVOIDED_INGREDIENT',
    );
    expect(ingredientMatches('Jajko', 'jajka')).toBe(true);
  });

  it('[RÓŻNICA] czas: planer (A) przepuszcza prep=0 przy twardym limicie; wyszukiwarka (C) prep≤0 odrzuca (osobny test C)', () => {
    const planner = recipe('x', { prepTimeMinutes: 0 });
    const req = request({
      constraints: {
        diet: null,
        requiredTags: [],
        avoidIngredients: [],
        excludeRecipeIds: [],
        maxPrepMinutes: 10,
      },
    });
    expect(hardFilterReason(planner, 'DINNER', [eater('a')], req)).toBeNull();
  });

  it('[RÓŻNICA] wymagane tagi: planer (A) = ORAZ po wszystkich tagach', () => {
    const planner = recipe('x', { tags: ['soup'] });
    const req = request({
      constraints: {
        diet: null,
        requiredTags: ['soup', 'poultry'],
        avoidIngredients: [],
        excludeRecipeIds: [],
      },
    });
    expect(hardFilterReason(planner, 'DINNER', [eater('a')], req)).toBe(
      'REQUIRED_TAG',
    );
  });

  it('dieta osoby w planerze (A) i wyszukiwarce (C) — ta sama funkcja, ten sam wynik', () => {
    const meat = { dietTags: ['MEAT'] };
    expect(
      hardFilterReason(
        recipe('x', meat),
        'DINNER',
        [eater('a', { diet: 'VEGETARIAN' })],
        request(),
      ),
    ).toBe('DIET');
    expect(
      passesAudience(searchable(meat), {
        allergens: [],
        excludedIngredientIds: [],
        diets: ['VEGETARIAN'],
      }),
    ).toBe(false);
  });
});
