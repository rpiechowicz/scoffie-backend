import { DayOfWeek } from '@prisma/client';
import {
  BalanceMeal,
  eaterCount,
  effectiveServings,
  nutritionPerPerson,
  servingsPerPerson,
  visibleToMember,
  weeklyBalanceForMember,
} from './daily-balance.util';

/**
 * Parytet z iOS (`SavedMealPlan.swift`, `CalendarView.swift`).
 *
 * Liczby są policzone RĘCZNIE ze wzorów w Swifcie. To nie jest kaprys:
 * użytkownik widzi dzienny licznik kalorii w aplikacji i porówna go z tym, co
 * powie asystent — rozjazd byłby widoczny od razu i podważałby zaufanie do
 * obu liczb naraz.
 */
const ANIA = 'ania';
const MAREK = 'marek';

const DAYS: DayOfWeek[] = ['MON', 'TUE'];

const meal = (overrides: Partial<BalanceMeal> = {}): BalanceMeal => ({
  dayOfWeek: 'MON',
  mealType: 'DINNER',
  participantIds: [],
  eatenByUserIds: [],
  plannedServings: null,
  recipe: {
    // Cały przepis na 2 porcje: 1000 kcal, czyli 500 kcal na porcję.
    servings: 2,
    nutritionKcal: 1000,
    nutritionProtein: 60,
    nutritionFat: 40,
    nutritionCarbs: 100,
    nutritionFiber: 10,
  },
  ...overrides,
});

describe('eaterCount', () => {
  it('puste audytorium znaczy „całe gospodarstwo"', () => {
    expect(eaterCount({ participantIds: [] }, 3)).toBe(3);
  });

  it('imienna lista liczy się sama', () => {
    expect(eaterCount({ participantIds: [ANIA] }, 3)).toBe(1);
  });

  it('nigdy nie schodzi do zera — dzielimy przez to', () => {
    expect(eaterCount({ participantIds: [] }, 0)).toBe(1);
  });
});

describe('effectiveServings', () => {
  it('brak zapisanej wartości = tyle porcji, ilu jedzących', () => {
    expect(
      effectiveServings({ participantIds: [], plannedServings: null }, 3),
    ).toBe(3);
  });

  it('zapisana wartość wygrywa', () => {
    expect(
      effectiveServings({ participantIds: [], plannedServings: 5 }, 3),
    ).toBe(5);
  });

  it('zero z uszkodzonych danych nie wyzeruje dnia', () => {
    expect(
      effectiveServings({ participantIds: [], plannedServings: 0 }, 3),
    ).toBe(1);
  });
});

describe('servingsPerPerson', () => {
  it('reguła auto daje równo jedną porcję na osobę', () => {
    // To jest sedno: dodanie domownika NIE zmienia makr, bo rośnie i licznik,
    // i mianownik. Makra ruszają się dopiero przy ręcznej zmianie porcji.
    expect(
      servingsPerPerson({ participantIds: [], plannedServings: null }, 4),
    ).toBe(1);
  });

  it('trzy porcje na dwie osoby to półtorej porcji na osobę', () => {
    expect(
      servingsPerPerson({ participantIds: [], plannedServings: 3 }, 2),
    ).toBe(1.5);
  });
});

describe('nutritionPerPerson', () => {
  it('przy regule auto to dokładnie jedna porcja przepisu', () => {
    // 1000 kcal / 2 porcje = 500 na porcję, udział = 1.
    expect(nutritionPerPerson(meal(), 2)).toEqual({
      kcal: 500,
      protein: 30,
      fat: 20,
      carbs: 50,
      fiber: 5,
    });
  });

  it('ręcznie ugotowane 3 porcje dla dwojga to 1,5 porcji na osobę', () => {
    expect(nutritionPerPerson(meal({ plannedServings: 3 }), 2).kcal).toBe(750);
  });

  it('danie tylko dla jednej osoby liczy się jej w całości', () => {
    // Audytorium = 1, porcje auto = 1 → jedna porcja przepisu.
    expect(nutritionPerPerson(meal({ participantIds: [ANIA] }), 2).kcal).toBe(
      500,
    );
  });
});

describe('visibleToMember', () => {
  it('własne danie wygrywa ze wspólnym w tym samym slocie', () => {
    // Bez tej reguły Ania dostałaby DWA obiady do jednego celu dziennego.
    const wspolny = meal();
    const jej = meal({ participantIds: [ANIA] });
    expect(visibleToMember([wspolny, jej], ANIA)).toEqual([jej]);
  });

  it('kto nie ma własnego, je wspólne', () => {
    const wspolny = meal();
    const jej = meal({ participantIds: [ANIA] });
    expect(visibleToMember([wspolny, jej], MAREK)).toEqual([wspolny]);
  });

  it('sam wspólny posiłek widzą wszyscy', () => {
    const wspolny = meal();
    expect(visibleToMember([wspolny], MAREK)).toEqual([wspolny]);
  });
});

describe('weeklyBalanceForMember', () => {
  const balance = (meals: BalanceMeal[], memberId = ANIA) =>
    weeklyBalanceForMember(meals, {
      memberId,
      householdMemberCount: 2,
      days: DAYS,
    });

  it('oddaje komplet dni, także pustych', () => {
    const wynik = balance([]);
    expect(wynik.map((day) => day.dayOfWeek)).toEqual(DAYS);
    expect(wynik[0].planned.kcal).toBe(0);
    expect(wynik[0].meals).toBe(0);
  });

  it('sumuje posiłki dnia na jedną osobę', () => {
    const wynik = balance([
      meal({ mealType: 'BREAKFAST' }),
      meal({ mealType: 'DINNER' }),
    ]);
    expect(wynik[0].planned.kcal).toBe(1000);
    expect(wynik[0].meals).toBe(2);
  });

  it('nie dolicza cudzego dania z tego samego slotu', () => {
    const wynik = balance([
      meal({ participantIds: [ANIA] }),
      meal({ participantIds: [MAREK] }),
    ]);
    expect(wynik[0].planned.kcal).toBe(500);
    expect(wynik[0].meals).toBe(1);
  });

  it('zjedzone to osobna suma — plan nie jest dowodem, że ktoś zjadł', () => {
    const wynik = balance([
      meal({ mealType: 'BREAKFAST', eatenByUserIds: [ANIA] }),
      meal({ mealType: 'DINNER' }),
    ]);
    expect(wynik[0].planned.kcal).toBe(1000);
    expect(wynik[0].eaten.kcal).toBe(500);
  });

  it('odhaczenie przez kogoś innego nie liczy się nam', () => {
    const wynik = balance([meal({ eatenByUserIds: [MAREK] })]);
    expect(wynik[0].eaten.kcal).toBe(0);
  });

  it('rozdziela dni', () => {
    const wynik = balance([
      meal({ dayOfWeek: 'MON' }),
      meal({ dayOfWeek: 'TUE' }),
      meal({ dayOfWeek: 'TUE', mealType: 'BREAKFAST' }),
    ]);
    expect(wynik[0].meals).toBe(1);
    expect(wynik[1].meals).toBe(2);
  });

  it('zaokrągla dopiero SUMĘ, nie każdy posiłek osobno', () => {
    // Trzy posiłki po 333,33 kcal na osobę: sumowane najpierw dają 1000,
    // obcinane po kolei — 999. Przez cały tydzień taki błąd narasta.
    const trzecia = meal({
      recipe: {
        servings: 3,
        nutritionKcal: 1000,
        nutritionProtein: 0,
        nutritionFat: 0,
        nutritionCarbs: 0,
        nutritionFiber: 0,
      },
    });
    const wynik = balance([
      { ...trzecia, mealType: 'BREAKFAST' },
      { ...trzecia, mealType: 'LUNCH' },
      { ...trzecia, mealType: 'DINNER' },
    ]);
    expect(wynik[0].planned.kcal).toBe(1000);
  });
});
