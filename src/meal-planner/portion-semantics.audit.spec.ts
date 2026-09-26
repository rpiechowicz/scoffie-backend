import {
  BalanceMeal,
  nutritionPerPerson,
  servingsPerPerson,
  visibleToMember,
  weeklyBalanceForMember,
} from '../weekly-plans/utils/daily-balance.util';
import {
  autoPlannedServings,
  clampPlannedServings,
  PLANNED_SERVINGS_MAX,
} from '../weekly-plans/utils/planned-servings.util';

/**
 * Audyt 2A (workstream, Etap 2) — jaką semantykę porcji i celów ma DZIŚ model
 * danych. To są testy CHARAKTERYZUJĄCE: przypinają zachowanie, na którym stoi
 * serwerowy planer, zanim cokolwiek na nim zbudujemy. Te same reguły liczy
 * iOS (`SavedMealPlan.swift`: `effectiveServings`, `servingsPerPerson`,
 * `visibleTo(memberId:)`), więc zmiana któregoś z nich to zmiana kontraktu
 * z telefonem, nie refaktor.
 *
 * Pytanie audytu: czy obecny model danych pozwala poprawnie dobrać porcje
 * i cele żywieniowe dla wielu osób jedzących ten sam posiłek?
 * Odpowiedź (raport 02, §1): TAK dla RÓWNEGO podziału porcji między
 * jedzących; NIE dla nierównych porcji tego samego dania — tego model nie
 * wyraża i planer tego nie udaje.
 */
const ANIA = 'ania';
const MAREK = 'marek';

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

describe('Audyt 2A: semantyka porcji i celów', () => {
  it('makra przepisu opisują CAŁY przepis; porcja = całość / servings', () => {
    // Jedna osoba, jedna porcja → dokładnie 1/4 przepisu.
    expect(nutritionPerPerson(meal({ plannedServings: 1 }), 1).kcal).toBe(500);
  });

  it('plannedServings to porcje ŁĄCZNE, dzielone RÓWNO między jedzących', () => {
    // Dwie osoby, trzy porcje: każda dostaje 1,5 porcji = 750 kcal.
    const shared = meal({ plannedServings: 3 });
    expect(servingsPerPerson(shared, 2)).toBe(1.5);
    expect(nutritionPerPerson(shared, 2).kcal).toBe(750);
  });

  it('reguła auto: porcji tyle, ilu jedzących → udział na osobę równo 1', () => {
    expect(autoPlannedServings(0, 3)).toBe(3); // „Wspólne" = cały dom
    expect(autoPlannedServings(2, 5)).toBe(2); // imienne audytorium
    expect(servingsPerPerson(meal({ plannedServings: null }), 3)).toBe(1);
  });

  it('dwa RÓŻNE cele przy jednym daniu dostają TEN SAM udział — model nie ma porcji per osoba', () => {
    // Ania (cel 1600) i Marek (cel 2800) jedzą wspólną kolację: obie osoby
    // dostają identyczną liczbę kcal, bo udział zależy tylko od porcji
    // łącznych i liczby jedzących — nie od celu osoby.
    const days = ['MON'] as const;
    const planned = [meal({ plannedServings: 3 })];
    const ania = weeklyBalanceForMember(planned, {
      memberId: ANIA,
      householdMemberCount: 2,
      days,
    });
    const marek = weeklyBalanceForMember(planned, {
      memberId: MAREK,
      householdMemberCount: 2,
      days,
    });
    expect(ania[0].planned.kcal).toBe(marek[0].planned.kcal);
  });

  it('jedyna droga do różnych kcal w jednym slocie: RÓŻNE dania dla różnych osób (własne wygrywa ze wspólnym)', () => {
    const slot = [
      meal({ participantIds: [], plannedServings: 2 }),
      meal({
        participantIds: [MAREK],
        plannedServings: 2,
        recipe: { ...recipe, nutritionKcal: 3200 },
      }),
    ];
    expect(visibleToMember(slot, MAREK)).toEqual([slot[1]]);
    expect(visibleToMember(slot, ANIA)).toEqual([slot[0]]);
  });

  it('porcje są CAŁKOWITE: osoba jedząca sama dostaje 1, 2, 3… porcje, nigdy 1,5', () => {
    // Jedyny mechanizm „trochę więcej" dla samotnego jedzącego to cała
    // dodatkowa porcja (+100 %). Planer nie może więc stroić kcal porcją
    // w domu jednoosobowym — musi dobierać DANIE.
    expect(clampPlannedServings(1.5)).toBe(1);
    const solo = [1, 2, 3].map((planned) =>
      servingsPerPerson(meal({ plannedServings: planned }), 1),
    );
    expect(solo).toEqual([1, 2, 3]);
  });

  it('porcji łącznie najwyżej 12 — dom >12 osób nie dostanie pełnej porcji na głowę', () => {
    expect(PLANNED_SERVINGS_MAX).toBe(12);
    expect(autoPlannedServings(0, 14)).toBe(12);
  });
});
