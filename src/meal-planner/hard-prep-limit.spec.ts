import { planMeals } from './meal-plan-engine';
import { hardFilterReason } from './meal-plan-scoring';
import {
  catalog,
  eater,
  recipe,
  request,
} from './planner-fixtures.spec-helper';

/**
 * Twardy limit czasu przygotowania (Etap 6.1, regresja g9). Dotąd limit
 * był wyłącznie miękką podpowiedzią, a przekroczenie szło jako `info`
 * niewidoczne dla modelu — plan „każde danie najwyżej 5 minut" wychodził
 * z daniami po 30 min i bez słowa o limicie.
 */
describe('twardy limit czasu przygotowania', () => {
  it('danie dłuższe niż limit odpada filtrem twardym PREP_TIME', () => {
    const slow = recipe('slow', { prepTimeMinutes: 30 });
    const fast = recipe('fast', { prepTimeMinutes: 5 });
    const limited = request({
      constraints: {
        diet: null,
        requiredTags: [],
        avoidIngredients: [],
        excludeRecipeIds: [],
        maxPrepMinutes: 5,
      },
    });
    expect(hardFilterReason(slow, 'DINNER', [eater('ania')], limited)).toBe(
      'PREP_TIME',
    );
    expect(hardFilterReason(fast, 'DINNER', [eater('ania')], limited)).not.toBe(
      'PREP_TIME',
    );
    // Bez limitu (brak pola) — bez zmian.
    expect(
      hardFilterReason(slow, 'DINNER', [eater('ania')], request()),
    ).not.toBe('PREP_TIME');
  });

  it('plan z limitem: zero dań ponad limit, pora bez takich dań = NO_CANDIDATES z powodem słowami', () => {
    // Katalog fikstur ma czasy 15–64 min — przy limicie 5 min nic się nie mieści.
    const draft = planMeals(
      request({
        constraints: {
          diet: null,
          requiredTags: [],
          avoidIngredients: [],
          excludeRecipeIds: [],
          maxPrepMinutes: 5,
        },
      }),
      catalog(),
    );
    expect(draft.items).toHaveLength(0);
    expect(draft.status).toBe('UNSAT');
    const noCandidates = draft.diagnostics.issues.filter(
      (issue) => issue.code === 'NO_CANDIDATES',
    );
    expect(noCandidates.length).toBeGreaterThan(0);
    expect(noCandidates[0].severity).toBe('error');
    expect(noCandidates[0].message).toMatch(/czas przygotowania ponad limit/);
  });
});
