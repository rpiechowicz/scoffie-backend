import { Sex, UserGoal } from '@prisma/client';

/**
 * Zapotrzebowanie kaloryczne i rozbicie na makra — PORT z iOS
 * (`Scoffie/Models/Components/BodyMetrics.swift`, `UserGoal.swift`).
 *
 * Do tej pory te wzory żyły wyłącznie na telefonie: serwer zapisywał
 * `calorieGoal` policzony przez klienta, a makra trzymał tylko wtedy, gdy
 * ktoś nadpisał je ręcznie (`UserPreference.proteinG/fatG/carbsG` są
 * nullable właśnie dlatego). Asystent czyta bazę, nie telefon — bez tego
 * portu nie wiedziałby, ile białka ma trafić w dzienny cel domownika, i
 * układałby plan pod samą liczbę kalorii.
 *
 * Wartości MUSZĄ zgadzać się z iOS co do grama: użytkownik widzi swój cel
 * w Ustawieniach, a plan od asystenta ma się z nim zgadzać. Pilnuje tego
 * `body-metrics.util.spec.ts` — przy zmianie wzoru po którejkolwiek stronie
 * druga musi pojechać razem.
 */

/** Zakresy, poniżej/powyżej których dane są bez sensu (iOS `BodyMetrics.init?`). */
export const HEIGHT_RANGE_CM = { min: 120, max: 230 } as const;
export const WEIGHT_RANGE_KG = { min: 30, max: 250 } as const;
export const AGE_RANGE = { min: 13, max: 110 } as const;

/** Krok suwaka kalorii i jego zakres. */
export const CALORIE_STEP = 50;
export const CALORIE_RANGE = { min: 1200, max: 3500 } as const;

/** Krok steppera makro — 193 g białka to liczba, której nikt nie odmierzy. */
export const GRAM_STEP = 5;

export type ActivityLevel = 1 | 2 | 3 | 4;

export type BodyMetrics = {
  heightCm: number;
  weightKg: number;
  age: number;
  activity: ActivityLevel;
  /** `null` dla kont sprzed dodania pola — BMR liczy się wtedy ze środka. */
  sex: Sex | null;
};

export type MacroTargets = {
  proteinG: number;
  fatG: number;
  carbsG: number;
};

/** Stała ze wzoru Mifflina-St Jeora; brak płci = środek obu wariantów. */
const BASAL_CONSTANT: Record<Sex, number> = { MALE: 5, FEMALE: -161 };
const BASAL_CONSTANT_UNKNOWN = -78;

const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  1: 1.2,
  2: 1.375,
  3: 1.55,
  4: 1.725,
};

/** Płaska podpowiedź, gdy sylwetki nie da się policzyć (iOS `UserGoal.suggestedCalories`). */
const FLAT_CALORIES: Record<UserGoal, number> = {
  HEALTHY: 2200,
  LOSE: 1800,
  GAIN: 2700,
  MAINTAIN: 2200,
  PLAN: 2300,
};

/** Białko w g/kg: punkt wyjścia z celu, treningi go przesuwają. */
const PROTEIN_BASE: Record<UserGoal, number> = {
  LOSE: 1.9,
  GAIN: 1.9,
  MAINTAIN: 1.5,
  HEALTHY: 1.5,
  PLAN: 1.2,
};
const PROTEIN_ACTIVITY_BONUS: Record<ActivityLevel, number> = {
  1: -0.2,
  2: 0,
  3: 0.2,
  4: 0.35,
};
const PROTEIN_RANGE = { min: 1.0, max: 2.4 } as const;

/** Udział tłuszczu w puli kalorii; na redukcji i budowie schodzi do 25%. */
const FAT_ENERGY_SHARE: Record<UserGoal, number> = {
  LOSE: 0.25,
  GAIN: 0.25,
  MAINTAIN: 0.3,
  HEALTHY: 0.3,
  PLAN: 0.3,
};
/** Podłoga tłuszczu w g/kg — gospodarka hormonalna. */
const FAT_FLOOR_PER_KG = 0.6;

/**
 * Swift `Double.rounded()` to „half away from zero", a `Math.round` w JS to
 * „half up" — różnią się na wartościach ujemnych. Tu wszystkie wejścia są
 * dodatnie, ale trzymamy semantykę Swifta, żeby port był portem, a nie
 * przybliżeniem.
 */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Zaokrąglenie do kroku suwaka i przycięcie do jego zakresu. */
export function snapCalories(raw: number): number {
  const stepped = roundHalfAwayFromZero(raw / CALORIE_STEP) * CALORIE_STEP;
  return Math.min(
    Math.max(Math.trunc(stepped), CALORIE_RANGE.min),
    CALORIE_RANGE.max,
  );
}

export function snapGrams(raw: number): number {
  return Math.max(
    Math.trunc(roundHalfAwayFromZero(raw / GRAM_STEP)) * GRAM_STEP,
    0,
  );
}

/**
 * Składa sylwetkę z tego, co jest w bazie, albo oddaje `null`, gdy
 * którejkolwiek danej brakuje lub jest poza zakresem — dokładnie jak
 * `BodyMetrics.init?` w iOS. Brak płci NIE blokuje rachunku.
 */
export function buildBodyMetrics(
  input: {
    heightCm: number | null;
    weightKg: number | null;
    yearOfBirth: number | null;
    activityLevel: number;
    sex: Sex | null;
  },
  now: Date = new Date(),
): BodyMetrics | null {
  const { heightCm, weightKg, yearOfBirth, activityLevel, sex } = input;
  if (heightCm === null || weightKg === null || yearOfBirth === null) {
    return null;
  }
  const age = now.getFullYear() - yearOfBirth;
  const inRange = (value: number, range: { min: number; max: number }) =>
    value >= range.min && value <= range.max;

  if (
    !inRange(heightCm, HEIGHT_RANGE_CM) ||
    !inRange(weightKg, WEIGHT_RANGE_KG) ||
    !inRange(age, AGE_RANGE) ||
    ![1, 2, 3, 4].includes(activityLevel)
  ) {
    return null;
  }

  return {
    heightCm,
    weightKg,
    age,
    activity: activityLevel as ActivityLevel,
    sex,
  };
}

/** Podstawowa przemiana materii wg Mifflina-St Jeora. */
export function basalMetabolicRate(metrics: BodyMetrics): number {
  return (
    10 * metrics.weightKg +
    6.25 * metrics.heightCm -
    5 * metrics.age +
    (metrics.sex ? BASAL_CONSTANT[metrics.sex] : BASAL_CONSTANT_UNKNOWN)
  );
}

/** BMR × współczynnik aktywności. */
export function totalDailyEnergyExpenditure(metrics: BodyMetrics): number {
  return basalMetabolicRate(metrics) * ACTIVITY_MULTIPLIER[metrics.activity];
}

/**
 * Sugerowany dzienny cel. Deficyt i nadwyżka są PROCENTOWE — 500 kcal mniej
 * znaczy co innego przy zapotrzebowaniu 1700 niż przy 3200 — i deficyt nigdy
 * nie schodzi poniżej BMR.
 */
export function suggestedCalories(
  goal: UserGoal,
  metrics: BodyMetrics | null,
): number {
  if (!metrics) return FLAT_CALORIES[goal];
  const tdee = totalDailyEnergyExpenditure(metrics);

  if (goal === 'LOSE') {
    return snapCalories(Math.max(tdee * 0.85, basalMetabolicRate(metrics)));
  }
  if (goal === 'GAIN') {
    return snapCalories(tdee * 1.12);
  }
  return snapCalories(tdee);
}

export function proteinPerKilogram(
  goal: UserGoal,
  activity: ActivityLevel,
): number {
  const value = PROTEIN_BASE[goal] + PROTEIN_ACTIVITY_BONUS[activity];
  return Math.min(Math.max(value, PROTEIN_RANGE.min), PROTEIN_RANGE.max);
}

/**
 * Rozbicie celu kalorycznego na makra.
 *
 * Kolejność nie jest przypadkowa: najpierw białko (masa ciała i treningi),
 * potem tłuszcz (udział w kaloriach, z podłogą 0,6 g/kg), a węglowodany
 * biorą całą resztę. Dzięki temu więcej treningów przy tym samym celu
 * automatycznie znaczy więcej węglowodanów, bez osobnej reguły.
 *
 * `null`, gdy nie ma sylwetki — makra zależą od MASY CIAŁA, więc bez niej
 * nie ma czego liczyć. Wołający pokazuje wtedy sam cel kaloryczny.
 */
export function macroTargets(
  goal: UserGoal,
  calories: number,
  metrics: BodyMetrics | null,
): MacroTargets | null {
  if (!metrics) return null;
  const kcal = Math.max(calories, 0);

  const protein = roundHalfAwayFromZero(
    metrics.weightKg * proteinPerKilogram(goal, metrics.activity),
  );
  const proteinKcal = protein * 4;

  const fatFloor = metrics.weightKg * FAT_FLOOR_PER_KG;
  const fat = roundHalfAwayFromZero(
    Math.max((kcal * FAT_ENERGY_SHARE[goal]) / 9, fatFloor),
  );
  const fatKcal = fat * 9;

  const carbs = roundHalfAwayFromZero(
    Math.max((kcal - proteinKcal - fatKcal) / 4, 0),
  );

  return {
    proteinG: snapGrams(protein),
    fatG: snapGrams(fat),
    carbsG: snapGrams(carbs),
  };
}
