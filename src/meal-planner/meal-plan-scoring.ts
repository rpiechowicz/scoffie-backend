import { DayOfWeek, MealType } from '@prisma/client';
import {
  conflictingAllergens,
  satisfiesDiet,
} from '../recipes/diet-rules.util';
import {
  BalanceMeal,
  nutritionPerPerson,
  visibleToMember,
} from '../weekly-plans/utils/daily-balance.util';
import {
  HardFilterReason,
  PlannedItem,
  PlannerEater,
  PlannerNutrition,
  PlannerRecipe,
  PlanningRequest,
  PlanningScope,
} from './meal-planner.types';

/**
 * Reguły oceny planu — JEDNE dla silnika (wybór dań) i dla niezależnej oceny
 * dowolnego planu (`evaluatePlan`, metryki pod benchmark Etapu 6). Gdyby
 * silnik optymalizował jedno, a metryka mierzyła drugie, „lepszy plan"
 * znaczyłby tylko „bardziej podobny do tego, co liczy silnik".
 */

/**
 * WAGI pór przy dzieleniu dziennego celu między sloty — nie udziały „na
 * sztywno". Pełny dzień (wszystkie pory domu) dostaje 100 % celu, a wagi się
 * normalizują: śniadanie/obiad/kolacja (25 : 35 : 20) = 31,25 / 43,75 / 25 %.
 * Pięć podstawowych pór sumuje się do 1,0, `SNACK` jest dodatkowy — ale po
 * normalizacji żadna kombinacja nie daje ani mniej, ani więcej niż cel.
 * (Do review Etapu 2 wagi były udziałami bez normalizacji i trzy pory
 * celowały w 80 % celu — niespójnie z aplikacją.)
 */
export const MEAL_KCAL_WEIGHT: Readonly<Record<MealType, number>> = {
  BREAKFAST: 0.25,
  SECOND_BREAKFAST: 0.1,
  LUNCH: 0.35,
  AFTERNOON_SNACK: 0.1,
  DINNER: 0.2,
  SNACK: 0.1,
};

/** Tolerancje (Etap 2, „Kryteria jakości") — względne odchylenie dnia osoby. */
export const KCAL_DAY_TOLERANCE = 0.1;
export const PROTEIN_DAY_TOLERANCE = 0.2;
export const FAT_CARBS_DAY_TOLERANCE = 0.25;

/**
 * Widełki udziału na osobę (porcje łączne / jedzący). 0,75–1,5 porcji to
 * „mniejsza albo większa porcja", a nie „podwójny obiad, żeby dobić kcal".
 * Porcje łączne są całkowite (audyt 2A), więc w domu jednoosobowym zostaje
 * wyłącznie 1 — kcal stroi się tam doborem dania.
 */
export const PORTION_SHARE_MIN = 0.75;
export const PORTION_SHARE_MAX = 1.5;
const PLANNED_SERVINGS_MAX = 12;

/** Wagi funkcji celu — mniej = lepiej. Kalibracja w raporcie 02, §5. */
export const WEIGHTS = {
  /** 10 % chybienia kcal dnia osoby kosztuje 0,1; 20 % — 0,4. */
  kcal: 10,
  protein: 3,
  fat: 1.5,
  carbs: 1.5,
  /**
   * Cel kcal konkretnego slotu („podobnie kalorycznie") — jawna prośba
   * użytkownika, więc 2× mocniej niż domykanie bilansu dnia.
   */
  slotKcal: 20,
  /** Każde wystąpienie przepisu ponad pierwsze w tygodniu. */
  repeat: 1,
  /** To samo mięso/ryba w tej samej porze dzień po dniu. */
  sameProteinNextDay: 0.1,
  /** Ten sam rodzaj dania (zupa, makaron…) dwa razy jednego dnia. */
  sameDishSameDay: 0.15,
  /** Przepis z niedawnych tygodni. */
  recent: 0.15,
  /** Brak mile widzianego tagu. */
  preferenceUnmet: 0.25,
  /** Przekroczenie czasu: stała + za minutę, z sufitem. */
  prepOver: 0.3,
  prepOverPerMinute: 0.01,
  prepOverCap: 0.6,
  /** Odejście od udziału 1 porcji na osobę. */
  portion: 0.2,
  favorite: -0.05,
  popularity: -0.02,
  /** Za każdy składnik wspólny z innymi daniami tygodnia (najwyżej 5). */
  sharedIngredient: -0.01,
  sharedIngredientCap: 5,
  /** Rozstrzyganie remisów ziarnem — mniejsze niż każda prawdziwa różnica. */
  jitter: 0.004,
} as const;

const PROTEIN_TAGS = new Set(['poultry', 'pork', 'beef', 'fish']);
const DISH_TAGS = new Set([
  'soup',
  'salad',
  'pasta',
  'grains',
  'potatoes',
  'dumplings',
  'stew',
  'porridge',
  'eggs',
  'sandwich',
  'pancakes',
  'yogurt',
  'bake',
]);

export const DAY_ORDER: readonly DayOfWeek[] = [
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
  'SUN',
];

export const slotKey = (day: DayOfWeek, meal: MealType): string =>
  `${day}|${meal}`;

// ── Audytorium ─────────────────────────────────────────────────────────────

/** Kto je pozycję: imienni uczestnicy albo cały dom. */
export function audienceOf(
  participantIds: readonly string[],
  members: readonly PlannerEater[],
): PlannerEater[] {
  if (participantIds.length === 0) return [...members];
  const wanted = new Set(participantIds);
  return members.filter((member) => wanted.has(member.userId));
}

/** Audytorium obejmujące wszystkich zwija się do „Wspólne" (jak w zapisie planu). */
export function normalizeParticipants(
  participantIds: readonly string[],
  members: readonly PlannerEater[],
): string[] {
  const unique = [...new Set(participantIds)];
  return unique.length === 0 || unique.length >= members.length
    ? []
    : unique.sort();
}

// ── Filtry twarde ──────────────────────────────────────────────────────────

/**
 * Pierwszy powód, dla którego przepis NIE może stanąć w tym slocie; `null` =
 * może. Te same funkcje co walidator zapisu i wyszukiwarka
 * (`diet-rules.util`), plus wymagania prośby. Dieta jest tu twarda, choć
 * walidator zapisu (`collectPlanViolations`) jej nie sprawdza — planer nie
 * proponuje dania, którego jedzący nie powinien jeść.
 */
export function hardFilterReason(
  recipe: PlannerRecipe,
  mealType: MealType,
  audience: readonly PlannerEater[],
  request: Pick<PlanningRequest, 'constraints'>,
): HardFilterReason | null {
  if (!recipe.active) return 'INACTIVE';
  if (!recipe.slots.includes(mealType)) return 'MEAL_TYPE';
  if (request.constraints.excludeRecipeIds.includes(recipe.id)) {
    return 'EXCLUDED_RECIPE';
  }
  const allergens = audience.flatMap((eater) => eater.allergens);
  if (conflictingAllergens(recipe.allergens, allergens).length > 0) {
    return 'ALLERGEN';
  }
  const excluded = new Set(
    audience.flatMap((eater) => eater.excludedIngredientIds),
  );
  if (recipe.ingredientIds.some((id) => excluded.has(id))) {
    return 'EXCLUDED_INGREDIENT';
  }
  const subject = {
    dietTags: recipe.dietTags,
    hasIngredientData: recipe.ingredientIds.length > 0,
    perServing: recipe.perServing,
  };
  if (!audience.every((eater) => satisfiesDiet(eater.diet, subject))) {
    return 'DIET';
  }
  const { diet, requiredTags, avoidIngredients } = request.constraints;
  if (diet && !satisfiesDiet(diet, subject)) return 'REQUEST_DIET';
  if (!requiredTags.every((tag) => recipe.tags.includes(tag))) {
    return 'REQUIRED_TAG';
  }
  if (
    avoidIngredients.some((avoided) =>
      recipe.ingredientNames.some((name) => name.includes(avoided)),
    )
  ) {
    return 'AVOIDED_INGREDIENT';
  }
  // Na końcu: bez makr nie da się policzyć celu, ale to nie jest zakaz —
  // walidator zapisu takie danie przepuści (ręczny wybór użytkownika).
  if (!recipe.perServing) return 'NO_NUTRITION';
  return null;
}

// ── Porcje ─────────────────────────────────────────────────────────────────

/** Ilu ludzi je pozycję (dla „Wspólne" — cały dom). */
export function eaterCountOf(
  participantIds: readonly string[],
  memberCount: number,
): number {
  return Math.max(
    1,
    participantIds.length === 0 ? memberCount : participantIds.length,
  );
}

/** Porcje łączne dopuszczalne dla tylu jedzących; pierwsza = reguła auto. */
export function allowedServings(
  eaters: number,
  mode: 'auto' | 'tune',
): number[] {
  const auto = Math.min(PLANNED_SERVINGS_MAX, Math.max(1, eaters));
  if (mode === 'auto') return [auto];
  const low = Math.max(1, Math.ceil(PORTION_SHARE_MIN * eaters));
  const high = Math.min(
    PLANNED_SERVINGS_MAX,
    Math.max(auto, Math.floor(PORTION_SHARE_MAX * eaters)),
  );
  const counts = [auto];
  for (let n = low; n <= high; n += 1) if (n !== auto) counts.push(n);
  return counts;
}

// ── Bilans ─────────────────────────────────────────────────────────────────

export type RecipeLookup = ReadonlyMap<string, PlannerRecipe>;

function toBalanceMeal(
  item: PlannedItem,
  recipe: PlannerRecipe | undefined,
): BalanceMeal | null {
  if (!recipe?.perServing) return null;
  const servings = Math.max(1, recipe.servings);
  return {
    dayOfWeek: item.dayOfWeek,
    mealType: item.mealType,
    participantIds: item.participantIds,
    eatenByUserIds: [],
    plannedServings: item.plannedServings,
    recipe: {
      servings,
      nutritionKcal: recipe.perServing.kcal * servings,
      nutritionProtein: recipe.perServing.protein * servings,
      nutritionFat: recipe.perServing.fat * servings,
      nutritionCarbs: recipe.perServing.carbs * servings,
      nutritionFiber: 0,
    },
  };
}

/**
 * Co JEDNA osoba zje jednego dnia z tych pozycji — te same reguły co bilans
 * w aplikacji (własne danie wygrywa ze wspólnym, udział = porcje / jedzący).
 */
export function eaterDayNutrition(
  dayItems: readonly PlannedItem[],
  eaterId: string,
  memberCount: number,
  recipes: RecipeLookup,
): PlannerNutrition {
  const total: PlannerNutrition = { kcal: 0, protein: 0, fat: 0, carbs: 0 };
  const bySlot = new Map<MealType, PlannedItem[]>();
  for (const item of dayItems) {
    bySlot.set(item.mealType, [...(bySlot.get(item.mealType) ?? []), item]);
  }
  for (const items of bySlot.values()) {
    for (const item of visibleToMember(items, eaterId)) {
      const meal = toBalanceMeal(item, recipes.get(item.recipeId));
      if (!meal) continue;
      const part = nutritionPerPerson(meal, memberCount);
      total.kcal += part.kcal;
      total.protein += part.protein;
      total.fat += part.fat;
      total.carbs += part.carbs;
    }
  }
  return total;
}

export type DayTarget = {
  kcal: number;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
};

const weightOf = (types: Iterable<MealType>): number => {
  let sum = 0;
  for (const meal of new Set(types)) sum += MEAL_KCAL_WEIGHT[meal];
  return sum;
};

/** Pory, między które dzieli się cel dnia — przy `FULL_DAY` same planowane. */
export function dayStructure(
  scope: PlanningScope,
  plannedTypes: Iterable<MealType>,
  dayMealTypes: Iterable<MealType>,
): Set<MealType> {
  return scope === 'FULL_DAY'
    ? new Set(plannedTypes)
    : new Set([...dayMealTypes, ...plannedTypes]);
}

/** Część celu przypadająca na porę przy danej strukturze dnia (wagi → 1,0). */
export function mealShare(
  meal: MealType,
  structure: Iterable<MealType>,
): number {
  const total = weightOf(structure);
  return total > 0 ? MEAL_KCAL_WEIGHT[meal] / total : 0;
}

export type EaterDayAssessment = {
  /** Co osoba je w ZAKRESIE (planowane pory; przy `FULL_DAY` = cały dzień). */
  evaluated: PlannerNutrition;
  /** Cel zakresu. */
  target: DayTarget;
  /** Cały dzień osoby (zakres + to, co je poza nim). */
  day: PlannerNutrition;
  /** Pełny dzienny cel kcal. */
  goalKcal: number;
  /** Mianownik odchylenia względnego kcal. */
  kcalBase: number;
};

/**
 * Bilans i cel JEDNEJ osoby w jednym dniu.
 *
 * Cel wynika wyłącznie z (1) pełnego dziennego celu osoby, (2) posiłków,
 * które ta osoba RZECZYWIŚCIE je (`visibleToMember` — osobisty obiad innego
 * domownika jej nie dotyczy), (3) zakresu planowania:
 *
 *   budżet  = cel dnia − to, co osoba je poza planowanymi porami
 *   cel     = budżet × waga(pory celu) / waga(pory niepokryte)
 *
 * gdzie pory niepokryte = struktura dnia bez tych, które osoba już je poza
 * planowanymi. `FULL_DAY`: struktura = planowane pory, więc całe planowane
 * pory dostają cały budżet (zwykle 100 % celu). `targetTypes` pozwala liczyć
 * cel części planowanych pór (zachłanny wybór: tylko już wypełnione).
 */
export function assessEaterDay(input: {
  eater: PlannerEater;
  memberCount: number;
  recipes: RecipeLookup;
  dayItems: readonly PlannedItem[];
  plannedTypes: ReadonlySet<MealType>;
  targetTypes: ReadonlySet<MealType>;
  dayMealTypes: readonly MealType[];
  scope: PlanningScope;
}): EaterDayAssessment {
  const { eater, memberCount, recipes, plannedTypes } = input;
  const inScope = input.dayItems.filter((item) =>
    plannedTypes.has(item.mealType),
  );
  const outside = input.dayItems.filter(
    (item) => !plannedTypes.has(item.mealType),
  );
  const evaluated = eaterDayNutrition(
    inScope,
    eater.userId,
    memberCount,
    recipes,
  );
  const fixed = eaterDayNutrition(outside, eater.userId, memberCount, recipes);
  const eatenOutside = new Set<MealType>();
  for (const meal of new Set(outside.map((item) => item.mealType))) {
    const slot = outside.filter((item) => item.mealType === meal);
    if (visibleToMember(slot, eater.userId).length > 0) eatenOutside.add(meal);
  }
  const uncovered = [
    ...dayStructure(input.scope, plannedTypes, input.dayMealTypes),
  ].filter((meal) => !eatenOutside.has(meal));
  const totalWeight = weightOf(uncovered);
  const share =
    totalWeight > 0
      ? weightOf([...input.targetTypes].filter((m) => uncovered.includes(m))) /
        totalWeight
      : 0;
  const budget = (goal: number, eaten: number) =>
    Math.max(0, goal - eaten) * share;
  const target: DayTarget = {
    kcal: budget(eater.kcalTarget, fixed.kcal),
    protein: eater.macros ? budget(eater.macros.proteinG, fixed.protein) : null,
    fat: eater.macros ? budget(eater.macros.fatG, fixed.fat) : null,
    carbs: eater.macros ? budget(eater.macros.carbsG, fixed.carbs) : null,
  };
  return {
    evaluated,
    target,
    day: {
      kcal: evaluated.kcal + fixed.kcal,
      protein: evaluated.protein + fixed.protein,
      fat: evaluated.fat + fixed.fat,
      carbs: evaluated.carbs + fixed.carbs,
    },
    goalKcal: eater.kcalTarget,
    // Pełny dzień: odchylenie względem PEŁNEGO celu. Część dnia: względem
    // celu zakresu (z podłogą, żeby pusty budżet nie dzielił przez zero).
    kcalBase:
      input.scope === 'FULL_DAY'
        ? Math.max(1, eater.kcalTarget)
        : Math.max(target.kcal, 0.05 * eater.kcalTarget, 1),
  };
}

const rel = (planned: number, target: number | null): number | null =>
  target && target > 0 ? (planned - target) / target : null;

/** Koszt dnia JEDNEJ osoby: kwadraty względnych odchyleń, ważone. */
export function eaterDayCost(assessment: EaterDayAssessment): number {
  const { evaluated: planned, target } = assessment;
  const kcal = (planned.kcal - target.kcal) / assessment.kcalBase;
  let cost = WEIGHTS.kcal * kcal * kcal;
  const protein = rel(planned.protein, target.protein);
  const fat = rel(planned.fat, target.fat);
  const carbs = rel(planned.carbs, target.carbs);
  if (protein !== null) cost += WEIGHTS.protein * protein * protein;
  if (fat !== null) cost += WEIGHTS.fat * fat * fat;
  if (carbs !== null) cost += WEIGHTS.carbs * carbs * carbs;
  return cost;
}

// ── Miękkie ────────────────────────────────────────────────────────────────

/** Deterministyczny ułamek [0, 1) z tekstu (FNV-1a) — ziarno remisów. */
export function seededFraction(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

export type SoftContext = {
  preferredTags: ReadonlySet<string>;
  maxPrepMinutes: number | null;
  favorites: ReadonlySet<string>;
  recent: ReadonlySet<string>;
  popularity: Readonly<Record<string, number>>;
  seed: string;
};

/** Koszt miękki jednej pozycji (bez tego, co zależy od reszty planu). */
export function itemSoftCost(
  recipe: PlannerRecipe,
  share: number,
  soft: SoftContext,
): number {
  let cost = WEIGHTS.portion * Math.abs(share - 1);
  if (
    soft.preferredTags.size > 0 &&
    !recipe.tags.some((tag) => soft.preferredTags.has(tag))
  ) {
    cost += WEIGHTS.preferenceUnmet;
  }
  if (
    soft.maxPrepMinutes !== null &&
    recipe.prepTimeMinutes > soft.maxPrepMinutes
  ) {
    cost += Math.min(
      WEIGHTS.prepOverCap,
      WEIGHTS.prepOver +
        WEIGHTS.prepOverPerMinute *
          (recipe.prepTimeMinutes - soft.maxPrepMinutes),
    );
  }
  if (soft.recent.has(recipe.id)) cost += WEIGHTS.recent;
  if (soft.favorites.has(recipe.id)) cost += WEIGHTS.favorite;
  const popularity = soft.popularity[recipe.id] ?? 0;
  if (popularity > 0) {
    cost += WEIGHTS.popularity * Math.min(1, Math.log10(1 + popularity) / 2);
  }
  cost += WEIGHTS.jitter * seededFraction(`${soft.seed}|${recipe.id}`);
  return cost;
}

/**
 * Koszt całego tygodnia zależny od RELACJI między pozycjami: powtórki,
 * monotonia, wspólne składniki. Liczony po wszystkich pozycjach (także
 * stałych), bo powtórka z tym, co już stoi w planie, jest tak samo powtórką.
 */
export function weekRelationCost(
  items: readonly PlannedItem[],
  recipes: RecipeLookup,
): number {
  let cost = 0;
  const uses = new Map<string, number>();
  const ingredientUses = new Map<string, number>();
  for (const item of items) {
    uses.set(item.recipeId, (uses.get(item.recipeId) ?? 0) + 1);
  }
  // Po RÓŻNYCH przepisach: powtórka dania dzieli składniki sama ze sobą,
  // a premia nie może nagradzać powtórek.
  for (const recipeId of uses.keys()) {
    for (const id of recipes.get(recipeId)?.sharedIngredientIds ?? []) {
      ingredientUses.set(id, (ingredientUses.get(id) ?? 0) + 1);
    }
  }
  for (const count of uses.values()) {
    if (count > 1) cost += WEIGHTS.repeat * (count - 1);
  }
  const byDay = new Map<DayOfWeek, PlannedItem[]>();
  for (const item of items) {
    byDay.set(item.dayOfWeek, [...(byDay.get(item.dayOfWeek) ?? []), item]);
  }
  for (const [day, dayItems] of byDay) {
    const dishes = new Map<string, number>();
    for (const item of dayItems) {
      const recipe = recipes.get(item.recipeId);
      for (const tag of recipe?.tags ?? []) {
        if (DISH_TAGS.has(tag)) dishes.set(tag, (dishes.get(tag) ?? 0) + 1);
      }
      const next = byDay.get(DAY_ORDER[DAY_ORDER.indexOf(day) + 1]);
      const proteins = (recipe?.tags ?? []).filter((tag) =>
        PROTEIN_TAGS.has(tag),
      );
      if (next && proteins.length > 0) {
        const tomorrow = next.find((other) => other.mealType === item.mealType);
        const theirs = recipes.get(tomorrow?.recipeId ?? '')?.tags ?? [];
        if (proteins.some((tag) => theirs.includes(tag))) {
          cost += WEIGHTS.sameProteinNextDay;
        }
      }
    }
    for (const count of dishes.values()) {
      if (count > 1) cost += WEIGHTS.sameDishSameDay * (count - 1);
    }
  }
  for (const recipeId of uses.keys()) {
    const shared = (recipes.get(recipeId)?.sharedIngredientIds ?? []).filter(
      (id) => (ingredientUses.get(id) ?? 0) > 1,
    ).length;
    cost +=
      WEIGHTS.sharedIngredient * Math.min(WEIGHTS.sharedIngredientCap, shared);
  }
  return cost;
}
