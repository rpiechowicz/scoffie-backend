import { MealType } from '@prisma/client';

/**
 * Sloty posiłków w kolejności dnia. Ta sama kolejność co w enumie Prismy
 * (a więc i w Postgresie), żeby `ORDER BY "mealType"` w planie tygodnia dawał
 * porządek dnia, a nie alfabetyczny.
 */
export const MEAL_TYPES_IN_DAY_ORDER = [
  MealType.BREAKFAST,
  MealType.SECOND_BREAKFAST,
  MealType.LUNCH,
  MealType.AFTERNOON_SNACK,
  MealType.DINNER,
  MealType.SNACK,
] as const;

/**
 * Sloty, których nie da się wyłączyć. Bez nich plan tygodnia przestaje być
 * planem posiłków, a lista zakupów nie ma z czego się policzyć — dlatego
 * ustawienia gospodarstwa mogą nimi wyłącznie potwierdzić stan, nie zmienić.
 */
export const CORE_MEAL_TYPES: readonly MealType[] = [
  MealType.BREAKFAST,
  MealType.LUNCH,
  MealType.DINNER,
];

/** Sloty opcjonalne — to je włącza i wyłącza użytkownik w ustawieniach. */
export const OPTIONAL_MEAL_TYPES: readonly MealType[] = [
  MealType.SECOND_BREAKFAST,
  MealType.AFTERNOON_SNACK,
  MealType.SNACK,
];

/**
 * Lista wartości do walidatorów `@IsIn` i do `@ApiProperty({ enum })`.
 * Mutowalna kopia, bo oba API oczekują `any[]`, a nie `readonly`.
 */
export const MEAL_TYPE_VALUES: string[] = [...MEAL_TYPES_IN_DAY_ORDER];

export function isMealType(value: unknown): value is MealType {
  return typeof value === 'string' && MEAL_TYPE_VALUES.includes(value);
}

/**
 * Porządkuje i odchudza listę slotów: usuwa duplikaty, dokłada obowiązkową
 * trójkę i sortuje po porze dnia. Jedno miejsce, przez które przechodzi każdy
 * zapis `Household.enabledMealTypes` — dzięki temu w bazie nigdy nie wyląduje
 * lista bez obiadu ani taka, w której podwieczorek stoi przed śniadaniem.
 */
export function normalizeEnabledMealTypes(
  values: readonly MealType[] | undefined | null,
): MealType[] {
  const requested = new Set<MealType>(values ?? []);
  for (const core of CORE_MEAL_TYPES) {
    requested.add(core);
  }
  return MEAL_TYPES_IN_DAY_ORDER.filter((type) => requested.has(type));
}

/**
 * Sloty, w których danie faktycznie da się zaplanować.
 *
 * `suitableMealTypes` bywa puste dla wierszy sprzed backfillu i dla przepisów
 * dodanych przez starszego klienta — wtedy czytamy je jak „pasuje tylko do
 * swojego slotu bazowego". Bez tego takie przepisy zniknęłyby z listy przy
 * dodawaniu posiłku zamiast po prostu nie dostać dodatkowych slotów.
 */
export function effectiveSuitableMealTypes(recipe: {
  mealType: MealType;
  suitableMealTypes?: MealType[] | null;
}): MealType[] {
  const declared = recipe.suitableMealTypes ?? [];
  const set = new Set<MealType>(declared.length > 0 ? declared : []);
  set.add(recipe.mealType);
  return MEAL_TYPES_IN_DAY_ORDER.filter((type) => set.has(type));
}
