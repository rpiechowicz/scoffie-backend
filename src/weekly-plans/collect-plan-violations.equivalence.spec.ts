import { DayOfWeek, MealType } from '@prisma/client';
import {
  effectiveSuitableMealTypes,
  MEAL_TYPES_IN_DAY_ORDER,
} from '../common/meal-types';
import {
  ALLERGENS,
  INGREDIENT_IDS,
  MEALS,
  prng,
  Rng,
} from '../recipes/constraints/constraint-fixtures.spec-helper';
import { ApplyWeekSlotDto } from './dto/apply-week-plan.dto';
import { portionsProblem } from './utils/plan-portions.util';
import { PlanViolation, WeeklyPlansService } from './weekly-plans.service';

/**
 * RÓWNOWAŻNOŚĆ walidatora zapisu planu (silnik B) po przepięciu alergenów
 * i wykluczeń na wspólny silnik (N8A S4).
 *
 * Wyrocznia = ZAMROŻONA kopia całego `collectPlanViolations` z `develop`
 * 3b71b2e (27.09.2026). Porównujemy PEŁNE listy naruszeń — kody, indeksy
 * i treść komunikatów co do znaku (kolejność alergenów w zdaniu czyta
 * użytkownik i model). Zmiana limitów albo komunikatów = zmiana wyroczni
 * w tym samym PR, z opisem.
 */

type PlannableRecipe = {
  id: string;
  mealType: MealType;
  suitableMealTypes: MealType[];
  allergens: string[];
  ingredientIds: string[];
};

const MAX_VARIANTS_PER_SLOT = 6;
const MAX_ITEMS_PER_MEAL_TYPE = 7 * 6;
const MAX_ITEMS_TOTAL = 7 * 6 * MEAL_TYPES_IN_DAY_ORDER.length;

function planSlotKey(slot: {
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
}): string {
  return `${slot.dayOfWeek}|${slot.mealType}|${slot.recipeId}`;
}

function legacyCollectPlanViolations(
  slots: ApplyWeekSlotDto[],
  recipes: Map<string, PlannableRecipe>,
  memberIds: Set<string>,
  allergensByMember: Map<string, string[]>,
  exclusionsByMember: Map<string, string[]> = new Map(),
): PlanViolation[] {
  const violations: PlanViolation[] = [];
  const seen = new Set<string>();
  const perSlot = new Map<string, number>();
  const perMealType = new Map<string, number>();

  slots.forEach((slot, index) => {
    const at = (code: PlanViolation['code'], message: string) =>
      violations.push({
        index,
        dayOfWeek: slot.dayOfWeek,
        mealType: slot.mealType,
        recipeId: slot.recipeId,
        code,
        message,
      });

    const key = planSlotKey(slot);
    if (seen.has(key)) {
      at('PLAN_SLOT_DUPLICATE', 'Ten przepis jest już w tym slocie.');
      return;
    }
    seen.add(key);

    const recipe = recipes.get(slot.recipeId);
    if (!recipe) {
      // Nieznany, wycofany albo należący do innego gospodarstwa — z punktu
      // widzenia wołającego to jedno i to samo: nie ma czego wstawić.
      at('RECIPE_NOT_FOUND', 'Nie znaleziono przepisu.');
      return;
    }
    if (!effectiveSuitableMealTypes(recipe).includes(slot.mealType)) {
      at(
        'RECIPE_NOT_SUITABLE_FOR_SLOT',
        'Ten przepis nie nadaje się do tego posiłku.',
      );
    }

    // Alergeny są TWARDE i sprawdza je SERWER, nie model.
    //
    // Do Fazy 1 pilnowała ich wyłącznie instrukcja w promptcie, a model
    // wnioskował o składzie z listy składników — która w digeście jest
    // przycięta do pięciu najcięższych. Na katalogu dev 15 z 65 przepisów
    // z laktozą nie pokazuje w niej nabiału, więc „dorsz z masłem" wygląda
    // na czysty. Audytorium liczymy tak samo jak wszędzie: puste
    // `participantIds` znaczy cały dom.
    const audience =
      (slot.participantIds ?? []).length > 0
        ? (slot.participantIds ?? [])
        : Array.from(memberIds);
    const conflicting = Array.from(
      new Set(
        audience.flatMap((memberId) =>
          (allergensByMember.get(memberId) ?? []).filter((allergen) =>
            recipe?.allergens.includes(allergen),
          ),
        ),
      ),
    );
    if (conflicting.length > 0) {
      at(
        'RECIPE_ALLERGEN_CONFLICT',
        `Danie zawiera alergeny domownika: ${conflicting.join(', ')}.`,
      );
    }

    // Wykluczenia są równie twarde co alergeny, ale to inna rzecz i inny
    // komunikat: alergen jest o zdrowiu, wykluczenie o gustach. Wspólny
    // kod dawałby zdanie „danie zawiera alergeny: pieczarka", które po
    // prostu nie jest prawdą — a użytkownik czyta te komunikaty.
    const excluded = new Set(
      audience.flatMap((memberId) => exclusionsByMember.get(memberId) ?? []),
    );
    if (excluded.size > 0) {
      const hit = recipe.ingredientIds.filter((id) => excluded.has(id));
      if (hit.length > 0) {
        at(
          'RECIPE_EXCLUDED_INGREDIENT',
          'Danie zawiera składnik, którego ktoś z jedzących nie je.',
        );
      }
    }

    const unknownParticipants = Array.from(
      new Set(slot.participantIds ?? []),
    ).filter((id) => !memberIds.has(id));
    if (unknownParticipants.length > 0) {
      at(
        'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
        `Nie należą do gospodarstwa: ${unknownParticipants.join(', ')}`,
      );
    }

    // Porcje per osoba (Etap 2.2): zbiór osób = audytorium, krok 0,05,
    // widełki i suma — inaczej bilans i lista zakupów rozjechałyby się
    // z tym, kto naprawdę je.
    if ((slot.portions ?? []).length > 0) {
      const problem = portionsProblem(slot.portions ?? [], new Set(audience));
      if (problem) at('PLAN_PORTIONS_INVALID', problem);
    }

    const slotKey = `${slot.dayOfWeek}|${slot.mealType}`;
    const inSlot = (perSlot.get(slotKey) ?? 0) + 1;
    perSlot.set(slotKey, inSlot);
    if (inSlot > MAX_VARIANTS_PER_SLOT) {
      at(
        'PLAN_SLOT_VARIANT_LIMIT_REACHED',
        `Za dużo dań w jednym posiłku (maks. ${MAX_VARIANTS_PER_SLOT}).`,
      );
    }

    const inMealType = (perMealType.get(slot.mealType) ?? 0) + 1;
    perMealType.set(slot.mealType, inMealType);
    if (inMealType > MAX_ITEMS_PER_MEAL_TYPE) {
      at(
        'PLAN_SLOT_LIMIT_REACHED',
        `Za dużo dań w tym posiłku w tygodniu (maks. ${MAX_ITEMS_PER_MEAL_TYPE}).`,
      );
    }

    if (index + 1 > MAX_ITEMS_TOTAL) {
      at(
        'PLAN_TOTAL_LIMIT_REACHED',
        `Za dużo pozycji w tygodniu (maks. ${MAX_ITEMS_TOTAL}).`,
      );
    }
  });

  return violations;
}

type Collect = (
  slots: ApplyWeekSlotDto[],
  recipes: Map<string, PlannableRecipe>,
  memberIds: Set<string>,
  allergensByMember: Map<string, string[]>,
  exclusionsByMember?: Map<string, string[]>,
) => PlanViolation[];

/** Bieżąca metoda serwisu — nie używa `this`, więc da się ją zawołać bez DI. */
const currentCollect = (
  WeeklyPlansService.prototype as unknown as { collectPlanViolations: Collect }
).collectPlanViolations;

const DAYS: DayOfWeek[] = ['MON', 'TUE', 'WED'];

function randomWeek(r: Rng) {
  const members = Array.from({ length: r.int(1, 4) }, (_, i) => `u${i + 1}`);
  const allergensByMember = new Map(
    members.map((id) => [id, r.chance(0.5) ? [] : r.subset(ALLERGENS, 3)]),
  );
  const exclusionsByMember = new Map(
    members.map((id) => [id, r.chance(0.6) ? [] : r.subset(INGREDIENT_IDS, 3)]),
  );
  const recipes = new Map<string, PlannableRecipe>();
  for (let i = 0; i < 8; i += 1) {
    const mealType = r.pick(MEALS);
    recipes.set(`r${i}`, {
      id: `r${i}`,
      mealType,
      suitableMealTypes: r.subset(MEALS, 3),
      allergens: r.subset(ALLERGENS, 4),
      ingredientIds: r.subset(INGREDIENT_IDS, 5),
    });
  }
  const slots: ApplyWeekSlotDto[] = Array.from({ length: r.int(1, 10) }, () => {
    const participantIds = r.chance(0.5)
      ? []
      : [...r.subset(members, 2), ...(r.chance(0.15) ? ['obcy'] : [])];
    const slot: ApplyWeekSlotDto = {
      dayOfWeek: r.pick(DAYS),
      mealType: r.pick(MEALS),
      // r8/r9 nie istnieją — ścieżka RECIPE_NOT_FOUND.
      recipeId: `r${r.int(0, 9)}`,
      participantIds,
    };
    if (r.chance(0.2)) {
      const audience = participantIds.length > 0 ? participantIds : members;
      slot.portions = audience.map((userId) => ({
        userId,
        servings: r.pick([0.5, 1, 1.5, 0.7]),
      }));
    }
    return slot;
  });
  // Co któryś tydzień dubluje pozycję — ścieżka PLAN_SLOT_DUPLICATE.
  if (r.chance(0.2)) slots.push({ ...slots[0] });
  return {
    slots,
    recipes,
    memberIds: new Set(members),
    allergensByMember,
    exclusionsByMember,
  };
}

const CASES = Number(process.env.CONSTRAINT_EQUIVALENCE_CASES ?? 20_000) / 4;

describe(`silnik ograniczeń ≡ walidator zapisu planu (N8A S4) na ${CASES} tygodniach`, () => {
  it('te same naruszenia co zamrożona kopia — kody, indeksy i komunikaty', () => {
    const r = prng(20260929);
    const diffs: string[] = [];
    const codes = new Map<string, number>();
    for (let i = 0; i < CASES; i += 1) {
      const week = randomWeek(r);
      const args = [
        week.slots,
        week.recipes,
        week.memberIds,
        week.allergensByMember,
        week.exclusionsByMember,
      ] as const;
      const expected = legacyCollectPlanViolations(...args);
      const actual = currentCollect(...args);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        diffs.push(
          `#${i}: ${JSON.stringify(expected)} ≠ ${JSON.stringify(actual)}`,
        );
      }
      for (const violation of expected) {
        codes.set(violation.code, (codes.get(violation.code) ?? 0) + 1);
      }
    }
    expect(diffs.slice(0, 5)).toEqual([]);
    // Reguły, które przepięliśmy, muszą być gęsto odwiedzone — także
    // alergeny kilku domowników naraz (kolejność w komunikacie).
    expect(codes.get('RECIPE_ALLERGEN_CONFLICT') ?? 0).toBeGreaterThan(1000);
    expect(codes.get('RECIPE_EXCLUDED_INGREDIENT') ?? 0).toBeGreaterThan(1000);
    for (const code of [
      'PLAN_SLOT_DUPLICATE',
      'RECIPE_NOT_FOUND',
      'RECIPE_NOT_SUITABLE_FOR_SLOT',
      'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
      'PLAN_PORTIONS_INVALID',
    ]) {
      expect({ code, seen: (codes.get(code) ?? 0) > 0 }).toEqual({
        code,
        seen: true,
      });
    }
  });
});
