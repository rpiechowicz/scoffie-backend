import { DietPreferenceValue, MealType } from '@prisma/client';
import { ApplyWeekSlotDto } from './dto/apply-week-plan.dto';
import { PlanViolation, WeeklyPlansService } from './weekly-plans.service';

// Dieta w walidatorze zapisu planu asystenta (S5, 3.10.2026). Bramka dotyczy
// TYLKO pozycji nowych albo z innym audytorium — danie spoza diety, które
// ktoś dodał ręcznie i którego asystent nie rusza, nie blokuje zapisu tygodnia.

type Recipe = {
  id: string;
  mealType: MealType;
  suitableMealTypes: MealType[];
  allergens: string[];
  ingredientIds: string[];
  dietTags: string[];
  perServing: { kcal: number; protein: number; carbs: number } | null;
};

type Collect = (
  slots: ApplyWeekSlotDto[],
  recipes: Map<string, Recipe>,
  memberIds: Set<string>,
  allergensByMember: Map<string, string[]>,
  exclusionsByMember?: Map<string, string[]>,
  diet?: {
    dietByMember: Map<string, DietPreferenceValue>;
    current: Map<string, string>;
  } | null,
) => PlanViolation[];

const collect = (
  WeeklyPlansService.prototype as unknown as { collectPlanViolations: Collect }
).collectPlanViolations;

const recipe = (id: string, dietTags: string[]): Recipe => ({
  id,
  mealType: 'DINNER',
  suitableMealTypes: ['DINNER'],
  allergens: [],
  ingredientIds: ['ing-1'],
  dietTags,
  perServing: { kcal: 500, protein: 30, carbs: 40 },
});

const RECIPES = new Map([
  ['schabowy', recipe('schabowy', ['MEAT'])],
  ['risotto', recipe('risotto', ['DAIRY'])],
]);
const MEMBERS = new Set(['wege', 'mieso']);
const DIETS = new Map<string, DietPreferenceValue>([
  ['wege', 'VEGETARIAN'],
  ['mieso', 'NONE'],
]);

const slot = (
  recipeId: string,
  participantIds: string[] = [],
): ApplyWeekSlotDto => ({
  dayOfWeek: 'MON',
  mealType: 'DINNER',
  recipeId,
  participantIds,
});

const codes = (
  slots: ApplyWeekSlotDto[],
  current: Map<string, string> | null,
): string[] =>
  collect(
    slots,
    RECIPES,
    MEMBERS,
    new Map(),
    new Map(),
    current ? { dietByMember: DIETS, current } : null,
  ).map((violation) => violation.code);

describe('WeeklyPlansService — dieta w zapisie planu asystenta (S5)', () => {
  it('nowe danie spoza diety kogoś z jedzących → RECIPE_DIET_CONFLICT', () => {
    expect(codes([slot('schabowy')], new Map())).toEqual([
      'RECIPE_DIET_CONFLICT',
    ]);
  });

  it('komunikat bez nazwy diety i bez osoby (dane o zdrowiu)', () => {
    const [violation] = collect(
      [slot('schabowy')],
      RECIPES,
      MEMBERS,
      new Map(),
      new Map(),
      { dietByMember: DIETS, current: new Map() },
    );
    expect(violation).toMatchObject({
      index: 0,
      dayOfWeek: 'MON',
      mealType: 'DINNER',
      code: 'RECIPE_DIET_CONFLICT',
    });
    expect(violation.message).not.toMatch(/wege|VEGETARIAN|wegetaria/i);
  });

  it('danie zgodne z dietą wszystkich jedzących przechodzi', () => {
    expect(codes([slot('risotto')], new Map())).toEqual([]);
  });

  it('audytorium bez osoby na diecie przechodzi', () => {
    expect(codes([slot('schabowy', ['mieso'])], new Map())).toEqual([]);
  });

  it('pozycja bez zmian (to samo danie, to samo audytorium) nie jest sprawdzana', () => {
    const current = new Map([['MON|DINNER|schabowy', '*']]);
    expect(codes([slot('schabowy')], current)).toEqual([]);
    // Pełna lista domowników to też „wszyscy” — jak zapis, który ją zwija.
    expect(codes([slot('schabowy', ['mieso', 'wege'])], current)).toEqual([]);
  });

  it('to samo danie z innym audytorium jest sprawdzane', () => {
    const current = new Map([['MON|DINNER|schabowy', 'mieso']]);
    expect(codes([slot('schabowy')], current)).toEqual([
      'RECIPE_DIET_CONFLICT',
    ]);
    expect(codes([slot('schabowy', ['wege'])], current)).toEqual([
      'RECIPE_DIET_CONFLICT',
    ]);
  });

  it('to samo danie przeniesione na inny dzień jest sprawdzane', () => {
    const current = new Map([['TUE|DINNER|schabowy', '*']]);
    expect(codes([slot('schabowy')], current)).toEqual([
      'RECIPE_DIET_CONFLICT',
    ]);
  });

  it('bez bramki diety (ręczny zapis z telefonu) dieta nie jest sprawdzana', () => {
    expect(codes([slot('schabowy')], null)).toEqual([]);
  });

  it('pusty skład przepisu: dieta mięsna nieznana, nie blokujemy (jak planer)', () => {
    const recipes = new Map([
      ['pusty', { ...recipe('pusty', ['MEAT']), ingredientIds: [] }],
    ]);
    expect(
      collect([slot('pusty')], recipes, MEMBERS, new Map(), new Map(), {
        dietByMember: DIETS,
        current: new Map(),
      }).map((violation) => violation.code),
    ).toEqual([]);
  });
});
