import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ShoppingListService } from './shopping-list.service';
import { PrismaService } from '../../prisma/prisma.service';

// ─── Mock data ─────────────────────────────────────────────────────────────────

const mockHouseholdId = 'hh-1';
const mockUserId = 'user-1';
const mockWeekStart = '2026-04-13'; // Monday

const mockMembership = {
  id: 'mem-1',
  userId: mockUserId,
  householdId: mockHouseholdId,
  role: 'OWNER',
};

/// A recipe ingredient row as the aggregator sees it — already normalized,
/// which is what `RecipeIngredient` stores.
const ingredient = (
  name: string,
  amount: number,
  unit = 'g',
  department = 'OTHER',
) => ({
  name,
  amount,
  unit,
  normalizedAmount: amount,
  normalizedUnit: unit,
  department,
});

type Ingredient = ReturnType<typeof ingredient>;

/// A Plan v2 day item: one dish pinned to a (day, slot). `participants` are
/// irrelevant to the shopping list — every dish is cooked once — but they are
/// what makes two items share a slot, so the fixtures carry them.
const dayItem = (
  id: string,
  dayOfWeek: number,
  mealType: string,
  ingredients: Ingredient[],
  participantIds: string[] = [],
) => ({
  id,
  weeklyPlanId: 'plan-1',
  dayOfWeek,
  mealType,
  recipe: { ingredients },
  participants: participantIds.map((userId) => ({ userId })),
});

/// A legacy pool item: no day, but an explicit `quantity` for how many times
/// the household planned to cook it that week.
const poolItem = (id: string, ingredients: Ingredient[], quantity: number) => ({
  id,
  recipe: { ingredients },
  quantity,
});

const weekPlanWith = (items: ReturnType<typeof dayItem>[]) => ({
  id: 'plan-1',
  householdId: mockHouseholdId,
  weekStart: new Date(mockWeekStart),
  items,
});

const poolWith = (items: ReturnType<typeof poolItem>[]) => ({
  id: 'shared-1',
  householdId: mockHouseholdId,
  weekStart: new Date(mockWeekStart),
  items,
});

const makePrismaMock = () => {
  const mock: any = {
    membership: {
      findUnique: jest.fn().mockResolvedValue(mockMembership),
    },
    // No day plan and no legacy pool unless a test sets one.
    weeklyPlan: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    sharedMealPlan: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    // `isStale` forces the read path through a full rebuild, which is where
    // the aggregation under test lives.
    shoppingList: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'sl-1', isStale: true, items: [] }),
      upsert: jest.fn().mockResolvedValue({ id: 'sl-1', items: [] }),
    },
    shoppingListItem: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockImplementation((args: any) => args.create),
    },
    shoppingItemCheck: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    shoppingListArchiveState: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn().mockImplementation((cbOrOps: any) => {
      if (typeof cbOrOps === 'function') {
        return cbOrOps(mock);
      }
      return Promise.all(cbOrOps);
    }),
  };
  return mock;
};

/// Finds an aggregated row by ingredient name. The classifier canonicalizes
/// names on the way in (plurals to singular: „Ziemniaki" to „Ziemniak"), so
/// match on a diacritic-insensitive stem rather than pinning its exact output.
const fold = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const findItem = (items: Array<{ name: string }>, stem: string) =>
  items.find((item) => fold(item.name).includes(fold(stem))) as any;

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ShoppingListService — agregacja z Planu v2', () => {
  let service: ShoppingListService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShoppingListService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ShoppingListService>(ShoppingListService);
  });

  afterEach(() => jest.clearAllMocks());

  const getList = () =>
    service.getShoppingList(mockUserId, mockHouseholdId, mockWeekStart);

  // ─── Sloty dzielone (rdzeń Planu v2) ────────────────────────────────────────

  it('powinno policzyć oba dania z jednego slotu podzielonego między domowników', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'DINNER', [ingredient('Kurczak', 300)], ['user-1']),
        dayItem('i-2', 1, 'DINNER', [ingredient('Tofu', 200)], ['user-2']),
      ]),
    );

    const items = await getList();

    expect(findItem(items, 'kurczak').totalAmount).toBe(300);
    expect(findItem(items, 'tofu').totalAmount).toBe(200);
  });

  it('powinno zsumować ten sam składnik z dwóch dań w jednym slocie', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'DINNER', [ingredient('Ryż', 100)], ['user-1']),
        dayItem('i-2', 1, 'DINNER', [ingredient('Ryż', 150)], ['user-2']),
      ]),
    );

    const items = await getList();

    expect(items).toHaveLength(1);
    expect(findItem(items, 'ryz').totalAmount).toBe(250);
  });

  // ─── Reguła „jedno danie = jedna porcja przepisu" ───────────────────────────

  it('powinno policzyć wspólne danie raz, niezależnie od liczby domowników', async () => {
    // Pusta lista uczestników znaczy „wszyscy" — i tak gotuje się raz.
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'DINNER', [ingredient('Mleko', 1, 'l')]),
      ]),
    );

    const items = await getList();

    expect(findItem(items, 'mleko').totalAmount).toBe(1);
  });

  it('powinno policzyć ten sam przepis dwa razy, gdy stoi w dwóch dniach', async () => {
    // Powtórzenia w tygodniu niesie sam kalendarz — to zastąpiło pole
    // `quantity` ze starej puli.
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'BREAKFAST', [ingredient('Owies', 50)]),
        dayItem('i-2', 4, 'BREAKFAST', [ingredient('Owies', 50)]),
      ]),
    );

    const items = await getList();

    expect(findItem(items, 'owies').totalAmount).toBe(100);
  });

  // ─── Współistnienie ze starą pulą ───────────────────────────────────────────

  it('powinno oprzeć listę na starej puli, gdy tydzień nie ma dni w Planie v2', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(null);
    prisma.sharedMealPlan.findUnique.mockResolvedValue(
      poolWith([poolItem('p-1', [ingredient('Makaron', 200)], 3)]),
    );

    const items = await getList();

    // Stara pula niosła krotność w `quantity` — 3 × 200 g.
    expect(findItem(items, 'makaron').totalAmount).toBe(600);
  });

  it('powinno przedkładać dni Planu v2 nad starą pulę dla tego samego tygodnia', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 2, 'LUNCH', [ingredient('Ziemniaki', 500)]),
      ]),
    );
    prisma.sharedMealPlan.findUnique.mockResolvedValue(
      poolWith([poolItem('p-1', [ingredient('Makaron', 200)], 3)]),
    );

    const items = await getList();

    expect(items).toHaveLength(1);
    expect(findItem(items, 'ziemniak').totalAmount).toBe(500);
    expect(prisma.sharedMealPlan.findUnique).not.toHaveBeenCalled();
  });

  it('powinno zwrócić pustą listę, gdy tydzień nie ma żadnego źródła', async () => {
    await expect(getList()).resolves.toEqual([]);
  });

  // ─── Kontrola dostępu ───────────────────────────────────────────────────────

  it('powinno odrzucić gdy użytkownik nie jest członkiem household', async () => {
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(getList()).rejects.toThrow(ForbiddenException);
  });
});
