import {
  conflictingAllergens,
  satisfiesDiet,
} from '../../recipes/diet-rules.util';
import {
  prng,
  randomMembers,
  randomRecipe,
} from '../../recipes/constraints/constraint-fixtures.spec-helper';
import {
  passesAudience,
  SearchableRecipe,
  SearchAudience,
} from './catalog-search';

/**
 * RÓWNOWAŻNOŚĆ wyszukiwarki `find_recipes` (silnik C) ze wspólnym silnikiem
 * (N8A S3). Wyrocznia = ZAMROŻONA kopia `passesAudience` z `develop` 3b71b2e
 * (27.09.2026); bieżąca funkcja idzie przez `audienceReason`.
 */
function legacyPassesAudience(
  recipe: SearchableRecipe,
  audience: SearchAudience,
): boolean {
  if (conflictingAllergens(recipe.allergens, audience.allergens).length > 0) {
    return false;
  }
  if (audience.excludedIngredientIds.length > 0) {
    const excluded = new Set(audience.excludedIngredientIds);
    if (recipe.ingredients.some((ingredient) => excluded.has(ingredient.id))) {
      return false;
    }
  }
  const subject = {
    dietTags: recipe.dietTags,
    hasIngredientData: recipe.ingredients.length > 0,
    perServing: recipe.perServing,
  };
  return audience.diets.every((diet) => satisfiesDiet(diet, subject));
}

const CASES = Number(process.env.CONSTRAINT_EQUIVALENCE_CASES ?? 20_000);

describe(`silnik ograniczeń ≡ find_recipes/passesAudience (N8A S3) na ${CASES} przypadkach`, () => {
  it('ten sam werdykt co zamrożona kopia — dla każdej kombinacji alergenów, wykluczeń i diet', () => {
    const r = prng(20260928);
    const diffs: string[] = [];
    let passed = 0;
    for (let i = 0; i < CASES; i += 1) {
      const base = randomRecipe(r, `r${i}`);
      const recipe: SearchableRecipe = {
        id: base.id,
        ref: `R${i}`,
        title: `Danie ${i}`,
        mealType: 'DINNER',
        slots: base.slots,
        servings: 2,
        prepTimeMinutes: base.prepTimeMinutes,
        perServing: base.perServing,
        allergens: base.allergens,
        dietTags: base.dietTags,
        ingredients: base.ingredientIds.map((id, index) => ({
          id,
          name: base.ingredientNames[index],
          department: 'inne',
          grams: 100,
          pantry: false,
        })),
        mainIngredients: [],
        tags: [],
        household: false,
        words: { title: [], tags: [], ingredients: [], description: [] },
      };
      const members = randomMembers(r);
      // Produkcja (`AgentCatalogService`) podaje sumy bez powtórzeń,
      // posortowane i bez `NONE`; tu celowo szerzej — z powtórzeniami i
      // `NONE` — żeby równoważność nie zależała od kształtu wejścia.
      const audience: SearchAudience = {
        allergens: members.flatMap((member) => member.allergens),
        excludedIngredientIds: members.flatMap(
          (member) => member.excludedIngredientIds,
        ),
        diets: members.map((member) => member.diet),
      };
      const expected = legacyPassesAudience(recipe, audience);
      const actual = passesAudience(recipe, audience);
      if (actual !== expected) {
        diffs.push(`#${i}: wyrocznia=${expected} bieżąca=${actual}`);
      }
      if (expected) passed += 1;
    }
    expect(diffs.slice(0, 10)).toEqual([]);
    // Oba wyniki muszą występować licznie — inaczej test nic nie mówi.
    expect(passed).toBeGreaterThan(CASES * 0.2);
    expect(CASES - passed).toBeGreaterThan(CASES * 0.2);
  });
});
