import {
  PlanRow,
  SCENARIOS,
  Verdict,
} from '../../scripts/lib/agent-benchmark-scenarios';

/**
 * Weryfikatory scenariuszy benchmarku (Etap 6.1) — bez modelu. Etap 6
 * pokazał trzy weryfikatory, które oceniały NIE TO, co trzeba:
 * - g10: wymagał przepisania liczby z karty w zdaniu (źródłem prawdy jest
 *   karta i wynik narzędzia),
 * - g13-zmiana-w-propozycji: szukał etykiety `VEGETARIAN` w `dietTags`, a te
 *   są KATEGORIAMI składników (MEAT, DAIRY, LEGUME…) — wegetariańskość to
 *   reguła `satisfiesDiet`, ta sama co w planerze,
 * - g8: odrzucał poprawny wynik „jedno danie, porcje osób liczy serwer"
 *   (`propose_household_split`), bo żądał dwóch różnych dań.
 */
const OWNER = '11111111-1111-4111-8111-111111111111';
const ANIA = '22222222-2222-4222-8222-222222222222';

function scenario(name: string) {
  const found = SCENARIOS.find((entry) => entry.name === name);
  if (!found) throw new Error(`brak scenariusza ${name}`);
  return found;
}

function row(
  overrides: Partial<Omit<PlanRow, 'recipe'>> & {
    recipe?: Partial<PlanRow['recipe']>;
  },
): PlanRow {
  return {
    dayOfWeek: 'WED',
    mealType: 'DINNER',
    recipeId: 'r-1',
    plannedServings: 1,
    participantIds: [],
    eatenByUserIds: [],
    ...overrides,
    recipe: {
      title: 'Danie',
      allergens: [],
      dietTags: [],
      prepTimeMinutes: 20,
      kcalPerServing: 500,
      ingredientIds: ['i-1'],
      householdId: null,
      ...(overrides.recipe ?? {}),
    },
  } as PlanRow;
}

function verdict(overrides: Partial<Verdict>): Verdict {
  return {
    world: {
      householdId: 'h',
      members: {
        owner: { userId: OWNER, displayName: 'Rafal' },
        ania: { userId: ANIA, displayName: 'Ania' },
      },
      catalog: [],
      ownRecipeIds: {},
      ingredientId: () => null,
    } as unknown as Verdict['world'],
    planBefore: [],
    plan: [],
    target: [],
    proposed: false,
    answer: '',
    answers: [],
    tools: [],
    calls: [],
    cards: [],
    modelSaw: '',
    notes: [],
    ownRecipes: [],
    ...overrides,
  };
}

describe('weryfikatory benchmarku (Etap 6.1)', () => {
  describe('g10-luka-makro: karta i wynik narzędzia są źródłem prawdy', () => {
    const call = (data: Record<string, unknown>) => ({
      name: 'show_macro_gap',
      input: {},
      ok: true,
      json: JSON.stringify({ ok: true, data }),
    });

    it('zdanie bez liczb karty przechodzi, gdy karta = wynik narzędzia', () => {
      const data = { current: 1907, target: 2200, gapKcalPerDay: 293 };
      const issues = scenario('g10-luka-makro').verify(
        verdict({
          cards: [{ kind: 'MACRO_GAP', payload: data }],
          calls: [call(data)],
          modelSaw: JSON.stringify({ ok: true, data }),
          answer: 'Karta pokazuje lukę i pomysły, jak ją domknąć.',
        }),
      );
      expect(issues).toEqual([]);
    });

    it('liczba kcal w zdaniu, której nie ma w wynikach narzędzi = zmyślona', () => {
      const data = { current: 1907, target: 2200 };
      const issues = scenario('g10-luka-makro').verify(
        verdict({
          cards: [{ kind: 'MACRO_GAP', payload: data }],
          calls: [call(data)],
          modelSaw: JSON.stringify({ ok: true, data }),
          answer: 'Brakuje Ci 999 kcal dziennie.',
        }),
      );
      expect(issues.join(' ')).toMatch(/999/);
    });
  });

  describe('g13-zmiana-w-propozycji: wegetariańskość = reguła diety, nie etykieta', () => {
    const breakfast = row({ mealType: 'BREAKFAST', recipeId: 'b1' });
    const lunch = row({ mealType: 'LUNCH', recipeId: 'l1' });
    const meatDinner = row({
      recipeId: 'd1',
      recipe: { dietTags: ['MEAT', 'GRAIN'] },
    });
    // „Burgery z czerwonej fasoli" z Etapu 6 — bez MEAT/FISH/CRUSTACEAN.
    const beanBurger = row({
      recipeId: 'd2',
      recipe: { dietTags: ['DAIRY', 'EGG', 'LEGUME', 'GRAIN'] },
    });

    it('danie bez mięsa i ryb przechodzi, reszta dnia nietknięta', () => {
      const issues = scenario('g13-zmiana-w-propozycji').verify(
        verdict({
          proposed: true,
          proposalHistory: [
            [breakfast, lunch, meatDinner],
            [breakfast, lunch, beanBurger],
          ],
          target: [breakfast, lunch, beanBurger],
        }),
      );
      expect(issues).toEqual([]);
    });

    it('mięsne danie po „wegetariańskiej" poprawce nie przechodzi', () => {
      const issues = scenario('g13-zmiana-w-propozycji').verify(
        verdict({
          proposed: true,
          proposalHistory: [
            [breakfast, lunch, meatDinner],
            [
              breakfast,
              lunch,
              row({ recipeId: 'd3', recipe: { dietTags: ['FISH'] } }),
            ],
          ],
          target: [
            breakfast,
            lunch,
            row({ recipeId: 'd3', recipe: { dietTags: ['FISH'] } }),
          ],
        }),
      );
      expect(issues.join(' ')).toMatch(/wegetaria/);
    });

    it('przebudowane śniadanie nie przechodzi („resztę zostaw")', () => {
      const issues = scenario('g13-zmiana-w-propozycji').verify(
        verdict({
          proposed: true,
          proposalHistory: [
            [breakfast, lunch, meatDinner],
            [row({ mealType: 'BREAKFAST', recipeId: 'b9' }), lunch, beanBurger],
          ],
          target: [
            row({ mealType: 'BREAKFAST', recipeId: 'b9' }),
            lunch,
            beanBurger,
          ],
        }),
      );
      expect(issues.join(' ')).toMatch(/BREAKFAST/);
    });
  });

  describe('g8-podzial-posilku: jedno danie z porcjami od serwera też jest rozdzieleniem', () => {
    it('karta podziału (jeden przepis, porcje osób od serwera) przechodzi', () => {
      const issues = scenario('g8-podzial-posilku').verify(
        verdict({
          proposed: true,
          target: [
            row({
              dayOfWeek: 'THU',
              participantIds: [OWNER, ANIA],
              plannedServings: 2,
            }),
          ],
          proposalCards: [
            {
              kind: 'HOUSEHOLD_SPLIT',
              payload: {
                dayOfWeek: 'THU',
                mealType: 'DINNER',
                portions: [
                  { userId: OWNER, kcal: 470 },
                  { userId: ANIA, kcal: 630 },
                ],
              },
            },
          ],
        }),
      );
      expect(issues).toEqual([]);
    });

    it('karta wyboru bez zmiany slotu nie jest rozdzieleniem', () => {
      const issues = scenario('g8-podzial-posilku').verify(
        verdict({
          target: [row({ dayOfWeek: 'THU' })],
          cards: [{ kind: 'OPTIONS', payload: { options: [] } }],
        }),
      );
      expect(issues.length).toBeGreaterThan(0);
    });
  });
});
