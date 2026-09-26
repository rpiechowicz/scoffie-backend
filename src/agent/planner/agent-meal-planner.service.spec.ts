import { planMeals } from '../../meal-planner/meal-plan-engine';
import {
  catalog,
  DAYS,
  eater,
  request,
} from '../../meal-planner/planner-fixtures.spec-helper';
import { plannerResultForModel } from './agent-meal-planner.service';

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
