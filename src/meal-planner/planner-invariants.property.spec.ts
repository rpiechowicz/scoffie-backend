import { DayOfWeek, DietPreferenceValue, MealType } from '@prisma/client';
import { ALLERGEN_IDS } from '../common/allergens';
import { satisfiesDiet } from '../recipes/diet-rules.util';
import { evaluatePlan, planMeals, suggestForSlot } from './meal-plan-engine';
import {
  PLANNER_PORTION_MAX,
  PLANNER_PORTION_MIN,
  PLANNER_PORTION_STEP,
  normalizeParticipants,
} from './meal-plan-scoring';
import {
  PlanDraft,
  PlannedItem,
  PlannerEater,
  PlannerRecipe,
  PlanningRequest,
} from './meal-planner.types';
import { macrosFor } from './planner-fixtures.spec-helper';

/**
 * Niezmienniki planera na losowych, ale DETERMINISTYCZNYCH danych
 * (noc 26/27.09, N4). Każdy przypadek bierze się z ziarna — błąd podaje
 * ziarno, więc da się go odtworzyć jednym wywołaniem `scenario(seed)`.
 *
 * Sprawdzenia twarde są liczone NIEZALEŻNIE od `hardFilterReason`
 * (przecięcie alergenów, wykluczenia, limity) — test nie może być
 * tautologią silnika. Dieta idzie przez `satisfiesDiet`, bo to kontrakt
 * parytetu z iOS, a nie szczegół planera.
 */

const CASES = Number(process.env.PLANNER_PROPERTY_CASES ?? 400);

// ── Generator ──────────────────────────────────────────────────────────────

function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) =>
    lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  const chance = (p: number) => next() < p;
  const subset = <T>(items: readonly T[], max: number): T[] => {
    const count = int(0, Math.min(max, items.length));
    const pool = [...items];
    const out: T[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(pool.splice(int(0, pool.length - 1), 1)[0]);
    }
    return out;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return { next, int, pick, chance, subset, shuffle };
}

const ALL_DAYS: DayOfWeek[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const ALL_MEALS: MealType[] = [
  'BREAKFAST',
  'SECOND_BREAKFAST',
  'LUNCH',
  'AFTERNOON_SNACK',
  'DINNER',
  'SNACK',
];
const DIETS: DietPreferenceValue[] = [
  'NONE',
  'NONE',
  'NONE',
  'VEGETARIAN',
  'VEGAN',
  'PESCATARIAN',
  'KETO',
  'PALEO',
  'HIGH_PROTEIN',
];
const DIET_TAGS = [
  'MEAT',
  'FISH',
  'DAIRY',
  'EGG',
  'CRUSTACEAN',
  'ANIMAL_OTHER',
];
const TAGS = ['soup', 'poultry', 'quick', 'pasta', 'fish', 'meatless', 'bake'];
const ALLERGENS = [...ALLERGEN_IDS];

type Scenario = {
  seed: number;
  recipes: PlannerRecipe[];
  request: PlanningRequest;
};

function scenario(seed: number): Scenario {
  const r = prng(seed);
  const recipes: PlannerRecipe[] = [];
  const recipeCount = r.int(20, 120);
  for (let i = 0; i < recipeCount; i += 1) {
    const id = `r${seed}-${i}`;
    const kcal = r.int(80, 950);
    const ingredients = r.subset(
      Array.from({ length: 40 }, (_, k) => `ing-${k}`),
      6,
    );
    const slots = r.subset(ALL_MEALS, 3);
    if (slots.length === 0) slots.push(r.pick(ALL_MEALS));
    recipes.push({
      id,
      title: `Danie ${i}`,
      slots,
      servings: r.int(1, 8),
      prepTimeMinutes: r.int(3, 90),
      perServing: r.chance(0.03) ? null : macrosFor(kcal),
      allergens: r.chance(0.5) ? r.subset(ALLERGENS, 2) : [],
      dietTags: r.subset(DIET_TAGS, 2),
      ingredientIds: ingredients,
      ingredientNames: ingredients.map((id) => `skladnik ${id}`),
      sharedIngredientIds: ingredients.slice(0, 2),
      tags: r.subset(TAGS, 3),
      active: !r.chance(0.05),
    });
  }

  const memberCount = r.int(1, 4);
  const members: PlannerEater[] = Array.from(
    { length: memberCount },
    (_, k) => {
      const kcalTarget = r.int(1400, 3200);
      const macros = macrosFor(kcalTarget);
      return {
        userId: `u${k}`,
        allergens: r.chance(0.5) ? r.subset(ALLERGENS, 2) : [],
        excludedIngredientIds: r.chance(0.3)
          ? r.subset(
              Array.from({ length: 40 }, (_, n) => `ing-${n}`),
              2,
            )
          : [],
        diet: r.pick(DIETS),
        kcalTarget,
        macros: r.chance(0.1)
          ? null
          : {
              proteinG: macros.protein,
              fatG: macros.fat,
              carbsG: macros.carbs,
            },
      };
    },
  );

  const days = r.subset(ALL_DAYS, 7);
  if (days.length === 0) days.push(r.pick(ALL_DAYS));
  const dayMealTypes = r.subset(ALL_MEALS, 5);
  if (dayMealTypes.length === 0) dayMealTypes.push('DINNER');
  const mealTypes = r.subset(dayMealTypes, dayMealTypes.length);
  if (mealTypes.length === 0) mealTypes.push(dayMealTypes[0]);

  const participantIds = r.chance(0.5)
    ? []
    : r.subset(
        members.map((m) => m.userId),
        members.length,
      );

  // Reszta tygodnia (poza planowanymi slotami) — dowolne dania i odbiorcy.
  const fixed: PlannedItem[] = [];
  const fixedCount = r.int(0, 6);
  for (let i = 0; i < fixedCount; i += 1) {
    const day = r.pick(ALL_DAYS);
    const meal = r.pick(ALL_MEALS);
    if (days.includes(day) && mealTypes.includes(meal)) continue;
    const who = r.chance(0.5)
      ? []
      : r.subset(
          members.map((m) => m.userId),
          members.length,
        );
    fixed.push({
      dayOfWeek: day,
      mealType: meal,
      recipeId: r.pick(recipes).id,
      participantIds: who,
      plannedServings: Math.max(1, who.length || members.length),
    });
  }

  const request: PlanningRequest = {
    days,
    mealTypes,
    scope: r.chance(0.5) ? 'FULL_DAY' : 'PARTIAL',
    dayMealTypes,
    members,
    participantIds,
    fixed,
    constraints: {
      diet: r.chance(0.2) ? r.pick(DIETS) : null,
      requiredTags: r.chance(0.15) ? [r.pick(TAGS)] : [],
      avoidIngredients: r.chance(0.2) ? [`skladnik ing-${r.int(0, 39)}`] : [],
      excludeRecipeIds: r.chance(0.3)
        ? r.subset(
            recipes.map((x) => x.id),
            3,
          )
        : [],
      maxPrepMinutes: r.chance(0.25) ? r.int(10, 60) : null,
    },
    preferences: {
      preferredTags: r.chance(0.3) ? [r.pick(TAGS)] : [],
      maxPrepMinutes: r.chance(0.3) ? r.int(10, 60) : null,
      favoriteRecipeIds: r.subset(
        recipes.map((x) => x.id),
        3,
      ),
      recentRecipeIds: r.subset(
        recipes.map((x) => x.id),
        3,
      ),
      popularity: {},
    },
    portionMode: r.pick(['auto', 'tune', 'per_user'] as const),
    seed: `s${seed}`,
  };
  return { seed, recipes, request };
}

// ── Niezależne sprawdzenia ────────────────────────────────────────────────

function audienceOfItem(
  item: PlannedItem,
  members: readonly PlannerEater[],
): PlannerEater[] {
  return item.participantIds.length === 0
    ? [...members]
    : members.filter((m) => item.participantIds.includes(m.userId));
}

/** Lista złamań twardych reguł dla jednej pozycji (pusta = OK). */
function hardProblems(
  item: PlannedItem,
  request: PlanningRequest,
  recipes: ReadonlyMap<string, PlannerRecipe>,
): string[] {
  const problems: string[] = [];
  const recipe = recipes.get(item.recipeId);
  if (!recipe) return [`nieznany przepis ${item.recipeId}`];
  if (!recipe.active) problems.push('nieaktywny');
  if (!recipe.slots.includes(item.mealType)) problems.push('zła pora');
  if (!recipe.perServing) problems.push('bez makr');
  const { constraints } = request;
  if (constraints.excludeRecipeIds.includes(recipe.id)) {
    problems.push('przepis wykluczony');
  }
  if (
    typeof constraints.maxPrepMinutes === 'number' &&
    recipe.prepTimeMinutes > constraints.maxPrepMinutes
  ) {
    problems.push(
      `czas ${recipe.prepTimeMinutes} > ${constraints.maxPrepMinutes}`,
    );
  }
  const audience = audienceOfItem(item, request.members);
  for (const eater of audience) {
    const hit = recipe.allergens.filter((a) => eater.allergens.includes(a));
    if (hit.length)
      problems.push(`alergen ${hit.join(',')} dla ${eater.userId}`);
    if (
      recipe.ingredientIds.some((id) =>
        eater.excludedIngredientIds.includes(id),
      )
    ) {
      problems.push(`wykluczony składnik dla ${eater.userId}`);
    }
    const subject = {
      dietTags: recipe.dietTags,
      hasIngredientData: recipe.ingredientIds.length > 0,
      perServing: recipe.perServing,
    };
    if (!satisfiesDiet(eater.diet, subject)) {
      problems.push(`dieta ${eater.diet} dla ${eater.userId}`);
    }
  }
  if (
    constraints.diet &&
    !satisfiesDiet(constraints.diet, {
      dietTags: recipe.dietTags,
      hasIngredientData: recipe.ingredientIds.length > 0,
      perServing: recipe.perServing,
    })
  ) {
    problems.push(`dieta prośby ${constraints.diet}`);
  }
  for (const tag of constraints.requiredTags) {
    if (!recipe.tags.includes(tag)) problems.push(`brak tagu ${tag}`);
  }
  for (const avoided of constraints.avoidIngredients) {
    if (recipe.ingredientNames.some((name) => name.includes(avoided))) {
      problems.push(`składnik „${avoided}”`);
    }
  }
  return problems;
}

function portionProblems(
  item: PlannedItem,
  request: PlanningRequest,
): string[] {
  const problems: string[] = [];
  if (
    !Number.isInteger(item.plannedServings) ||
    item.plannedServings < 1 ||
    item.plannedServings > 12
  ) {
    problems.push(`plannedServings ${item.plannedServings}`);
  }
  if (request.portionMode !== 'per_user') {
    if (item.portions !== undefined) problems.push('porcje bez per_user');
    return problems;
  }
  if (!item.portions) return problems; // równy podział — dozwolony fallback
  const audience = audienceOfItem(item, request.members).map((e) => e.userId);
  const users = item.portions.map((p) => p.userId).sort();
  if (JSON.stringify(users) !== JSON.stringify([...audience].sort())) {
    problems.push(
      `porcje dla ${users.join(',')} ≠ audytorium ${audience.join(',')}`,
    );
  }
  let total = 0;
  for (const portion of item.portions) {
    total += portion.servings;
    // Krok planera (0,5 od 27.09) — połówka, jedna, półtorej; nie 0,8.
    const steps = portion.servings / PLANNER_PORTION_STEP;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      problems.push(
        `porcja ${portion.servings} nie co ${PLANNER_PORTION_STEP}`,
      );
    }
    if (
      portion.servings < PLANNER_PORTION_MIN - 1e-9 ||
      portion.servings > PLANNER_PORTION_MAX + 1e-9
    ) {
      problems.push(`porcja ${portion.servings} poza widełkami`);
    }
  }
  if (item.plannedServings !== Math.min(12, Math.ceil(total - 1e-9))) {
    problems.push(`plannedServings ${item.plannedServings} ≠ ceil(Σ ${total})`);
  }
  return problems;
}

/** Wszystkie niezmienniki szkicu planu; pusta lista = OK. */
function planProblems(s: Scenario, draft: PlanDraft): string[] {
  const { request } = s;
  const lookup = new Map(s.recipes.map((x) => [x.id, x]));
  const problems: string[] = [];
  const requested = new Set(
    request.days.flatMap((d) => request.mealTypes.map((m) => `${d}|${m}`)),
  );
  const seen = new Set<string>();
  const expectedParticipants = normalizeParticipants(
    request.participantIds,
    request.members,
  );
  for (const item of draft.items) {
    const key = `${item.dayOfWeek}|${item.mealType}`;
    if (!requested.has(key)) problems.push(`slot spoza prośby ${key}`);
    if (seen.has(key)) problems.push(`dwa dania w ${key}`);
    seen.add(key);
    if (
      JSON.stringify([...item.participantIds].sort()) !==
      JSON.stringify([...expectedParticipants].sort())
    ) {
      problems.push(`uczestnicy ${item.participantIds.join(',')} w ${key}`);
    }
    for (const p of hardProblems(item, request, lookup))
      problems.push(`${key}: ${p}`);
    for (const p of portionProblems(item, request))
      problems.push(`${key}: ${p}`);
  }
  const filled = draft.items.length;
  if (draft.status === 'OK') {
    if (filled !== requested.size) problems.push('OK przy niepełnym planie');
    if (draft.diagnostics.issues.some((i) => i.severity === 'error')) {
      problems.push('OK z błędem w diagnostyce');
    }
  }
  if (draft.status === 'UNSAT' && filled > 0)
    problems.push('UNSAT z pozycjami');
  if (filled < requested.size && draft.status === 'OK') {
    problems.push('brakujące sloty przy OK');
  }
  if (draft.diagnostics.metrics.hardViolations !== 0) {
    problems.push(`hardViolations ${draft.diagnostics.metrics.hardViolations}`);
  }
  const reevaluated = evaluatePlan(request, s.recipes, draft.items);
  if (reevaluated.metrics.hardViolations !== 0) {
    problems.push(
      `evaluatePlan: hardViolations ${reevaluated.metrics.hardViolations}`,
    );
  }
  return problems;
}

const strip = (draft: PlanDraft) =>
  JSON.stringify({
    ...draft,
    diagnostics: {
      ...draft.diagnostics,
      metrics: { ...draft.diagnostics.metrics, durationMs: 0 },
    },
  });

const slotsOf = (draft: PlanDraft) =>
  draft.items
    .map(
      (i) => `${i.dayOfWeek}|${i.mealType}|${i.recipeId}|${i.plannedServings}`,
    )
    .sort()
    .join(';');

// ── Testy ──────────────────────────────────────────────────────────────────

describe(`planer — niezmienniki na ${CASES} losowych przypadkach (N4)`, () => {
  const seeds = Array.from({ length: CASES }, (_, i) => 1000 + i);

  it('twarde reguły, sloty, uczestnicy, porcje, status i hardViolations', () => {
    const failures: string[] = [];
    const statuses: Record<string, number> = {};
    for (const seed of seeds) {
      const s = scenario(seed);
      const draft = planMeals(s.request, s.recipes);
      statuses[draft.status] = (statuses[draft.status] ?? 0) + 1;
      const problems = planProblems(s, draft);
      if (problems.length)
        failures.push(`seed ${seed}: ${problems.slice(0, 3).join(' | ')}`);
    }
    // Generator musi dawać wszystkie trzy stany — inaczej test niczego nie mówi.
    expect(Object.keys(statuses).sort()).toEqual(['OK', 'PARTIAL', 'UNSAT']);
    expect(failures).toEqual([]);
  });

  it('ten sam seed i te same dane → ten sam plan (co do bajta, poza czasem)', () => {
    const failures: number[] = [];
    for (const seed of seeds.slice(0, 150)) {
      const s = scenario(seed);
      const a = planMeals(s.request, s.recipes);
      const b = planMeals(s.request, s.recipes);
      if (strip(a) !== strip(b)) failures.push(seed);
    }
    expect(failures).toEqual([]);
  });

  it('kolejność wejścia (katalog, dni, pory, domownicy) nie zmienia planu', () => {
    const failures: number[] = [];
    for (const seed of seeds.slice(0, 200)) {
      const s = scenario(seed);
      const r = prng(seed * 7 + 1);
      const shuffled: PlanningRequest = {
        ...s.request,
        days: r.shuffle(s.request.days),
        mealTypes: r.shuffle(s.request.mealTypes),
        members: r.shuffle(s.request.members),
      };
      const a = planMeals(s.request, s.recipes);
      const b = planMeals(shuffled, r.shuffle(s.recipes));
      if (slotsOf(a) !== slotsOf(b) || a.status !== b.status)
        failures.push(seed);
    }
    expect(failures).toEqual([]);
  });

  it('twardsze ograniczenie nie powiększa puli kandydatów żadnej pory', () => {
    const failures: string[] = [];
    for (const seed of seeds.slice(0, 200)) {
      const s = scenario(seed);
      const r = prng(seed * 13 + 5);
      const base = planMeals(s.request, s.recipes);
      const tighter: PlanningRequest[] = [
        {
          ...s.request,
          members: s.request.members.map((m, i) =>
            i === 0
              ? { ...m, allergens: [...m.allergens, r.pick(ALLERGENS)] }
              : m,
          ),
        },
        {
          ...s.request,
          constraints: {
            ...s.request.constraints,
            maxPrepMinutes: Math.min(
              s.request.constraints.maxPrepMinutes ?? 90,
              r.int(5, 40),
            ),
          },
        },
        {
          ...s.request,
          constraints: {
            ...s.request.constraints,
            excludeRecipeIds: [
              ...s.request.constraints.excludeRecipeIds,
              ...base.items.map((i) => i.recipeId),
            ],
          },
        },
      ];
      tighter.forEach((request, variant) => {
        const draft = planMeals(request, s.recipes);
        for (const stats of draft.diagnostics.candidates) {
          const before = base.diagnostics.candidates.find(
            (c) => c.mealType === stats.mealType,
          );
          if (before && stats.eligible > before.eligible) {
            failures.push(
              `seed ${seed} v${variant} ${stats.mealType}: ${before.eligible} → ${stats.eligible}`,
            );
          }
        }
        // Wariant 2: wykluczone dania nie wracają.
        if (variant === 2) {
          const banned = new Set(request.constraints.excludeRecipeIds);
          for (const item of draft.items) {
            if (banned.has(item.recipeId))
              failures.push(`seed ${seed}: wrócił ${item.recipeId}`);
          }
        }
        for (const p of planProblems({ ...s, request }, draft)) {
          failures.push(`seed ${seed} v${variant}: ${p}`);
        }
      });
    }
    expect(failures).toEqual([]);
  });

  it('PARTIAL: pozycje INNYCH osób poza planowanymi porami nie zmieniają celu pytającego', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const seed of seeds) {
      const s = scenario(seed);
      if (s.request.members.length < 2) continue;
      const asker = s.request.members[0].userId;
      const other = s.request.members[1].userId;
      const request: PlanningRequest = {
        ...s.request,
        scope: 'PARTIAL',
        participantIds: [asker],
        fixed: [],
      };
      const planned = new Set(request.mealTypes);
      const outside = (request.dayMealTypes ?? []).filter(
        (m) => !planned.has(m),
      );
      if (outside.length === 0) continue;
      const withOthers: PlanningRequest = {
        ...request,
        fixed: request.days.flatMap((day) =>
          outside.map((meal) => ({
            dayOfWeek: day,
            mealType: meal,
            recipeId: s.recipes.find((x) => x.perServing)!.id,
            participantIds: [other],
            plannedServings: 1,
          })),
        ),
      };
      const target = (draft: PlanDraft) =>
        draft.diagnostics.days
          .map((d) => {
            const e = d.eaters.find((x) => x.userId === asker);
            return `${d.dayOfWeek}:${e ? Math.round(e.kcalTarget) : '-'}`;
          })
          .join(',');
      const a = planMeals(request, s.recipes);
      const b = planMeals(withOthers, s.recipes);
      checked += 1;
      if (target(a) !== target(b))
        failures.push(`seed ${seed}: ${target(a)} ≠ ${target(b)}`);
    }
    expect(checked).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  });

  it('suggestForSlot: tylko dozwolone dania, bez duplikatów, najwyżej `count`', () => {
    const failures: string[] = [];
    for (const seed of seeds) {
      const s = scenario(seed);
      const request: PlanningRequest = {
        ...s.request,
        days: [s.request.days[0]],
        mealTypes: [s.request.mealTypes[0]],
      };
      const count = 1 + (seed % 5);
      const out = suggestForSlot(request, s.recipes, { count });
      const lookup = new Map(s.recipes.map((x) => [x.id, x]));
      const ids = out.suggestions.map((x) => x.item.recipeId);
      if (ids.length > count)
        failures.push(`seed ${seed}: ${ids.length} > ${count}`);
      if (new Set(ids).size !== ids.length)
        failures.push(`seed ${seed}: duplikat`);
      if (out.eligible === 0 && ids.length > 0)
        failures.push(`seed ${seed}: dania bez kandydatów`);
      for (const suggestion of out.suggestions) {
        const item = suggestion.item;
        if (
          item.dayOfWeek !== request.days[0] ||
          item.mealType !== request.mealTypes[0]
        ) {
          failures.push(
            `seed ${seed}: slot ${item.dayOfWeek}|${item.mealType}`,
          );
        }
        for (const p of hardProblems(item, request, lookup))
          failures.push(`seed ${seed}: ${p}`);
        for (const p of portionProblems(item, request))
          failures.push(`seed ${seed}: ${p}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
