import { DayOfWeek, MealType } from '@prisma/client';
import {
  CandidateStats,
  DayDiagnostics,
  HardFilterReason,
  PlanDraft,
  PlanIssue,
  PlanMetrics,
  PlannedItem,
  PlannerEater,
  PlannerRecipe,
  PlanningRequest,
  PlanStatus,
} from './meal-planner.types';
import {
  allowedServings,
  assessEaterDay,
  audienceOf,
  DAY_ORDER,
  dayStructure,
  eaterCountOf,
  eaterDayCost,
  eaterDayNutrition,
  mealShare,
  FAT_CARBS_DAY_TOLERANCE,
  hardFilterReason,
  itemSoftCost,
  KCAL_DAY_TOLERANCE,
  MEAL_KCAL_WEIGHT,
  normalizeParticipants,
  portionFor,
  PROTEIN_DAY_TOLERANCE,
  RecipeLookup,
  slotKey,
  SoftContext,
  WEIGHTS,
  weekRelationCost,
} from './meal-plan-scoring';

/**
 * Serwerowy planer posiłków — jeden silnik dla dnia, tygodnia i podmiany
 * jednego slotu (workstream, Etap 2). Dzień to tydzień z jednym dniem,
 * podmiana to plan jednego slotu z resztą tygodnia jako `fixed`.
 *
 * Algorytm (prosty, przewidywalny, bez solvera):
 * 1. Kandydaci: dla każdej pory filtry TWARDE (`hardFilterReason`: aktywność,
 *    pora, alergeny, wykluczenia i dieta KAŻDEGO jedzącego, wymagania prośby,
 *    makra), potem tani ranking wstępny (kcal porcji wobec celu slotu +
 *    preferencje) i obcięcie do `CANDIDATES_PER_MEAL_TYPE`. To jedyne
 *    miejsce, które widzi całą pulę — koszt reszty nie rośnie z katalogiem.
 * 2. Zachłannie: dzień po dniu, pory od największego udziału kcal; w slocie
 *    wygrywa para (przepis, porcje) o najniższym koszcie planu z tym, co już
 *    wybrane (bilans dnia wobec celu WYPEŁNIONYCH pór, powtórki, preferencje).
 * 3. Lokalna poprawa: kilka przejść, w których każdy slot może zmienić danie,
 *    jeśli obniża to koszt CAŁEGO tygodnia (pełne cele dni, powtórki,
 *    monotonia, wspólne składniki) — dzięki temu tydzień nie jest sumą
 *    niezależnie optymalnych dni.
 * Remisy rozstrzyga ziarno (`seed`) — ten sam seed i dane dają ten sam plan.
 * Filtry twarde są PRZED scoringiem, więc żaden koszt nie „kupi" alergenu.
 */

/** Ilu kandydatów na porę trafia do właściwego doboru. */
export const CANDIDATES_PER_MEAL_TYPE = 60;
/** Ile przejść lokalnej poprawy najwyżej. */
export const IMPROVEMENT_PASSES = 3;

const EPSILON = 1e-9;

type Slot = { day: DayOfWeek; meal: MealType };

type Scope = {
  request: PlanningRequest;
  lookup: RecipeLookup;
  members: readonly PlannerEater[];
  audience: PlannerEater[];
  participantIds: string[];
  soft: SoftContext;
  /** Koszt miękki pozycji zależy tylko od (przepis, udział) — liczony raz. */
  softCache: Map<string, number>;
  /** Pory planowane w tej prośbie. */
  plannedTypes: ReadonlySet<MealType>;
};

function softContextOf(request: PlanningRequest): SoftContext {
  return {
    preferredTags: new Set(request.preferences.preferredTags),
    maxPrepMinutes: request.preferences.maxPrepMinutes,
    favorites: new Set(request.preferences.favoriteRecipeIds),
    recent: new Set(request.preferences.recentRecipeIds),
    popularity: request.preferences.popularity,
    seed: request.seed ?? '',
  };
}

function scopeOf(
  request: PlanningRequest,
  recipes: readonly PlannerRecipe[],
): Scope {
  const participantIds = normalizeParticipants(
    request.participantIds,
    request.members,
  );
  return {
    request,
    lookup: new Map(recipes.map((recipe) => [recipe.id, recipe])),
    members: request.members,
    audience: audienceOf(participantIds, request.members),
    participantIds,
    soft: softContextOf(request),
    softCache: new Map(),
    plannedTypes: new Set(request.mealTypes),
  };
}

function orderedMealTypes(mealTypes: readonly MealType[]): MealType[] {
  return [...new Set(mealTypes)].sort(
    (a, b) =>
      MEAL_KCAL_WEIGHT[b] - MEAL_KCAL_WEIGHT[a] ||
      Object.keys(MEAL_KCAL_WEIGHT).indexOf(a) -
        Object.keys(MEAL_KCAL_WEIGHT).indexOf(b),
  );
}

function orderedDays(days: readonly DayOfWeek[]): DayOfWeek[] {
  const wanted = new Set(days);
  return DAY_ORDER.filter((day) => wanted.has(day));
}

// ── Koszt ──────────────────────────────────────────────────────────────────

/** Ocena osobo-dnia w zakresie prośby — patrz `assessEaterDay`. */
function assess(
  scope: Scope,
  eater: PlannerEater,
  dayItems: readonly PlannedItem[],
  targetTypes: ReadonlySet<MealType>,
) {
  return assessEaterDay({
    eater,
    memberCount: scope.members.length,
    recipes: scope.lookup,
    dayItems,
    plannedTypes: scope.plannedTypes,
    targetTypes,
    dayMealTypes: scope.request.dayMealTypes ?? scope.request.mealTypes,
    scope: scope.request.scope,
  });
}

/** Koszt dnia dla audytorium; cel liczony dla pór `targetTypes`. */
function dayCost(
  scope: Scope,
  day: DayOfWeek,
  dayItems: readonly PlannedItem[],
  targetTypes: ReadonlySet<MealType>,
): number {
  if (scope.audience.length === 0 || targetTypes.size === 0) return 0;
  let cost = 0;
  for (const eater of scope.audience) {
    cost += eaterDayCost(assess(scope, eater, dayItems, targetTypes));
  }
  cost /= scope.audience.length;
  // „Podobnie kalorycznie": cel konkretnego slotu, NA OSOBĘ.
  for (const [key, target] of Object.entries(
    scope.request.slotKcalTargets ?? {},
  )) {
    const [targetDay, meal] = key.split('|') as [DayOfWeek, MealType];
    if (targetDay !== day || target <= 0) continue;
    const slotItems = dayItems.filter((item) => item.mealType === meal);
    const kcals = scope.audience.map(
      (eater) =>
        eaterDayNutrition(
          slotItems,
          eater.userId,
          scope.members.length,
          scope.lookup,
        ).kcal,
    );
    if (scope.request.portionMode === 'per_user') {
      // Porcje per osoba (Etap 2.2): „podobnie kaloryczne" to DANIE — średnio
      // na osobę; porcję każdej osoby dobiera jej własny bilans dnia.
      const mean = kcals.reduce((sum, kcal) => sum + kcal, 0) / kcals.length;
      const deviation = (mean - target) / target;
      cost += WEIGHTS.slotKcal * deviation * deviation;
      continue;
    }
    let slotCost = 0;
    for (const kcal of kcals) {
      const deviation = (kcal - target) / target;
      slotCost += WEIGHTS.slotKcal * deviation * deviation;
    }
    cost += slotCost / scope.audience.length;
  }
  return cost;
}

function softCostOf(scope: Scope, items: readonly PlannedItem[]): number {
  let cost = 0;
  const eaters = eaterCountOf(scope.participantIds, scope.members.length);
  for (const item of items) {
    const recipe = scope.lookup.get(item.recipeId);
    if (!recipe) continue;
    if (item.portions && item.portions.length > 0) {
      // Porcje per osoba: słaba kara za odejście od 1, bez kary „udziału".
      const deviation =
        item.portions.reduce(
          (sum, portion) => sum + Math.abs(portion.servings - 1),
          0,
        ) / item.portions.length;
      cost +=
        softOfRecipe(scope, recipe, 1) + WEIGHTS.portionPerUser * deviation;
      continue;
    }
    const share = item.plannedServings / eaters;
    const key = `${recipe.id}|${share}`;
    let value = scope.softCache.get(key);
    if (value === undefined) {
      value = itemSoftCost(recipe, share, scope.soft);
      scope.softCache.set(key, value);
    }
    cost += value;
  }
  return cost;
}

function softOfRecipe(
  scope: Scope,
  recipe: PlannerRecipe,
  share: number,
): number {
  const key = `${recipe.id}|${share}`;
  let value = scope.softCache.get(key);
  if (value === undefined) {
    value = itemSoftCost(recipe, share, scope.soft);
    scope.softCache.set(key, value);
  }
  return value;
}

/** Pełna funkcja celu planu (mniej = lepiej) — ta sama w silniku i w ocenie. */
export function planObjective(
  request: PlanningRequest,
  recipes: readonly PlannerRecipe[],
  planned: readonly PlannedItem[],
): number {
  const scope = scopeOf(request, recipes);
  return objectiveOf(scope, planned);
}

function objectiveOf(scope: Scope, planned: readonly PlannedItem[]): number {
  const all = [...scope.request.fixed, ...planned];
  const days = new Set([
    ...scope.request.days,
    ...planned.map((item) => item.dayOfWeek),
  ]);
  let cost = 0;
  for (const day of days) {
    cost += dayCost(
      scope,
      day,
      all.filter((item) => item.dayOfWeek === day),
      scope.plannedTypes,
    );
  }
  return (
    cost + softCostOf(scope, planned) + weekRelationCost(all, scope.lookup)
  );
}

// ── Kandydaci ──────────────────────────────────────────────────────────────

function candidatesFor(
  scope: Scope,
  meal: MealType,
  /** Tylko te przepisy (np. „z kurczakiem" w propozycjach); brak = wszystkie. */
  allowed?: ReadonlySet<string>,
): { stats: CandidateStats; eligible: PlannerRecipe[] } {
  const removed: Partial<Record<HardFilterReason, number>> = {};
  const eligible: PlannerRecipe[] = [];
  for (const recipe of scope.lookup.values()) {
    if (allowed && !allowed.has(recipe.id)) continue;
    const reason = hardFilterReason(
      recipe,
      meal,
      scope.audience,
      scope.request,
    );
    if (reason) {
      if (reason !== 'MEAL_TYPE' && reason !== 'INACTIVE') {
        removed[reason] = (removed[reason] ?? 0) + 1;
      }
      continue;
    }
    eligible.push(recipe);
  }
  const suitable = [...scope.lookup.values()].filter(
    (recipe) => recipe.active && recipe.slots.includes(meal),
  ).length;

  // Ranking wstępny: kcal porcji wobec średniego celu slotu + miękkie.
  const share = mealShare(
    meal,
    dayStructure(
      scope.request.scope,
      scope.plannedTypes,
      scope.request.dayMealTypes ?? scope.request.mealTypes,
    ),
  );
  const slotTarget =
    scope.audience.reduce((sum, eater) => sum + eater.kcalTarget * share, 0) /
    Math.max(1, scope.audience.length);
  const pre = (recipe: PlannerRecipe): number =>
    (slotTarget > 0
      ? Math.abs((recipe.perServing?.kcal ?? 0) - slotTarget) / slotTarget
      : 0) + itemSoftCost(recipe, 1, scope.soft);
  const ranked = eligible
    .map((recipe) => ({ recipe, score: pre(recipe) }))
    .sort((a, b) => a.score - b.score || a.recipe.id.localeCompare(b.recipe.id))
    .slice(0, CANDIDATES_PER_MEAL_TYPE)
    .map((entry) => entry.recipe);

  return {
    stats: {
      mealType: meal,
      total: suitable,
      eligible: eligible.length,
      removed,
    },
    eligible: ranked,
  };
}

// ── Porcje per osoba ───────────────────────────────────────────────────────

function itemForSlot(
  scope: Scope,
  slot: Slot,
  recipeId: string,
  servings: number,
): PlannedItem {
  return {
    dayOfWeek: slot.day,
    mealType: slot.meal,
    recipeId,
    participantIds: scope.participantIds,
    plannedServings: servings,
  };
}

/**
 * Pozycja z porcjami per osoba (Etap 2.2): każda osoba dostaje porcję, która
 * domyka JEJ cel pór `targetTypes` przy tym, co już jest w dniu (bez tego
 * slotu). Krok 0,05, widełki 0,5–1,5; suma > 12 porcji (dom > 8 osób na
 * dużych porcjach) = `null`, bo zapis by ją odrzucił — wtedy równy podział.
 */
function perUserItemFor(
  scope: Scope,
  slot: Slot,
  recipe: PlannerRecipe,
  others: readonly PlannedItem[],
  targetTypes: ReadonlySet<MealType>,
): PlannedItem | null {
  const kcalPerServing = recipe.perServing?.kcal ?? 0;
  const dayItems = [...scope.request.fixed, ...others].filter(
    (item) => item.dayOfWeek === slot.day,
  );
  const portions = scope.audience.map((eater) => {
    const assessment = assess(scope, eater, dayItems, targetTypes);
    const residual = assessment.target.kcal - assessment.evaluated.kcal;
    return {
      userId: eater.userId,
      servings: portionFor(residual, kcalPerServing),
    };
  });
  const total = portions.reduce((sum, portion) => sum + portion.servings, 0);
  if (portions.length === 0 || total > 12) return null;
  return {
    ...itemForSlot(
      scope,
      slot,
      recipe.id,
      Math.min(12, Math.ceil(total - 1e-9)),
    ),
    portions,
  };
}

// ── Propozycje na jeden slot (Etap 3) ─────────────────────────────────────

/** Z ilu najlepszych dań wybieramy zróżnicowane propozycje. */
export const SUGGESTION_POOL = 24;
/**
 * Kara różnorodności w PRZELICZENIU NA POZYCJE rankingu: każdy tag wspólny
 * z już wybranym daniem przesuwa kandydata o tyle miejsc w dół. Ranking,
 * a nie koszt, bo skala kosztu zależy od domu (cele, liczba osób) —
 * pozycja nie.
 */
export const SUGGESTION_DIVERSITY_PENALTY = 4;

export type SlotSuggestion = {
  item: PlannedItem;
  /** Kcal tego dania na osobę audytorium (z porcją osoby, gdy są porcje). */
  perPerson: { userId: string; kcal: number }[];
};

export type SlotSuggestions = {
  status: PlanStatus;
  suggestions: SlotSuggestion[];
  /** Ile dań przeszło filtry twarde. */
  eligible: number;
  candidates: CandidateStats;
  /**
   * Życzenia miękkie, których nie dało się utrzymać jako warunek (za mało
   * dań) — wtedy dalej ważą w rankingu, ale nie zawężają listy.
   */
  relaxed: ('max_prep_minutes' | 'prefer_tags')[];
  /** Ile kcal zostaje osobie na ten slot przy reszcie dnia (bez tego slotu). */
  slotBudget: { userId: string; kcal: number }[];
};

/**
 * Kilka ZRÓŻNICOWANYCH dań na jeden slot (dzień + pora) — serwerowa odpowiedź
 * na „co na kolację?" (`suggest_meals`). Te same filtry twarde i ta sama
 * funkcja kosztu dnia, co planer (alergeny, diety, wykluczenia, życzenia
 * prośby, bilans osoby przy reszcie dnia, powtórki w tygodniu), plus:
 *
 * - życzenie miękkie („szybko" = `maxPrepMinutes`, `preferredTags`) zawęża
 *   listę, gdy zostaje co najmniej `count` dań — użytkownik prosił o szybkie,
 *   więc nie dostaje wolnego „bo lepiej trafia w kalorie";
 * - wybór zachłanny z karą za tagi wspólne z już wybranymi (inne białko,
 *   inny rodzaj dania) — trzy warianty tego samego to nie wybór.
 *
 * `request.days` i `request.mealTypes` — po jednym elemencie.
 */
export function suggestForSlot(
  request: PlanningRequest,
  recipes: readonly PlannerRecipe[],
  options: { count: number; allowedRecipeIds?: ReadonlySet<string> },
): SlotSuggestions {
  const scope = scopeOf(request, recipes);
  const slot: Slot = { day: request.days[0], meal: request.mealTypes[0] };
  const { stats, eligible } = candidatesFor(
    scope,
    slot.meal,
    options.allowedRecipeIds,
  );
  const count = Math.max(1, options.count);
  const relaxed: SlotSuggestions['relaxed'] = [];
  let pool = eligible;
  const { maxPrepMinutes, preferredTags } = request.preferences;
  if (maxPrepMinutes !== null) {
    const quick = pool.filter(
      (recipe) => recipe.prepTimeMinutes <= maxPrepMinutes,
    );
    if (quick.length >= count) pool = quick;
    else relaxed.push('max_prep_minutes');
  }
  if (preferredTags.length > 0) {
    const tagged = pool.filter((recipe) =>
      recipe.tags.some((tag) => preferredTags.includes(tag)),
    );
    if (tagged.length >= count) pool = tagged;
    else relaxed.push('prefer_tags');
  }

  const eaters = eaterCountOf(scope.participantIds, scope.members.length);
  const perUser = request.portionMode === 'per_user';
  const servings = allowedServings(
    eaters,
    request.portionMode === 'tune' ? 'tune' : 'auto',
  );
  const dayFixed = request.fixed.filter((item) => item.dayOfWeek === slot.day);
  const types = scope.plannedTypes;
  const costOf = (item: PlannedItem): number =>
    dayCost(scope, slot.day, [...dayFixed, item], types) +
    weekRelationCost([...request.fixed, item], scope.lookup) +
    softCostOf(scope, [item]);

  const ranked = pool
    .map((recipe) => {
      const options = perUser
        ? [
            perUserItemFor(scope, slot, recipe, [], types) ??
              itemForSlot(scope, slot, recipe.id, servings[0]),
          ]
        : servings.map((option) => itemForSlot(scope, slot, recipe.id, option));
      let best: { item: PlannedItem; cost: number } | null = null;
      for (const item of options) {
        const cost = costOf(item);
        if (!best || cost < best.cost - EPSILON) best = { item, cost };
      }
      return { recipe, ...(best as { item: PlannedItem; cost: number }) };
    })
    .sort((a, b) => a.cost - b.cost || a.recipe.id.localeCompare(b.recipe.id))
    .slice(0, SUGGESTION_POOL);

  // Tagi, o które PROSZONO, nie są „podobieństwem" — mają być wspólne.
  const wanted = new Set([
    ...preferredTags,
    ...request.constraints.requiredTags,
  ]);
  const picked: typeof ranked = [];
  const remaining = ranked.map((entry, rank) => ({ entry, rank }));
  while (picked.length < count && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Infinity;
    remaining.forEach(({ entry, rank }, index) => {
      const overlap = entry.recipe.tags.filter(
        (tag) =>
          !wanted.has(tag) &&
          picked.some((chosen) => chosen.recipe.tags.includes(tag)),
      ).length;
      const score = rank + SUGGESTION_DIVERSITY_PENALTY * overlap;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    picked.push(remaining.splice(bestIndex, 1)[0].entry);
  }

  const suggestions = picked.map(({ item }) => ({
    item,
    perPerson: scope.audience.map((eater) => ({
      userId: eater.userId,
      kcal: Math.round(
        eaterDayNutrition(
          [item],
          eater.userId,
          scope.members.length,
          scope.lookup,
        ).kcal,
      ),
    })),
  }));
  const slotBudget = scope.audience.map((eater) => {
    const assessment = assess(scope, eater, dayFixed, types);
    return {
      userId: eater.userId,
      kcal: Math.max(
        0,
        Math.round(assessment.target.kcal - assessment.evaluated.kcal),
      ),
    };
  });
  return {
    status:
      suggestions.length === 0
        ? 'UNSAT'
        : suggestions.length < count
          ? 'PARTIAL'
          : 'OK',
    suggestions,
    eligible: stats.eligible,
    candidates: stats,
    relaxed,
    slotBudget,
  };
}

// ── Silnik ─────────────────────────────────────────────────────────────────

export function planMeals(
  request: PlanningRequest,
  recipes: readonly PlannerRecipe[],
): PlanDraft {
  const startedAt = Date.now();
  const scope = scopeOf(request, recipes);
  const meals = orderedMealTypes(request.mealTypes);
  const days = orderedDays(request.days);
  const eaters = eaterCountOf(scope.participantIds, scope.members.length);
  const perUser = request.portionMode === 'per_user';
  const servingsOptions = allowedServings(
    eaters,
    request.portionMode === 'auto' ? 'auto' : 'tune',
  );

  const pools = new Map<MealType, PlannerRecipe[]>();
  const stats: CandidateStats[] = [];
  for (const meal of meals) {
    const { stats: mealStats, eligible } = candidatesFor(scope, meal);
    pools.set(meal, eligible);
    stats.push(mealStats);
  }

  const slots: Slot[] = days.flatMap((day) =>
    meals.map((meal) => ({ day, meal })),
  );
  const chosen = new Map<string, PlannedItem>();
  const planned = () => [...chosen.values()];
  const itemFor = (
    slot: Slot,
    recipeId: string,
    servings: number,
  ): PlannedItem => itemForSlot(scope, slot, recipeId, servings);

  /**
   * Porcje per osoba dla przepisu w slocie (Etap 2.2): każda osoba dostaje
   * porcję, która domyka JEJ cel pór `targetTypes` przy tym, co już jest
   * w dniu (bez tego slotu) — także przy „podobnie kalorycznie" (cel slotu
   * waży wtedy tylko w wyborze DANIA; wspólna porcja dla 1600 i 2600 kcal
   * rozjechałaby oba dni). Krok 0,05, widełki 0,5–1,5; suma > 12 porcji
   * (dom > 8 osób na dużych porcjach) wraca do równego podziału, bo zapis by
   * ją odrzucił.
   */
  const perUserItem = (
    slot: Slot,
    recipe: PlannerRecipe,
    others: readonly PlannedItem[],
    targetTypes: ReadonlySet<MealType>,
  ): PlannedItem | null =>
    perUserItemFor(scope, slot, recipe, others, targetTypes);

  /** Koszt planu zależny od slotu: jego dzień + relacje + miękkie. */
  const localCost = (
    slot: Slot,
    items: readonly PlannedItem[],
    targetTypes: ReadonlySet<MealType>,
  ): number => {
    const all = [...request.fixed, ...items];
    return (
      dayCost(
        scope,
        slot.day,
        all.filter((item) => item.dayOfWeek === slot.day),
        targetTypes,
      ) +
      weekRelationCost(all, scope.lookup) +
      softCostOf(scope, items)
    );
  };

  const bestFor = (
    slot: Slot,
    targetTypes: () => ReadonlySet<MealType>,
  ): { item: PlannedItem; cost: number } | null => {
    const key = slotKey(slot.day, slot.meal);
    let best: { item: PlannedItem; cost: number } | null = null;
    const types = targetTypes();
    const others = [...chosen.entries()]
      .filter(([otherKey]) => otherKey !== key)
      .map(([, item]) => item);
    for (const recipe of pools.get(slot.meal) ?? []) {
      const options = perUser
        ? [
            perUserItem(slot, recipe, others, types) ??
              itemFor(slot, recipe.id, servingsOptions[0]),
          ]
        : servingsOptions.map((servings) => itemFor(slot, recipe.id, servings));
      for (const item of options) {
        const trial = new Map(chosen);
        trial.set(key, item);
        const cost = localCost(slot, [...trial.values()], types);
        if (!best || cost < best.cost - EPSILON) best = { item, cost };
      }
    }
    return best;
  };

  // 2. Zachłannie — cel liczony dla planowanych pór JUŻ wypełnionych tego
  // dnia (i bieżącej). Pozycje stałe wchodzą przez budżet osoby, nie przez
  // listę pór — tylko te, które ona rzeczywiście je.
  for (const slot of slots) {
    const best = bestFor(
      slot,
      () =>
        new Set([
          ...planned()
            .filter((item) => item.dayOfWeek === slot.day)
            .map((item) => item.mealType),
          slot.meal,
        ]),
    );
    if (best) chosen.set(slotKey(slot.day, slot.meal), best.item);
  }

  // 3. Lokalna poprawa — pełne cele dni, koszt całego tygodnia.
  for (let pass = 0; pass < IMPROVEMENT_PASSES; pass += 1) {
    let improved = false;
    for (const slot of slots) {
      const key = slotKey(slot.day, slot.meal);
      const current = chosen.get(key);
      if (!current) continue;
      const types = () => scope.plannedTypes;
      const currentCost = localCost(slot, planned(), types());
      const best = bestFor(slot, types);
      if (best && best.cost < currentCost - EPSILON) {
        chosen.set(key, best.item);
        improved = true;
      }
    }
    if (!improved) break;
  }

  const items = slots
    .map((slot) => chosen.get(slotKey(slot.day, slot.meal)))
    .filter((item): item is PlannedItem => item !== undefined);

  const evaluation = evaluatePlan(request, recipes, items, {
    candidates: stats,
    slotsRequested: slots.length,
    durationMs: Date.now() - startedAt,
  });

  const issues: PlanIssue[] = [];
  for (const meal of meals) {
    const mealStats = stats.find((entry) => entry.mealType === meal);
    const pool = pools.get(meal) ?? [];
    if (pool.length === 0) {
      issues.push({
        code: 'NO_CANDIDATES',
        severity: 'error',
        mealType: meal,
        message: `Brak dania na tę porę, które spełnia ograniczenia jedzących i prośby (w puli ${mealStats?.total ?? 0}, odpadły: ${describeRemoved(mealStats?.removed ?? {})}).`,
      });
      continue;
    }
    const needed = days.length;
    if (mealStats && mealStats.eligible < needed) {
      issues.push({
        code: 'REPEAT_FORCED',
        severity: 'info',
        mealType: meal,
        message: `Tylko ${mealStats.eligible} dań spełnia ograniczenia na ${needed} dni — powtórki są nieuniknione.`,
      });
    }
  }
  issues.push(...evaluation.issues);

  return {
    status: statusOf(items.length, slots.length, issues),
    items,
    diagnostics: {
      issues,
      days: evaluation.days,
      candidates: stats,
      metrics: evaluation.metrics,
    },
  };
}

function describeRemoved(
  removed: Partial<Record<HardFilterReason, number>>,
): string {
  const entries = Object.entries(removed).filter(([, count]) => count);
  return entries.length > 0
    ? entries.map(([reason, count]) => `${reason}×${count}`).join(', ')
    : 'brak dań na tę porę';
}

function statusOf(
  filled: number,
  requested: number,
  issues: readonly PlanIssue[],
): PlanStatus {
  if (requested > 0 && filled === 0) return 'UNSAT';
  if (filled < requested) return 'PARTIAL';
  const missed = issues.some(
    (issue) =>
      issue.code === 'KCAL_OUT_OF_TOLERANCE' ||
      issue.code === 'PROTEIN_OUT_OF_TOLERANCE',
  );
  return missed ? 'PARTIAL' : 'OK';
}

// ── Ocena dowolnego planu ──────────────────────────────────────────────────

/**
 * Ocena planu NIEZALEŻNA od tego, kto go ułożył — planer albo model.
 * `items` = pozycje do oceny (planowane), `request.fixed` = reszta tygodnia.
 * Te same reguły co funkcja celu silnika; do tego ponowne sprawdzenie
 * filtrów twardych (`hardViolations` — dla planu z planera zawsze 0).
 */
export function evaluatePlan(
  request: PlanningRequest,
  recipes: readonly PlannerRecipe[],
  items: readonly PlannedItem[],
  extra: {
    candidates?: CandidateStats[];
    slotsRequested?: number;
    durationMs?: number;
  } = {},
): { days: DayDiagnostics[]; issues: PlanIssue[]; metrics: PlanMetrics } {
  const scope = scopeOf(request, recipes);
  const all = [...request.fixed, ...items];
  const issues: PlanIssue[] = [];
  const days: DayDiagnostics[] = [];
  const kcalDeviations: number[] = [];
  const dayDeviations: number[] = [];
  const macroDeviations = { protein: [], fat: [], carbs: [] } as Record<
    'protein' | 'fat' | 'carbs',
    number[]
  >;

  for (const day of orderedDays(request.days)) {
    const dayItems = all.filter((item) => item.dayOfWeek === day);
    const eaters = scope.audience.map((eater) => {
      const assessment = assess(scope, eater, dayItems, scope.plannedTypes);
      const planned = assessment.evaluated;
      const target = assessment.target;
      const kcalDeviation = (planned.kcal - target.kcal) / assessment.kcalBase;
      kcalDeviations.push(Math.abs(kcalDeviation));
      dayDeviations.push(
        Math.abs(assessment.day.kcal - assessment.goalKcal) /
          Math.max(1, assessment.goalKcal),
      );
      if (Math.abs(kcalDeviation) > KCAL_DAY_TOLERANCE) {
        const whole = request.scope === 'FULL_DAY';
        issues.push({
          code: 'KCAL_OUT_OF_TOLERANCE',
          severity: 'warning',
          dayOfWeek: day,
          userId: eater.userId,
          planned: Math.round(planned.kcal),
          target: Math.round(target.kcal),
          message: whole
            ? `${Math.round(assessment.day.kcal)} kcal w dniu wobec celu ${Math.round(assessment.goalKcal)} (${signedPct(kcalDeviation)}).`
            : `planowane pory: ${Math.round(planned.kcal)} kcal wobec ${Math.round(target.kcal)} z pozostałego celu dnia (${signedPct(kcalDeviation)}).`,
        });
      }
      for (const macro of ['protein', 'fat', 'carbs'] as const) {
        const macroTarget = target[macro];
        if (!macroTarget) continue;
        const deviation = (planned[macro] - macroTarget) / macroTarget;
        macroDeviations[macro].push(Math.abs(deviation));
        const tolerance =
          macro === 'protein' ? PROTEIN_DAY_TOLERANCE : FAT_CARBS_DAY_TOLERANCE;
        if (Math.abs(deviation) > tolerance) {
          issues.push({
            code:
              macro === 'protein'
                ? 'PROTEIN_OUT_OF_TOLERANCE'
                : 'MACRO_OUT_OF_TOLERANCE',
            severity: macro === 'protein' ? 'warning' : 'info',
            dayOfWeek: day,
            userId: eater.userId,
            planned: Math.round(planned[macro]),
            target: Math.round(macroTarget),
            message: `${macro}: ${Math.round(planned[macro])} g wobec ${Math.round(macroTarget)} g (${signedPct(deviation)}).`,
          });
        }
      }
      return {
        userId: eater.userId,
        kcal: Math.round(planned.kcal),
        kcalTarget: Math.round(target.kcal),
        kcalDeviation: round3(kcalDeviation),
        dayKcal: Math.round(assessment.day.kcal),
        kcalGoal: Math.round(assessment.goalKcal),
        protein: Math.round(planned.protein),
        proteinTarget: roundOrNull(target.protein),
        fat: Math.round(planned.fat),
        fatTarget: roundOrNull(target.fat),
        carbs: Math.round(planned.carbs),
        carbsTarget: roundOrNull(target.carbs),
      };
    });
    days.push({ dayOfWeek: day, scope: request.scope, eaters });
  }

  let hardViolations = 0;
  let softUnmet = 0;
  for (const item of items) {
    const recipe = scope.lookup.get(item.recipeId);
    const audience = audienceOf(item.participantIds, scope.members);
    const reason = recipe
      ? hardFilterReason(recipe, item.mealType, audience, request)
      : 'INACTIVE';
    if (reason && reason !== 'NO_NUTRITION') hardViolations += 1;
    if (!recipe) continue;
    const { maxPrepMinutes, preferredTags } = request.preferences;
    if (maxPrepMinutes !== null && recipe.prepTimeMinutes > maxPrepMinutes) {
      softUnmet += 1;
      issues.push({
        code: 'PREP_TIME_EXCEEDED',
        severity: 'info',
        dayOfWeek: item.dayOfWeek,
        mealType: item.mealType,
        message: `${recipe.title}: ${recipe.prepTimeMinutes} min (podpowiedź: ${maxPrepMinutes}).`,
      });
    }
    if (
      preferredTags.length > 0 &&
      !recipe.tags.some((tag) => preferredTags.includes(tag))
    ) {
      softUnmet += 1;
      issues.push({
        code: 'PREFERENCE_UNMET',
        severity: 'info',
        dayOfWeek: item.dayOfWeek,
        mealType: item.mealType,
        message: `${recipe.title}: bez żadnego z tagów ${preferredTags.join(', ')}.`,
      });
    }
  }

  const uses = new Map<string, number>();
  for (const item of all) {
    uses.set(item.recipeId, (uses.get(item.recipeId) ?? 0) + 1);
  }
  let repeats = 0;
  for (const count of uses.values()) repeats += Math.max(0, count - 1);

  const requestedSlots = new Set(
    orderedDays(request.days).flatMap((day) =>
      request.mealTypes.map((meal) => slotKey(day, meal)),
    ),
  );
  const filled = new Set(
    items
      .map((item) => slotKey(item.dayOfWeek, item.mealType))
      .filter((key) => requestedSlots.has(key)),
  );

  return {
    days,
    issues,
    metrics: {
      kcalDeviationPct: pct(mean(kcalDeviations)),
      maxKcalDeviationPct: pct(Math.max(0, ...kcalDeviations)),
      dayKcalDeviationPct: pct(mean(dayDeviations)),
      maxDayKcalDeviationPct: pct(Math.max(0, ...dayDeviations)),
      proteinDeviationPct: meanPctOrNull(macroDeviations.protein),
      fatDeviationPct: meanPctOrNull(macroDeviations.fat),
      carbsDeviationPct: meanPctOrNull(macroDeviations.carbs),
      hardViolations,
      repeats,
      softUnmet,
      objective: round3(objectiveOf(scope, items)),
      slotsRequested: extra.slotsRequested ?? requestedSlots.size,
      slotsFilled: filled.size,
      candidatesConsidered: (extra.candidates ?? []).reduce(
        (sum, entry) => sum + entry.eligible,
        0,
      ),
      durationMs: extra.durationMs ?? 0,
    },
  };
}

const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
const pct = (fraction: number): number => Math.round(fraction * 1000) / 10;
const meanPctOrNull = (values: readonly number[]): number | null =>
  values.length === 0 ? null : pct(mean(values));
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const roundOrNull = (value: number | null): number | null =>
  value === null ? null : Math.round(value);
const signedPct = (fraction: number): string =>
  `${fraction >= 0 ? '+' : '−'}${Math.round(Math.abs(fraction) * 100)} %`;
