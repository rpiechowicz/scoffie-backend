import { Test, TestingModule } from '@nestjs/testing';
import { RecipesService } from './recipes.service';
import { RecipesCacheService } from './recipes-cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveSuitableMealTypes } from './suitable-meal-types.util';

// ─── Mock data ─────────────────────────────────────────────────────────────────

const mockUserId = '11111111-1111-4111-8111-111111111111';
const mockHouseholdId = '22222222-2222-4222-8222-222222222222';
const RECIPE_ID = '7adf5ec0-e3e5-4b28-8bb4-5515c780948c';

// Prawdziwe UUID v4: `@IsUUID()` na `ingredientId` odrzuciłoby `ing-oats`
// zanim test dotarłby do tego, co naprawdę sprawdza.
const ING_OATS = 'a0000000-0000-4000-8000-000000000001';
const ING_MILK = 'a0000000-0000-4000-8000-000000000002';
const ING_BANANA = 'a0000000-0000-4000-8000-000000000003';
const ING_BANANA_NP = 'a0000000-0000-4000-8000-000000000004';
const ING_SPICE = 'a0000000-0000-4000-8000-000000000005';
const ING_NO_MACROS = 'a0000000-0000-4000-8000-000000000006';
const ING_GHOST = 'a0000000-0000-4000-8000-000000000007';

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
  id: ING_OATS,
  name: 'płatki owsiane',
  category: 'Zboża i makarony',
  ...macros(379, 13.2, 57.6, 6.9, 10.1),
  gramsPerPiece: null,
  allergens: ['gluten'],
  dietTags: ['GLUTEN_GRAIN', 'GRAIN'],
};
const milk = {
  id: ING_MILK,
  name: 'mleko',
  category: 'Nabiał',
  ...macros(61, 3.3, 4.7, 3.3, 0),
  gramsPerPiece: null,
  allergens: ['lactose'],
  dietTags: ['DAIRY'],
};
const banana = {
  id: ING_BANANA,
  name: 'banan',
  category: 'Owoce',
  ...macros(89, 1.1, 20, 0.3, 2.6),
  gramsPerPiece: 120,
  allergens: [] as string[],
  dietTags: [] as string[],
};
const bananaNoPiece = { ...banana, id: ING_BANANA_NP, gramsPerPiece: null };
const spice = {
  id: ING_SPICE,
  name: 'przyprawa uniwersalna',
  category: 'Przyprawy i sosy',
  ...macros(0, 0, 0, 0, 0),
  gramsPerPiece: null,
  allergens: ['celery'],
  dietTags: ['PROCESSED'],
};
const noMacros = {
  id: ING_NO_MACROS,
  name: 'tajemniczy proszek',
  category: 'Inne',
  ...macros(null, null, null, null, null),
  gramsPerPiece: null,
  allergens: [] as string[],
  dietTags: [] as string[],
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
      // Zwraca tylko te składniki, o które pytano — jak baza (kolumna uuid
      // porównuje bez względu na wielkość liter i oddaje małe).
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const ids: string[] = where.id.in.map((id: string) => id.toLowerCase());
        return Promise.resolve(
          ALL_INGREDIENTS.filter((ingredient) => ids.includes(ingredient.id)),
        );
      }),
    },
    recipe: {
      create: jest
        .fn()
        .mockImplementation((args: any) =>
          Promise.resolve({ id: RECIPE_ID, ...args.data, ingredients: [] }),
        ),
      findMany: jest.fn().mockResolvedValue([]),
      // `findById` filtruje po `isActive`, wiec pyta `findFirst`; `findUnique`
      // zostaje dla bramki edycji (`loadEditableRecipe`).
      findFirst: jest.fn().mockResolvedValue({
        id: RECIPE_ID,
        title: 'Owsianka',
        description: null,
        imageUrl: 'https://cdn.example/owsianka.jpg',
        mealType: 'BREAKFAST',
        suitableMealTypes: [],
        householdId: mockHouseholdId,
        sourceMeta: null,
        ingredients: [],
      }),
      update: jest.fn().mockResolvedValue({ id: RECIPE_ID }),
      findUnique: jest.fn().mockResolvedValue({
        isActive: true,
        isCatalog: false,
        id: RECIPE_ID,
        title: 'Owsianka',
        description: null,
        imageUrl: 'https://cdn.example/owsianka.jpg',
        mealType: 'BREAKFAST',
        suitableMealTypes: [],
        householdId: mockHouseholdId,
        sourceMeta: null,
        ingredients: [],
      }),
    },
    recipeFavorite: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'fav-1' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // `update` kasuje wiersze składników tylko wtedy, gdy przyszła ich nowa
    // lista — testy pustej listy pilnują, że nie kasuje ich nigdy indziej.
    recipeIngredient: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest
      .fn()
      .mockImplementation((cbOrOps: any) =>
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
  { ingredientId: ING_OATS, amount: 100, unit: 'g' },
  { ingredientId: ING_MILK, amount: 300, unit: 'ml' },
];

// ─── Tests ─────────────────────────────────────────────────────────────────────

const makeCacheMock = () => ({
  invalidateRecipesList: jest.fn(),
  get: jest.fn().mockReturnValue(null),
  set: jest.fn(),
  // Ten sam format klucza co w `RecipesCacheService` — testy sprawdzają, że
  // do klucza trafia zwalidowana wartość filtra.
  buildRecipesListKey: jest.fn(
    (input: {
      userId: string;
      householdId?: string;
      mealType?: string;
      isFavorite?: boolean;
      page: number;
      limit: number;
    }) =>
      [
        'recipes:list:',
        input.userId,
        input.householdId ?? 'all-households',
        input.mealType ?? 'all-meals',
        typeof input.isFavorite === 'boolean'
          ? String(input.isFavorite)
          : 'all-favorites',
        input.page,
        input.limit,
      ].join(':'),
  ),
});

/** Wspólna asercja: wejście odrzucone na walidacji, z listą `details`. */
const expectValidationError = async (
  attempt: Promise<unknown>,
  detail: RegExp,
) => {
  await expect(attempt).rejects.toMatchObject({
    status: 400,
    response: {
      code: 'VALIDATION_ERROR',
      details: expect.arrayContaining([expect.stringMatching(detail)]),
    },
  });
};

describe('RecipesService.create', () => {
  let service: RecipesService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let cache: ReturnType<typeof makeCacheMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    cache = makeCacheMock();

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

  it('tagi przepisu to unia tagów składników; do wierszy składników nie trafiają', async () => {
    await service.create(mockUserId, baseDto({ ingredients: oatsAndMilk }));
    const data = createdData();
    expect(data.allergens).toEqual(['gluten', 'lactose']);
    expect(data.dietTags).toEqual(['DAIRY', 'GLUTEN_GRAIN', 'GRAIN']);
    for (const row of data.ingredients.create) {
      expect(row).not.toHaveProperty('allergens');
      expect(row).not.toHaveProperty('dietTags');
      expect(row).not.toHaveProperty('nutrition');
    }
  });

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

  it('nutritionSalt z DTO to sól dodana — przy składnikach bez sodu jest całą solą', async () => {
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
        ingredients: [{ ingredientId: ING_BANANA, amount: 2, unit: 'szt' }],
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
          ingredients: [{ ingredientId: ING_NO_MACROS, amount: 50, unit: 'g' }],
        }),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'VALIDATION_ERROR',
        details: [expect.stringContaining('tajemniczy proszek')],
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
            { ingredientId: ING_BANANA_NP, amount: 2, unit: 'szt' },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'VALIDATION_ERROR',
        details: [expect.stringMatching(/gramsPerPiece.*banan/)],
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
        ingredients: [{ ingredientId: ING_SPICE, amount: 1, unit: 'łyżeczka' }],
      }),
    );

    expect(createdData().ingredients.create[0]).toEqual({
      ingredientId: ING_SPICE,
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
            { ingredientId: ING_OATS, amount: 100, unit: 'g' },
            { ingredientId: ING_OATS, amount: 50, unit: 'g' },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining(ING_OATS),
      },
    });
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('odrzuca nieznaną jednostkę z listą dozwolonych (ta sama, co ALLOWED_UNITS)', async () => {
    // Łapie to już DTO (`@IsIn` z listą z `ingredient-amount.util`), zanim
    // serwis dojdzie do własnej bramki — komunikat wymienia, co wolno.
    await expectValidationError(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [{ ingredientId: ING_SPICE, amount: 1, unit: 'garść' }],
        }),
      ),
      /ingredients\.0\.unit must be one of the following values: g, kg, ml, l, szt, szczypta, łyżeczka, łyżka, lyzeczka, lyzka/,
    );
    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('odrzuca ilość zero lub ujemną', async () => {
    await expect(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [{ ingredientId: ING_OATS, amount: 0, unit: 'g' }],
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('tłumaczy błąd bramki kategorii na VALIDATION_ERROR 400', async () => {
    const attempt = service.create(
      mockUserId,
      baseDto({
        ingredients: [{ ingredientId: ING_MILK, amount: 1, unit: 'łyżeczka' }],
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

  it('odrzuca nieznany składnik: INGREDIENT_NOT_FOUND 404 z brakującymi id w details', async () => {
    await expect(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [
            { ingredientId: ING_OATS, amount: 100, unit: 'g' },
            { ingredientId: ING_GHOST, amount: 10, unit: 'g' },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'INGREDIENT_NOT_FOUND', details: [ING_GHOST] },
    });
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  // ─── Walidacja DTO na wejściu serwisu (ta sama warstwa dla WS, HTTP i
  // wołań in-process asystenta) — Prisma nie jest wołana wcale. ───

  it('odrzuca zły difficulty z listą dozwolonych, nie dotykając bazy', async () => {
    await expectValidationError(
      service.create(mockUserId, baseDto({ difficulty: 'IMPOSSIBLE' })),
      /difficulty must be one of the following values: EASY, MEDIUM, HARD/,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('odrzuca zły mealType z listą slotów', async () => {
    await expectValidationError(
      service.create(mockUserId, baseDto({ mealType: 'BRUNCH' })),
      /mealType must be one of the following values: BREAKFAST, .*DINNER/,
    );
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('nie koercuje typów: servings true / prepTimeMinutes [30] / nutritionKcal "520" → VALIDATION_ERROR', async () => {
    await expectValidationError(
      service.create(mockUserId, baseDto({ servings: true })),
      /servings must be an integer number/,
    );
    await expectValidationError(
      service.create(mockUserId, baseDto({ prepTimeMinutes: [30] })),
      /prepTimeMinutes must be an integer number/,
    );
    await expectValidationError(
      service.create(mockUserId, baseDto({ nutritionKcal: '520' })),
      /nutritionKcal must be a number/,
    );
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('odrzuca servings jako tekst i poza zakresem 1..20', async () => {
    await expectValidationError(
      service.create(mockUserId, baseDto({ servings: 'dwa' })),
      /servings must be an integer number/,
    );
    await expectValidationError(
      service.create(mockUserId, baseDto({ servings: 21 })),
      /servings must not be greater than 20/,
    );
    await expectValidationError(
      service.create(mockUserId, baseDto({ servings: 0 })),
      /servings must not be less than 1/,
    );
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('odrzuca householdId i ingredientId nie-UUID', async () => {
    await expectValidationError(
      service.create(mockUserId, baseDto({ householdId: 'hh-1' })),
      /householdId must be a UUID/,
    );
    await expectValidationError(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [{ ingredientId: 'ing-oats', amount: 100, unit: 'g' }],
        }),
      ),
      /ingredients\.0\.ingredientId must be a UUID/,
    );
    expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
  });

  it('brak wymaganych pól daje pełną listę braków (bez TypeError)', async () => {
    await expectValidationError(
      service.create(mockUserId, { householdId: mockHouseholdId } as any),
      /title must be a string/,
    );
    await expectValidationError(
      service.create(mockUserId, undefined as any),
      /householdId must be a UUID/,
    );
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });

  it('nieznane pole w DTO to błąd — asystent nie może halucynować pól', async () => {
    await expectValidationError(
      service.create(mockUserId, baseDto({ calories: 100 })),
      /property calories should not exist/,
    );
  });

  it('ingredientId wielkimi literami przechodzi walidację (iOS wysyła uuidString)', async () => {
    await service.create(
      mockUserId,
      baseDto({
        ingredients: [
          { ingredientId: ING_OATS.toUpperCase(), amount: 100, unit: 'g' },
        ],
      }),
    );

    // Wiersz składnika dostaje id z bazy (małe litery), nie z payloadu.
    expect(createdData().ingredients.create[0].ingredientId).toBe(ING_OATS);
  });

  it('duplikat różniący się tylko wielkością liter to nadal duplikat', async () => {
    await expect(
      service.create(
        mockUserId,
        baseDto({
          ingredients: [
            { ingredientId: ING_OATS, amount: 100, unit: 'g' },
            { ingredientId: ING_OATS.toUpperCase(), amount: 50, unit: 'g' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
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
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'NOT_HOUSEHOLD_MEMBER' },
    });
    expect(prisma.ingredient.findMany).not.toHaveBeenCalled();
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });
});

// ─── findAll / findById / setFavorite: walidacja na wejściu ─────────────────

describe('RecipesService — walidacja wejścia pozostałych metod', () => {
  let service: RecipesService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let cache: ReturnType<typeof makeCacheMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    cache = makeCacheMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecipesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RecipesCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<RecipesService>(RecipesService);
  });

  describe('findAll', () => {
    it('nieznany mealType → VALIDATION_ERROR z listą slotów, bez zapytań (dawniej: cały katalog)', async () => {
      await expectValidationError(
        service.findAll(mockUserId, { mealType: 'BRUNCH' } as any),
        /mealType must be one of the following values: BREAKFAST, SECOND_BREAKFAST, LUNCH, AFTERNOON_SNACK, DINNER, SNACK/,
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.recipe.findMany).not.toHaveBeenCalled();
      expect(cache.buildRecipesListKey).not.toHaveBeenCalled();
    });

    it('page/limit jako śmieci → VALIDATION_ERROR (dawniej NaN w skip → 500)', async () => {
      await expectValidationError(
        service.findAll(mockUserId, { page: 'abc' } as any),
        /page must be an integer number/,
      );
      await expectValidationError(
        service.findAll(mockUserId, { limit: 0 } as any),
        /limit must not be less than 1/,
      );
      await expectValidationError(
        service.findAll(mockUserId, { limit: 101 } as any),
        /limit must not be greater than 100/,
      );
      expect(prisma.recipe.findMany).not.toHaveBeenCalled();
    });

    it('isFavorite jako dowolny tekst → VALIDATION_ERROR (dawniej cicho ignorowane)', async () => {
      await expectValidationError(
        service.findAll(mockUserId, {
          householdId: mockHouseholdId,
          isFavorite: 'yes',
        } as any),
        /isFavorite must be a boolean value/,
      );
      expect(prisma.recipeFavorite.findMany).not.toHaveBeenCalled();
    });

    it('householdId nie-UUID → VALIDATION_ERROR przed ensureMembership', async () => {
      await expectValidationError(
        service.findAll(mockUserId, { householdId: 'hh-1' } as any),
        /householdId must be a UUID/,
      );
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
    });

    it('stringi z HTTP ("1", "true") przechodzą przez @Transform jak dawniej', async () => {
      await service.findAll(mockUserId, {
        householdId: mockHouseholdId,
        page: '2',
        limit: '10',
        isFavorite: 'true',
      } as any);

      expect(prisma.recipe.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
    });

    it('klucz cache i filtr Prismy budowane ze zwalidowanego mealType', async () => {
      await service.findAll(mockUserId, {
        mealType: 'DINNER',
        limit: 5,
      } as any);

      expect(cache.buildRecipesListKey).toHaveBeenCalledWith({
        userId: 'global',
        mealType: 'DINNER',
        isFavorite: undefined,
        page: 1,
        limit: 5,
      });
      expect(prisma.recipe.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: expect.arrayContaining([
                  { suitableMealTypes: { has: 'DINNER' } },
                ]),
              }),
            ]),
          }),
        }),
      );
    });

    it('bez householdId widac WYLACZNIE katalog', async () => {
      await service.findAll(mockUserId, { limit: 5 } as any);

      // Lista wolana bez kontekstu domu nie ma prawa pokazac cudzych
      // przepisow — po wprowadzeniu `isCatalog` to jest bramka, nie filtr.
      expect(prisma.recipe.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, AND: [{ isCatalog: true }] },
        }),
      );
    });

    it('z householdId widac katalog PLUS wlasne przepisy domu', async () => {
      await service.findAll(mockUserId, {
        householdId: mockHouseholdId,
        limit: 5,
      } as any);

      expect(prisma.recipe.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              { OR: [{ isCatalog: true }, { householdId: mockHouseholdId }] },
            ]),
          }),
        }),
      );
    });

    it('klucz cache niesie householdId — inaczej dom A dostalby liste domu B', async () => {
      await service.findAll(mockUserId, {
        householdId: mockHouseholdId,
        limit: 5,
      } as any);

      expect(cache.buildRecipesListKey).toHaveBeenCalledWith(
        expect.objectContaining({ householdId: mockHouseholdId }),
      );
    });

    it('limit 100 (pełna strona iOS = brzeg @Max) przechodzi i idzie jako take: 100', async () => {
      await service.findAll(mockUserId, {
        householdId: mockHouseholdId,
        page: 1,
        limit: 100,
      } as any);

      expect(prisma.recipe.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });

    it('brak filtrów = domyślna strona 1 po 24, bez filtra slotu', async () => {
      await service.findAll(mockUserId, undefined);

      expect(prisma.recipe.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, AND: [{ isCatalog: true }] },
          skip: 0,
          take: 24,
        }),
      );
    });
  });

  describe('findById', () => {
    it('id nie-UUID → VALIDATION_ERROR, recipe.findUnique nie wywołane (dawniej P2023 → 500)', async () => {
      await expectValidationError(
        service.findById(mockUserId, 'not-a-uuid'),
        /^id must be a UUID$/,
      );
      expect(prisma.recipe.findFirst).not.toHaveBeenCalled();
    });

    it('householdId nie-UUID → VALIDATION_ERROR przed jakimkolwiek zapytaniem', async () => {
      await expectValidationError(
        service.findById(mockUserId, RECIPE_ID, 'hh-1'),
        /householdId must be a UUID/,
      );
      expect(prisma.recipe.findFirst).not.toHaveBeenCalled();
    });

    it('poprawne id: oddaje przepis z flagą isFavorite dla domu', async () => {
      prisma.recipeFavorite.findUnique.mockResolvedValue({ id: 'fav-1' });

      const result = await service.findById(
        mockUserId,
        RECIPE_ID,
        mockHouseholdId,
      );

      expect(result).toEqual(
        expect.objectContaining({ id: RECIPE_ID, isFavorite: true }),
      );
      expect(result).not.toHaveProperty('sourceMeta');
    });

    it('nieznany przepis → RECIPE_NOT_FOUND 404', async () => {
      prisma.recipe.findFirst.mockResolvedValue(null);

      await expect(
        service.findById(mockUserId, RECIPE_ID),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'RECIPE_NOT_FOUND' },
      });
    });

    it('przepis z katalogu widac bez kontekstu domu', async () => {
      prisma.recipe.findFirst.mockResolvedValue({
        id: RECIPE_ID,
        title: 'Owsianka',
        description: null,
        imageUrl: null,
        mealType: 'BREAKFAST',
        suitableMealTypes: [],
        isCatalog: true,
        householdId: 'inny-dom',
        sourceMeta: null,
        ingredients: [],
      });

      await expect(
        service.findById(mockUserId, RECIPE_ID),
      ).resolves.toMatchObject({ id: RECIPE_ID });
    });

    it('cudzy przepis gospodarstwa to 404, nie 403 — nie potwierdzamy, ze istnieje', async () => {
      prisma.recipe.findFirst.mockResolvedValue({
        id: RECIPE_ID,
        title: 'Sekretna zapiekanka',
        description: null,
        imageUrl: null,
        mealType: 'DINNER',
        suitableMealTypes: [],
        isCatalog: false,
        householdId: 'cudzy-dom',
        sourceMeta: null,
        ingredients: [],
      });

      await expect(
        service.findById(mockUserId, RECIPE_ID),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'RECIPE_NOT_FOUND' },
      });
    });
  });

  describe('setFavorite', () => {
    const dto = {
      recipeId: RECIPE_ID,
      householdId: mockHouseholdId,
      isFavorite: true,
    };

    it('isFavorite jako string "false" → VALIDATION_ERROR, nic nie zapisane (dawniej truthy = polubione)', async () => {
      await expectValidationError(
        service.setFavorite(mockUserId, {
          ...dto,
          isFavorite: 'false',
        } as any),
        /isFavorite must be a boolean value/,
      );
      expect(prisma.recipe.findUnique).not.toHaveBeenCalled();
      expect(prisma.recipeFavorite.upsert).not.toHaveBeenCalled();
      expect(prisma.recipeFavorite.deleteMany).not.toHaveBeenCalled();
      expect(cache.invalidateRecipesList).not.toHaveBeenCalled();
    });

    it('recipeId nie-UUID albo brak data → VALIDATION_ERROR z details', async () => {
      await expectValidationError(
        service.setFavorite(mockUserId, { ...dto, recipeId: 'recipe-1' }),
        /recipeId must be a UUID/,
      );
      await expectValidationError(
        service.setFavorite(mockUserId, undefined as any),
        /householdId must be a UUID/,
      );
      expect(prisma.recipe.findUnique).not.toHaveBeenCalled();
    });

    it('true → upsert; oddaje szczegóły przepisu i zwalidowaną zmianę do broadcastu', async () => {
      prisma.recipeFavorite.findUnique.mockResolvedValue({ id: 'fav-1' });

      const result = await service.setFavorite(mockUserId, dto);

      expect(prisma.recipeFavorite.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.recipeFavorite.deleteMany).not.toHaveBeenCalled();
      expect(result.change).toEqual({
        recipeId: RECIPE_ID,
        householdId: mockHouseholdId,
        isFavorite: true,
      });
      expect(result.recipe).toEqual(
        expect.objectContaining({ id: RECIPE_ID, isFavorite: true }),
      );
      expect(cache.invalidateRecipesList).toHaveBeenCalledTimes(1);
    });

    it('false → deleteMany, bez upsertu', async () => {
      const result = await service.setFavorite(mockUserId, {
        ...dto,
        isFavorite: false,
      });

      expect(prisma.recipeFavorite.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.recipeFavorite.upsert).not.toHaveBeenCalled();
      expect(result.change.isFavorite).toBe(false);
    });

    it('nie-członek domu → NOT_HOUSEHOLD_MEMBER bez zapisu', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(service.setFavorite(mockUserId, dto)).rejects.toMatchObject({
        status: 403,
        response: { code: 'NOT_HOUSEHOLD_MEMBER' },
      });
      expect(prisma.recipeFavorite.upsert).not.toHaveBeenCalled();
    });
  });
});

// ─── Puste listy nie są łatką ──────────────────────────────────────────────────

/**
 * AUDYT 13.09.2026. `ingredients: []` przechodziło walidację i było traktowane
 * jak „zastąp składniki" — a lista zastępuje W CAŁOŚCI, więc `deleteMany`
 * kasował wszystkie wiersze, `create` się nie wykonywał (`?.length` = 0),
 * makra schodziły do zera, a `deriveRecipeTags([])` czyścił ALERGENY. Zostawał
 * tytuł „Kurczak z orzechami" bez składników, o zerowych kaloriach i bez
 * alergenów — a bramka alergenowa czyta właśnie `Recipe.allergens`.
 *
 * Model potrafi taką listę wygenerować z samego złego zrozumienia prośby,
 * a dla przepisów nie ma „Cofnij". Dlatego pusta lista jest teraz błędem
 * walidacji, a „nie ruszaj składników" wyraża się POMINIĘCIEM pola.
 */
describe('RecipesService — pusta lista nie jest łatką', () => {
  let service: RecipesService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecipesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RecipesCacheService, useValue: makeCacheMock() },
      ],
    }).compile();
    service = module.get<RecipesService>(RecipesService);
  });

  it('update z ingredients: [] odmawia i NIE kasuje składników', async () => {
    await expect(
      service.update(mockUserId, RECIPE_ID, {
        householdId: mockHouseholdId,
        ingredients: [],
      } as any),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_ERROR' },
    });

    // Kluczowa asercja: transakcja nigdy nie ruszyła, więc nie ma jak
    // skasować składników ani wyzerować alergenów.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.recipe.update).not.toHaveBeenCalled();
  });

  it('update z steps: [] odmawia — kroki też zastępują w całości', async () => {
    await expect(
      service.update(mockUserId, RECIPE_ID, {
        householdId: mockHouseholdId,
        steps: [],
      } as any),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_ERROR' },
    });
    expect(prisma.recipe.update).not.toHaveBeenCalled();
  });

  it('update BEZ pola ingredients zostawia składniki w spokoju', async () => {
    // Druga strona kontraktu: pominięcie pola to jedyny sposób, żeby
    // poprawić tytuł bez ruszania składników — i on musi dalej działać.
    await service.update(mockUserId, RECIPE_ID, {
      householdId: mockHouseholdId,
      title: 'Owsianka inaczej',
    } as any);

    expect(prisma.recipeIngredient.deleteMany).not.toHaveBeenCalled();
    const data = prisma.recipe.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('ingredients');
    expect(data).not.toHaveProperty('allergens');
    expect(data.title).toBe('Owsianka inaczej');
  });

  it('create z ingredients: [] odmawia — przepis bez alergenów wygląda na bezpieczny', async () => {
    await expect(
      service.create(mockUserId, baseDto({ ingredients: [] })),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_ERROR' },
    });
    expect(prisma.recipe.create).not.toHaveBeenCalled();
  });
});
