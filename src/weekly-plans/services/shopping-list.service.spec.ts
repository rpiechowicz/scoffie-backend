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

/// A Plan v2 day item: one dish pinned to a (day, slot). `participants` do
/// not reach the shopping list — the scaling runs off `plannedServings`,
/// which the server already derived from them — but they are what makes two
/// items share a slot, so the fixtures carry them.
///
/// Domyślnie pozycja gotuje dokładnie tyle porcji, na ile napisany jest
/// przepis (mnożnik 1), żeby testy agregacji nie mieszały się ze skalowaniem;
/// testy reguły porcji podają obie liczby jawnie.
const dayItem = (
  id: string,
  dayOfWeek: number,
  mealType: string,
  ingredients: Ingredient[],
  participantIds: string[] = [],
  plannedServings = 2,
  recipeServings = 2,
) => ({
  id,
  weeklyPlanId: 'plan-1',
  dayOfWeek,
  mealType,
  plannedServings,
  recipe: { ingredients, servings: recipeServings },
  participants: participantIds.map((userId) => ({ userId })),
});

/// A legacy pool item: no day, no portions, but an explicit `quantity` for how
/// many times the household planned to cook it that week. `recipe.servings` is
/// here only to prove the legacy branch ignores it.
const poolItem = (id: string, ingredients: Ingredient[], quantity: number) => ({
  id,
  recipe: { ingredients, servings: 2 },
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

/// Finds an aggregated row by ingredient name. Nazwa idzie na listę dosłownie
/// z katalogu (tylko z wielką literą), więc dopasowanie po rdzeniu bez
/// diakrytyków to wygoda testów, nie obejście kanonizacji.
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

  // ─── Nazwy i działy idą z katalogu dosłownie ────────────────────────────────
  //
  // Lista używa `RecipeIngredient.name` bez regexowego „canonicalizera”, który
  // zamieniał „fasola biała z puszki” w „Sól” (dopasowanie `/sol/` bez granicy
  // słowa, sumowane z prawdziwą solą) i zlewał kawałki kurczaka w jeden wiersz.

  it('nie powinno przemianować fasoli na sól ani scalić jej z solą', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'DINNER', [
          ingredient('fasola biała z puszki', 480, 'g', 'Konserwy'),
          ingredient('sól', 2, 'g', 'Przyprawy i sosy'),
        ]),
      ]),
    );

    const items = await getList();

    expect(items).toHaveLength(2);
    const beans = items.find((item) => item.name === 'Fasola biała z puszki');
    const salt = items.find((item) => item.name === 'Sól');
    expect(beans).toMatchObject({
      productKey: 'fasola biała z puszki::g',
      department: 'Konserwy',
      totalAmount: 480,
    });
    expect(salt).toMatchObject({
      productKey: 'sól::g',
      department: 'Przyprawy i sosy',
      totalAmount: 2,
    });
  });

  it('powinno zostawić różne kawałki kurczaka jako osobne wiersze', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'DINNER', [
          ingredient('filet z kurczaka', 320, 'g', 'Mięso'),
        ]),
        dayItem('i-2', 2, 'DINNER', [
          ingredient('noga z kurczaka', 600, 'g', 'Mięso'),
        ]),
      ]),
    );

    const items = await getList();

    expect(items.map((item) => item.name).sort()).toEqual([
      'Filet z kurczaka',
      'Noga z kurczaka',
    ]);
  });

  it('powinno wziąć dział z katalogu dosłownie, a nieznaną etykietę zamienić na „Inne”', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'DINNER', [
          ingredient('seler korzeniowy', 100, 'g', 'Warzywa'),
          ingredient('tajemniczy produkt', 1, 'szt', 'Zupełnie obca etykieta'),
        ]),
      ]),
    );

    const items = await getList();

    expect(findItem(items, 'seler korzeniowy').department).toBe('Warzywa');
    expect(findItem(items, 'tajemniczy').department).toBe('Inne');
  });

  // ─── Reguła „pozycja waży plannedServings / recipe.servings" ────────────────
  //
  // Ilości składników opisują CAŁY przepis, czyli `recipe.servings` porcji, a
  // slot gotuje `plannedServings` porcji. Waga pozycji to więc ułamek, nie
  // krotność — dopóki obie liczby są równe, lista wygląda jak dawniej.

  it('powinno kupić połowę składników na posiłek solo z przepisu na dwie porcje', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem(
          'i-1',
          1,
          'DINNER',
          [ingredient('Kurczak', 300)],
          ['user-1'],
          1,
          2,
        ),
      ]),
    );

    const items = await getList();

    expect(findItem(items, 'kurczak').totalAmount).toBe(150);
  });

  it('powinno kupić cały przepis na wspólne danie na dwie porcje', async () => {
    // Pusta lista uczestników znaczy „wszyscy", a serwer przełożył to na
    // dwie porcje — dokładnie tyle, na ile napisany jest przepis.
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'DINNER', [ingredient('Mleko', 1, 'l')], [], 2, 2),
      ]),
    );

    const items = await getList();

    expect(findItem(items, 'mleko').totalAmount).toBe(1);
  });

  it('powinno kupić podwójnie, gdy slot podbito do czterech porcji', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'DINNER', [ingredient('Kurczak', 300)], [], 4, 2),
      ]),
    );

    const items = await getList();

    expect(findItem(items, 'kurczak').totalAmount).toBe(600);
  });

  it('powinno złożyć dwa posiłki solo z tego samego przepisu w jeden komplet składników', async () => {
    // Dwa razy pół przepisu ma dać dokładnie jeden przepis, bez pyłu po
    // dzieleniu — inaczej lista rozjeżdżałaby się o gramy przy każdym
    // slocie dzielonym.
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'DINNER', [ingredient('Ryż', 200)], ['user-1'], 1, 2),
        dayItem('i-2', 1, 'DINNER', [ingredient('Ryż', 200)], ['user-2'], 1, 2),
      ]),
    );

    const items = await getList();

    expect(items).toHaveLength(1);
    expect(findItem(items, 'ryz').totalAmount).toBe(200);
  });

  it('powinno policzyć ten sam przepis dwa razy, gdy stoi w dwóch dniach', async () => {
    // Powtórzenia w tygodniu niesie sam kalendarz — to zastąpiło pole
    // `quantity` ze starej puli. Skalowanie porcji działa niezależnie: każdy
    // z dni gotuje pełny przepis (2 z 2 porcji).
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

    // Stara pula niosła krotność w `quantity` — 3 × 200 g. Reguła porcji
    // jej nie dotyczy: tamte tygodnie nie mają dni ani porcji, więc
    // `servings` przepisu nie dzieli tu niczego.
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
