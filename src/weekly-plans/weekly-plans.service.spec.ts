import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { WeeklyPlansService } from './weekly-plans.service';
import { PrismaService } from '../prisma/prisma.service';

// ─── Mock data ─────────────────────────────────────────────────────────────────

const mockHouseholdId = 'hh-1';
const mockUserId = 'user-1';
const mockRecipeId = 'recipe-uuid-1';
const mockWeekStart = '2026-04-13'; // Monday

const mockMembership = {
  id: 'mem-1',
  userId: mockUserId,
  householdId: mockHouseholdId,
  role: 'OWNER',
};

const mockPlanItem = {
  id: 'plan-item-1',
  weeklyPlanId: 'plan-1',
  dayOfWeek: 1,
  mealType: 'BREAKFAST',
  recipeId: mockRecipeId,
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
      update: jest.fn().mockResolvedValue({ ...mockShoppingItem, isChecked: true }),
      upsert: jest.fn().mockResolvedValue(mockShoppingItem),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    shoppingItemCheck: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({ ...mockShoppingItem, isChecked: true }),
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
    $transaction: jest.fn().mockImplementation((cbOrOps: any, opts?: any) => {
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
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeeklyPlansService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<WeeklyPlansService>(WeeklyPlansService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── upsertWeekSlot ───────────────────────────────────────────────────────

  describe('upsertWeekSlot', () => {
    it('powinno przypisać przepis do slotu (dzień + typ posiłku)', async () => {
      await service.upsertWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        { dayOfWeek: 1, mealType: 'BREAKFAST', recipeId: mockRecipeId },
      );

      expect(prisma.membership.findUnique).toHaveBeenCalled();
      expect(prisma.weeklyPlan.upsert).toHaveBeenCalled();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem household', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.upsertWeekSlot(
          'outsider',
          mockHouseholdId,
          mockWeekStart,
          { dayOfWeek: 1, mealType: 'BREAKFAST', recipeId: mockRecipeId },
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── removeWeekSlot ───────────────────────────────────────────────────────

  describe('removeWeekSlot', () => {
    it('powinno usunąć slot z planu', async () => {
      // Mock existing slot for removal
      prisma.planItem.findFirst.mockResolvedValue(mockPlanItem);

      await service.removeWeekSlot(
        mockUserId,
        mockHouseholdId,
        mockWeekStart,
        { dayOfWeek: 1, mealType: 'BREAKFAST' },
      );

      expect(prisma.membership.findUnique).toHaveBeenCalled();
    });

    it('powinno odrzucić gdy użytkownik nie jest członkiem', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(
        service.removeWeekSlot(
          'outsider',
          mockHouseholdId,
          mockWeekStart,
          { dayOfWeek: 1, mealType: 'BREAKFAST' },
        ),
      ).rejects.toThrow(ForbiddenException);
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
      await service.setShoppingItemChecked(
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
        service.setShoppingItemChecked(
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
        service.getByHouseholdAndWeek('outsider', mockHouseholdId, mockWeekStart),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
