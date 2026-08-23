import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
  dayOfWeek: 1,
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
        dayOfWeek: 1,
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
          dayOfWeek: 1,
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
  });

  // ─── removeWeekSlot ───────────────────────────────────────────────────────

  describe('removeWeekSlot', () => {
    it('powinno usunąć slot z planu', async () => {
      // Mock existing slot for removal
      prisma.planItem.findFirst.mockResolvedValue(mockPlanItem);

      await service.removeWeekSlot(mockUserId, mockHouseholdId, mockWeekStart, {
        dayOfWeek: 1,
        mealType: 'BREAKFAST',
      });

      expect(prisma.membership.findUnique).toHaveBeenCalled();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.removeWeekSlot('outsider', mockHouseholdId, mockWeekStart, {
          dayOfWeek: 1,
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

    it('powinno odrzucić gdy użytkownik nie jest członkiem', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.clearWeekPlan('outsider', mockHouseholdId, mockWeekStart),
      ).rejects.toThrow(ForbiddenException);
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
