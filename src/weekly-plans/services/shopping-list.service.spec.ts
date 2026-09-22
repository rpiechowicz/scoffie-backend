import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import {
  SHOPPING_LIST_RULES_VERSION,
  ShoppingListService,
} from './shopping-list.service';
import { PrismaService } from '../../prisma/prisma.service';

// ─── Mock data ─────────────────────────────────────────────────────────────────

// Prawdziwe UUID v4 — `ensureMembership` bramkuje format przez `assertUuid`,
// więc `hh-1` zatrzymałoby się na VALIDATION_ERROR przed logiką pod testem.
const mockHouseholdId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const mockUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mockArchiveId = '44444444-4444-4444-8444-444444444444';
const mockWeekStart = '2026-04-13'; // Monday

const mockMembership = {
  id: 'mem-1',
  userId: mockUserId,
  householdId: mockHouseholdId,
  role: 'OWNER',
};

/// A recipe ingredient row as the aggregator sees it — already normalized,
/// which is what `RecipeIngredient` stores. `gramsPerPiece` przychodzi
/// z katalogu (`Ingredient`) — domyślnie brak, czyli bez przeliczania.
const ingredient = (
  name: string,
  amount: number,
  unit = 'g',
  department = 'OTHER',
  gramsPerPiece: number | null = null,
) => ({
  name,
  amount,
  unit,
  normalizedAmount: amount,
  normalizedUnit: unit,
  department,
  ingredient: { gramsPerPiece },
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

const weekPlanWith = (items: ReturnType<typeof dayItem>[]) => ({
  id: 'plan-1',
  householdId: mockHouseholdId,
  weekStart: new Date(mockWeekStart),
  items,
});

const makePrismaMock = () => {
  const mock: any = {
    membership: {
      findUnique: jest.fn().mockResolvedValue(mockMembership),
    },
    // No day plan unless a test sets one.
    weeklyPlan: {
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
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockImplementation((args: any) => args.create),
    },
    shoppingItemCheck: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // Dopisane „brakuje mi" — domyślnie nic, jak w domu, który z tego nie
    // korzysta.
    shoppingListExtra: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    recipe: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    shoppingListArchiveState: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
    },
    shoppingListArchive: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _max: { revision: null } }),
      create: jest.fn().mockResolvedValue({ id: 'arch-new' }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
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

  // ─── Jedna jednostka na produkt ─────────────────────────────────────────────
  //
  // Katalog zapisuje cebulę raz w gramach („150 g”), raz w sztukach („1 szt”).
  // Lista kleiła pozycje po parze nazwa + jednostka, więc tydzień z obydwoma
  // przepisami dawał „Cebula (g)” i „Cebula (szt)” — zgłoszenie z 22.09.2026.

  it('powinno złożyć cebulę w gramach i w sztukach w jeden wiersz w sztukach', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'LUNCH', [
          ingredient('cebula', 330, 'g', 'Warzywa', 110),
        ]),
        dayItem('i-2', 2, 'DINNER', [
          ingredient('cebula', 1, 'szt', 'Warzywa', 110),
        ]),
      ]),
    );

    const items = await getList();

    expect(items).toEqual([
      expect.objectContaining({
        productKey: 'cebula::szt',
        name: 'Cebula',
        unit: 'szt',
        totalAmount: 4,
      }),
    ]);
  });

  it('powinno liczyć produkt z masą sztuki w sztukach także wtedy, gdy tydzień ma go tylko w gramach', async () => {
    // Jednostka zależy od produktu, nie od tygodnia — inaczej cebula
    // skakałaby między gramami a sztukami razem z planem, a zaznaczenie
    // „kupione” gubiłoby się przy każdej takiej zmianie (inny `productKey`).
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'LUNCH', [
          ingredient('ziemniak', 500, 'g', 'Warzywa', 100),
        ]),
      ]),
    );

    const items = await getList();

    expect(items).toEqual([
      expect.objectContaining({
        productKey: 'ziemniak::szt',
        unit: 'szt',
        totalAmount: 5,
      }),
    ]);
  });

  it('powinno zaokrąglić sztuki w górę do połówki', async () => {
    // 145 g + pół sztuki ogórka po 250 g = 1,08 szt → w sklepie półtora.
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'LUNCH', [
          ingredient('ogórek', 145, 'g', 'Warzywa', 250),
          ingredient('jajko', 1, 'szt', 'Nabiał', 50),
        ]),
        dayItem('i-2', 2, 'LUNCH', [
          ingredient('ogórek', 0.5, 'szt', 'Warzywa', 250),
        ]),
      ]),
    );

    const items = await getList();

    expect(findItem(items, 'ogorek')).toMatchObject({
      unit: 'szt',
      totalAmount: 1.5,
    });
    expect(findItem(items, 'jajko').totalAmount).toBe(1);
  });

  it('bez masy sztuki nie ma czym przeliczyć — gramy i sztuki zostają osobno, z jednostką w nazwie', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'LUNCH', [ingredient('seler naciowy', 80, 'g')]),
        dayItem('i-2', 2, 'LUNCH', [ingredient('seler naciowy', 1, 'szt')]),
      ]),
    );

    const items = await getList();

    expect(items.map((item) => item.name).sort()).toEqual([
      'Seler naciowy (g)',
      'Seler naciowy (szt)',
    ]);
  });

  it('powinno przeliczyć migawkę zbudowaną według starszych reguł przy pierwszym odczycie', async () => {
    // Lista policzona przed ujednoliceniem jednostek nie jest „stale”, ale
    // trzyma stare wiersze — bez wersji reguł czekałaby na zmianę planu.
    prisma.shoppingList.findUnique.mockResolvedValue({
      id: 'sl-1',
      isStale: false,
      rulesVersion: 0,
      items: [
        {
          productKey: 'cebula::g',
          name: 'Cebula (g)',
          unit: 'g',
          department: 'Warzywa',
          totalAmount: 330,
          isChecked: false,
        },
      ],
    });
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'LUNCH', [
          ingredient('cebula', 330, 'g', 'Warzywa', 110),
        ]),
      ]),
    );

    const items = await getList();

    expect(items.map((item) => item.productKey)).toEqual(['cebula::szt']);
    expect(prisma.shoppingList.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          isStale: false,
          rulesVersion: SHOPPING_LIST_RULES_VERSION,
        }),
      }),
    );
  });

  it('nie powinno przebudowywać migawki zbudowanej według bieżących reguł', async () => {
    prisma.shoppingList.findUnique.mockResolvedValue({
      id: 'sl-1',
      isStale: false,
      rulesVersion: SHOPPING_LIST_RULES_VERSION,
      items: [
        {
          productKey: 'cebula::szt',
          name: 'Cebula',
          unit: 'szt',
          department: 'Warzywa',
          totalAmount: 3,
          isChecked: true,
        },
      ],
    });
    prisma.weeklyPlan.findUnique.mockResolvedValue({ items: [{ id: 'i-1' }] });

    const items = await getList();

    expect(items).toEqual([
      expect.objectContaining({ productKey: 'cebula::szt', isChecked: true }),
    ]);
    expect(prisma.shoppingList.upsert).not.toHaveBeenCalled();
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

  // ─── Wycofana pula tygodniowa (WP-03) ──────────────────────────────────────
  //
  // Dawna pula tygodniowa potrafiła podstawić widmową listę tygodniowi, z
  // którego usunięto wszystkie posiłki po jednym. `PlanItem` jest jedynym
  // źródłem; tabele puli nie istnieją (migracja 20260903090000).

  it('nie powinno budować listy ze starej puli, gdy tydzień nie ma dni w Planie v2', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(null);

    await expect(getList()).resolves.toEqual([]);
  });

  it('nie powinno pytać o starą pulę, gdy tydzień ma dni w Planie v2', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 2, 'LUNCH', [ingredient('Ziemniaki', 500)]),
      ]),
    );

    const items = await getList();

    expect(items).toHaveLength(1);
    expect(findItem(items, 'ziemniak').totalAmount).toBe(500);
  });

  it('powinno przebudować listę do pustej, gdy snapshot ma pozycje, a tydzień nie ma już źródła', async () => {
    // Widmowa lista: snapshot zbudowany kiedyś z puli, dziś bez pokrycia w
    // PlanItem. `hasShoppingSourceData` musi odpowiedzieć „nie ma źródła" i
    // wymusić przebudowę, a nie oddać stary snapshot.
    prisma.shoppingList.findUnique.mockResolvedValue({
      id: 'sl-1',
      isStale: false,
      items: [
        {
          id: 'sli-1',
          productKey: 'makaron::g',
          name: 'Makaron',
          unit: 'g',
          department: 'OTHER',
          totalAmount: 600,
          isChecked: false,
        },
      ],
    });
    prisma.weeklyPlan.findUnique.mockResolvedValue(null);

    await expect(getList()).resolves.toEqual([]);
  });

  it('powinno zwrócić pustą listę, gdy tydzień nie ma żadnego źródła', async () => {
    await expect(getList()).resolves.toEqual([]);
  });

  // ─── Kontrola dostępu ───────────────────────────────────────────────────────

  it('powinno odrzucić gdy użytkownik nie jest członkiem household', async () => {
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(getList()).rejects.toMatchObject({
      status: 403,
      response: { code: 'NOT_HOUSEHOLD_MEMBER' },
    });
  });
});

// ─── Zaznaczenia przy przebudowie i archiwum ──────────────────────────────────
//
// Przebudowa listy nie może gubić tego, co użytkownik odhaczył, ani udawać,
// że nic się nie zmieniło, gdy do zamkniętego tygodnia doszły zakupy.
// Kolejność źródeł: delta względem bieżącego archiwum wymusza „nie" →
// bieżący snapshot → stare `ShoppingItemCheck` → „nie".

describe('ShoppingListService — zaznaczenia i archiwum', () => {
  let service: ShoppingListService;
  let prisma: ReturnType<typeof makePrismaMock>;

  const ziemniaki = (amount = 500) =>
    weekPlanWith([
      dayItem('i-1', 1, 'LUNCH', [ingredient('ziemniak', amount)]),
    ]);

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

  afterEach(() => jest.restoreAllMocks());

  const getList = () =>
    service.getShoppingList(mockUserId, mockHouseholdId, mockWeekStart);

  it('przenosi zaznaczenie z bieżącego snapshotu', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(ziemniaki());
    prisma.shoppingList.upsert.mockResolvedValue({
      id: 'sl-1',
      items: [{ productKey: 'ziemniak::g', isChecked: true }],
    });

    const items = await getList();

    expect(findItem(items, 'ziemniak').isChecked).toBe(true);
  });

  it('bez snapshotu bierze zaznaczenie ze starego ShoppingItemCheck', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(ziemniaki());
    prisma.shoppingItemCheck.findMany.mockResolvedValue([
      { productKey: 'ziemniak::g', isChecked: true },
    ]);

    const items = await getList();

    expect(findItem(items, 'ziemniak').isChecked).toBe(true);
  });

  it('wzrost ilości względem bieżącego archiwum odznacza pozycję', async () => {
    prisma.weeklyPlan.findUnique.mockResolvedValue(ziemniaki(750));
    prisma.shoppingList.upsert.mockResolvedValue({
      id: 'sl-1',
      items: [{ productKey: 'ziemniak::g', isChecked: true }],
    });
    prisma.shoppingListArchiveState.findUnique.mockResolvedValue({
      currentArchiveId: 'arch-1',
      currentArchive: {
        items: [{ productKey: 'ziemniak::g', totalAmount: 500 }],
      },
    });

    const items = await getList();

    expect(findItem(items, 'ziemniak').isChecked).toBe(false);
  });

  it('ta sama ilość po zaokrągleniu nie odznacza (baseline z archiwum ma 2 miejsca)', async () => {
    // 0.375 g szczypty w sumie vs 0.38 g zapisane w archiwum — bez
    // zaokrąglenia przed porównaniem każde odświeżenie zdejmowało ptaszek.
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([dayItem('i-1', 1, 'LUNCH', [ingredient('sól', 0.375)])]),
    );
    prisma.shoppingList.upsert.mockResolvedValue({
      id: 'sl-1',
      items: [{ productKey: 'sól::g', isChecked: true }],
    });
    prisma.shoppingListArchiveState.findUnique.mockResolvedValue({
      currentArchiveId: 'arch-1',
      currentArchive: { items: [{ productKey: 'sól::g', totalAmount: 0.38 }] },
    });

    const items = await getList();

    expect(findItem(items, 'sol').isChecked).toBe(true);
  });

  it('składnik bez normalizedAmount wchodzi w surowej ilości i zostawia ostrzeżenie', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    prisma.weeklyPlan.findUnique.mockResolvedValue(
      weekPlanWith([
        dayItem('i-1', 1, 'LUNCH', [
          {
            name: 'tajemniczy proszek',
            amount: 3,
            unit: 'łyżeczka',
            normalizedAmount: null as unknown as number,
            normalizedUnit: null as unknown as string,
            department: 'Inne',
            ingredient: { gramsPerPiece: null },
          },
        ]),
      ]),
    );

    const items = await getList();

    expect(findItem(items, 'tajemniczy')).toMatchObject({
      totalAmount: 3,
      unit: 'łyżeczka',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('tajemniczy proszek'),
    );
  });

  describe('archiveShoppingList', () => {
    const archive = () =>
      service.archiveShoppingList(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        'Tydzień 16',
      );

    it('pusta lista → SHOPPING_LIST_EMPTY', async () => {
      await expect(archive()).rejects.toMatchObject({
        response: { code: 'SHOPPING_LIST_EMPTY' },
      });
    });

    it('nieodhaczone pozycje → SHOPPING_LIST_NOT_COMPLETED', async () => {
      prisma.weeklyPlan.findUnique.mockResolvedValue(ziemniaki());

      await expect(archive()).rejects.toMatchObject({
        response: { code: 'SHOPPING_LIST_NOT_COMPLETED' },
      });
      expect(prisma.shoppingListArchive.create).not.toHaveBeenCalled();
    });

    it('nowy zestaw dostaje revision max+1 i staje się bieżącym archiwum', async () => {
      prisma.weeklyPlan.findUnique.mockResolvedValue(ziemniaki());
      prisma.shoppingList.upsert.mockResolvedValue({
        id: 'sl-1',
        items: [{ productKey: 'ziemniak::g', isChecked: true }],
      });
      prisma.shoppingListArchive.aggregate.mockResolvedValue({
        _max: { revision: 2 },
      });

      const result = await archive();

      expect(prisma.shoppingListArchive.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            revision: 3,
            weekLabel: 'Tydzień 16',
            signature: expect.stringContaining('ziemniak::g|500.000000'),
          }),
        }),
      );
      expect(prisma.shoppingListArchiveState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: { currentArchiveId: 'arch-new' },
        }),
      );
      expect(result).toEqual({ archiveId: 'arch-new' });
    });

    it('ten sam zestaw → to samo archiwum, bez podbijania revision', async () => {
      prisma.weeklyPlan.findUnique.mockResolvedValue(ziemniaki());
      prisma.shoppingList.upsert.mockResolvedValue({
        id: 'sl-1',
        items: [{ productKey: 'ziemniak::g', isChecked: true }],
      });
      prisma.shoppingListArchive.findUnique.mockResolvedValue({
        id: 'arch-9',
        revision: 2,
      });

      const result = await archive();

      expect(prisma.shoppingListArchive.create).not.toHaveBeenCalled();
      expect(prisma.shoppingListArchive.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'arch-9' },
          data: expect.objectContaining({ weekLabel: 'Tydzień 16' }),
        }),
      );
      expect(result).toEqual({ archiveId: 'arch-9' });
    });

    // `weekLabel` to skalar z koperty (nie DTO), więc bramka jest ręczna —
    // ale ma zatrzymać się PRZED membership i transakcją, jak `validateDto`.
    it.each([
      ['pusty napis', ''],
      ['same spacje', '   '],
      ['65 znaków', 'x'.repeat(65)],
      ['liczba', 42],
      ['brak', undefined],
    ])(
      'weekLabel: %s → VALIDATION_ERROR, Prisma nietknięta',
      async (_, label) => {
        await expect(
          service.archiveShoppingList(
            mockUserId,
            mockHouseholdId,
            mockWeekStart,
            label as never,
          ),
        ).rejects.toMatchObject({
          status: 400,
          response: {
            code: 'VALIDATION_ERROR',
            details: [
              'weekLabel must be a non-empty string up to 64 characters',
            ],
          },
        });
        expect(prisma.membership.findUnique).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('weekLabel o długości 64 przechodzi bramkę', async () => {
      await expect(
        service.archiveShoppingList(
          mockUserId,
          mockHouseholdId,
          mockWeekStart,
          'x'.repeat(64),
        ),
      ).rejects.toMatchObject({ response: { code: 'SHOPPING_LIST_EMPTY' } });
      expect(prisma.membership.findUnique).toHaveBeenCalled();
    });
  });
});

// ─── Walidacja wejścia i kody błędów (Faza 0, krok 2) ────────────────────────
//
// Nie-UUID w `archiveId`/`householdId` kończył się P2023 z Postgresa → 500;
// brak archiwum albo pozycji leciał jako goły `NotFoundException` bez kodu,
// po którym iOS mógłby zdecydować. Teraz: VALIDATION_ERROR przed pierwszym
// zapytaniem, a „nie ma" ma własny kod z listy `APP_ERROR_CODES`.

describe('ShoppingListService — walidacja i kody', () => {
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

  const validationError = (details: string[]) => ({
    status: 400,
    response: { code: 'VALIDATION_ERROR', details },
  });

  it('getShoppingList: nie-UUID householdId → VALIDATION_ERROR przed membership', async () => {
    await expect(
      service.getShoppingList(mockUserId, 'hh-1', mockWeekStart),
    ).rejects.toMatchObject(validationError(['householdId must be a UUID']));
    expect(prisma.membership.findUnique).not.toHaveBeenCalled();
  });

  describe.each([
    ['selectShoppingListArchive', 'select'],
    ['deleteShoppingListArchive', 'delete'],
  ] as const)('%s', (_, kind) => {
    const call = (archiveId: string) =>
      kind === 'select'
        ? service.selectShoppingListArchive(
            mockUserId,
            mockHouseholdId,
            archiveId,
          )
        : service.deleteShoppingListArchive(
            mockUserId,
            mockHouseholdId,
            archiveId,
          );

    it("archiveId 'arch-1' → VALIDATION_ERROR, bez membership i transakcji", async () => {
      await expect(call('arch-1')).rejects.toMatchObject(
        validationError(['archiveId must be a UUID']),
      );
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('brak archiwum → SHOPPING_LIST_ARCHIVE_NOT_FOUND 404', async () => {
      prisma.shoppingListArchive.findUnique.mockResolvedValue(null);

      await expect(call(mockArchiveId)).rejects.toMatchObject({
        status: 404,
        response: { code: 'SHOPPING_LIST_ARCHIVE_NOT_FOUND' },
      });
      expect(prisma.shoppingListArchiveState.upsert).not.toHaveBeenCalled();
      expect(prisma.shoppingListArchive.delete).not.toHaveBeenCalled();
    });

    it('archiwum innego gospodarstwa → ten sam 404 (nie zdradzamy, że istnieje)', async () => {
      prisma.shoppingListArchive.findUnique.mockResolvedValue({
        id: mockArchiveId,
        householdId: '55555555-5555-4555-8555-555555555555',
        weekStart: new Date(mockWeekStart),
      });

      await expect(call(mockArchiveId)).rejects.toMatchObject({
        status: 404,
        response: { code: 'SHOPPING_LIST_ARCHIVE_NOT_FOUND' },
      });
      expect(prisma.shoppingListArchive.delete).not.toHaveBeenCalled();
    });

    it('trafione archiwum → weekStart jako YYYY-MM-DD', async () => {
      prisma.shoppingListArchive.findUnique.mockResolvedValue({
        id: mockArchiveId,
        householdId: mockHouseholdId,
        weekStart: new Date(mockWeekStart),
      });

      await expect(call(mockArchiveId)).resolves.toEqual({
        archiveId: mockArchiveId,
        weekStart: mockWeekStart,
      });
      expect(prisma.shoppingListArchiveState.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('setShoppingItemChecked', () => {
    const check = (dto: unknown) =>
      service.setShoppingItemChecked(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        dto as never,
      );

    it.each([
      [
        'isChecked jako napis',
        { productKey: 'mleko::l', isChecked: 'tak' },
        ['isChecked must be a boolean value'],
      ],
      [
        'pusty productKey',
        { productKey: '', isChecked: true },
        ['productKey must be longer than or equal to 1 characters'],
      ],
      [
        'productKey ponad 200 znaków',
        { productKey: 'x'.repeat(201), isChecked: true },
        ['productKey must be shorter than or equal to 200 characters'],
      ],
      [
        'brak data',
        undefined,
        [
          'productKey must be shorter than or equal to 200 characters',
          'productKey must be longer than or equal to 1 characters',
          'productKey must be a string',
          'isChecked must be a boolean value',
        ],
      ],
    ])('%s → VALIDATION_ERROR, Prisma nietknięta', async (_, dto, details) => {
      await expect(check(dto)).rejects.toMatchObject(validationError(details));
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('brak pozycji na liście → SHOPPING_ITEM_NOT_FOUND 404', async () => {
      // Snapshot bez pozycji o tym kluczu: mock `shoppingList.findUnique`
      // oddaje `items: []` niezależnie od `where`.
      await expect(
        check({ productKey: 'mleko::l', isChecked: true }),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'SHOPPING_ITEM_NOT_FOUND' },
      });
    });

    it('trafiona pozycja → zapis w snapshocie i w ShoppingItemCheck', async () => {
      prisma.shoppingList.findUnique.mockImplementation((args: any) =>
        Promise.resolve(
          args?.select?.id
            ? { id: 'sl-1', items: [{ productKey: 'mleko::l' }] }
            : { id: 'sl-1', isStale: false, items: [] },
        ),
      );
      prisma.shoppingListItem.update = jest.fn().mockResolvedValue({});
      prisma.shoppingItemCheck.upsert = jest
        .fn()
        .mockResolvedValue({ productKey: 'mleko::l', isChecked: true });

      await expect(
        check({ productKey: 'mleko::l', isChecked: true }),
      ).resolves.toEqual({ productKey: 'mleko::l', isChecked: true });
      expect(prisma.shoppingListItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isChecked: true } }),
      );
    });
  });
});

// ─── Dopisane z przepisu („brakuje mi") ───────────────────────────────────────

const mockRecipeId = '55555555-5555-4555-8555-555555555555';
const ING_MILK = '66666666-6666-4666-8666-666666666666';
const ING_OATS = '77777777-7777-4777-8777-777777777777';

const recipeIngredient = (
  id: string,
  name: string,
  normalizedAmount: number,
  normalizedUnit = 'g',
  department = 'Nabiał',
  gramsPerPiece: number | null = null,
) => ({
  id,
  name,
  normalizedAmount,
  normalizedUnit,
  department,
  ingredient: { gramsPerPiece },
});

/// Wiersz `ShoppingListExtra` tak, jak czyta go `loadExtras` — z przepisem,
/// z którego go dopisano (tytuł dla `addedFrom`, składniki dla masy sztuki).
const extraRow = (
  productKey: string,
  name: string,
  unit: string,
  amount: number,
  options: {
    id?: string;
    department?: string;
    recipeTitle?: string;
    recipeIngredients?: Array<{
      name: string;
      ingredient: { gramsPerPiece: number | null };
    }>;
  } = {},
) => ({
  id: options.id ?? `x-${productKey}`,
  productKey,
  name,
  unit,
  department: options.department ?? 'Inne',
  amount,
  recipe: {
    title: options.recipeTitle ?? 'Przepis',
    ingredients: options.recipeIngredients ?? [],
  },
});

describe('ShoppingListService — dopisane z przepisu', () => {
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

  const add = (data: object) =>
    service.addRecipeExtras(
      mockUserId,
      mockHouseholdId,
      mockWeekStart,
      data as any,
    );

  describe('agregacja', () => {
    it('powinno zsumować dopisane z tym samym produktem z planu w jeden wiersz', async () => {
      prisma.weeklyPlan.findUnique.mockResolvedValue(
        weekPlanWith([
          dayItem('i-1', 1, 'BREAKFAST', [ingredient('mleko', 200, 'ml')]),
        ]),
      );
      prisma.shoppingListExtra.findMany.mockResolvedValue([
        extraRow('mleko::ml', 'Mleko', 'ml', 100, { department: 'Nabiał' }),
      ]);

      const items = await service.getShoppingList(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
      );

      expect(items).toHaveLength(1);
      expect(findItem(items, 'mleko').totalAmount).toBe(300);
    });

    it('powinno zbudować listę z samych dopisanych, gdy plan jest pusty', async () => {
      prisma.shoppingListExtra.findMany.mockResolvedValue([
        extraRow('borówka::g', 'Borówka', 'g', 50, { department: 'Owoce' }),
      ]);

      const items = await service.getShoppingList(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
      );

      expect(items).toEqual([
        expect.objectContaining({
          productKey: 'borówka::g',
          totalAmount: 50,
          isChecked: false,
        }),
      ]);
    });

    it('nie powinno przebudowywać listy z samych dopisanych przy każdym odczycie', async () => {
      prisma.shoppingList.findUnique.mockResolvedValue({
        id: 'sl-1',
        isStale: false,
        rulesVersion: SHOPPING_LIST_RULES_VERSION,
        items: [
          {
            productKey: 'borówka::g',
            name: 'Borówka',
            unit: 'g',
            department: 'Owoce',
            totalAmount: 50,
            isChecked: false,
          },
        ],
      });
      prisma.shoppingListExtra.findFirst.mockResolvedValue({ id: 'x-1' });

      await service.getShoppingList(mockUserId, mockHouseholdId, mockWeekStart);

      expect(prisma.shoppingList.upsert).not.toHaveBeenCalled();
    });

    it('powinno podpisać pozycje stanu listy przepisami, z których je dopisano', async () => {
      prisma.shoppingListExtra.findMany.mockResolvedValue(
        ['Owsianka', 'Owsianka', 'Pancakes'].map((recipeTitle, index) =>
          extraRow('borówka::g', 'Borówka', 'g', 50, {
            id: `x-${index}`,
            department: 'Owoce',
            recipeTitle,
          }),
        ),
      );
      prisma.shoppingListArchive.findMany = jest.fn().mockResolvedValue([]);
      prisma.shoppingListArchiveState.findMany = jest
        .fn()
        .mockResolvedValue([]);

      const state = await service.getShoppingListState(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
      );

      expect(state.items[0].addedFrom).toEqual(['Owsianka', 'Pancakes']);
    });

    it('powinno przeliczyć dopisaną cebulę sprzed ujednolicenia (gramy) i złożyć ją z cebulą z planu', async () => {
      // Wiersz zapisany 21.09.2026 ma klucz `cebula::g` — tabela nie jest
      // przepisywana migracją, więc przeliczenie dzieje się przy odczycie.
      prisma.weeklyPlan.findUnique.mockResolvedValue(
        weekPlanWith([
          dayItem('i-1', 1, 'LUNCH', [
            ingredient('cebula', 1, 'szt', 'Warzywa', 110),
          ]),
        ]),
      );
      prisma.shoppingListExtra.findMany.mockResolvedValue([
        extraRow('cebula::g', 'Cebula', 'g', 220, {
          department: 'Warzywa',
          recipeIngredients: [
            { name: 'cebula', ingredient: { gramsPerPiece: 110 } },
          ],
        }),
      ]);

      const items = await service.getShoppingList(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
      );

      expect(items).toEqual([
        expect.objectContaining({
          productKey: 'cebula::szt',
          name: 'Cebula',
          unit: 'szt',
          totalAmount: 3,
        }),
      ]);
    });
  });

  describe('addRecipeExtras', () => {
    beforeEach(() => {
      prisma.recipe.findFirst.mockResolvedValue({
        id: mockRecipeId,
        servings: 2,
        ingredients: [
          recipeIngredient(ING_MILK, 'mleko', 200, 'ml'),
          recipeIngredient(ING_OATS, 'płatki owsiane', 50, 'g', 'Zboża'),
        ],
      });
    });

    it('powinno przeskalować ilości na porcje i zapisać je pod kluczem z listy', async () => {
      const result = await add({
        recipeId: mockRecipeId,
        servings: 1,
        ingredientIds: [ING_MILK, ING_OATS],
      });

      expect(result).toEqual({
        added: 2,
        productKeys: ['mleko::ml', 'płatki owsiane::g'],
      });
      expect(prisma.shoppingListExtra.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            householdId_weekStart_recipeId_productKey: {
              householdId: mockHouseholdId,
              weekStart: new Date(mockWeekStart),
              recipeId: mockRecipeId,
              productKey: 'mleko::ml',
            },
          },
          // Podmiana, nie dopisanie: drugie stuknięcie nie dubluje ilości.
          update: expect.objectContaining({ amount: 100 }),
          create: expect.objectContaining({ name: 'Mleko', amount: 100 }),
        }),
      );
    });

    it('powinno zapisać produkt z masą sztuki w sztukach — pod tym samym kluczem, co plan', async () => {
      prisma.recipe.findFirst.mockResolvedValue({
        id: mockRecipeId,
        servings: 2,
        ingredients: [
          recipeIngredient(ING_MILK, 'cebula', 220, 'g', 'Warzywa', 110),
        ],
      });

      const result = await add({
        recipeId: mockRecipeId,
        servings: 2,
        ingredientIds: [ING_MILK],
      });

      expect(result).toEqual({ added: 1, productKeys: ['cebula::szt'] });
      expect(prisma.shoppingListExtra.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ unit: 'szt', amount: 2 }),
          create: expect.objectContaining({
            productKey: 'cebula::szt',
            unit: 'szt',
            amount: 2,
          }),
        }),
      );
    });

    it('ponowne dopisanie zastępuje wiersz tego przepisu sprzed ujednolicenia, zamiast go dublować', async () => {
      prisma.recipe.findFirst.mockResolvedValue({
        id: mockRecipeId,
        servings: 2,
        ingredients: [
          recipeIngredient(ING_MILK, 'cebula', 220, 'g', 'Warzywa', 110),
        ],
      });
      prisma.shoppingListExtra.findMany.mockResolvedValue([
        extraRow('cebula::g', 'Cebula', 'g', 220, {
          id: 'x-stary',
          recipeIngredients: [
            { name: 'cebula', ingredient: { gramsPerPiece: 110 } },
          ],
        }),
      ]);

      await add({
        recipeId: mockRecipeId,
        servings: 2,
        ingredientIds: [ING_MILK],
      });

      expect(prisma.shoppingListExtra.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            householdId: mockHouseholdId,
            weekStart: new Date(mockWeekStart),
            recipeId: mockRecipeId,
          },
        }),
      );
      expect(prisma.shoppingListExtra.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['x-stary'] } },
      });
    });

    it('powinno szukać przepisu tylko w katalogu i w przepisach tego domu', async () => {
      await add({
        recipeId: mockRecipeId,
        servings: 2,
        ingredientIds: [ING_MILK, ING_OATS],
      });

      expect(prisma.recipe.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: mockRecipeId,
            isActive: true,
            OR: [{ isCatalog: true }, { householdId: mockHouseholdId }],
          },
        }),
      );
    });

    it('powinno odhaczone jako kupione przywrócić do kupienia i oznaczyć listę do przebudowy', async () => {
      await add({
        recipeId: mockRecipeId,
        servings: 2,
        ingredientIds: [ING_MILK, ING_OATS],
      });

      expect(prisma.shoppingListItem.updateMany).toHaveBeenCalledWith({
        where: {
          shoppingList: {
            householdId: mockHouseholdId,
            weekStart: new Date(mockWeekStart),
          },
          productKey: { in: ['mleko::ml', 'płatki owsiane::g'] },
        },
        data: { isChecked: false },
      });
      expect(prisma.shoppingItemCheck.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isChecked: false } }),
      );
      expect(prisma.shoppingList.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ isStale: true }),
        }),
      );
    });

    it('powinno odsłonić listę schowaną po wyczyszczeniu historii tygodnia', async () => {
      await add({
        recipeId: mockRecipeId,
        servings: 2,
        ingredientIds: [ING_MILK, ING_OATS],
      });

      expect(prisma.shoppingListArchiveState.deleteMany).toHaveBeenCalledWith({
        where: {
          householdId: mockHouseholdId,
          weekStart: new Date(mockWeekStart),
          currentArchiveId: null,
        },
      });
    });

    it('cudzy albo wycofany przepis → RECIPE_NOT_FOUND bez zapisu', async () => {
      prisma.recipe.findFirst.mockResolvedValue(null);

      await expect(
        add({ recipeId: mockRecipeId, servings: 2, ingredientIds: [ING_MILK] }),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'RECIPE_NOT_FOUND' },
      });
      expect(prisma.shoppingListExtra.upsert).not.toHaveBeenCalled();
    });

    it('składnik spoza przepisu → VALIDATION_ERROR bez zapisu', async () => {
      prisma.recipe.findFirst.mockResolvedValue({
        id: mockRecipeId,
        servings: 2,
        ingredients: [recipeIngredient(ING_MILK, 'mleko', 200, 'ml')],
      });

      await expect(
        add({
          recipeId: mockRecipeId,
          servings: 2,
          ingredientIds: [ING_MILK, ING_OATS],
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'VALIDATION_ERROR',
          details: ['ingredientIds must belong to the recipe'],
        },
      });
      expect(prisma.shoppingListExtra.upsert).not.toHaveBeenCalled();
    });

    it.each([
      ['porcje poza widełkami', { servings: 13, ingredientIds: [ING_MILK] }],
      ['pusta lista składników', { servings: 2, ingredientIds: [] }],
      ['składnik nie-UUID', { servings: 2, ingredientIds: ['mleko'] }],
    ])('%s → VALIDATION_ERROR przed membership', async (_, data) => {
      await expect(
        add({ recipeId: mockRecipeId, ...data }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'VALIDATION_ERROR' },
      });
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('removeShoppingExtra', () => {
    const remove = (productKey: string) =>
      service.removeShoppingExtra(mockUserId, mockHouseholdId, mockWeekStart, {
        productKey,
      });

    it('powinno zdjąć dopisane ze wszystkich przepisów i oznaczyć listę do przebudowy', async () => {
      prisma.shoppingListExtra.findMany.mockResolvedValue([
        extraRow('mleko::ml', 'Mleko', 'ml', 100, { id: 'x-1' }),
        extraRow('mleko::ml', 'Mleko', 'ml', 50, { id: 'x-2' }),
        extraRow('owies::g', 'Owies', 'g', 50, { id: 'x-3' }),
      ]);
      prisma.shoppingListExtra.deleteMany.mockResolvedValue({ count: 2 });

      await expect(remove('mleko::ml')).resolves.toEqual({ removed: 2 });
      expect(prisma.shoppingListExtra.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            householdId: mockHouseholdId,
            weekStart: new Date(mockWeekStart),
          },
        }),
      );
      expect(prisma.shoppingListExtra.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['x-1', 'x-2'] } },
      });
      expect(prisma.shoppingList.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ isStale: true }),
        }),
      );
    });

    it('produkt bez dopisanej części → SHOPPING_ITEM_NOT_FOUND', async () => {
      await expect(remove('mleko::ml')).rejects.toMatchObject({
        status: 404,
        response: { code: 'SHOPPING_ITEM_NOT_FOUND' },
      });
      expect(prisma.shoppingListExtra.deleteMany).not.toHaveBeenCalled();
      expect(prisma.shoppingList.upsert).not.toHaveBeenCalled();
    });

    it('zdjęcie „Cebula” w sztukach zabiera też dopisane sprzed ujednolicenia (w gramach)', async () => {
      prisma.shoppingListExtra.findMany.mockResolvedValue([
        extraRow('cebula::g', 'Cebula', 'g', 220, {
          id: 'x-stary',
          recipeIngredients: [
            { name: 'cebula', ingredient: { gramsPerPiece: 110 } },
          ],
        }),
      ]);
      prisma.shoppingListExtra.deleteMany.mockResolvedValue({ count: 1 });

      await expect(remove('cebula::szt')).resolves.toEqual({ removed: 1 });
      expect(prisma.shoppingListExtra.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['x-stary'] } },
      });
    });
  });
});
