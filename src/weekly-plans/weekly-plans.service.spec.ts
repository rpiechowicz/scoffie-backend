import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WeeklyPlansService } from './weekly-plans.service';
import { ShoppingListService } from './services/shopping-list.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Mock data ─────────────────────────────────────────────────────────────────

const mockHouseholdId = 'hh-1';
const mockUserId = 'user-1';
const mockOtherUserId = 'user-2';
const mockRecipeId = 'recipe-uuid-1';
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
  { userId: mockUserId },
  { userId: mockOtherUserId },
];

const mockPlanItem = {
  id: 'plan-item-1',
  weeklyPlanId: 'plan-1',
  dayOfWeek: 'MON',
  mealType: 'BREAKFAST',
  recipeId: mockRecipeId,
  plannedServings: 2,
};

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
};

const mockWeeklyPlan = {
  id: 'plan-1',
  householdId: mockHouseholdId,
  weekStart: new Date(mockWeekStart),
  items: [
    {
      ...mockPlanItem,
      recipe: mockRecipe,
    },
  ],
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
    },
    weeklyPlan: {
      findUnique: jest.fn().mockResolvedValue(mockWeeklyPlan),
      upsert: jest.fn().mockResolvedValue({ id: 'plan-1' }),
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
    // Wycofana pula tygodniowa (WP-03). Delegaty zostają wyłącznie jako
    // czujniki: test `clearWeekPlan` dowodzi, że nikt ich już nie woła.
    sharedMealPlan: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    sharedMealPlanItem: {
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
      ).rejects.toThrow(ForbiddenException);
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

    it('wartość powyżej zakresu jest przycięta do 12', async () => {
      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        plannedServings: 99,
      });

      expectCreatedWithServings(12);
    });

    it('wartość poniżej zakresu jest podciągnięta do 1', async () => {
      // Koperty payloadów WS w gatewayu nie mają `@ValidateNested()` na polu
      // `data`, więc dekoratory DTO nigdy się nie uruchamiają i zero naprawdę
      // dochodzi do serwisu — klamra w kodzie jest jedyną obroną.
      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        plannedServings: 0,
      });

      expectCreatedWithServings(1);
    });
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

    it('jawnie podane porcje są klamrowane także na gałęzi UPDATE', async () => {
      mockExistingItem(2, []);

      await service.upsertWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        ...baseSlot,
        plannedServings: 99,
      });

      expectUpdatedWithServings(12);
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

      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        { ...baseSlot, participantIds: [mockUserId] },
      );

      expectCreatedWith([mockUserId], 1);
    });

    it('jawna pusta lista znaczy „Wspólne", nie „przejmij"', async () => {
      mockSlot({
        replaced: { plannedServings: 1, participantIds: [mockOtherUserId] },
      });

      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        { ...baseSlot, participantIds: [] },
      );

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

      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        { ...baseSlot, participantIds: [mockUserId] },
      );

      expectCreatedWith([mockUserId], 1);
    });

    it('jawne porcje wygrywają także przy podmianie', async () => {
      mockSlot({ replaced: { plannedServings: 4, participantIds: [] } });

      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        { ...baseSlot, plannedServings: 3 },
      );

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
      expect(prisma.membership.findMany).not.toHaveBeenCalled();
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
        response: { code: 'CONFLICT' },
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
        response: { code: 'VALIDATION_ERROR' },
        status: 400,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('duch po byłym domowniku nie blokuje podmiany i nie przechodzi dalej', async () => {
      // Stare danie było „dla nas dwojga" imiennie, ale drugi domownik odszedł.
      // Po odsianiu ducha zostaje pełny skład domu, czyli „Wspólne"; porcje z
      // reguły auto przeliczają się na jedną osobę.
      prisma.membership.findMany.mockResolvedValue([{ userId: mockUserId }]);
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
      ).rejects.toThrow(ForbiddenException);
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
      ).rejects.toThrow(ForbiddenException);
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
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── clearWeekPlan ────────────────────────────────────────────────────────

  describe('clearWeekPlan', () => {
    it('powinno usunąć wszystkie sloty danego tygodnia', async () => {
      await service.clearWeekPlan(mockUserId, mockHouseholdId, mockWeekStart);

      expect(prisma.membership.findUnique).toHaveBeenCalled();
    });

    it('nie dotyka już wycofanej puli tygodniowej', async () => {
      await service.clearWeekPlan(mockUserId, mockHouseholdId, mockWeekStart);

      expect(prisma.planItem.deleteMany).toHaveBeenCalled();
      expect(prisma.sharedMealPlan.findUnique).not.toHaveBeenCalled();
      expect(prisma.sharedMealPlanItem.deleteMany).not.toHaveBeenCalled();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.clearWeekPlan('outsider', mockHouseholdId, mockWeekStart),
      ).rejects.toThrow(ForbiddenException);
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
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── getByHouseholdAndWeek ────────────────────────────────────────────────

  describe('getByHouseholdAndWeek', () => {
    it('powinno zwrócić plan tygodniowy', async () => {
      const result = await service.getByHouseholdAndWeek(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
      );

      expect(prisma.membership.findUnique).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.getByHouseholdAndWeek(
          'outsider',
          mockHouseholdId,
          mockWeekStart,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
