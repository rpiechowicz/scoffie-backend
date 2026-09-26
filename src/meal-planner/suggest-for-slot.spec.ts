import { suggestForSlot } from './meal-plan-engine';
import { PlannedItem, PlannerRecipe } from './meal-planner.types';
import {
  catalog,
  eater,
  recipe,
  request,
} from './planner-fixtures.spec-helper';

/**
 * Propozycje na jeden slot (`suggest_meals`, workstream Etap 3) — bez bazy
 * i bez modelu. Te same filtry twarde i ta sama funkcja kosztu dnia, co
 * planer, plus zawężenie życzeniem miękkim i różnorodność.
 */
const byId = (recipes: PlannerRecipe[]) =>
  new Map(recipes.map((entry) => [entry.id, entry]));

const dinnerRequest = (over: Parameters<typeof request>[0] = {}) =>
  request({
    days: ['MON'],
    mealTypes: ['DINNER'],
    scope: 'PARTIAL',
    dayMealTypes: ['BREAKFAST', 'LUNCH', 'DINNER'],
    portionMode: 'auto',
    ...over,
  });

describe('suggestForSlot', () => {
  it('1. oddaje żądaną liczbę RÓŻNYCH dań na tę porę, status OK', () => {
    const recipes = catalog();
    const result = suggestForSlot(dinnerRequest(), recipes, { count: 3 });
    expect(result.status).toBe('OK');
    expect(result.suggestions).toHaveLength(3);
    const ids = result.suggestions.map((entry) => entry.item.recipeId);
    expect(new Set(ids).size).toBe(3);
    const lookup = byId(recipes);
    for (const id of ids) {
      expect(lookup.get(id)?.slots).toContain('DINNER');
    }
    expect(result.eligible).toBeGreaterThanOrEqual(3);
  });

  it('2. alergia i dieta jedzącego są twarde', () => {
    const recipes = [
      ...catalog(),
      // Idealne kalorycznie danie z glutenem — nie ma prawa wejść.
      recipe('perfect-gluten', { kcal: 600, allergens: ['GLUTEN'] }),
    ];
    const result = suggestForSlot(
      dinnerRequest({
        members: [
          eater('ania', { allergens: ['GLUTEN'], diet: 'VEGETARIAN' }),
          eater('marek'),
        ],
      }),
      recipes,
      { count: 3 },
    );
    const lookup = byId(recipes);
    expect(result.suggestions.length).toBeGreaterThan(0);
    for (const entry of result.suggestions) {
      const chosen = lookup.get(entry.item.recipeId)!;
      expect(chosen.allergens).not.toContain('GLUTEN');
      expect(chosen.dietTags).not.toContain('MEAT');
      expect(chosen.dietTags).not.toContain('FISH');
    }
  });

  it('3. „szybkie": gdy wystarczy dań, wszystkie mieszczą się w czasie; inaczej życzenie łagodnieje jawnie', () => {
    const recipes = catalog();
    const quick = suggestForSlot(
      dinnerRequest({
        preferences: {
          ...request().preferences,
          maxPrepMinutes: 25,
        },
      }),
      recipes,
      { count: 3 },
    );
    const lookup = byId(recipes);
    for (const entry of quick.suggestions) {
      expect(
        lookup.get(entry.item.recipeId)!.prepTimeMinutes,
      ).toBeLessThanOrEqual(25);
    }
    expect(quick.relaxed).toEqual([]);

    const impossible = suggestForSlot(
      dinnerRequest({
        preferences: { ...request().preferences, maxPrepMinutes: 1 },
      }),
      recipes,
      { count: 3 },
    );
    expect(impossible.suggestions).toHaveLength(3);
    expect(impossible.relaxed).toContain('max_prep_minutes');
  });

  it('różnorodność: trzy dania nie są trzema wariantami tego samego białka', () => {
    const recipes = catalog({ perMeal: 30 });
    const result = suggestForSlot(dinnerRequest(), recipes, { count: 3 });
    const lookup = byId(recipes);
    const proteins = result.suggestions.map(
      (entry) =>
        lookup
          .get(entry.item.recipeId)!
          .tags.find((tag) =>
            ['poultry', 'pork', 'beef', 'fish', 'meatless'].includes(tag),
          )!,
    );
    expect(new Set(proteins).size).toBe(3);
  });

  it('dozwolona pula (składnik z prośby) zawęża kandydatów', () => {
    const recipes = catalog();
    const allowed = new Set(
      recipes
        .filter((entry) => entry.slots.includes('DINNER'))
        .slice(0, 4)
        .map((entry) => entry.id),
    );
    const result = suggestForSlot(dinnerRequest(), recipes, {
      count: 3,
      allowedRecipeIds: allowed,
    });
    for (const entry of result.suggestions) {
      expect(allowed.has(entry.item.recipeId)).toBe(true);
    }
  });

  it('dopasowanie do dnia: przy ciężkim obiedzie kolacja jest lżejsza niż przy pustym dniu', () => {
    // Obiad na 1500 kcal przy celu 2000 — na kolację zostaje niewiele.
    const heavyLunch = recipe('mega-lunch', { kcal: 1500, slots: ['LUNCH'] });
    const recipes = [...catalog(), heavyLunch];
    const fixed: PlannedItem[] = [
      {
        dayOfWeek: 'MON',
        mealType: 'LUNCH',
        recipeId: heavyLunch.id,
        participantIds: [],
        plannedServings: 1,
      },
    ];
    const lookup = byId(recipes);
    const mean = (ids: string[]) =>
      ids.reduce((sum, id) => sum + lookup.get(id)!.perServing!.kcal, 0) /
      ids.length;
    const free = suggestForSlot(dinnerRequest(), recipes, { count: 3 });
    const afterHeavy = suggestForSlot(dinnerRequest({ fixed }), recipes, {
      count: 3,
    });
    expect(
      mean(afterHeavy.suggestions.map((entry) => entry.item.recipeId)),
    ).toBeLessThan(mean(free.suggestions.map((entry) => entry.item.recipeId)));
    // Budżet slotu mówi to samo liczbą.
    expect(afterHeavy.slotBudget[0].kcal).toBeLessThan(free.slotBudget[0].kcal);
  });

  it('UNSAT: nic nie spełnia ograniczeń → zero propozycji, bez fałszywego sukcesu', () => {
    const allGluten = catalog().map((entry) => ({
      ...entry,
      allergens: ['GLUTEN'],
    }));
    const result = suggestForSlot(
      dinnerRequest({ members: [eater('ania', { allergens: ['GLUTEN'] })] }),
      allGluten,
      { count: 3 },
    );
    expect(result.status).toBe('UNSAT');
    expect(result.suggestions).toEqual([]);
    expect(result.candidates.removed.ALLERGEN).toBeGreaterThan(0);
  });

  it('porcje per osoba (per_user): para 1600/2600 — każde danie z porcją każdej osoby', () => {
    const result = suggestForSlot(
      dinnerRequest({
        portionMode: 'per_user',
        members: [
          eater('asia', { kcalTarget: 1600 }),
          eater('rafal', { kcalTarget: 2600 }),
        ],
      }),
      catalog(),
      { count: 3 },
    );
    expect(result.suggestions).toHaveLength(3);
    for (const entry of result.suggestions) {
      const portions = Object.fromEntries(
        (entry.item.portions ?? []).map((p) => [p.userId, p.servings]),
      );
      expect(portions.rafal).toBeGreaterThan(portions.asia);
    }
  });

  it('ten sam seed i dane → te same propozycje', () => {
    const recipes = catalog();
    const a = suggestForSlot(dinnerRequest(), recipes, { count: 3 });
    const b = suggestForSlot(dinnerRequest(), recipes, { count: 3 });
    expect(a.suggestions).toEqual(b.suggestions);
  });
});
