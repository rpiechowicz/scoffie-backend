import { Test, TestingModule } from '@nestjs/testing';
import { WeeklyPlansService } from './weekly-plans.service';
import { ShoppingListService } from './services/shopping-list.service';
import { PrismaService } from '../prisma/prisma.service';

// Podgląd tygodnia BEZ zapisu — materiał na kartę propozycji asystenta.
//
// Dwie rzeczy, których pilnują te testy, są kontraktem, nie szczegółem:
// 1. przy naruszeniu nie wraca ŻADNA treść (`slots: null`) — karta, której
//    nie wolno zapisać, nie ma prawa wyglądać jak gotowa propozycja;
// 2. nazwy i kalorie pochodzą z BAZY, nie z wejścia — bo wejście układa model.

const householdId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const oatmealId = '33333333-3333-4333-8333-333333333333';
const soupId = '44444444-4444-4444-8444-444444444444';
const weekStart = '2026-04-13'; // poniedziałek

const RECIPES = [
  {
    id: oatmealId,
    title: 'Owsianka z bananem',
    mealType: 'BREAKFAST',
    suitableMealTypes: ['BREAKFAST'],
    allergens: ['gluten'],
    servings: 2,
    prepTimeMinutes: 10,
    nutritionKcal: 700,
  },
  {
    id: soupId,
    title: 'Zupa krem z dyni',
    mealType: 'DINNER',
    suitableMealTypes: ['DINNER'],
    allergens: [],
    servings: 4,
    prepTimeMinutes: 35,
    nutritionKcal: 1000,
  },
];

type MockOptions = {
  /** Alergeny drugiego domownika — pusta lista = nikt niczego nie unika. */
  otherAllergens?: string[];
  /** Pozycje, które JUŻ są w tygodniu. */
  current?: Array<{
    dayOfWeek: string;
    mealType: string;
    recipeId: string;
    plannedServings?: number;
    participants?: Array<{ userId: string }>;
  }>;
};

const makePrismaMock = ({ otherAllergens = [], current = [] }: MockOptions = {}) => {
  const rows = current.map((item) => ({
    dayOfWeek: item.dayOfWeek,
    mealType: item.mealType,
    recipeId: item.recipeId,
    plannedServings: item.plannedServings ?? 2,
    participants: item.participants ?? [],
    recipe: { title: RECIPES.find((r) => r.id === item.recipeId)?.title ?? '' },
  }));

  return {
    membership: {
      findUnique: jest.fn().mockResolvedValue({ id: 'mem-1', userId, householdId }),
      findMany: jest.fn().mockResolvedValue([
        { userId, user: { preferences: { allergens: [] } } },
        { userId: otherUserId, user: { preferences: { allergens: otherAllergens } } },
      ]),
    },
    // Jeden mock obsługuje oba odczyty przepisów (walidacja i opis pozycji) —
    // zwraca nadzbiór pól, tak jak zrobiłaby baza.
    recipe: { findMany: jest.fn().mockResolvedValue(RECIPES) },
    weeklyPlan: { findUnique: jest.fn().mockResolvedValue({ id: 'plan-1' }) },
    planItem: { findMany: jest.fn().mockResolvedValue(rows) },
  };
};

const buildService = async (prisma: ReturnType<typeof makePrismaMock>) => {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      WeeklyPlansService,
      { provide: PrismaService, useValue: prisma },
      { provide: ShoppingListService, useValue: { markShoppingListStale: jest.fn() } },
    ],
  }).compile();
  return module.get<WeeklyPlansService>(WeeklyPlansService);
};

const slot = (over: Record<string, unknown> = {}) =>
  ({
    dayOfWeek: 'MON',
    mealType: 'BREAKFAST',
    recipeId: oatmealId,
    ...over,
  }) as never;

describe('WeeklyPlansService.previewWeekPlan', () => {
  it('opisuje pozycje danymi Z BAZY, nie z wejścia', async () => {
    const prisma = makePrismaMock();
    const service = await buildService(prisma);

    const preview = await service.previewWeekPlan(userId, householdId, weekStart, {
      slots: [slot(), slot({ dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: soupId })],
    });

    expect(preview.violations).toEqual([]);
    expect(preview.slots).toHaveLength(2);
    expect(preview.slots?.[0]).toMatchObject({
      dayOfWeek: 'MON',
      mealType: 'BREAKFAST',
      title: 'Owsianka z bananem',
      // 700 kcal na 2 porcje — karta pokazuje porcję, nie garnek.
      kcalPerServing: 350,
      prepTimeMinutes: 10,
      change: 'NEW',
    });
    expect(preview.slots?.[1]).toMatchObject({
      title: 'Zupa krem z dyni',
      kcalPerServing: 250,
      change: 'NEW',
    });
  });

  it('rozróżnia pozycje nowe od tych, które już stoją w tygodniu', async () => {
    const prisma = makePrismaMock({
      current: [{ dayOfWeek: 'MON', mealType: 'BREAKFAST', recipeId: oatmealId }],
    });
    const service = await buildService(prisma);

    const preview = await service.previewWeekPlan(userId, householdId, weekStart, {
      slots: [slot(), slot({ dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: soupId })],
    });

    expect(preview.slots?.map((s) => s.change)).toEqual(['KEPT', 'NEW']);
    expect(preview.removed).toEqual([]);
  });

  it('wymienia pozycje, które ZNIKNĄ — bo stan docelowy ich nie zawiera', async () => {
    const prisma = makePrismaMock({
      current: [{ dayOfWeek: 'WED', mealType: 'DINNER', recipeId: soupId }],
    });
    const service = await buildService(prisma);

    const preview = await service.previewWeekPlan(userId, householdId, weekStart, {
      slots: [slot()],
    });

    expect(preview.removed).toEqual([
      {
        dayOfWeek: 'WED',
        mealType: 'DINNER',
        recipeId: soupId,
        title: 'Zupa krem z dyni',
      },
    ]);
  });

  it('przy naruszeniu nie oddaje ŻADNEJ treści — jest tylko powód', async () => {
    // Domownik unika glutenu, a owsianka go ma. Alergeny sprawdza serwer,
    // nie model — i to jest dokładnie ten test.
    const prisma = makePrismaMock({ otherAllergens: ['gluten'] });
    const service = await buildService(prisma);

    const preview = await service.previewWeekPlan(userId, householdId, weekStart, {
      slots: [slot()],
    });

    expect(preview.slots).toBeNull();
    expect(preview.removed).toBeNull();
    expect(preview.changes).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(preview.violations).toHaveLength(1);
    expect(preview.violations[0]).toMatchObject({
      index: 0,
      code: 'RECIPE_ALLERGEN_CONFLICT',
      recipeId: oatmealId,
    });
  });

  it('nie zapisuje niczego', async () => {
    const prisma = makePrismaMock();
    const service = await buildService(prisma);

    await service.previewWeekPlan(userId, householdId, weekStart, { slots: [slot()] });

    // Mock nie ma metod zapisu — gdyby podgląd ich dotknął, test padłby na
    // `undefined is not a function`. Ta asercja pilnuje, że nikt ich nie doda.
    expect(Object.keys(prisma.planItem)).toEqual(['findMany']);
    expect(Object.keys(prisma.weeklyPlan)).toEqual(['findUnique']);
  });
});

describe('WeeklyPlansService.snapshotWeekAsSlots', () => {
  it('oddaje tydzień w kształcie WEJŚCIA applyWeekPlan — materiał na „Cofnij”', async () => {
    const prisma = makePrismaMock({
      current: [
        {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
          recipeId: oatmealId,
          plannedServings: 3,
          participants: [{ userId: otherUserId }],
        },
      ],
    });
    const service = await buildService(prisma);

    const snapshot = await service.snapshotWeekAsSlots(userId, householdId, weekStart);

    expect(snapshot).toEqual([
      {
        dayOfWeek: 'MON',
        mealType: 'BREAKFAST',
        recipeId: oatmealId,
        participantIds: [otherUserId],
        plannedServings: 3,
      },
    ]);
  });

  it('pusty tydzień to pusta lista, nie null', async () => {
    const prisma = makePrismaMock();
    const service = await buildService(prisma);

    await expect(
      service.snapshotWeekAsSlots(userId, householdId, weekStart),
    ).resolves.toEqual([]);
  });
});
