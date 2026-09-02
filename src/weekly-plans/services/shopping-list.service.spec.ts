import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ShoppingListService } from './shopping-list.service';
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
      upsert: jest.fn().mockImplementation((args: any) => args.create),
    },
    shoppingItemCheck: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
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
