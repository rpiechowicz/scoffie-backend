import { planMeals } from './meal-plan-engine';
import {
  KCAL_DAY_TOLERANCE,
  PLANNER_PORTION_MAX,
  PLANNER_PORTION_MIN,
  PLANNER_PORTION_STEP,
  portionFor,
} from './meal-plan-scoring';
import { PlannedItem, PlannerRecipe } from './meal-planner.types';
import { catalog, DAYS, eater, request } from './planner-fixtures.spec-helper';

/**
 * Planer z porcjami per osoba (workstream, Etap 2.2, `portionMode:
 * 'per_user'`). Numery w opisach = lista testów obowiązkowych Etapu 2.2.
 * Każdy test porównuje z trybem sprzed etapu (`tune`: równy podział), żeby
 * zysk był widać w samym teście, a nie tylko w raporcie.
 */
const byId = (recipes: PlannerRecipe[]) =>
  new Map(recipes.map((entry) => [entry.id, entry]));

const isStep = (servings: number) =>
  Math.abs(
    Math.round(servings / PLANNER_PORTION_STEP) * PLANNER_PORTION_STEP -
      servings,
  ) < 1e-9;

const couple = [
  eater('asia', { kcalTarget: 1600 }),
  eater('rafal', { kcalTarget: 2600 }),
];
const family = [
  eater('a', { kcalTarget: 1600 }),
  eater('b', { kcalTarget: 2600 }),
  eater('c', { kcalTarget: 2000 }),
  eater('d', { kcalTarget: 1400 }),
];

function expectSaneAllocation(items: PlannedItem[], audience: string[]) {
  for (const item of items) {
    expect(item.portions).toBeDefined();
    const portions = item.portions ?? [];
    expect(portions.map((p) => p.userId).sort()).toEqual([...audience].sort());
    for (const portion of portions) {
      expect(portion.servings).toBeGreaterThanOrEqual(PLANNER_PORTION_MIN);
      expect(portion.servings).toBeLessThanOrEqual(PLANNER_PORTION_MAX);
      expect(isStep(portion.servings)).toBe(true);
    }
    const total = portions.reduce((sum, p) => sum + p.servings, 0);
    // plannedServings = pochodna ceil(Σ) dla starych klientów.
    expect(item.plannedServings).toBe(Math.ceil(total - 1e-9));
  }
}

describe('stałe domenowe porcji planera', () => {
  it('porcja osoby 0,5–1,5 porcji przepisu, krok 0,05', () => {
    expect(PLANNER_PORTION_MIN).toBe(0.5);
    expect(PLANNER_PORTION_MAX).toBe(1.5);
    expect(PLANNER_PORTION_STEP).toBe(0.05);
  });

  it('portionFor: zaokrągla do kroku i przycina do widełek', () => {
    expect(portionFor(500, 500)).toBe(1);
    expect(portionFor(640, 500)).toBe(1.3); // 1,28 → 1,3
    expect(portionFor(410, 500)).toBe(0.8); // 0,82 → 0,8
    expect(portionFor(100, 500)).toBe(0.5); // za mało — nie ćwiartka obiadu
    expect(portionFor(2000, 500)).toBe(1.5); // za dużo — nie trzy kolacje
    expect(portionFor(-50, 500)).toBe(0.5);
    expect(portionFor(500, 0)).toBe(1);
  });
});

describe('planMeals — porcje per osoba', () => {
  it('4. solo 2000 kcal: porcja dopasowana (np. 0,9 / 1,1), dzień bliżej celu niż przy całych porcjach', () => {
    const recipes = catalog();
    const base = request({ days: DAYS });
    const tune = planMeals({ ...base, portionMode: 'tune' }, recipes);
    const perUser = planMeals({ ...base, portionMode: 'per_user' }, recipes);
    expectSaneAllocation(perUser.items, ['ania']);
    expect(
      perUser.diagnostics.metrics.maxDayKcalDeviationPct,
    ).toBeLessThanOrEqual(KCAL_DAY_TOLERANCE * 100);
    expect(perUser.diagnostics.metrics.dayKcalDeviationPct).toBeLessThanOrEqual(
      tune.diagnostics.metrics.dayKcalDeviationPct + 0.5,
    );
    expect(perUser.status).toBe('OK');
  });

  it('5. para 1600/2600: to samo danie, różne porcje, każdy dzień ≤ 10 % (przed: ~23 %)', () => {
    const recipes = catalog();
    const base = request({ days: DAYS, members: couple });
    const tune = planMeals({ ...base, portionMode: 'tune' }, recipes);
    const perUser = planMeals({ ...base, portionMode: 'per_user' }, recipes);

    expectSaneAllocation(perUser.items, ['asia', 'rafal']);
    // Wspólne danie zostaje wspólne: jedna pozycja na slot, „Wspólne".
    expect(perUser.items).toHaveLength(21);
    expect(
      perUser.items.every((item) => item.participantIds.length === 0),
    ).toBe(true);
    // Rafał (2600) dostaje większą porcję niż Asia (1600) w każdym daniu.
    for (const item of perUser.items) {
      const of = (id: string) =>
        item.portions!.find((p) => p.userId === id)!.servings;
      expect(of('rafal')).toBeGreaterThan(of('asia'));
    }

    const before = tune.diagnostics.metrics;
    const after = perUser.diagnostics.metrics;
    expect(before.dayKcalDeviationPct).toBeGreaterThan(15);
    expect(after.dayKcalDeviationPct).toBeLessThanOrEqual(5);
    expect(after.maxDayKcalDeviationPct).toBeLessThanOrEqual(10);
    for (const day of perUser.diagnostics.days) {
      for (const person of day.eaters) {
        expect(Math.abs(person.kcalDeviation)).toBeLessThanOrEqual(
          KCAL_DAY_TOLERANCE,
        );
      }
    }
    expect(perUser.status).toBe('OK');
  });

  it('6. rodzina 4 osób (1400–2600): każdy dzień ≤ 10 % (przed: ~14 %)', () => {
    const recipes = catalog();
    const base = request({ days: DAYS, members: family });
    const tune = planMeals({ ...base, portionMode: 'tune' }, recipes);
    const perUser = planMeals({ ...base, portionMode: 'per_user' }, recipes);
    expectSaneAllocation(perUser.items, ['a', 'b', 'c', 'd']);
    expect(perUser.diagnostics.metrics.dayKcalDeviationPct).toBeLessThan(
      tune.diagnostics.metrics.dayKcalDeviationPct,
    );
    expect(
      perUser.diagnostics.metrics.maxDayKcalDeviationPct,
    ).toBeLessThanOrEqual(KCAL_DAY_TOLERANCE * 100);
    expect(perUser.status).toBe('OK');
  });

  it('7. porcje nie łamią twardych ograniczeń: alergia i dieta jednej osoby obowiązują we wspólnym daniu', () => {
    const recipes = catalog();
    const lookup = byId(recipes);
    const draft = planMeals(
      request({
        days: DAYS,
        portionMode: 'per_user',
        members: [
          eater('asia', {
            kcalTarget: 1600,
            allergens: ['GLUTEN'],
            diet: 'VEGETARIAN',
          }),
          eater('rafal', { kcalTarget: 2600 }),
        ],
      }),
      recipes,
    );
    expect(draft.diagnostics.metrics.hardViolations).toBe(0);
    for (const item of draft.items) {
      const chosen = lookup.get(item.recipeId)!;
      expect(chosen.allergens).not.toContain('GLUTEN');
      expect(chosen.dietTags).not.toContain('MEAT');
      expect(chosen.dietTags).not.toContain('FISH');
    }
  });

  it('za lekkie dania: porcja nie przekracza 1,5 i plan uczciwie zostaje PARTIAL', () => {
    const light = catalog({ minKcal: 120, maxKcal: 200 });
    const draft = planMeals(
      request({ members: couple, portionMode: 'per_user' }),
      light,
    );
    for (const item of draft.items) {
      for (const portion of item.portions ?? []) {
        expect(portion.servings).toBeLessThanOrEqual(PLANNER_PORTION_MAX);
      }
    }
    expect(draft.status).toBe('PARTIAL');
  });

  it('ten sam seed → identyczna alokacja', () => {
    const recipes = catalog();
    const req = request({
      days: DAYS,
      members: couple,
      portionMode: 'per_user',
    });
    expect(planMeals(req, recipes).items).toEqual(
      planMeals(req, recipes).items,
    );
  });

  it('8. podmiana jednego slotu: reszta (z porcjami) jest stała, nowe danie domyka dzień KAŻDEJ osoby', () => {
    const recipes = catalog({ perMeal: 30 });
    const base = planMeals(
      request({ days: DAYS, members: couple, portionMode: 'per_user' }),
      recipes,
    );
    const wednesday = base.items.find(
      (item) => item.dayOfWeek === 'WED' && item.mealType === 'DINNER',
    )!;
    const rest = base.items.filter((item) => item !== wednesday);
    const restSnapshot = JSON.parse(JSON.stringify(rest)) as PlannedItem[];

    const draft = planMeals(
      request({
        days: ['WED'],
        mealTypes: ['DINNER'],
        members: couple,
        fixed: rest,
        scope: 'PARTIAL',
        dayMealTypes: ['BREAKFAST', 'LUNCH', 'DINNER'],
        portionMode: 'per_user',
        constraints: {
          diet: null,
          requiredTags: [],
          avoidIngredients: [],
          excludeRecipeIds: [wednesday.recipeId],
        },
        // „Podobnie kaloryczne" waży w wyborze DANIA, nie spłaszcza porcji.
        slotKcalTargets: { 'WED|DINNER': 600 },
      }),
      recipes,
    );
    // Silnik oddaje tylko nowy slot; pozycje stałe (i ich porcje) nietknięte.
    expect(draft.items).toHaveLength(1);
    expect(rest).toEqual(restSnapshot);
    expectSaneAllocation(draft.items, ['asia', 'rafal']);
    const portions = draft.items[0].portions!;
    const of = (id: string) => portions.find((p) => p.userId === id)!.servings;
    expect(of('rafal')).toBeGreaterThan(of('asia'));
    for (const person of draft.diagnostics.days[0].eaters) {
      expect(Math.abs(person.kcalDeviation)).toBeLessThanOrEqual(
        KCAL_DAY_TOLERANCE,
      );
    }
  });

  it('pozycje stałe z porcjami liczą się w bilansie osoby — planer nie dubluje kcal', () => {
    const recipes = catalog();
    const lunch = recipes.find((entry) => entry.slots.includes('LUNCH'))!;
    const fixed: PlannedItem = {
      dayOfWeek: 'MON',
      mealType: 'LUNCH',
      recipeId: lunch.id,
      participantIds: [],
      plannedServings: 3,
      portions: [
        { userId: 'asia', servings: 0.5 },
        { userId: 'rafal', servings: 1.5 },
      ],
    };
    const draft = planMeals(
      request({
        members: couple,
        mealTypes: ['BREAKFAST', 'DINNER'],
        fixed: [fixed],
        portionMode: 'per_user',
      }),
      recipes,
    );
    const lunchKcal = lunch.perServing!.kcal;
    const day = draft.diagnostics.days[0];
    for (const person of day.eaters) {
      const share = person.userId === 'asia' ? 0.5 : 1.5;
      // Planowane pory + stały obiad TEJ osoby ≈ jej cel dnia.
      expect(person.dayKcal).toBeGreaterThanOrEqual(lunchKcal * share);
      expect(Math.abs(person.kcalDeviation)).toBeLessThanOrEqual(
        KCAL_DAY_TOLERANCE,
      );
    }
  });
});
