import { DietPreferenceValue, MealType } from '@prisma/client';
import {
  conflictingAllergens,
  satisfiesDiet,
} from '../recipes/diet-rules.util';
import {
  checkRecipe,
  ConstraintReason,
  ConstraintSetV1,
} from '../recipes/constraints/recipe-constraints';
import {
  AVOIDED,
  DIETS,
  MEALS,
  prng,
  randomMembers,
  randomRecipe,
  Rng,
  TAGS,
} from '../recipes/constraints/constraint-fixtures.spec-helper';
import { hardFilterReason } from './meal-plan-scoring';
import {
  HardFilterReason,
  PlannerEater,
  PlannerRecipe,
  PlanningRequest,
} from './meal-planner.types';

/**
 * RÓWNOWAŻNOŚĆ planera (silnik A) z `checkRecipe` (N8A S1).
 *
 * Wyrocznią jest ZAMROŻONA kopia `hardFilterReason` z `develop` 3b71b2e
 * (27.09.2026) — nie bieżąca funkcja. Dzięki temu test zostaje ostry także
 * po przepięciu planera na `checkRecipe` (S2): gdyby oba silniki zmieniły
 * się razem, porównanie z bieżącym kodem byłoby tautologią. Świadoma zmiana
 * semantyki = zmiana wyroczni w tym samym PR, z opisem dlaczego.
 */
function legacyHardFilterReason(
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
  const maxPrep = request.constraints.maxPrepMinutes;
  if (typeof maxPrep === 'number' && recipe.prepTimeMinutes > maxPrep) {
    return 'PREP_TIME';
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
  if (!recipe.perServing) return 'NO_NUTRITION';
  return null;
}

/** Mapowanie wejścia planera na zbiór ograniczeń — kandydat na adapter S2. */
function plannerSet(
  mealType: MealType,
  audience: readonly PlannerEater[],
  request: Pick<PlanningRequest, 'constraints'>,
): ConstraintSetV1 {
  const { constraints } = request;
  return {
    v: 1,
    audience: {
      allergens: [...new Set(audience.flatMap((e) => e.allergens))],
      excludedIngredientIds: [
        ...new Set(audience.flatMap((e) => e.excludedIngredientIds)),
      ],
      diets: [...new Set(audience.map((e) => e.diet))],
    },
    request: {
      mealType,
      excludeRecipeIds: constraints.excludeRecipeIds,
      maxPrepMinutes:
        typeof constraints.maxPrepMinutes === 'number'
          ? constraints.maxPrepMinutes
          : null,
      requestDiet: constraints.diet ?? null,
      requiredTags: constraints.requiredTags,
      avoidIngredients: constraints.avoidIngredients,
      requireNutrition: true,
    },
  };
}

type Case = {
  recipe: PlannerRecipe;
  mealType: MealType;
  audience: PlannerEater[];
  request: Pick<PlanningRequest, 'constraints'>;
};

function randomCase(r: Rng, i: number): Case {
  const base = randomRecipe(r, `r${i}`);
  const recipe: PlannerRecipe = {
    ...base,
    title: `Danie ${i}`,
    servings: r.int(1, 8),
    sharedIngredientIds: base.ingredientIds,
  };
  const audience: PlannerEater[] = randomMembers(r).map((member) => ({
    ...member,
    kcalTarget: 2000,
    macros: null,
  }));
  const diet: DietPreferenceValue | null = r.chance(0.6) ? null : r.pick(DIETS);
  return {
    recipe,
    // Zwykle pora, do której przepis się nadaje — inaczej 60 % przypadków
    // kończy się na MEAL_TYPE i dalsze gałęzie są rzadko odwiedzane.
    mealType:
      recipe.slots.length > 0 && r.chance(0.8)
        ? r.pick(recipe.slots)
        : r.pick(MEALS),
    audience,
    request: {
      constraints: {
        diet,
        requiredTags: r.chance(0.7) ? [] : r.subset(TAGS, 2),
        avoidIngredients: r.chance(0.7) ? [] : r.subset(AVOIDED, 2),
        excludeRecipeIds: r.chance(0.1)
          ? [recipe.id, 'inny']
          : r.chance(0.2)
            ? ['inny']
            : [],
        maxPrepMinutes: r.pick([undefined, null, 0, 5, 10, 30, 60]),
      },
    },
  };
}

const CASES = Number(process.env.CONSTRAINT_EQUIVALENCE_CASES ?? 20_000);

describe(`silnik ograniczeń ≡ planer (N8A S1) na ${CASES} losowych przypadkach`, () => {
  it('checkRecipe daje ten sam pierwszy powód co zamrożony hardFilterReason — i co bieżący', () => {
    const r = prng(20260927);
    const seen = new Map<ConstraintReason | 'OK', number>();
    const diffs: string[] = [];
    for (let i = 0; i < CASES; i += 1) {
      const c = randomCase(r, i);
      const expected = legacyHardFilterReason(
        c.recipe,
        c.mealType,
        c.audience,
        c.request,
      );
      const viaSet = checkRecipe(
        c.recipe,
        plannerSet(c.mealType, c.audience, c.request),
      );
      const current = hardFilterReason(
        c.recipe,
        c.mealType,
        c.audience,
        c.request,
      );
      if (viaSet !== expected || current !== expected) {
        diffs.push(
          `#${i}: wyrocznia=${expected} checkRecipe=${viaSet} planer=${current}`,
        );
      }
      seen.set(expected ?? 'OK', (seen.get(expected ?? 'OK') ?? 0) + 1);
    }
    expect(diffs.slice(0, 10)).toEqual([]);

    // Generator musi dochodzić do KAŻDEGO powodu — inaczej „0 różnic” nic
    // nie znaczy dla gałęzi, do której nie dotarł.
    const reasons: (ConstraintReason | 'OK')[] = [
      'OK',
      'INACTIVE',
      'MEAL_TYPE',
      'EXCLUDED_RECIPE',
      'PREP_TIME',
      'ALLERGEN',
      'EXCLUDED_INGREDIENT',
      'DIET',
      'REQUEST_DIET',
      'REQUIRED_TAG',
      'AVOIDED_INGREDIENT',
      'NO_NUTRITION',
    ];
    const minimum = Math.max(1, Math.floor(CASES / 2000));
    const rare = reasons
      .map((reason) => ({ reason, count: seen.get(reason) ?? 0 }))
      .filter((entry) => entry.count < minimum);
    expect(rare).toEqual([]);
  });
});
