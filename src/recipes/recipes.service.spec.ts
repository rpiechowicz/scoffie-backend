import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { RecipesService } from './recipes.service';
import { RecipesCacheService } from './recipes-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveSuitableMealTypes } from './suitable-meal-types.util';

// ─── Mock data ─────────────────────────────────────────────────────────────────

const mockUserId = '11111111-1111-4111-8111-111111111111';
const mockHouseholdId = '22222222-2222-4222-8222-222222222222';

const macros = (
  kcal: number | null,
  protein: number | null,
  carbs: number | null,
  fat: number | null,
  fiber: number | null,
) => ({
  nutritionKcalPer100: kcal,
  nutritionProteinPer100: protein,
  nutritionCarbsPer100: carbs,
  nutritionFatPer100: fat,
  nutritionFiberPer100: fiber,
});

const oats = {
  id: 'ing-oats',
  name: 'płatki owsiane',
  category: 'Zboża i makarony',
  ...macros(379, 13.2, 57.6, 6.9, 10.1),
  gramsPerPiece: null,
};
const milk = {
  id: 'ing-milk',
  name: 'mleko',
  category: 'Nabiał',
  ...macros(61, 3.3, 4.7, 3.3, 0),
  gramsPerPiece: null,
};
const banana = {
  id: 'ing-banana',
  name: 'banan',
  category: 'Owoce',
  ...macros(89, 1.1, 20, 0.3, 2.6),
  gramsPerPiece: 120,
};
const bananaNoPiece = { ...banana, id: 'ing-banana-np', gramsPerPiece: null };
const spice = {
  id: 'ing-spice',
  name: 'przyprawa uniwersalna',
  category: 'Przyprawy i sosy',
  ...macros(0, 0, 0, 0, 0),
  gramsPerPiece: null,
};
const noMacros = {
  id: 'ing-x',
  name: 'tajemniczy proszek',
  category: 'Inne',
  ...macros(null, null, null, null, null),
  gramsPerPiece: null,
};

const ALL_INGREDIENTS = [oats, milk, banana, bananaNoPiece, spice, noMacros];

const makePrismaMock = () => {
  const mock: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: mockUserId }),
    },
    membership: {
      findUnique: jest.fn().mockResolvedValue({ id: 'mem-1' }),
    },
    ingredient: {
      // Zwraca tylko te składniki, o które pytano — jak baza.
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const ids: string[] = where.id.in;
        return Promise.resolve(
          ALL_INGREDIENTS.filter((ingredient) => ids.includes(ingredient.id)),
        );
      }),
    },
    recipe: {
      create: jest.fn().mockImplementation((args: any) =>
        Promise.resolve({ id: 'recipe-1', ...args.data, ingredients: [] }),
      ),
    },
    $transaction: jest.fn().mockImplementation((cbOrOps: any) =>
      typeof cbOrOps === 'function' ? cbOrOps(mock) : Promise.all(cbOrOps),
    ),
  };
  return mock;
};

const baseDto = (over: Record<string, unknown> = {}) =>
  ({
    title: 'Owsianka z bananem',
    description: 'Płatki na mleku',
    mealType: 'BREAKFAST',
    difficulty: 'EASY',
    prepTimeMinutes: 10,
    servings: 2,
    householdId: mockHouseholdId,
    ...over,
  }) as any;

const oatsAndMilk = [
  { ingredientId: 'ing-oats', amount: 100, unit: 'g' },
  { ingredientId: 'ing-milk', amount: 300, unit: 'ml' },
];

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('RecipesService.create', () => {
  let service: RecipesService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let cache: { invalidateRecipesList: jest.Mock };

  beforeEach(async () => {
    prisma = makePrismaMock();
    cache = { invalidateRecipesList: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecipesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RecipesCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<RecipesService>(RecipesService);
  });

  const createdData = () => prisma.recipe.create.mock.calls[0][0].data;

  it('liczy makra ze składników i ignoruje wartości z DTO', async () => {
    await service.create(
      mockUserId,
      baseDto({
        ingredients: oatsAndMilk,
        nutritionKcal: 9999,
        nutritionProtein: 1,
      }),
    );

    // 100 g owsianki + 300 ml mleka: 379 + 3×61 = 562 kcal itd., zaokrąglone
    // do całości tak samo jak w skrypcie przeliczania.
    expect(createdData()).toEqual(
      expect.objectContaining({
        nutritionKcal: 562,
        nutritionProtein: 23,
        nutritionCarbs: 72,
        nutritionFat: 17,
        nutritionFiber: 10,
        nutritionSalt: 0,
      }),
    );
  });

  it('nutritionSalt zostaje z DTO, bo składniki nie mają sodu', async () => {
    await service.create(
      mockUserId,
      baseDto({ ingredients: oatsAndMilk, nutritionSalt: 1.5 }),
    );

    expect(createdData().nutritionSalt).toBe(1.5);
  });

  it('przelicza sztuki przez gramsPerPiece', async () => {
    await service.create(
      mockUserId,
      baseDto({
        ingredients: [{ ingredientId: 'ing-banana', amount: 2, unit: 'szt' }],
      }),
    );

    // 2 × 120 g = 240 g; 89 kcal × 2,4 = 213,6 → 214.
    expect(createdData().nutritionKcal).toBe(214);
  });

  it('odrzuca przepis ze składnikiem bez makr', async () => {
    await expect(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [{ ingredientId: 'ing-x', amount: 50, unit: 'g' }],
        }),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'VALIDATION_ERROR',
        details: { missingNutrition: ['tajemniczy proszek'] },
      },
    });
    expect(prisma.recipe.create).not.toHaveBeenCalled();
    expect(cache.invalidateRecipesList).not.toHaveBeenCalled();
  });

  it('odrzuca sztuki bez gramsPerPiece', async () => {
    await expect(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [
            { ingredientId: 'ing-banana-np', amount: 2, unit: 'szt' },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'VALIDATION_ERROR',
        details: { missingPieceWeight: ['banan'] },
      },
    });
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('normalizuje łyżeczkę przyprawy tak samo jak import', async () => {
    // Przed poprawką kopia tabeli w serwisie nie znała „przyprawy
    // uniwersalnej" i dawała domyślne 2,5 g.
    await service.create(
      mockUserId,
      baseDto({
        ingredients: [
          { ingredientId: 'ing-spice', amount: 1, unit: 'łyżeczka' },
        ],
      }),
    );

    expect(createdData().ingredients.create[0]).toEqual({
      ingredientId: 'ing-spice',
      name: 'przyprawa uniwersalna',
      amount: 1,
      unit: 'łyżeczka',
      normalizedAmount: 4,
      normalizedUnit: 'g',
      department: 'Przyprawy i sosy',
    });
  });

  it('uzupełnia suitableMealTypes klasyfikatorem z policzonych kcal', async () => {
    await service.create(mockUserId, baseDto({ ingredients: oatsAndMilk }));

    const expected = resolveSuitableMealTypes({
      title: 'Owsianka z bananem',
      description: 'Płatki na mleku',
      mealType: 'BREAKFAST',
      prepTimeMinutes: 10,
      servings: 2,
      nutritionKcal: 562,
      suitableMealTypes: undefined,
    });
    expect(expected).toContain('BREAKFAST');
    expect(expected.length).toBeGreaterThan(1);
    expect(createdData().suitableMealTypes).toEqual(expected);
  });

  it('zachowuje sloty podane wprost i slot bazowy', async () => {
    await service.create(
      mockUserId,
      baseDto({ ingredients: oatsAndMilk, suitableMealTypes: ['LUNCH'] }),
    );

    const stored: string[] = createdData().suitableMealTypes;
    expect(stored).toContain('BREAKFAST');
    expect(stored).toContain('LUNCH');
    expect(stored.indexOf('BREAKFAST')).toBeLessThan(stored.indexOf('LUNCH'));
  });

  it('unieważnia cache listy przepisów', async () => {
    await service.create(mockUserId, baseDto({ ingredients: oatsAndMilk }));

    expect(cache.invalidateRecipesList).toHaveBeenCalledTimes(1);
  });

  it('odrzuca zduplikowany ingredientId', async () => {
    await expect(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [
            { ingredientId: 'ing-oats', amount: 100, unit: 'g' },
            { ingredientId: 'ing-oats', amount: 50, unit: 'g' },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('ing-oats'),
      },
    });
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('odrzuca nieznaną jednostkę', async () => {
    await expect(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [{ ingredientId: 'ing-spice', amount: 1, unit: 'garść' }],
        }),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('garść'),
      },
    });
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('odrzuca ilość zero lub ujemną', async () => {
    await expect(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [{ ingredientId: 'ing-oats', amount: 0, unit: 'g' }],
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('tłumaczy błąd bramki kategorii na VALIDATION_ERROR 400', async () => {
    const attempt = service.create(
      mockUserId,
      baseDto({
        ingredients: [{ ingredientId: 'ing-milk', amount: 1, unit: 'łyżeczka' }],
      }),
    );

    await expect(attempt).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'VALIDATION_ERROR',
        message: expect.stringMatching(/mleko/),
      },
    });
    await expect(attempt).rejects.toMatchObject({
      response: { message: expect.stringMatching(/Przyprawy i sosy/) },
    });
  });

  it('odrzuca nieznany składnik', async () => {
    await expect(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [{ ingredientId: 'ing-ghost', amount: 10, unit: 'g' }],
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('bez składników zostawia makra z DTO', async () => {
    await service.create(mockUserId, baseDto({ nutritionKcal: 520 }));

    expect(createdData().nutritionKcal).toBe(520);
    expect(createdData().ingredients).toBeUndefined();
    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
  });

  it('odrzuca nie-członka gospodarstwa przed jakąkolwiek pracą', async () => {
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(
      service.create(mockUserId, baseDto({ ingredients: oatsAndMilk })),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });
});
