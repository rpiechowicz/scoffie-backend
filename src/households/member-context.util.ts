import {
  DietPreferenceValue,
  MembershipRole,
  Sex,
  UserGoal,
} from '@prisma/client';
import {
  buildBodyMetrics,
  macroTargets,
  type MacroTargets,
} from '../users/body-metrics.util';

/**
 * Kontekst domownika dla planowania — preferencje, sylwetka i policzone cele
 * w jednym kształcie.
 *
 * Powstało, bo asystent nie ma jak zebrać tego sam: preferencje są w
 * `UserPreference`, sylwetka w `User`, a cele makro liczyły się WYŁĄCZNIE na
 * telefonie (patrz `src/users/body-metrics.util.ts`). Bez tego agregatu
 * „zaplanuj tydzień dla domu" znaczyłoby N wywołań i tak bez makr.
 *
 * Ta sama luka boli iOS: po włączeniu auth klient stracił dostęp do cudzych
 * preferencji (`users:preferences:get` czyta tylko własne), a lista
 * domowników ich nie niesie — więc ekran planu nie wie, kto czego nie je.
 */

/** Wartości domyślne z `UserPreference` w schemacie — dla kont bez wiersza. */
export const PREFERENCE_DEFAULTS = {
  dietPreference: 'NONE' as DietPreferenceValue,
  calorieGoal: 2000,
  allergens: [] as string[],
  goal: 'HEALTHY' as UserGoal,
  activityLevel: 2,
} as const;

/**
 * Skąd wzięły się makra:
 * - `STORED` — użytkownik nadpisał je ręcznie (wszystkie trzy w bazie),
 * - `COMPUTED` — policzone z sylwetki i celu, tak jak liczy je telefon,
 * - `UNAVAILABLE` — nie da się policzyć, bo brakuje sylwetki (makra zależą
 *   od masy ciała). Asystent ma wtedy trzymać się samych kalorii, a nie
 *   zgadywać gramy.
 */
export type MacrosSource = 'STORED' | 'COMPUTED' | 'UNAVAILABLE';

export type MemberContext = {
  userId: string;
  displayName: string;
  role: MembershipRole;
  dietPreference: DietPreferenceValue;
  allergens: string[];
  goal: UserGoal;
  activityLevel: number;
  body: {
    sex: Sex | null;
    heightCm: number | null;
    weightKg: number | null;
    yearOfBirth: number | null;
  };
  targets: {
    calorieGoal: number;
    macros: MacroTargets | null;
    macrosSource: MacrosSource;
  };
};

export type MemberContextRow = {
  role: MembershipRole;
  user: {
    id: string;
    displayName: string;
    sex: Sex | null;
    heightCm: number | null;
    weightKg: number | null;
    yearOfBirth: number | null;
    preferences: {
      dietPreference: DietPreferenceValue;
      calorieGoal: number;
      allergens: string[];
      goal: UserGoal;
      activityLevel: number;
      proteinG: number | null;
      fatG: number | null;
      carbsG: number | null;
    } | null;
  };
};

export function toMemberContext(
  row: MemberContextRow,
  now: Date = new Date(),
): MemberContext {
  const { user } = row;
  // Brak wiersza preferencji to normalny stan konta, które nie przeszło
  // jeszcze kreatora — czytamy domyślne ze schematu. NIE tworzymy wiersza:
  // odczyt z efektem ubocznym (`users:preferences:get`) jest dokładnie tym,
  // czego audyt kazał tu nie powtarzać.
  const preferences = user.preferences ?? PREFERENCE_DEFAULTS;

  const metrics = buildBodyMetrics(
    {
      heightCm: user.heightCm,
      weightKg: user.weightKg,
      yearOfBirth: user.yearOfBirth,
      activityLevel: preferences.activityLevel,
      sex: user.sex,
    },
    now,
  );

  const stored = user.preferences;
  // Nadpisanie liczy się tylko w komplecie: częściowo wypełnione makra
  // (jedno pole z UI, które padło w połowie zapisu) zmieszane z policzonymi
  // dałyby zestaw, który się nie sumuje do celu kalorycznego.
  const hasStoredMacros =
    stored?.proteinG != null && stored?.fatG != null && stored?.carbsG != null;

  const computed = macroTargets(
    preferences.goal,
    preferences.calorieGoal,
    metrics,
  );

  const macros: MacroTargets | null = hasStoredMacros
    ? {
        proteinG: stored.proteinG!,
        fatG: stored.fatG!,
        carbsG: stored.carbsG!,
      }
    : computed;

  const macrosSource: MacrosSource = hasStoredMacros
    ? 'STORED'
    : computed
      ? 'COMPUTED'
      : 'UNAVAILABLE';

  return {
    userId: user.id,
    displayName: user.displayName,
    role: row.role,
    dietPreference: preferences.dietPreference,
    allergens: preferences.allergens,
    goal: preferences.goal,
    activityLevel: preferences.activityLevel,
    body: {
      sex: user.sex,
      heightCm: user.heightCm,
      weightKg: user.weightKg,
      yearOfBirth: user.yearOfBirth,
    },
    targets: {
      calorieGoal: preferences.calorieGoal,
      macros,
      macrosSource,
    },
  };
}
