import { evaluatePlan, planMeals } from './meal-plan-engine';
import {
  KCAL_DAY_TOLERANCE,
  PORTION_SHARE_MAX,
  PORTION_SHARE_MIN,
} from './meal-plan-scoring';
import { PlannedItem, PlannerRecipe } from './meal-planner.types';
import {
  catalog,
  DAYS,
  eater,
  recipe,
  request,
} from './planner-fixtures.spec-helper';

/**
 * Silnik planera (workstream, Etap 2) — bez bazy i bez modelu. Numery w opisach
 * odpowiadają liście obowiązkowych testów z polecenia Etapu 2.
 */
const byId = (recipes: PlannerRecipe[]) =>
  new Map(recipes.map((entry) => [entry.id, entry]));

describe('planMeals — dzień', () => {
  it('1. trafia w cel kcal dnia w tolerancji (±10 %), status OK', () => {
    const draft = planMeals(request(), catalog());
    expect(draft.status).toBe('OK');
    expect(draft.items).toHaveLength(3);
    // Pełny dzień (pory domu) = 100 % celu 2000 kcal — tak, jak porównuje
    // aplikacja (`WeeklyPlanView` × `DailyNutritionTargets`), nie 80 %.
    const [day] = draft.diagnostics.days;
    expect(day.eaters[0].kcalTarget).toBe(2000);
    expect(Math.abs(day.eaters[0].kcalDeviation)).toBeLessThanOrEqual(
      KCAL_DAY_TOLERANCE,
    );
    expect(draft.diagnostics.metrics.hardViolations).toBe(0);
  });

  it('każdy slot dostaje danie właściwej pory', () => {
    const recipes = catalog();
    const draft = planMeals(request(), recipes);
    const lookup = byId(recipes);
    for (const item of draft.items) {
      expect(lookup.get(item.recipeId)?.slots).toContain(item.mealType);
    }
  });

  it('2. alergia NIGDY nie jest łamana — nawet gdy danie z alergenem idealnie trafia w cel', () => {
    const perfect = recipe('perfect-gluten', {
      kcal: 320,
      slots: ['DINNER'],
      allergens: ['GLUTEN'],
    });
    const recipes = [...catalog(), perfect];
    for (const seed of ['a', 'b', 'c', 'd']) {
      const draft = planMeals(
        request({
          seed,
          days: DAYS,
          members: [eater('ania', { allergens: ['GLUTEN'] })],
        }),
        recipes,
      );
      const lookup = byId(recipes);
      for (const item of draft.items) {
        expect(lookup.get(item.recipeId)?.allergens).not.toContain('GLUTEN');
      }
      expect(draft.diagnostics.metrics.hardViolations).toBe(0);
    }
  });

  it('alergia JEDNEGO domownika obowiązuje w daniu wspólnym', () => {
    const recipes = catalog();
    const draft = planMeals(
      request({
        days: DAYS,
        members: [eater('ania'), eater('marek', { allergens: ['GLUTEN'] })],
      }),
      recipes,
    );
    const lookup = byId(recipes);
    expect(
      draft.items.some((item) =>
        lookup.get(item.recipeId)?.allergens.includes('GLUTEN'),
      ),
    ).toBe(false);
  });

  it('3. dieta NIGDY nie jest łamana (profil i prośba)', () => {
    const recipes = catalog();
    const lookup = byId(recipes);
    const vegetarian = planMeals(
      request({
        days: DAYS,
        members: [eater('ania', { diet: 'VEGETARIAN' })],
      }),
      recipes,
    );
    const fromRequest = planMeals(
      request({
        days: DAYS,
        constraints: {
          diet: 'VEGETARIAN',
          requiredTags: [],
          avoidIngredients: [],
          excludeRecipeIds: [],
        },
      }),
      recipes,
    );
    for (const draft of [vegetarian, fromRequest]) {
      expect(draft.items.length).toBeGreaterThan(0);
      for (const item of draft.items) {
        const tags = lookup.get(item.recipeId)?.dietTags ?? [];
        expect(tags).not.toContain('MEAT');
        expect(tags).not.toContain('FISH');
      }
    }
  });

  it('wykluczony składnik domownika i „bez X" z prośby nie wchodzą', () => {
    const recipes = catalog();
    const lookup = byId(recipes);
    const draft = planMeals(
      request({
        days: DAYS,
        members: [eater('ania', { excludedIngredientIds: ['shared-1'] })],
        constraints: {
          diet: null,
          requiredTags: [],
          avoidIngredients: ['losos'],
          excludeRecipeIds: [],
        },
      }),
      recipes,
    );
    for (const item of draft.items) {
      const chosen = lookup.get(item.recipeId)!;
      expect(chosen.ingredientIds).not.toContain('shared-1');
      expect(chosen.ingredientNames).not.toContain('losos');
    }
  });

  it('4. przepis nieaktywny nie trafia do planu, choćby był idealny', () => {
    const retired = recipe('retired', {
      kcal: 320,
      slots: ['DINNER'],
      active: false,
    });
    const draft = planMeals(request({ days: DAYS }), [...catalog(), retired]);
    expect(draft.items.map((item) => item.recipeId)).not.toContain('retired');
  });

  it('przepis bez makr nie jest planowany (nie da się policzyć celu), ale liczy się w diagnostyce', () => {
    const noMacros = recipe('no-macros', {
      slots: ['DINNER'],
      perServing: null,
    });
    const draft = planMeals(request(), [...catalog(), noMacros]);
    expect(draft.items.map((item) => item.recipeId)).not.toContain('no-macros');
    const dinner = draft.diagnostics.candidates.find(
      (entry) => entry.mealType === 'DINNER',
    );
    expect(dinner?.removed.NO_NUTRITION).toBe(1);
  });

  it('5. porcje w rozsądnych widełkach; osoba sama zawsze dostaje 1 porcję', () => {
    const solo = planMeals(request({ days: DAYS }), catalog());
    expect(solo.items.every((item) => item.plannedServings === 1)).toBe(true);

    const family = planMeals(
      request({
        days: DAYS,
        members: [
          eater('a', { kcalTarget: 1600 }),
          eater('b', { kcalTarget: 2600 }),
          eater('c', { kcalTarget: 2000 }),
          eater('d', { kcalTarget: 2400 }),
        ],
      }),
      catalog(),
    );
    for (const item of family.items) {
      const share = item.plannedServings / 4;
      expect(share).toBeGreaterThanOrEqual(PORTION_SHARE_MIN);
      expect(share).toBeLessThanOrEqual(PORTION_SHARE_MAX);
      expect(Number.isInteger(item.plannedServings)).toBe(true);
    }
  });

  it('porcje nie „naprawiają" kcal: przy samych lekkich daniach udział zostaje ≤ 1,5, a status PARTIAL', () => {
    const light = catalog({ minKcal: 120, maxKcal: 200 });
    const draft = planMeals(
      request({ members: [eater('a'), eater('b')] }),
      light,
    );
    for (const item of draft.items) {
      expect(item.plannedServings / 2).toBeLessThanOrEqual(PORTION_SHARE_MAX);
    }
    expect(draft.status).toBe('PARTIAL');
    expect(
      draft.diagnostics.issues.some(
        (issue) => issue.code === 'KCAL_OUT_OF_TOLERANCE',
      ),
    ).toBe(true);
  });

  it('6. UNSAT: żadne danie nie spełnia ograniczeń → diagnostyka z powodem, bez fałszywego sukcesu', () => {
    const allGluten = catalog().map((entry) => ({
      ...entry,
      allergens: ['GLUTEN'],
    }));
    const draft = planMeals(
      request({ members: [eater('ania', { allergens: ['GLUTEN'] })] }),
      allGluten,
    );
    expect(draft.status).toBe('UNSAT');
    expect(draft.items).toHaveLength(0);
    const noCandidates = draft.diagnostics.issues.filter(
      (issue) => issue.code === 'NO_CANDIDATES',
    );
    expect(noCandidates).toHaveLength(3);
    expect(noCandidates[0].severity).toBe('error');
    expect(noCandidates[0].message).toContain('ALLERGEN');
    expect(draft.diagnostics.candidates[0].removed.ALLERGEN).toBe(20);
  });

  it('PARTIAL: jedna pora niemożliwa, reszta zaplanowana', () => {
    const recipes = catalog().map((entry) =>
      entry.slots.includes('BREAKFAST')
        ? { ...entry, dietTags: ['MEAT'] }
        : entry,
    );
    const draft = planMeals(
      request({ members: [eater('ania', { diet: 'VEGETARIAN' })] }),
      recipes,
    );
    expect(draft.status).toBe('PARTIAL');
    expect(draft.items.map((item) => item.mealType).sort()).toEqual([
      'DINNER',
      'LUNCH',
    ]);
    expect(draft.diagnostics.metrics.slotsFilled).toBe(2);
    expect(draft.diagnostics.metrics.slotsRequested).toBe(3);
  });

  it('11. ten sam seed i dane → identyczny plan', () => {
    const recipes = catalog({ perMeal: 40 });
    const input = request({ days: DAYS, seed: 'powtarzalnie' });
    expect(planMeals(input, recipes).items).toEqual(
      planMeals(input, recipes).items,
    );
  });

  it('inny seed daje poprawny plan (bez złamań), niekoniecznie ten sam', () => {
    const recipes = catalog({ perMeal: 40 });
    const draft = planMeals(request({ days: DAYS, seed: 'inny' }), recipes);
    expect(draft.diagnostics.metrics.hardViolations).toBe(0);
    expect(draft.items).toHaveLength(21);
  });
});

describe('planMeals — tydzień', () => {
  it('7. tydzień nie powtarza dań bez potrzeby', () => {
    const draft = planMeals(request({ days: DAYS }), catalog());
    expect(draft.items).toHaveLength(21);
    expect(draft.diagnostics.metrics.repeats).toBe(0);
    expect(draft.status).toBe('OK');
  });

  it('za mało dań na porę: powtórki tylko tyle, ile trzeba, z informacją REPEAT_FORCED', () => {
    const recipes = [
      ...catalog({ meals: ['BREAKFAST', 'LUNCH'] }),
      recipe('d1', { kcal: 320 }),
      recipe('d2', { kcal: 330 }),
      recipe('d3', { kcal: 310 }),
    ];
    const draft = planMeals(request({ days: DAYS }), recipes);
    expect(draft.diagnostics.metrics.repeats).toBe(4);
    expect(
      draft.diagnostics.issues.some((issue) => issue.code === 'REPEAT_FORCED'),
    ).toBe(true);
  });

  it('tydzień to NIE suma niezależnie optymalnych dni', () => {
    const recipes = catalog();
    const lookup = byId(recipes);
    const independent: PlannedItem[] = DAYS.flatMap(
      (day) => planMeals(request({ days: [day] }), recipes).items,
    );
    const week = planMeals(request({ days: DAYS }), recipes);
    const weekRequest = request({ days: DAYS });
    const independentScore = evaluatePlan(weekRequest, recipes, independent);
    // Każdy dzień osobno bierze to samo „najlepsze" danie — tydzień nie.
    expect(independentScore.metrics.repeats).toBeGreaterThan(0);
    expect(week.diagnostics.metrics.repeats).toBe(0);
    expect(week.diagnostics.metrics.objective).toBeLessThan(
      independentScore.metrics.objective,
    );
    expect(lookup.size).toBeGreaterThan(0);
  });

  it('uwzględnia to, co już stoi w tygodniu (bilans i powtórki)', () => {
    const recipes = catalog();
    const fixed: PlannedItem[] = [
      {
        dayOfWeek: 'MON',
        mealType: 'DINNER',
        recipeId: 'dinner-005',
        participantIds: [],
        plannedServings: 1,
      },
    ];
    const draft = planMeals(
      request({ days: ['TUE', 'WED'], mealTypes: ['DINNER'], fixed }),
      recipes,
    );
    expect(draft.items.map((item) => item.recipeId)).not.toContain(
      'dinner-005',
    );
  });

  it('niedawne przepisy i czas gotowania to miękkie preferencje, nie zakazy', () => {
    const recipes = [recipe('only', { kcal: 330, prepTimeMinutes: 90 })];
    const draft = planMeals(
      request({
        mealTypes: ['DINNER'],
        preferences: {
          preferredTags: ['quick'],
          maxPrepMinutes: 20,
          favoriteRecipeIds: [],
          recentRecipeIds: ['only'],
          popularity: {},
        },
      }),
      recipes,
    );
    expect(draft.items.map((item) => item.recipeId)).toEqual(['only']);
    expect(draft.diagnostics.metrics.softUnmet).toBe(2);
  });
});

/**
 * Review Etapu 2: cel osoby nie może zależeć od posiłku, którego ona NIE je.
 * `eaterDayNutrition` szanuje `visibleToMember`, a cel liczył pokrycie ze
 * WSZYSTKICH pór stałych pozycji dnia — także osobistego obiadu Marka.
 */
describe('cel osoby a pozycje innych domowników', () => {
  it('osobisty obiad Marka NIE zmienia celu Ani, dla której planujemy kolację', () => {
    const recipes = catalog();
    const members = [eater('ania'), eater('marek')];
    const plan = (fixed: PlannedItem[]) =>
      planMeals(
        request({
          members,
          participantIds: ['ania'],
          mealTypes: ['DINNER'],
          fixed,
        }),
        recipes,
      );
    const anja = (draft: ReturnType<typeof planMeals>) =>
      draft.diagnostics.days[0].eaters.find(
        (entry) => entry.userId === 'ania',
      )!;

    const without = anja(plan([]));
    const withMarkLunch = anja(
      plan([
        {
          dayOfWeek: 'MON',
          mealType: 'LUNCH',
          recipeId: 'lunch-010',
          participantIds: ['marek'],
          plannedServings: 1,
        },
      ]),
    );
    expect(withMarkLunch.kcalTarget).toBe(without.kcalTarget);
    expect(withMarkLunch.kcal).toBe(without.kcal);
  });
});

/**
 * Semantyka celu po review Etapu 2 (testy obowiązkowe 1–8 z poprawki).
 * `FULL_DAY` = planowane pory to cały dzień, razem 100 % celu; `PARTIAL` =
 * cel osoby minus to, co ONA je poza planowanymi porami, podzielony wagami.
 */
describe('semantyka celu kcal (FULL_DAY / PARTIAL)', () => {
  const recipes = catalog({
    meals: [
      'BREAKFAST',
      'SECOND_BREAKFAST',
      'LUNCH',
      'AFTERNOON_SNACK',
      'DINNER',
    ],
  });
  const kcalOf = (id: string) =>
    recipes.find((entry) => entry.id === id)!.perServing!.kcal;
  const item = (
    mealType: PlannedItem['mealType'],
    recipeId: string,
    participantIds: string[] = [],
    plannedServings = 1,
  ): PlannedItem => ({
    dayOfWeek: 'MON',
    mealType,
    recipeId,
    participantIds,
    plannedServings,
  });
  const targetOf = (draft: ReturnType<typeof planMeals>, userId: string) =>
    draft.diagnostics.days[0].eaters.find((e) => e.userId === userId)!;
  const partial = {
    scope: 'PARTIAL' as const,
    dayMealTypes: ['BREAKFAST', 'LUNCH', 'DINNER'] as PlannedItem['mealType'][],
  };

  it('1. cel 2000 + pełne śniadanie/obiad/kolacja → cel dnia 2000, nie 1600', () => {
    const draft = planMeals(request(), recipes);
    const ania = targetOf(draft, 'ania');
    expect(ania.kcalTarget).toBe(2000);
    expect(ania.kcalGoal).toBe(2000);
    expect(Math.abs(ania.dayKcal - 2000) / 2000).toBeLessThanOrEqual(
      KCAL_DAY_TOLERANCE,
    );
  });

  it('2. pięć podstawowych pór → nadal 100 % celu, bez podwójnego skalowania', () => {
    const draft = planMeals(
      request({
        mealTypes: [
          'BREAKFAST',
          'SECOND_BREAKFAST',
          'LUNCH',
          'AFTERNOON_SNACK',
          'DINNER',
        ],
      }),
      recipes,
    );
    expect(targetOf(draft, 'ania').kcalTarget).toBe(2000);
    expect(draft.items).toHaveLength(5);
  });

  it('3. plan częściowy: posiłki osoby odejmują się od pozostałego celu', () => {
    const fixed = [
      item('BREAKFAST', 'breakfast-005'),
      item('LUNCH', 'lunch-010'),
    ];
    const draft = planMeals(
      request({ ...partial, mealTypes: ['DINNER'], fixed }),
      recipes,
    );
    const ania = targetOf(draft, 'ania');
    const eaten = kcalOf('breakfast-005') + kcalOf('lunch-010');
    expect(ania.kcalTarget).toBe(Math.round(2000 - eaten));
    expect(ania.dayKcal).toBe(Math.round(eaten + ania.kcal));
  });

  it('4. osobisty posiłek INNEGO domownika nie zmienia celu planowanej osoby', () => {
    const members = [eater('ania'), eater('marek')];
    const plan = (fixed: PlannedItem[]) =>
      planMeals(
        request({
          ...partial,
          members,
          participantIds: ['ania'],
          mealTypes: ['DINNER'],
          fixed,
        }),
        recipes,
      );
    const without = targetOf(plan([]), 'ania');
    const withMark = targetOf(
      plan([item('LUNCH', 'lunch-010', ['marek'])]),
      'ania',
    );
    // Ania nie je nic stałego: cel kolacji = 2000 × 0,20 / (0,25+0,35+0,20).
    expect(without.kcalTarget).toBe(500);
    expect(withMark.kcalTarget).toBe(500);
  });

  it('5. wspólny stały posiłek wpływa na cel KAŻDEGO, kto go je', () => {
    const members = [
      eater('ania', { kcalTarget: 1600 }),
      eater('marek', { kcalTarget: 2600 }),
    ];
    const draft = planMeals(
      request({
        ...partial,
        members,
        mealTypes: ['DINNER'],
        fixed: [item('LUNCH', 'lunch-010', [], 2)],
      }),
      recipes,
    );
    // Obiad wspólny: 2 porcje na 2 osoby = 1 porcja każdemu. Zostają pory
    // niepokryte: śniadanie i kolacja (0,25 + 0,20); kolacja ma 0,20 z nich.
    const lunch = kcalOf('lunch-010');
    const share = 0.2 / 0.45;
    expect(targetOf(draft, 'ania').kcalTarget).toBe(
      Math.round((1600 - lunch) * share),
    );
    expect(targetOf(draft, 'marek').kcalTarget).toBe(
      Math.round((2600 - lunch) * share),
    );
  });

  it('6. osobisty stały posiłek osoby wpływa TYLKO na jej pozostały cel', () => {
    const members = [eater('ania'), eater('marek')];
    const draft = planMeals(
      request({
        ...partial,
        members,
        mealTypes: ['DINNER'],
        fixed: [item('LUNCH', 'lunch-010', ['ania'])],
      }),
      recipes,
    );
    const lunch = kcalOf('lunch-010');
    expect(targetOf(draft, 'ania').kcalTarget).toBe(
      Math.round((2000 - lunch) * (0.2 / 0.45)),
    );
    expect(targetOf(draft, 'marek').kcalTarget).toBe(500);
  });

  it('7. podmiana slotu: reszta dnia bez zmian, cel slotu = rzeczywisty bilans osoby', () => {
    const base = planMeals(request(), recipes);
    const dinner = base.items.find((entry) => entry.mealType === 'DINNER')!;
    const rest = base.items.filter((entry) => entry !== dinner);
    const draft = planMeals(
      request({
        ...partial,
        mealTypes: ['DINNER'],
        fixed: rest,
        constraints: {
          diet: null,
          requiredTags: [],
          avoidIngredients: [],
          excludeRecipeIds: [dinner.recipeId],
        },
      }),
      recipes,
    );
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0].mealType).toBe('DINNER');
    const eaten = rest.reduce(
      (sum, entry) => sum + kcalOf(entry.recipeId) * entry.plannedServings,
      0,
    );
    expect(targetOf(draft, 'ania').kcalTarget).toBe(Math.round(2000 - eaten));
  });
});

describe('planMeals — podmiana jednego slotu (2D)', () => {
  const recipes = catalog({ perMeal: 30 });
  const base = planMeals(request({ days: DAYS }), recipes);
  const wednesday = base.items.find(
    (item) => item.dayOfWeek === 'WED' && item.mealType === 'DINNER',
  )!;
  const rest = base.items.filter((item) => item !== wednesday);

  it('8. zmienia tylko wskazany slot — reszta jest `fixed` i nie wraca w wyniku', () => {
    const draft = planMeals(
      request({
        days: ['WED'],
        mealTypes: ['DINNER'],
        fixed: rest,
        constraints: {
          diet: null,
          requiredTags: [],
          avoidIngredients: [],
          excludeRecipeIds: [wednesday.recipeId],
        },
      }),
      recipes,
    );
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toMatchObject({
      dayOfWeek: 'WED',
      mealType: 'DINNER',
    });
    expect(draft.items[0].recipeId).not.toBe(wednesday.recipeId);
    // Nowe danie nie powtarza niczego, co zostaje w tygodniu.
    expect(rest.map((item) => item.recipeId)).not.toContain(
      draft.items[0].recipeId,
    );
  });

  it('9. „wegetariańska, podobnie kaloryczna": dieta twarda, kcal blisko zastępowanego', () => {
    const lookup = byId(recipes);
    const originalKcal = lookup.get(wednesday.recipeId)!.perServing!.kcal;
    const draft = planMeals(
      request({
        days: ['WED'],
        mealTypes: ['DINNER'],
        fixed: rest,
        constraints: {
          diet: 'VEGETARIAN',
          requiredTags: [],
          avoidIngredients: [],
          excludeRecipeIds: [wednesday.recipeId],
        },
        slotKcalTargets: { 'WED|DINNER': originalKcal },
        portionMode: 'auto',
        scope: 'PARTIAL',
        dayMealTypes: ['BREAKFAST', 'LUNCH', 'DINNER'],
      }),
      recipes,
    );
    const chosen = lookup.get(draft.items[0].recipeId)!;
    expect(chosen.dietTags).not.toContain('MEAT');
    expect(chosen.dietTags).not.toContain('FISH');
    // Najbliższy MOŻLIWY zamiennik: wegetariański, na kolację, bez powtórki
    // z resztą tygodnia (powtórka kosztuje więcej niż kilka % kcal).
    const used = new Set(rest.map((item) => item.recipeId));
    const deviation = (kcal: number) =>
      Math.abs(kcal - originalKcal) / originalKcal;
    const best = Math.min(
      ...recipes
        .filter(
          (entry) =>
            entry.slots.includes('DINNER') &&
            entry.dietTags.length === 0 &&
            entry.id !== wednesday.recipeId &&
            !used.has(entry.id),
        )
        .map((entry) => deviation(entry.perServing!.kcal)),
    );
    expect(deviation(chosen.perServing!.kcal)).toBeLessThanOrEqual(best + 0.02);
    expect(used.has(chosen.id)).toBe(false);
    expect(draft.items[0].plannedServings).toBe(1);
  });
});

describe('evaluatePlan — ocena dowolnego planu (metryki)', () => {
  it('liczy złamane twarde ograniczenia w planie spoza planera', () => {
    const recipes = catalog();
    const glutenDinner = recipes.find(
      (entry) =>
        entry.slots.includes('DINNER') && entry.allergens.includes('GLUTEN'),
    )!;
    const badPlan: PlannedItem[] = [
      {
        dayOfWeek: 'MON',
        mealType: 'DINNER',
        recipeId: glutenDinner.id,
        participantIds: [],
        plannedServings: 1,
      },
      {
        dayOfWeek: 'MON',
        mealType: 'LUNCH',
        recipeId: glutenDinner.id, // kolacja na obiad — zła pora
        participantIds: [],
        plannedServings: 1,
      },
    ];
    const result = evaluatePlan(
      request({ members: [eater('ania', { allergens: ['GLUTEN'] })] }),
      recipes,
      badPlan,
    );
    expect(result.metrics.hardViolations).toBe(2);
    expect(result.metrics.repeats).toBe(1);
    expect(result.metrics.slotsFilled).toBe(2);
  });

  it('metryki planera: odchylenia, powtórki, kandydaci, czas', () => {
    const draft = planMeals(request({ days: DAYS }), catalog());
    const metrics = draft.diagnostics.metrics;
    expect(metrics.kcalDeviationPct).toBeLessThanOrEqual(10);
    expect(metrics.proteinDeviationPct).not.toBeNull();
    expect(metrics.candidatesConsidered).toBe(60);
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.slotsFilled).toBe(21);
  });
});

describe('planMeals — skala', () => {
  it('katalog 5000 przepisów: tydzień dla 4 osób w rozsądnym czasie', () => {
    const big = catalog({ perMeal: 1700, minKcal: 150, maxKcal: 1100 });
    const startedAt = Date.now();
    const draft = planMeals(
      request({
        days: DAYS,
        members: [eater('a'), eater('b'), eater('c'), eater('d')],
      }),
      big,
    );
    const elapsed = Date.now() - startedAt;
    expect(draft.items).toHaveLength(21);
    expect(draft.diagnostics.metrics.hardViolations).toBe(0);
    // Pomiar do raportu — próg luźny, żeby CI na wolnej maszynie nie migało.
    expect(elapsed).toBeLessThan(10_000);
    process.stdout.write(`[planer] 5100 przepisów, 21 slotów: ${elapsed} ms\n`);
  });
});
