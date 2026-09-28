import { planMeals } from '../../meal-planner/meal-plan-engine';
import {
  catalog,
  DAYS,
  eater,
  request,
} from '../../meal-planner/planner-fixtures.spec-helper';
import { toSearchable } from '../search/catalog-search';
import {
  AgentMealPlannerService,
  planDate,
  plannerResultForModel,
} from './agent-meal-planner.service';

describe('planDate', () => {
  it('najwcześniejszy planowany dzień tygodnia od poniedziałku', () => {
    expect(planDate('2026-09-28', ['WED', 'MON']).toISOString()).toBe(
      '2026-09-28T00:00:00.000Z',
    );
    expect(planDate('2026-09-28', ['SUN']).toISOString()).toBe(
      '2026-10-04T00:00:00.000Z',
    );
    expect(planDate('2026-09-28T00:00:00.000Z', []).toISOString()).toBe(
      '2026-09-28T00:00:00.000Z',
    );
  });
});

/**
 * Reguły katalogu 1000 w planerze asystenta: planer SAM nie bierze dodatku,
 * dania poza sezonem ani dania „od święta” poza okresem okazji — a ręczny
 * wybór (`portionsForChoice`) tych reguł nie zna.
 */
describe('AgentMealPlannerService — sezon, okazje, dodatki', () => {
  const source = (
    id: string,
    over: Partial<Parameters<typeof toSearchable>[0]> = {},
  ) =>
    toSearchable(
      {
        id,
        title: `Danie ${id}`,
        mealType: 'DINNER',
        suitableMealTypes: ['DINNER'],
        prepTimeMinutes: 20,
        servings: 2,
        nutritionKcal: 1200,
        nutritionProtein: 80,
        nutritionFat: 40,
        nutritionCarbs: 120,
        allergens: [],
        dietTags: [],
        ingredients: [
          {
            ingredientId: `i-${id}`,
            name: `składnik ${id}`,
            department: 'Warzywa',
            normalizedAmount: 300,
            normalizedUnit: 'g',
            gramsPerPiece: null,
          },
        ],
        ...over,
      },
      id,
      false,
    );
  const pool = [
    source('zwykle'),
    source('zimowe', { seasons: ['WINTER'] }),
    source('karp', {
      occasions: ['CHRISTMAS_EVE'],
      features: ['OCCASIONAL'],
    }),
    source('sok', { features: ['SIDE'] }),
  ];
  const member = {
    userId: 'ania',
    displayName: 'Ania',
    role: 'OWNER',
    dietPreference: 'NONE',
    allergens: [],
    goal: 'MAINTAIN',
    activityLevel: 1.4,
    targets: { calorieGoal: 2000, macros: null, macrosSource: 'UNAVAILABLE' },
    restrictions: { excludedIngredients: [] },
  };
  const service = new AgentMealPlannerService(
    {
      household: {
        findUnique: () =>
          Promise.resolve({ name: 'Dom', enabledMealTypes: ['DINNER'] }),
      },
    } as never,
    {
      planningPool: () =>
        Promise.resolve({
          recipes: pool,
          signals: {
            favorites: new Set(),
            plannedLastWeek: new Set(),
            popularity: new Map(),
          },
        }),
      searchablesByIds: () => Promise.resolve([]),
    } as never,
    { memberPreferences: () => Promise.resolve([member]) } as never,
    { snapshotWeekAsSlots: () => Promise.resolve([]) } as never,
    {
      membersForModel: () => Promise.resolve({ members: [member] }),
    } as never,
  );
  const suggestOn = (weekStart: string) =>
    service.suggest({
      userId: 'ania',
      householdId: 'dom',
      weekStart,
      dayOfWeek: 'THU',
      mealType: 'DINNER',
      forUserIds: [],
      wishes: {
        diet: null,
        requiredTags: [],
        preferredTags: [],
        avoidIngredients: [],
        maxPrepMinutes: null,
      },
      includeIngredients: [],
      count: 4,
      seed: 'test',
    });
  const ids = (outcome: Awaited<ReturnType<typeof suggestOn>>) =>
    outcome.draft.suggestions.map((option) => option.item.recipeId).sort();

  it('w lipcu: bez dania zimowego, bez karpia i bez soku', async () => {
    expect(ids(await suggestOn('2026-07-13'))).toEqual(['zwykle']);
  });

  it('w grudniu przed Wigilią: zimowe i karp wracają, sok dalej nie', async () => {
    expect(ids(await suggestOn('2026-12-14'))).toEqual([
      'karp',
      'zimowe',
      'zwykle',
    ]);
  });

  it('wybór człowieka (porcje dla wskazanego dania) reguł dnia nie zna', async () => {
    const outcome = await service.portionsForChoice({
      userId: 'ania',
      householdId: 'dom',
      weekStart: '2026-07-13',
      dayOfWeek: 'THU',
      mealType: 'DINNER',
      participantIds: [],
      recipeId: 'karp',
      currentSlots: [],
      seed: 'test',
    });
    expect(outcome.ok).toBe(true);
  });
});

/**
 * Wynik planera dla MODELU (Etap 2E) — test 12 z listy: prywatność. Domownik
 * bez zgody na asystenta: jego alergie i cele planer STOSUJE (to robi serwer),
 * ale model nie dostaje ani jego identyfikatora, ani liczb o nim.
 */
describe('plannerResultForModel', () => {
  const draft = planMeals(
    request({
      days: DAYS,
      members: [
        eater('ania', { kcalTarget: 1600 }),
        eater('bez-zgody', { kcalTarget: 2800, allergens: ['GLUTEN'] }),
      ],
    }),
    catalog(),
  );
  const outcome = {
    draft,
    targetSlots: [],
    consentedUserIds: new Set(['ania']),
    titles: new Map<string, string>(),
  };

  it('nie ujawnia identyfikatora ani bilansu domownika bez zgody', () => {
    const forModel = plannerResultForModel(outcome);
    const text = JSON.stringify(forModel);
    expect(text).not.toContain('bez-zgody');
    expect(forModel.perPersonDaily.map((entry) => entry.userId)).toEqual([
      'ania',
    ]);
    // Cel tej osoby nie jest trafiony (wspólne danie, 1600 vs 2800) — model
    // wie, że COŚ nie wyszło, ale nie wie komu i o ile.
    expect(text).toContain('domownik bez zgody na asystenta');
  });

  it('a jej alergia i tak obowiązuje w planie (robi to serwer)', () => {
    expect(draft.diagnostics.metrics.hardViolations).toBe(0);
  });

  it('zwięźle: status, wypełnienie, odchylenie, najwyżej 10 powodów', () => {
    const forModel = plannerResultForModel(outcome);
    expect(forModel.status).toBe(draft.status);
    expect(forModel.filled).toBe('21/21');
    expect(forModel.issues.length).toBeLessThanOrEqual(10);
  });
});
