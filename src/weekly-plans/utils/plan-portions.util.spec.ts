import {
  BalanceMeal,
  nutritionPerPerson,
  servingsPerPerson,
  weeklyBalanceForMember,
} from './daily-balance.util';
import {
  cookedServings,
  derivedPlannedServings,
  PORTION_STEP,
  PORTION_UNITS_PER_SERVING,
  portionsProblem,
  portionsTotal,
  samePortions,
  servingsToUnits,
  toPortionRows,
  toPortionViews,
  unitsToServings,
} from './plan-portions.util';

/**
 * Porcje per osoba (workstream, Etap 2.2) — jednostki, walidacja i bilans.
 * Numery w opisach = lista testów obowiązkowych z polecenia Etapu 2.2.
 */
const ASIA = '00000000-0000-4000-8000-00000000000a';
const RAFAL = '00000000-0000-4000-8000-00000000000b';

/** Przepis na 4 porcje: 2000 kcal całości = 500 kcal na porcję. */
const recipe = {
  servings: 4,
  nutritionKcal: 2000,
  nutritionProtein: 120,
  nutritionFat: 80,
  nutritionCarbs: 200,
  nutritionFiber: 20,
};

const meal = (over: Partial<BalanceMeal> = {}): BalanceMeal => ({
  dayOfWeek: 'MON',
  mealType: 'DINNER',
  participantIds: [],
  eatenByUserIds: [],
  plannedServings: null,
  recipe,
  ...over,
});

describe('jednostki porcji', () => {
  it('1 jednostka = 0,05 porcji; zapis w liczbach całkowitych', () => {
    expect(PORTION_UNITS_PER_SERVING).toBe(20);
    expect(PORTION_STEP).toBeCloseTo(0.05);
    expect(servingsToUnits(1)).toBe(20);
    expect(servingsToUnits(0.8)).toBe(16);
    expect(servingsToUnits(1.35)).toBe(27);
    expect(unitsToServings(27)).toBe(1.35);
    expect(unitsToServings(16)).toBe(0.8);
  });

  it('odrzuca porcje spoza kroku 0,05 i spoza widełek zapisu 0,1–6', () => {
    expect(servingsToUnits(0.33)).toBeNull();
    expect(servingsToUnits(0.05)).toBeNull();
    expect(servingsToUnits(0.1)).toBe(2);
    expect(servingsToUnits(6)).toBe(120);
    expect(servingsToUnits(6.05)).toBeNull();
    expect(servingsToUnits(Number.NaN)).toBeNull();
  });

  it('Σ porcji liczona w jednostkach — bez śmieci zmiennoprzecinkowych', () => {
    const portions = [
      { userId: ASIA, servings: 0.8 },
      { userId: RAFAL, servings: 1.3 },
    ];
    expect(portionsTotal(portions)).toBe(2.1);
    // plannedServings dla starych klientów: ceil(Σ), klamra 1..12.
    expect(derivedPlannedServings(portions)).toBe(3);
    expect(derivedPlannedServings([{ userId: ASIA, servings: 2 }])).toBe(2);
    expect(derivedPlannedServings([{ userId: ASIA, servings: 0.5 }])).toBe(1);
  });

  it('wiersze ↔ widok: sortowanie po osobie, brak relacji = brak alokacji', () => {
    expect(toPortionViews(undefined)).toEqual([]);
    expect(toPortionViews(null)).toEqual([]);
    const views = toPortionViews([
      { userId: RAFAL, units: 26 },
      { userId: ASIA, units: 16 },
    ]);
    expect(views).toEqual([
      { userId: ASIA, servings: 0.8 },
      { userId: RAFAL, servings: 1.3 },
    ]);
    expect(toPortionRows(views)).toEqual([
      { userId: ASIA, units: 16 },
      { userId: RAFAL, units: 26 },
    ]);
    expect(samePortions(views, [...views].reverse())).toBe(true);
    expect(
      samePortions(views, [
        { userId: ASIA, servings: 0.85 },
        { userId: RAFAL, servings: 1.3 },
      ]),
    ).toBe(false);
  });
});

describe('walidacja alokacji (PLAN_PORTIONS_INVALID)', () => {
  const both = new Set([ASIA, RAFAL]);

  it('poprawna: dokładnie audytorium, krok 0,05', () => {
    expect(
      portionsProblem(
        [
          { userId: ASIA, servings: 0.8 },
          { userId: RAFAL, servings: 1.3 },
        ],
        both,
      ),
    ).toBeNull();
  });

  it('brak osoby z audytorium, obca osoba albo duplikat = błąd', () => {
    expect(portionsProblem([{ userId: ASIA, servings: 1 }], both)).toMatch(
      /dokładnie te osoby/,
    );
    expect(
      portionsProblem(
        [
          { userId: ASIA, servings: 1 },
          { userId: 'obcy', servings: 1 },
        ],
        both,
      ),
    ).toMatch(/dokładnie te osoby/);
    expect(
      portionsProblem(
        [
          { userId: ASIA, servings: 1 },
          { userId: ASIA, servings: 1 },
        ],
        both,
      ),
    ).toMatch(/najwyżej jedną/);
  });

  it('porcja spoza kroku i suma > 12 = błąd', () => {
    expect(
      portionsProblem(
        [
          { userId: ASIA, servings: 0.83 },
          { userId: RAFAL, servings: 1 },
        ],
        both,
      ),
    ).toMatch(/wielokrotność/);
    expect(
      portionsProblem(
        [
          { userId: ASIA, servings: 6 },
          { userId: RAFAL, servings: 6.05 },
        ],
        both,
      ),
    ).not.toBeNull();
    const many = new Set(['a', 'b', 'c']);
    expect(
      portionsProblem(
        ['a', 'b', 'c'].map((userId) => ({ userId, servings: 4.5 })),
        many,
      ),
    ).toMatch(/najwyżej 12/);
  });
});

describe('bilans osoby z porcjami per osoba', () => {
  it('1. pozycja BEZ alokacji liczy się jak dotąd: plannedServings / jedzący', () => {
    const legacy = meal({ plannedServings: 3 });
    expect(servingsPerPerson(legacy, 2, ASIA)).toBe(1.5);
    expect(servingsPerPerson(legacy, 2, RAFAL)).toBe(1.5);
    expect(servingsPerPerson(legacy, 2)).toBe(1.5);
    expect(nutritionPerPerson(legacy, 2, ASIA).kcal).toBe(750);
  });

  it('2. wspólne danie, dwie osoby z różnymi porcjami → różne kcal', () => {
    const shared = meal({
      plannedServings: 3,
      portions: [
        { userId: ASIA, servings: 0.8 },
        { userId: RAFAL, servings: 1.3 },
      ],
    });
    expect(nutritionPerPerson(shared, 2, ASIA).kcal).toBe(400);
    expect(nutritionPerPerson(shared, 2, RAFAL).kcal).toBe(650);
    // Bez wskazania osoby (np. średnia domu) — średnia porcja.
    expect(servingsPerPerson(shared, 2)).toBeCloseTo(1.05);
    // `plannedServings` (pochodna 3) NIE wpływa na bilans pozycji z alokacją.
    expect(
      nutritionPerPerson({ ...shared, plannedServings: 12 }, 2, ASIA).kcal,
    ).toBe(400);
  });

  it('osoba bez wpisu w alokacji (np. dołączyła po planowaniu) je 1 porcję', () => {
    const shared = meal({
      portions: [{ userId: ASIA, servings: 0.8 }],
    });
    expect(servingsPerPerson(shared, 2, RAFAL)).toBe(1);
  });

  it('bilans tygodnia osoby czyta JEJ porcję', () => {
    const planned = [
      meal({
        portions: [
          { userId: ASIA, servings: 0.8 },
          { userId: RAFAL, servings: 1.3 },
        ],
      }),
    ];
    const params = { householdMemberCount: 2, days: ['MON'] as const };
    const asia = weeklyBalanceForMember(planned, { ...params, memberId: ASIA });
    const rafal = weeklyBalanceForMember(planned, {
      ...params,
      memberId: RAFAL,
    });
    expect(asia[0].planned.kcal).toBe(400);
    expect(rafal[0].planned.kcal).toBe(650);
  });
});

describe('lista zakupów: ile gotujemy', () => {
  it('3. z alokacją dokładnie Σ porcji (0,8 + 1,3 = 2,1), bez niej plannedServings', () => {
    expect(
      cookedServings({
        plannedServings: 3,
        portions: [
          { userId: ASIA, servings: 0.8 },
          { userId: RAFAL, servings: 1.3 },
        ],
      }),
    ).toBe(2.1);
    expect(cookedServings({ plannedServings: 3, portions: [] })).toBe(3);
    expect(cookedServings({ plannedServings: 2 })).toBe(2);
  });
});
