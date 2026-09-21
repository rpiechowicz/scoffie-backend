import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { WeeklyPlansService } from './weekly-plans.service';
import { ShoppingListService } from './services/shopping-list.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Mock data ─────────────────────────────────────────────────────────────────

// Prawdziwe UUID v4: od Fazy 0 `ensureMembership` i DTO bramkują format
// (`assertUuid`/`@IsUUID()`), więc `hh-1` zatrzymałoby się na VALIDATION_ERROR
// zanim test dotarłby do logiki, którą sprawdza.
const mockHouseholdId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const mockUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mockOtherUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const mockRecipeId = '33333333-3333-4333-8333-333333333333';
const mockWeekStart = '2026-04-13'; // Monday

const mockMembership = {
  id: 'mem-1',
  userId: mockUserId,
  householdId: mockHouseholdId,
  role: 'OWNER',
};

// Gospodarstwo dwuosobowe, bo dopiero przy dwóch domownikach widać różnicę
// między regułą auto („Wspólne" = wszyscy) a twardą jedynką z `@default`.
const mockHouseholdMembers = [
  { userId: mockUserId, user: { preferences: null } },
  { userId: mockOtherUserId, user: { preferences: null } },
];

const mockRecipe = {
  id: mockRecipeId,
  title: 'Owsianka',
  description: 'Owsianka z mlekiem',
  mealType: 'BREAKFAST',
  difficulty: 'EASY',
  prepTimeMinutes: 10,
  servings: 2,
  imageUrl: null,
  nutritionKcal: 350,
  nutritionProtein: 12,
  nutritionFat: 8,
  nutritionCarbs: 55,
  nutritionFiber: 6,
  nutritionSalt: 0.2,
  isActive: true,
  authorId: mockUserId,
  householdId: mockHouseholdId,
  ingredients: [
    {
      name: 'Mleko',
      amount: 1,
      unit: 'l',
      normalizedAmount: 1,
      normalizedUnit: 'l',
      department: 'DAIRY',
    },
  ],
  allergens: ['milk'],
  dietTags: ['vegetarian'],
  // Pusta lista jak w wierszach sprzed backfillu — mapowanie ma ją
  // znormalizować do slotu bazowego, nie przepuścić pustą.
  suitableMealTypes: [] as string[],
};

// Wiersz w kształcie `PLAN_ITEM_INCLUDE` — tak wracają `create`/`update`/
// `findUniqueOrThrow`, a `withPlanItemRelationIds` czyta relacje bez `?.`.
const mockPlanItem = {
  id: 'plan-item-1',
  weeklyPlanId: 'plan-1',
  dayOfWeek: 'MON',
  mealType: 'BREAKFAST',
  recipeId: mockRecipeId,
  plannedServings: 2,
  recipe: mockRecipe,
  participants: [] as { userId: string }[],
  consumptions: [] as { userId: string }[],
};

const mockWeeklyPlan = {
  id: 'plan-1',
  householdId: mockHouseholdId,
  weekStart: new Date(mockWeekStart),
  items: [mockPlanItem],
};

const mockShoppingItem = {
  id: 'shop-1',
  householdId: mockHouseholdId,
  weekStart: new Date(mockWeekStart),
  productKey: 'mleko',
  name: 'Mleko',
  unit: 'l',
  department: 'DAIRY',
  totalAmount: 1,
  isChecked: false,
};

const makePrismaMock = () => {
  const mock: any = {
    membership: {
      findUnique: jest.fn().mockResolvedValue(mockMembership),
      findMany: jest.fn().mockResolvedValue(mockHouseholdMembers),
      count: jest.fn().mockResolvedValue(mockHouseholdMembers.length),
    },
    recipe: {
      findUnique: jest.fn().mockResolvedValue(mockRecipe),
      // `ensureRecipeForHousehold` filtruje po widocznosci (katalog albo wlasny
      // przepis domu), wiec pyta `findFirst`, nie `findUnique` po samym id.
      findFirst: jest.fn().mockResolvedValue(mockRecipe),
      // Bramka alergenów/wykluczeń przy ręcznym wstawianiu (`loadPlannableRecipes`).
      findMany: jest.fn().mockResolvedValue([]),
    },
    weeklyPlan: {
      findUnique: jest.fn().mockResolvedValue(mockWeeklyPlan),
      findUniqueOrThrow: jest.fn().mockResolvedValue(mockWeeklyPlan),
      create: jest.fn().mockResolvedValue({ ...mockWeeklyPlan, items: [] }),
      upsert: jest.fn().mockResolvedValue({ id: 'plan-1' }),
      // Zamek zapisu tygodnia (`lockWeekForWrite`).
      update: jest.fn().mockResolvedValue({ id: 'plan-1' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    planItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([mockPlanItem]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(mockPlanItem),
      update: jest.fn().mockResolvedValue(mockPlanItem),
      delete: jest.fn().mockResolvedValue(mockPlanItem),
      deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(mockPlanItem),
    },
    planItemParticipant: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    planItemConsumption: {
      upsert: jest.fn().mockResolvedValue({
        planItemId: mockPlanItem.id,
        userId: mockUserId,
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    shoppingList: {
      findUnique: jest.fn().mockImplementation((args?: any) => {
        if (args?.select?.id) {
          return Promise.resolve({
            id: 'sl-1',
            items: [{ productKey: mockShoppingItem.productKey }],
          });
        }

        return Promise.resolve({
          id: 'sl-1',
          items: [mockShoppingItem],
        });
      }),
      upsert: jest.fn().mockResolvedValue({ id: 'sl-1', items: [] }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    shoppingListItem: {
      findFirst: jest.fn().mockResolvedValue(mockShoppingItem),
      findMany: jest.fn().mockResolvedValue([mockShoppingItem]),
      update: jest
        .fn()
        .mockResolvedValue({ ...mockShoppingItem, isChecked: true }),
      upsert: jest.fn().mockResolvedValue(mockShoppingItem),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    shoppingItemCheck: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest
        .fn()
        .mockResolvedValue({ ...mockShoppingItem, isChecked: true }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    shoppingListArchiveState: {
      findUnique: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    shoppingListArchive: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn().mockImplementation((cbOrOps: any, _opts?: any) => {
      if (typeof cbOrOps === 'function') {
        return cbOrOps(mock);
      }
      return Promise.all(cbOrOps);
    }),
  };
  return mock;
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('WeeklyPlansService', () => {
  let service: WeeklyPlansService;
  let shoppingListService: ShoppingListService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeeklyPlansService,
        ShoppingListService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<WeeklyPlansService>(WeeklyPlansService);
    shoppingListService = module.get<ShoppingListService>(ShoppingListService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── upsertWeekSlot ───────────────────────────────────────────────────────

  describe('upsertWeekSlot', () => {
    it('powinno przypisać przepis do slotu (dzień + typ posiłku)', async () => {
      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        dayOfWeek: 'MON',
        mealType: 'BREAKFAST',
        recipeId: mockRecipeId,
      });

      expect(prisma.membership.findUnique).toHaveBeenCalled();
      expect(prisma.weeklyPlan.upsert).toHaveBeenCalled();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem household', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.upsertWeekSlot('outsider', mockHouseholdId, mockWeekStart, {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
          recipeId: mockRecipeId,
        }),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'NOT_HOUSEHOLD_MEMBER' },
      });
    });
  });

  // ─── upsertWeekSlot: walidacja DTO na wejściu ─────────────────────────────
  //
  // Dekoratory DTO nie działają na WS, więc serwis woła `validateDto` sam —
  // PRZED pierwszym zapytaniem. Złe wejście = VALIDATION_ERROR z listą
  // dozwolonych wartości, a Prisma nie jest tknięta (ani membership, ani
  // transakcja).

  describe('upsertWeekSlot — walidacja', () => {
    const valid = {
      dayOfWeek: 'MON',
      mealType: 'BREAKFAST',
      recipeId: mockRecipeId,
    } as const;

    const expectValidationError = async (
      dto: unknown,
      detail: string | RegExp,
    ) => {
      await expect(
        service.upsertWeekSlot(
          mockUserId,
          mockHouseholdId,
          mockWeekStart,
          dto as never,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'VALIDATION_ERROR',
          details: expect.arrayContaining([expect.stringMatching(detail)]),
        },
      });
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    };

    it("dayOfWeek 'MONDAY' → VALIDATION_ERROR z listą MON..SUN, bez transakcji", async () => {
      await expectValidationError(
        { ...valid, dayOfWeek: 'MONDAY' },
        /dayOfWeek must be one of the following values: MON, TUE, WED, THU, FRI, SAT, SUN/,
      );
    });

    it("mealType 'SUPPER' → VALIDATION_ERROR z listą slotów", async () => {
      await expectValidationError(
        { ...valid, mealType: 'SUPPER' },
        /mealType must be one of the following values: BREAKFAST, SECOND_BREAKFAST, LUNCH, AFTERNOON_SNACK, DINNER, SNACK/,
      );
    });

    it("recipeId 'abc' → VALIDATION_ERROR", async () => {
      await expectValidationError(
        { ...valid, recipeId: 'abc' },
        /recipeId must be a UUID/,
      );
    });

    it('brak data (undefined) → VALIDATION_ERROR z listą brakujących pól, nie TypeError', async () => {
      await expectValidationError(undefined, /dayOfWeek must be one of/);
    });

    it('nieznane pole (halucynacja asystenta) → VALIDATION_ERROR', async () => {
      await expectValidationError(
        { ...valid, portionSize: 3 },
        /property portionSize should not exist/,
      );
    });

    it('participantIds z nie-UUID → VALIDATION_ERROR', async () => {
      await expectValidationError(
        { ...valid, participantIds: ['ania'] },
        /each value in participantIds must be a UUID/,
      );
    });

    it('nie-UUID householdId → VALIDATION_ERROR z `ensureMembership`, zanim Prisma cokolwiek dostanie', async () => {
      await expect(
        service.upsertWeekSlot(mockUserId, 'hh-1', mockWeekStart, valid),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'VALIDATION_ERROR',
          details: ['householdId must be a UUID'],
        },
      });
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    });

    it('UUID wielkimi literami (iOS `uuidString`) przechodzi', async () => {
      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...valid,
        recipeId: mockRecipeId.toUpperCase(),
      });

      expect(prisma.planItem.create).toHaveBeenCalledTimes(1);
    });
  });

  // ─── upsertWeekSlot: porcje ───────────────────────────────────────────────

  // Reguła auto-porcji siedzi w prywatnym `resolvePlannedServings`, więc
  // sprawdzamy ją tak, jak widzi ją klient: po tym, co trafia do zapisu.
  describe('upsertWeekSlot — plannedServings', () => {
    const baseSlot = {
      dayOfWeek: 'MON',
      mealType: 'BREAKFAST',
      recipeId: mockRecipeId,
    } as const;

    const expectCreatedWithServings = (plannedServings: number) =>
      expect(prisma.planItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ plannedServings }),
        }),
      );

    it('„Wspólne" w gospodarstwie 2-osobowym daje 2 porcje', async () => {
      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expectCreatedWithServings(2);
    });

    it('jawna lista jednej osoby daje 1 porcję', async () => {
      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        participantIds: [mockUserId],
      });

      expectCreatedWithServings(1);
    });

    it('wymienienie wszystkich domowników liczy się jak „Wspólne"', async () => {
      // Lista nazywająca cały dom zwija się do pustej, więc obie formy tego
      // samego wyboru muszą dać tyle samo porcji — inaczej stepper skakałby
      // po samej zmianie sposobu zaznaczenia audytorium.
      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        participantIds: [mockUserId, mockOtherUserId],
      });

      expectCreatedWithServings(2);
    });

    it('jawnie podane porcje wygrywają z regułą', async () => {
      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        plannedServings: 4,
      });

      expectCreatedWithServings(4);
    });

    it('górna granica 12 przechodzi dosłownie', async () => {
      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        plannedServings: 12,
      });

      expectCreatedWithServings(12);
    });

    it.each([0, 99, 2.5, '2'])(
      'plannedServings %p → VALIDATION_ERROR zamiast cichego przycięcia',
      async (plannedServings) => {
        // Dawniej klamra w serwisie była jedyną obroną (dekoratory DTO nie
        // działały na WS) i 99 cicho stawało się 12. Od Fazy 0 `@Min/@Max`
        // odpalają się przez `validateDto`, więc klient i asystent dostają
        // jasny błąd z zakresem, a klamra została jako druga linia.
        await expect(
          service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
            ...baseSlot,
            plannedServings: plannedServings as number,
          }),
        ).rejects.toMatchObject({
          status: 400,
          response: {
            code: 'VALIDATION_ERROR',
            details: expect.arrayContaining([
              expect.stringMatching(/plannedServings must/),
            ]),
          },
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });

  // ─── upsertWeekSlot: porcje na istniejącym itemie ─────────────────────────

  // Gałąź UPDATE ma własną regułę, bo „pominięte" znaczy tu co innego niż przy
  // tworzeniu: nie „policz od zera", tylko „nie ruszaj tego, co użytkownik
  // wybrał ręcznie". Chipy audytorium i stepper porcji siedzą w jednym arkuszu,
  // a klient wysyła porcje wyłącznie po ruszeniu steppera — bez tego
  // rozróżnienia każde tapnięcie w chip kasowałoby „gotuję 4 porcje".
  describe('upsertWeekSlot — porcje na istniejącym itemie', () => {
    const baseSlot = {
      dayOfWeek: 'MON',
      mealType: 'BREAKFAST',
      recipeId: mockRecipeId,
    } as const;

    const expectUpdatedWithServings = (plannedServings: number) => {
      expect(prisma.planItem.create).not.toHaveBeenCalled();
      expect(prisma.planItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockPlanItem.id },
          data: expect.objectContaining({ plannedServings }),
        }),
      );
    };

    /**
     * Item, który już leży w slocie. Gałąź UPDATE potrzebuje jego STAREGO
     * audytorium, żeby odróżnić „porcje z reguły auto" od „porcje wybrane
     * ręcznie", więc mock musi oddać `participants` — sam `id` już nie
     * wystarczy.
     */
    const mockExistingItem = (
      plannedServings: number,
      participantIds: string[] = [],
    ) =>
      prisma.planItem.findFirst.mockResolvedValue({
        id: mockPlanItem.id,
        plannedServings,
        participants: participantIds.map((userId) => ({ userId })),
      });

    it('nadpisuje porcje na istniejącym itemie zamiast tworzyć nowy', async () => {
      mockExistingItem(2);

      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        plannedServings: 3,
      });

      expectUpdatedWithServings(3);
    });

    it('pominięte porcje nie kasują ręcznego wyboru przy zmianie audytorium', async () => {
      // 4 porcje przy „Wspólnym" w domu dwuosobowym — stare auto dałoby 2, więc
      // czwórka jest świadomym wyborem. Przełączenie na „tylko ja" nie ma prawa
      // jej ruszyć.
      mockExistingItem(4, []);

      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        participantIds: [mockUserId],
      });

      expectUpdatedWithServings(4);
    });

    it('pominięte porcje nie kasują ręcznego wyboru przy niezmienionym audytorium', async () => {
      mockExistingItem(4, []);

      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expectUpdatedWithServings(4);
    });

    it('pominięte porcje przeliczają się, gdy poprzednia wartość była z reguły auto', async () => {
      // 2 porcje przy „Wspólnym" w domu dwuosobowym to dokładnie stare auto,
      // więc nikt tego nie nadpisywał. Zejście do „tylko ja" musi zejść do 1 —
      // inaczej lista zakupów kupowałaby dla dwojga.
      mockExistingItem(2, []);

      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        participantIds: [mockUserId],
      });

      expectUpdatedWithServings(1);
    });

    it('pominięte porcje rosną z audytorium, gdy poprzednia wartość była z reguły auto', async () => {
      // Odwrotny kierunek: „tylko ja" (1 uczestnik, auto = 1) → „Wspólne".
      mockExistingItem(1, [mockUserId]);

      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expectUpdatedWithServings(2);
    });

    it('jawnie podane porcje wygrywają nawet z zapisanym ręcznym wyborem', async () => {
      mockExistingItem(4, []);

      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        participantIds: [mockUserId],
        plannedServings: 3,
      });

      expectUpdatedWithServings(3);
    });

    it('porcje poza zakresem nie dochodzą do gałęzi UPDATE (VALIDATION_ERROR)', async () => {
      mockExistingItem(2, []);

      await expect(
        service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
          ...baseSlot,
          plannedServings: 99,
        }),
      ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });

      expect(prisma.planItem.update).not.toHaveBeenCalled();
    });

    // ─── changeKind ─────────────────────────────────────────────────────────
    //
    // Rozróżnienie istnieje wyłącznie po to, żeby gateway wiedział, KIEDY
    // zawracać głowę drugiemu domownikowi. Bez niego przesunięcie steppera
    // porcji wyglądało dla powiadomień identycznie jak wstawienie nowego dania
    // — i dlatego każdy zapis porcji wysyłał komuś push.

    it('nowe danie w slocie zgłasza się jako CREATED', async () => {
      prisma.planItem.findFirst.mockResolvedValue(null);

      const result = await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expect(result).toEqual(
        expect.objectContaining({ changeKind: 'CREATED' }),
      );
    });

    it('sama zmiana porcji zgłasza się jako DETAILS_CHANGED, nie CREATED', async () => {
      mockExistingItem(2, []);

      const result = await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        { ...baseSlot, plannedServings: 3 },
      );

      expect(result).toEqual(
        expect.objectContaining({ changeKind: 'DETAILS_CHANGED' }),
      );
    });

    it('powtórzony zapis bez żadnej zmiany zgłasza się jako NOOP', async () => {
      // Tak wygląda ponowienie po nieodebranym ACK-u: ten sam upsert leci
      // drugi raz. Nie jest zdarzeniem i nie ma prawa niczego wysłać.
      mockExistingItem(2, []);

      const result = await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        { ...baseSlot, plannedServings: 2 },
      );

      expect(result).toEqual(expect.objectContaining({ changeKind: 'NOOP' }));
    });
  });

  // ─── upsertWeekSlot — replaceRecipeId ─────────────────────────────────────
  //
  // „Zmień danie" w jednej transakcji. Do tej pory klient robił to jako
  // REMOVE_SLOT + UPSERT_SLOT: slot stał chwilę pusty, drugi domownik dostawał
  // dwa zdarzenia, a przerwany zapis zostawiał pustkę. Tu stary wariant znika
  // i nowy wchodzi w tym samym `$transaction`.

  describe('upsertWeekSlot — replaceRecipeId', () => {
    const oldRecipeId = '11111111-1111-4111-8111-111111111111';
    const newRecipeId = '22222222-2222-4222-8222-222222222222';
    const replacedItemId = 'plan-item-old';

    const baseSlot = {
      dayOfWeek: 'MON',
      mealType: 'BREAKFAST',
      recipeId: newRecipeId,
      replaceRecipeId: oldRecipeId,
    } as const;

    /**
     * `findFirst` jest wołany dwa razy: raz o stary wariant (po
     * `replaceRecipeId`), raz o ewentualny istniejący item nowego przepisu.
     * Mock rozróżnia je po `where.recipeId`, żeby test nie zależał od
     * kolejności wywołań.
     */
    const mockSlot = (params: {
      replaced?: { plannedServings: number; participantIds: string[] } | null;
      existing?: { plannedServings: number; participantIds: string[] } | null;
    }) =>
      prisma.planItem.findFirst.mockImplementation(({ where }: any) => {
        if (where.recipeId === oldRecipeId) {
          return Promise.resolve(
            params.replaced
              ? {
                  id: replacedItemId,
                  plannedServings: params.replaced.plannedServings,
                  participants: params.replaced.participantIds.map(
                    (userId) => ({ userId }),
                  ),
                }
              : null,
          );
        }
        if (where.recipeId === newRecipeId) {
          return Promise.resolve(
            params.existing
              ? {
                  id: mockPlanItem.id,
                  plannedServings: params.existing.plannedServings,
                  participants: params.existing.participantIds.map(
                    (userId) => ({ userId }),
                  ),
                }
              : null,
          );
        }
        return Promise.resolve(null);
      });

    const expectCreatedWith = (
      participantIds: string[],
      plannedServings: number,
    ) =>
      expect(prisma.planItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            recipeId: newRecipeId,
            plannedServings,
            participants: {
              create: participantIds.map((userId) => ({ userId })),
            },
          }),
        }),
      );

    beforeEach(() => {
      prisma.recipe.findUnique.mockResolvedValue({
        ...mockRecipe,
        id: newRecipeId,
      });
    });

    it('kasuje stary wariant i tworzy nowy w tej samej transakcji', async () => {
      mockSlot({ replaced: { plannedServings: 2, participantIds: [] } });

      const result = await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.planItem.delete).toHaveBeenCalledWith({
        where: { id: replacedItemId },
      });
      expect(prisma.planItem.create).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        expect.objectContaining({
          changeKind: 'REPLACED',
          replacedItemIds: [replacedItemId],
        }),
      );
    });

    it('kasuje stary wariant PRZED liczeniem limitów slotu', async () => {
      mockSlot({ replaced: { plannedServings: 2, participantIds: [] } });
      const order: string[] = [];
      prisma.planItem.delete.mockImplementation(() => {
        order.push('delete');
        return Promise.resolve(mockPlanItem);
      });
      prisma.planItem.count.mockImplementation(() => {
        order.push('count');
        return Promise.resolve(0);
      });

      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expect(order[0]).toBe('delete');
      expect(order.filter((step) => step === 'count')).toHaveLength(3);
    });

    it('bez participantIds przejmuje audytorium starego dania', async () => {
      mockSlot({
        replaced: { plannedServings: 1, participantIds: [mockOtherUserId] },
      });

      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expectCreatedWith([mockOtherUserId], 1);
    });

    it('jawne participantIds wygrywa z przejętym audytorium', async () => {
      mockSlot({
        replaced: { plannedServings: 1, participantIds: [mockOtherUserId] },
      });

      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        participantIds: [mockUserId],
      });

      expectCreatedWith([mockUserId], 1);
    });

    it('jawna pusta lista znaczy „Wspólne", nie „przejmij"', async () => {
      mockSlot({
        replaced: { plannedServings: 1, participantIds: [mockOtherUserId] },
      });

      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        participantIds: [],
      });

      expectCreatedWith([], 2);
    });

    it('ręcznie wybrane porcje przeżywają podmianę dania', async () => {
      // 4 porcje w domu 2-osobowym przy „Wspólne" — nie ma jak wyjść z reguły
      // auto, więc to świadomy wybór.
      mockSlot({ replaced: { plannedServings: 4, participantIds: [] } });

      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expectCreatedWith([], 4);
    });

    it('porcje z reguły auto przeliczają się z nowego audytorium', async () => {
      // 2 porcje przy „Wspólne" w domu 2-osobowym = auto. Zawężenie do jednej
      // osoby ma dać 1, nie zostawić dwóch.
      mockSlot({ replaced: { plannedServings: 2, participantIds: [] } });

      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        participantIds: [mockUserId],
      });

      expectCreatedWith([mockUserId], 1);
    });

    it('jawne porcje wygrywają także przy podmianie', async () => {
      mockSlot({ replaced: { plannedServings: 4, participantIds: [] } });

      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        plannedServings: 3,
      });

      expectCreatedWith([], 3);
    });

    it('replaceRecipeId równe recipeId niczego nie kasuje', async () => {
      // Tak wygląda edycja audytorium w arkuszu: klient wysyła edytowany
      // przepis również jako „stary". To zwykły upsert, nie podmiana.
      prisma.planItem.findFirst.mockResolvedValue({
        id: mockPlanItem.id,
        plannedServings: 2,
        participants: [],
      });

      const result = await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        { ...baseSlot, replaceRecipeId: newRecipeId, plannedServings: 3 },
      );

      expect(prisma.planItem.delete).not.toHaveBeenCalled();
      expect(prisma.planItem.create).not.toHaveBeenCalled();
      // Domownicy są czytani, ale tylko dla bramki alergenów/wykluczeń —
      // audytorium nie jest przeliczane (zapis zostaje DETAILS_CHANGED).
      expect(result).toEqual(
        expect.objectContaining({
          changeKind: 'DETAILS_CHANGED',
          replacedItemIds: [],
        }),
      );
    });

    it('podmiana na przepis, który już leży w slocie, aktualizuje go zamiast tworzyć', async () => {
      mockSlot({
        replaced: { plannedServings: 2, participantIds: [] },
        existing: { plannedServings: 2, participantIds: [] },
      });

      const result = await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expect(prisma.planItem.delete).toHaveBeenCalledWith({
        where: { id: replacedItemId },
      });
      expect(prisma.planItem.create).not.toHaveBeenCalled();
      expect(prisma.planItem.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: mockPlanItem.id } }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          changeKind: 'REPLACED',
          replacedItemIds: [replacedItemId],
        }),
      );
    });

    it('brak starego wariantu degraduje się do zwykłego wstawienia', async () => {
      // Drugi telefon zdążył usunąć stare danie. Nie ma czego kasować, ale
      // nowe danie ma wejść.
      mockSlot({ replaced: null });

      const result = await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expect(prisma.planItem.delete).not.toHaveBeenCalled();
      expect(prisma.planItem.create).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        expect.objectContaining({ changeKind: 'CREATED', replacedItemIds: [] }),
      );
    });

    it('naruszenie unikalności przy tworzeniu to CONFLICT, nie 500', async () => {
      mockSlot({ replaced: { plannedServings: 2, participantIds: [] } });
      prisma.planItem.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.upsertWeekSlot(
          mockUserId,
          mockHouseholdId,
          mockWeekStart,
          baseSlot,
        ),
      ).rejects.toMatchObject({
        response: { code: 'PLAN_SLOT_DUPLICATE' },
        status: 409,
      });
    });

    it('nie-UUID w replaceRecipeId to VALIDATION_ERROR, zanim ruszy transakcja', async () => {
      await expect(
        service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
          ...baseSlot,
          replaceRecipeId: 'abc',
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'VALIDATION_ERROR',
          details: ['replaceRecipeId must be a UUID'],
        },
        status: 400,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    });

    it('duch po byłym domowniku nie blokuje podmiany i nie przechodzi dalej', async () => {
      // Stare danie było „dla nas dwojga" imiennie, ale drugi domownik odszedł.
      // Po odsianiu ducha zostaje pełny skład domu, czyli „Wspólne"; porcje z
      // reguły auto przeliczają się na jedną osobę.
      prisma.membership.findMany.mockResolvedValue([
        { userId: mockUserId, user: { preferences: null } },
      ]);
      mockSlot({
        replaced: {
          plannedServings: 2,
          participantIds: [mockUserId, 'ghost-user'],
        },
      });

      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        baseSlot,
      );

      expectCreatedWith([], 1);
    });
  });

  // ─── removeWeekSlot ───────────────────────────────────────────────────────

  describe('removeWeekSlot', () => {
    it('powinno usunąć slot z planu', async () => {
      // Mock existing slot for removal
      prisma.planItem.findFirst.mockResolvedValue(mockPlanItem);

      await service.removeWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        dayOfWeek: 'MON',
        mealType: 'BREAKFAST',
      });

      expect(prisma.membership.findUnique).toHaveBeenCalled();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.removeWeekSlot('outsider', mockHouseholdId, mockWeekStart, {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
        }),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'NOT_HOUSEHOLD_MEMBER' },
      });
    });

    it("dayOfWeek 'Monday' → VALIDATION_ERROR z listą dni, Prisma nietknięta", async () => {
      await expect(
        service.removeWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
          dayOfWeek: 'Monday' as never,
          mealType: 'BREAKFAST',
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'VALIDATION_ERROR',
          details: [
            'dayOfWeek must be one of the following values: MON, TUE, WED, THU, FRI, SAT, SUN',
          ],
        },
      });
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('recipeId nie-UUID → VALIDATION_ERROR (zamiast P2023 z Postgresa)', async () => {
      await expect(
        service.removeWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
          recipeId: 'recipe-uuid-1',
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'VALIDATION_ERROR',
          details: ['recipeId must be a UUID'],
        },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('brak data → VALIDATION_ERROR, nie TypeError', async () => {
      await expect(
        service.removeWeekSlot(
          mockUserId,
          mockHouseholdId,
          mockWeekStart,
          undefined as never,
        ),
      ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    });
  });

  // ─── setMealEaten ─────────────────────────────────────────────────────────

  describe('setMealEaten', () => {
    beforeEach(() => {
      prisma.planItem.findFirst.mockResolvedValue(mockPlanItem);
    });

    it('powinno zapisać znacznik zjedzenia dla użytkownika', async () => {
      await service.setMealEaten(mockUserId, mockHouseholdId, mockWeekStart, {
        dayOfWeek: 'MON',
        mealType: 'BREAKFAST',
        recipeId: mockRecipeId,
        isEaten: true,
      });

      expect(prisma.planItemConsumption.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            planItemId_userId: {
              planItemId: mockPlanItem.id,
              userId: mockUserId,
            },
          },
        }),
      );
      expect(prisma.planItemConsumption.deleteMany).not.toHaveBeenCalled();
    });

    it('powinno zdjąć znacznik gdy isEaten=false', async () => {
      await service.setMealEaten(mockUserId, mockHouseholdId, mockWeekStart, {
        dayOfWeek: 'MON',
        mealType: 'BREAKFAST',
        recipeId: mockRecipeId,
        isEaten: false,
      });

      expect(prisma.planItemConsumption.deleteMany).toHaveBeenCalledWith({
        where: { planItemId: mockPlanItem.id, userId: mockUserId },
      });
      expect(prisma.planItemConsumption.upsert).not.toHaveBeenCalled();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.setMealEaten('outsider', mockHouseholdId, mockWeekStart, {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
          recipeId: mockRecipeId,
          isEaten: true,
        }),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'NOT_HOUSEHOLD_MEMBER' },
      });
    });

    it('powinno odrzucić gdy posiłku nie ma w slocie', async () => {
      prisma.planItem.findFirst.mockResolvedValue(null);

      await expect(
        service.setMealEaten(mockUserId, mockHouseholdId, mockWeekStart, {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
          recipeId: mockRecipeId,
          isEaten: true,
        }),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'PLAN_ITEM_NOT_FOUND' },
      });
    });

    it('brak wiersza tygodnia → PLAN_ITEM_NOT_FOUND 404, nie goły NotFoundException', async () => {
      prisma.weeklyPlan.findUnique.mockResolvedValue(null);

      await expect(
        service.setMealEaten(mockUserId, mockHouseholdId, mockWeekStart, {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
          recipeId: mockRecipeId,
          isEaten: true,
        }),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'PLAN_ITEM_NOT_FOUND' },
      });
      expect(prisma.planItem.findFirst).not.toHaveBeenCalled();
    });

    it("isEaten 'yes' → VALIDATION_ERROR, nic nie zapisane", async () => {
      // Truthy napis dawniej odhaczał posiłek — teraz `@IsBoolean()` działa
      // także na WS, a serwis porównuje `=== true`.
      await expect(
        service.setMealEaten(mockUserId, mockHouseholdId, mockWeekStart, {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
          recipeId: mockRecipeId,
          isEaten: 'yes' as never,
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'VALIDATION_ERROR',
          details: ['isEaten must be a boolean value'],
        },
      });
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
      expect(prisma.planItemConsumption.upsert).not.toHaveBeenCalled();
      expect(prisma.planItemConsumption.deleteMany).not.toHaveBeenCalled();
    });

    it('brak recipeId → VALIDATION_ERROR', async () => {
      await expect(
        service.setMealEaten(mockUserId, mockHouseholdId, mockWeekStart, {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
          isEaten: true,
        } as never),
      ).rejects.toMatchObject({
        response: {
          code: 'VALIDATION_ERROR',
          details: ['recipeId must be a UUID'],
        },
      });
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    });

    it('oddaje item w kształcie z listy przepisów (suitableMealTypes znormalizowane)', async () => {
      const result = await service.setMealEaten(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
          recipeId: mockRecipeId,
          isEaten: true,
        },
      );

      expect(result).toEqual(
        expect.objectContaining({
          participantIds: [],
          eatenByUserIds: [],
          recipe: expect.objectContaining({
            allergens: ['milk'],
            dietTags: ['vegetarian'],
            suitableMealTypes: ['BREAKFAST'],
          }),
        }),
      );
      expect(result).not.toHaveProperty('participants');
      expect(result).not.toHaveProperty('consumptions');
    });
  });

  // ─── clearWeekPlan ────────────────────────────────────────────────────────

  describe('clearWeekPlan', () => {
    it('powinno usunąć wszystkie sloty danego tygodnia', async () => {
      await service.clearWeekPlan(mockUserId, mockHouseholdId, mockWeekStart);

      expect(prisma.membership.findUnique).toHaveBeenCalled();
    });

    it('kasuje sloty przez PlanItem — jedyne źródło prawdy po WP-03', async () => {
      await service.clearWeekPlan(mockUserId, mockHouseholdId, mockWeekStart);

      expect(prisma.planItem.deleteMany).toHaveBeenCalled();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.clearWeekPlan('outsider', mockHouseholdId, mockWeekStart),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'NOT_HOUSEHOLD_MEMBER' },
      });
    });
  });

  // ─── Wycofane API (WP-03) ─────────────────────────────────────────────────
  //
  // Pula tygodniowa i handlery „plan po id" nie mają żadnego klienta. Strażnik
  // przed ich cichym powrotem: metoda ma NIE istnieć, nie tylko nie być
  // wołana.

  describe('wycofane metody puli tygodniowej', () => {
    it.each([
      'listByHousehold',
      'create',
      'addItem',
      'removeItem',
      'getSharedMealPlan',
      'saveSharedMealPlan',
    ])('%s nie istnieje już w serwisie', (method) => {
      expect(
        (service as unknown as Record<string, unknown>)[method],
      ).toBeUndefined();
    });
  });

  // ─── setShoppingItemChecked ───────────────────────────────────────────────

  describe('setShoppingItemChecked', () => {
    it('powinno sprawdzić członkostwo przed zaznaczeniem produktu', async () => {
      await shoppingListService.setShoppingItemChecked(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        { productKey: 'mleko', isChecked: true },
      );

      expect(prisma.membership.findUnique).toHaveBeenCalled();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        shoppingListService.setShoppingItemChecked(
          'outsider',
          mockHouseholdId,
          mockWeekStart,
          { productKey: 'mleko', isChecked: true },
        ),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'NOT_HOUSEHOLD_MEMBER' },
      });
    });

    it("isChecked 'tak' → VALIDATION_ERROR, membership nie sprawdzane", async () => {
      await expect(
        shoppingListService.setShoppingItemChecked(
          mockUserId,
          mockHouseholdId,
          mockWeekStart,
          { productKey: 'mleko', isChecked: 'tak' as never },
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'VALIDATION_ERROR',
          details: ['isChecked must be a boolean value'],
        },
      });
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ─── getByHouseholdAndWeek ────────────────────────────────────────────────

  describe('getByHouseholdAndWeek', () => {
    it('powinno zwrócić plan tygodniowy z weekStart jako YYYY-MM-DD', async () => {
      const result = await service.getByHouseholdAndWeek(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
      );

      expect(prisma.membership.findUnique).toHaveBeenCalled();
      expect(prisma.weeklyPlan.create).not.toHaveBeenCalled();
      // Jeden format tygodnia na drucie — ten sam, co w kopercie i w
      // broadcastach; dotąd szedł tu ISO datetime z Prismy.
      expect(result.weekStart).toBe(mockWeekStart);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          id: 'plan-item-1',
          participantIds: [],
          eatenByUserIds: [],
        }),
      );
    });

    it('przepis w itemie ma allergens, dietTags i znormalizowane suitableMealTypes', async () => {
      const result = await service.getByHouseholdAndWeek(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
      );

      const select =
        prisma.weeklyPlan.findUnique.mock.calls[0][0].include.items.include
          .recipe.select;
      expect(select).toEqual(
        expect.objectContaining({
          allergens: true,
          dietTags: true,
          suitableMealTypes: true,
        }),
      );
      expect(result.items[0].recipe).toEqual(
        expect.objectContaining({
          allergens: ['milk'],
          dietTags: ['vegetarian'],
          // Pusta lista z bazy = „tylko slot bazowy", jak w `recipes:findAll`.
          suitableMealTypes: ['BREAKFAST'],
        }),
      );
    });

    it('pusty tydzień → pusty plan w pełnym kształcie, nie 404', async () => {
      // iOS dekoduje `id` i `weekStart` jako wymagane, a asystent nie może
      // dostawać 404 za „jeszcze nic nie zaplanowano" — wiersz zakładamy
      // przy odczycie (precedens: `clearWeekPlan` zostawia pusty wiersz).
      prisma.weeklyPlan.findUnique.mockResolvedValue(null);
      prisma.weeklyPlan.create.mockResolvedValue({
        id: 'plan-new',
        householdId: mockHouseholdId,
        weekStart: new Date(mockWeekStart),
        items: [],
      });

      const result = await service.getByHouseholdAndWeek(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
      );

      expect(prisma.weeklyPlan.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            householdId: mockHouseholdId,
            weekStart: new Date(`${mockWeekStart}T00:00:00.000Z`),
          },
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          id: 'plan-new',
          householdId: mockHouseholdId,
          weekStart: mockWeekStart,
          items: [],
        }),
      );
    });

    it('wyścig dwóch telefonów o pusty tydzień (P2002) → ponowny odczyt, nie CONFLICT', async () => {
      prisma.weeklyPlan.findUnique.mockResolvedValue(null);
      prisma.weeklyPlan.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prisma.weeklyPlan.findUniqueOrThrow.mockResolvedValue({
        ...mockWeeklyPlan,
        id: 'plan-from-other-phone',
      });

      const result = await service.getByHouseholdAndWeek(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
      );

      expect(prisma.weeklyPlan.findUniqueOrThrow).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        expect.objectContaining({
          id: 'plan-from-other-phone',
          weekStart: mockWeekStart,
        }),
      );
      expect(result.items).toHaveLength(1);
    });

    it('inny błąd Prismy przy zakładaniu wiersza leci dalej', async () => {
      prisma.weeklyPlan.findUnique.mockResolvedValue(null);
      prisma.weeklyPlan.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.getByHouseholdAndWeek(
          mockUserId,
          mockHouseholdId,
          mockWeekStart,
        ),
      ).rejects.toThrow('db down');
      expect(prisma.weeklyPlan.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('nie-UUID householdId → VALIDATION_ERROR przed jakimkolwiek zapytaniem', async () => {
      await expect(
        service.getByHouseholdAndWeek(mockUserId, 'hh-1', mockWeekStart),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'VALIDATION_ERROR',
          details: ['householdId must be a UUID'],
        },
      });
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
      expect(prisma.weeklyPlan.findUnique).not.toHaveBeenCalled();
    });

    it('weekStart, który nie jest poniedziałkiem → VALIDATION_ERROR, wiersz nie powstaje', async () => {
      await expect(
        service.getByHouseholdAndWeek(
          mockUserId,
          mockHouseholdId,
          '2026-04-14',
        ),
      ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
      expect(prisma.weeklyPlan.create).not.toHaveBeenCalled();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.getByHouseholdAndWeek(
          'outsider',
          mockHouseholdId,
          mockWeekStart,
        ),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'NOT_HOUSEHOLD_MEMBER' },
      });
    });
  });
});
