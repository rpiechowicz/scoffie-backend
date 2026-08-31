import { DayOfWeek, MealType } from '@prisma/client';

/**
 * Bilans dnia — ile JEDNA OSOBA zjada z zaplanowanych posiłków.
 *
 * PORT z iOS (`Models/Plans/SavedMealPlan.swift`, `Views/…/CalendarView.swift`).
 * Do Fazy 1 ta arytmetyka żyła wyłącznie na telefonie: serwer trzymał surowe
 * `plannedServings` i `eatenByUserIds`, ale nie umiał odpowiedzieć na pytanie
 * „czy ten dzień mieści się w celach domownika". Asystent, który układa
 * tydzień, potrzebuje tej odpowiedzi PRZED pokazaniem propozycji.
 *
 * Trzy reguły, które trzeba było przenieść dokładnie, bo użytkownik widzi ich
 * wynik w aplikacji i porównuje go z tym, co powie asystent:
 *
 * 1. **Kto je dane danie.** W jednym slocie własne danie wygrywa ze wspólnym —
 *    jeśli Ania ma swój obiad, to nie je także obiadu wspólnego. Bez tego
 *    dzienny licznik doliczałby jej dwa obiady do jednego celu.
 * 2. **Ile porcji przypada na osobę.** `plannedServings` to porcje ŁĄCZNE.
 *    Udział jednej osoby to `porcje / liczba jedzących`, więc przy regule auto
 *    wychodzi równo 1 — makra nie zmieniają się od samego dodania domownika,
 *    a dopiero wtedy, gdy ktoś świadomie ugotuje więcej.
 * 3. **Sumowanie na zmiennoprzecinkowych, zaokrąglenie NA KOŃCU.** Udział na
 *    osobę bywa ułamkowy (trzy porcje na dwie osoby to 1,5); obcinanie każdego
 *    posiłku z osobna gubiło do jednej kcal na pozycję, a błąd kumulował się
 *    przez cały dzień.
 */
export type BalanceNutrition = {
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  fiber: number;
};

export type BalanceMeal = {
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  /** Puste = „Wspólne" (całe gospodarstwo). */
  participantIds: string[];
  eatenByUserIds: string[];
  /** Porcje ŁĄCZNE; `null` = policz z audytorium (reguła auto). */
  plannedServings: number | null;
  recipe: {
    servings: number;
    nutritionKcal: number;
    nutritionProtein: number;
    nutritionFat: number;
    nutritionCarbs: number;
    nutritionFiber: number;
  };
};

export const ZERO_BALANCE: BalanceNutrition = {
  kcal: 0,
  protein: 0,
  fat: 0,
  carbs: 0,
  fiber: 0,
};

/** Ilu ludzi je to danie. `max(1, …)` chroni przed dzieleniem przez zero. */
export function eaterCount(
  meal: Pick<BalanceMeal, 'participantIds'>,
  householdMemberCount: number,
): number {
  const eaters =
    meal.participantIds.length === 0
      ? householdMemberCount
      : meal.participantIds.length;
  return Math.max(1, eaters);
}

/**
 * Porcje użyte do liczenia: zapisane albo policzone z audytorium.
 *
 * Jedyne miejsce, w którym „nie wiem" zamienia się w liczbę — tą samą regułą,
 * co przy zapisie slotu. Posiłek bez zapisanej wartości (stary plan) schodzi
 * do dzisiejszych liczb, a nie do połowy.
 */
export function effectiveServings(
  meal: Pick<BalanceMeal, 'participantIds' | 'plannedServings'>,
  householdMemberCount: number,
): number {
  if (meal.plannedServings == null) {
    return eaterCount(meal, householdMemberCount);
  }
  return Math.max(1, meal.plannedServings);
}

/** Udział jednej osoby w daniu, wyrażony w porcjach przepisu. */
export function servingsPerPerson(
  meal: Pick<BalanceMeal, 'participantIds' | 'plannedServings'>,
  householdMemberCount: number,
): number {
  return (
    effectiveServings(meal, householdMemberCount) /
    eaterCount(meal, householdMemberCount)
  );
}

/** Makra przypadające na jedną osobę — bez zaokrąglania. */
export function nutritionPerPerson(
  meal: BalanceMeal,
  householdMemberCount: number,
): BalanceNutrition {
  const share = servingsPerPerson(meal, householdMemberCount);
  // Makra w bazie opisują CAŁY przepis (patrz CLAUDE.md), więc najpierw na
  // porcję, potem razy udział.
  const perServing = 1 / Math.max(1, meal.recipe.servings);
  const factor = perServing * share;
  return {
    kcal: meal.recipe.nutritionKcal * factor,
    protein: meal.recipe.nutritionProtein * factor,
    fat: meal.recipe.nutritionFat * factor,
    carbs: meal.recipe.nutritionCarbs * factor,
    fiber: meal.recipe.nutritionFiber * factor,
  };
}

/**
 * Posiłki jednego slotu, które NAPRAWDĘ je wskazany domownik.
 *
 * Własne danie wygrywa ze wspólnym; brak własnego znaczy, że je wspólne.
 */
export function visibleToMember<T extends Pick<BalanceMeal, 'participantIds'>>(
  slotMeals: T[],
  memberId: string,
): T[] {
  const own = slotMeals.filter((meal) =>
    meal.participantIds.includes(memberId),
  );
  return own.length > 0
    ? own
    : slotMeals.filter((meal) => meal.participantIds.length === 0);
}

function addInto(total: BalanceNutrition, part: BalanceNutrition): void {
  total.kcal += part.kcal;
  total.protein += part.protein;
  total.fat += part.fat;
  total.carbs += part.carbs;
  total.fiber += part.fiber;
}

function roundBalance(total: BalanceNutrition): BalanceNutrition {
  return {
    kcal: Math.round(total.kcal),
    protein: Math.round(total.protein),
    fat: Math.round(total.fat),
    carbs: Math.round(total.carbs),
    fiber: Math.round(total.fiber),
  };
}

export type DayBalance = {
  dayOfWeek: DayOfWeek;
  /** Wszystko, co ta osoba ma zaplanowane na ten dzień. */
  planned: BalanceNutrition;
  /** Tylko to, co odhaczyła jako zjedzone — plan nie jest dowodem, że zjadła. */
  eaten: BalanceNutrition;
  /** Ile pozycji planu składa się na `planned`. */
  meals: number;
};

/**
 * Bilans wszystkich dni tygodnia dla jednego domownika.
 *
 * Zwracamy komplet siedmiu dni, także pustych — wołający (i model) dostaje
 * przewidywalny kształt, zamiast zgadywać, czy brak dnia znaczy „zero", czy
 * „nie policzono".
 */
export function weeklyBalanceForMember(
  meals: BalanceMeal[],
  params: {
    memberId: string;
    householdMemberCount: number;
    days: readonly DayOfWeek[];
  },
): DayBalance[] {
  const { memberId, householdMemberCount, days } = params;

  return days.map((dayOfWeek) => {
    const dayMeals = meals.filter((meal) => meal.dayOfWeek === dayOfWeek);
    const slots = new Set(dayMeals.map((meal) => meal.mealType));

    const planned = { ...ZERO_BALANCE };
    const eaten = { ...ZERO_BALANCE };
    let counted = 0;

    for (const slot of slots) {
      const mine = visibleToMember(
        dayMeals.filter((meal) => meal.mealType === slot),
        memberId,
      );
      for (const meal of mine) {
        const perPerson = nutritionPerPerson(meal, householdMemberCount);
        addInto(planned, perPerson);
        counted += 1;
        if (meal.eatenByUserIds.includes(memberId)) {
          addInto(eaten, perPerson);
        }
      }
    }

    return {
      dayOfWeek,
      planned: roundBalance(planned),
      eaten: roundBalance(eaten),
      meals: counted,
    };
  });
}
