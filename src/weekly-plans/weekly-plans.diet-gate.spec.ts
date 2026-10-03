import { DietPreferenceValue, MealType } from '@prisma/client';
import { ApplyWeekSlotDto } from './dto/apply-week-plan.dto';
import { PlanViolation, WeeklyPlansService } from './weekly-plans.service';

// Dieta w walidatorze zapisu tygodnia (S5, 3.10.2026). Bramka dotyczy TYLKO
// osób, które pozycja dokłada do jedzących względem bazy — danie spoza diety,
// które ktoś dodał ręcznie, a asystent go nie rusza albo tylko zawęża, nie
// blokuje zapisu tygodnia.

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
    current: Map<string, ReadonlySet<string>>;
    allDiets?: boolean;
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
const MEMBERS = new Set(['wege', 'mieso', 'dziecko']);
const DIETS = new Map<string, DietPreferenceValue>([
  ['wege', 'VEGETARIAN'],
  ['mieso', 'NONE'],
]);
const ALL: ReadonlySet<string> = MEMBERS;
const only = (...ids: string[]): ReadonlySet<string> => new Set(ids);

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
  current: Map<string, ReadonlySet<string>> | null,
  diets: Map<string, DietPreferenceValue> = DIETS,
): string[] =>
  collect(
    slots,
    RECIPES,
    MEMBERS,
    new Map(),
    new Map(),
    current ? { dietByMember: diets, current } : null,
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

  it('pozycja bez zmian (to samo danie, ci sami jedzący) nie jest sprawdzana', () => {
    const current = new Map([['MON|DINNER|schabowy', ALL]]);
    expect(codes([slot('schabowy')], current)).toEqual([]);
    // Pełna lista domowników to też „wszyscy”.
    expect(
      codes([slot('schabowy', ['mieso', 'wege', 'dziecko'])], current),
    ).toEqual([]);
  });

  it('zawężenie jedzących nikogo nie dokłada — nie jest sprawdzane (R3)', () => {
    // „Dziecko nie zje środowej kolacji”: ręczny schabowy dla wszystkich
    // zawężony do dwóch osób, wśród nich wegetarianin, który już go „jadł”.
    const current = new Map([['MON|DINNER|schabowy', ALL]]);
    expect(codes([slot('schabowy', ['wege', 'mieso'])], current)).toEqual([]);
  });

  it('dołożenie osoby na diecie do istniejącej pozycji jest sprawdzane', () => {
    const current = new Map([['MON|DINNER|schabowy', only('mieso')]]);
    expect(codes([slot('schabowy')], current)).toEqual([
      'RECIPE_DIET_CONFLICT',
    ]);
    expect(codes([slot('schabowy', ['wege'])], current)).toEqual([
      'RECIPE_DIET_CONFLICT',
    ]);
    // Dołożenie osoby BEZ diety przechodzi.
    expect(codes([slot('schabowy', ['mieso', 'dziecko'])], current)).toEqual(
      [],
    );
  });

  it('były domownik w starych wierszach nie zasłania nowego', () => {
    // W bazie [mieso, ktoś, kto odszedł] — tyle samo osób co dziś w domu,
    // ale „wszyscy” po zapisie dokłada wegetarianina.
    const current = new Map([
      ['MON|DINNER|schabowy', only('mieso', 'dziecko', 'byly')],
    ]);
    expect(codes([slot('schabowy')], current)).toEqual([
      'RECIPE_DIET_CONFLICT',
    ]);
  });

  it('diety makro (KETO, HIGH_PROTEIN) nie są bramką zapisu', () => {
    const diets = new Map<string, DietPreferenceValue>([
      ['wege', 'KETO'],
      ['mieso', 'HIGH_PROTEIN'],
    ]);
    const recipes = new Map([
      ['bez-makr', { ...recipe('bez-makr', []), perServing: null }],
    ]);
    expect(
      collect([slot('bez-makr')], recipes, MEMBERS, new Map(), new Map(), {
        dietByMember: diets,
        current: new Map(),
      }),
    ).toEqual([]);
    expect(codes([slot('schabowy')], new Map(), diets)).toEqual([]);
  });

  it('raport (`allDiets`) zgłasza też diety makro — nic nie blokuje', () => {
    const diets = new Map<string, DietPreferenceValue>([['wege', 'KETO']]);
    const recipes = new Map([
      ['bez-makr', { ...recipe('bez-makr', []), perServing: null }],
    ]);
    expect(
      collect([slot('bez-makr')], recipes, MEMBERS, new Map(), new Map(), {
        dietByMember: diets,
        current: new Map(),
        allDiets: true,
      }).map((violation) => violation.code),
    ).toEqual(['RECIPE_DIET_CONFLICT']);
  });

  it('to samo danie przeniesione na inny dzień jest sprawdzane', () => {
    const current = new Map([['TUE|DINNER|schabowy', ALL]]);
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
