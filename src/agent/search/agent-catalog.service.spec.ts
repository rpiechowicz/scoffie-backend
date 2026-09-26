import { PrismaService } from '../../prisma/prisma.service';
import { createTurnMemo } from '../turn-memo';
import { AgentCatalogService, SearchContext } from './agent-catalog.service';
import { RecipeSearchQuery } from './catalog-search';

const CATALOG = '22222222-2222-4222-8222-222222222222';
const HOME = 'h-1';
const ANIA = 'u-ania';
const BARTEK = 'u-bartek';

const row = (
  id: string,
  title: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  title,
  description: null,
  mealType: 'LUNCH',
  suitableMealTypes: [],
  prepTimeMinutes: 30,
  servings: 2,
  nutritionKcal: 1000,
  nutritionProtein: 60,
  nutritionFat: 30,
  nutritionCarbs: 100,
  allergens: [],
  dietTags: [],
  ingredients: [
    {
      ingredientId: `ing-${id}`,
      name: 'Cebula',
      department: 'Warzywa',
      normalizedAmount: 100,
      normalizedUnit: 'g',
      ingredient: { gramsPerPiece: null },
    },
  ],
  ...overrides,
});

const query = (
  overrides: Partial<RecipeSearchQuery> = {},
): RecipeSearchQuery => ({
  text: '',
  mealType: null,
  tags: [],
  includeIngredients: [],
  excludeIngredients: [],
  maxPrepMinutes: null,
  maxKcalPerServing: null,
  minProteinPerServing: null,
  sort: 'BEST_FIT',
  limit: 8,
  ...overrides,
});

describe('AgentCatalogService', () => {
  const original = process.env.RECIPE_IMPORT_HOUSEHOLD_ID;
  let findMany: jest.Mock;
  let recipeAggregate: jest.Mock;
  /** Rewizja logu synchronizacji katalogu (Etap 4) — odcisk wersji indeksu. */
  let revisionQuery: jest.Mock;
  let memberships: jest.Mock;
  let service: AgentCatalogService;

  const context = (overrides: Partial<SearchContext> = {}): SearchContext => ({
    userId: ANIA,
    householdId: HOME,
    forUserIds: [],
    consentedUserIds: new Set([ANIA]),
    ...overrides,
  });

  beforeEach(() => {
    process.env.RECIPE_IMPORT_HOUSEHOLD_ID = CATALOG;
    findMany = jest.fn((args: { where: { householdId: string } }) =>
      Promise.resolve(
        args.where.householdId === CATALOG
          ? [
              row('r-orzech', 'Sałatka z orzechami', { allergens: ['NUTS'] }),
              row('r-schab', 'Schab pieczony', { dietTags: ['MEAT'] }),
              row('r-zupa', 'Zupa pomidorowa'),
            ]
          : [row('r-dom', 'Babcina zupa')],
      ),
    );
    recipeAggregate = jest.fn().mockResolvedValue({
      _count: { _all: 3 },
      _max: { updatedAt: new Date('2026-09-20T10:00:00Z') },
    });
    memberships = jest.fn().mockResolvedValue([
      {
        userId: ANIA,
        user: {
          displayName: 'Ania',
          preferences: {
            allergens: [],
            excludedIngredientIds: [],
            dietPreference: 'VEGETARIAN',
          },
        },
      },
      {
        userId: BARTEK,
        user: {
          displayName: 'Bartek',
          preferences: {
            allergens: ['NUTS'],
            excludedIngredientIds: [],
            dietPreference: 'NONE',
          },
        },
      },
    ]);
    revisionQuery = jest
      .fn()
      .mockResolvedValue([{ epoch: 'epoka', head: BigInt(7) }]);
    const prisma = {
      $queryRaw: revisionQuery,
      recipe: { findMany, aggregate: recipeAggregate },
      recipeIngredient: {
        aggregate: jest.fn().mockResolvedValue({
          _max: { updatedAt: new Date('2026-09-20T10:00:00Z') },
        }),
      },
      membership: { findMany: memberships },
      planItem: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      recipeFavorite: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new AgentCatalogService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    if (original === undefined) delete process.env.RECIPE_IMPORT_HOUSEHOLD_ID;
    else process.env.RECIPE_IMPORT_HOUSEHOLD_ID = original;
  });

  it('indeks katalogu żyje w pamięci, dopóki rewizja katalogu się nie zmieni', async () => {
    const first = await service.snapshot();
    const second = await service.snapshot();
    expect(second).toBe(first);
    expect(findMany).toHaveBeenCalledTimes(1);

    // Etap 4: jedno zapytanie o rewizję logu zamiast dwóch agregatów.
    expect(recipeAggregate).not.toHaveBeenCalled();
    revisionQuery.mockResolvedValue([{ epoch: 'epoka', head: BigInt(8) }]);
    const third = await service.snapshot();
    expect(third).not.toBe(first);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('indeks R01… w kolejności z bazy, mapa bez nazw dań', async () => {
    const snapshot = await service.snapshot();
    expect(snapshot.digest.index).toEqual({
      R01: 'r-orzech',
      R02: 'r-schab',
      R03: 'r-zupa',
    });
    expect(snapshot.map).toContain('W katalogu jest 3 dań');
    expect(snapshot.map).not.toContain('Schab pieczony');
  });

  it('filtry twarde całego domu — także osoby bez zgody, ale bez jej szczegółów', async () => {
    const result = await service.search(context(), query());
    // Ania jest wegetarianką (schab odpada), Bartek ma alergię na orzechy.
    expect(result.hits.map((hit) => hit.title).sort()).toEqual([
      'Babcina zupa',
      'Zupa pomidorowa',
    ]);
    expect(result.appliedForAudience).toEqual([
      'Ania: dieta wegetariańska',
      'ograniczenia 1 domowników bez zgody na asystenta (nałożone, bez szczegółów)',
    ]);
    expect(JSON.stringify(result)).not.toContain('NUTS');
    expect(JSON.stringify(result)).not.toContain('Bartek');
  });

  it('jedzący wskazani wprost: ograniczenia tylko ich', async () => {
    const result = await service.search(
      context({
        forUserIds: [BARTEK],
        consentedUserIds: new Set([ANIA, BARTEK]),
      }),
      query(),
    );
    expect(result.hits.map((hit) => hit.title)).toContain('Schab pieczony');
    expect(result.hits.map((hit) => hit.title)).not.toContain(
      'Sałatka z orzechami',
    );
    expect(result.appliedForAudience).toEqual(['Bartek: bez: NUTS']);
  });

  it('obcy identyfikator jedzącego to błąd dla modelu, nie cichy „cały dom"', async () => {
    await expect(
      service.search(context({ forUserIds: ['u-obcy'] }), query()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('przepis domu ma referencję = własny identyfikator i znacznik household', async () => {
    const result = await service.search(context(), query({ text: 'babcina' }));
    expect(result.hits).toEqual([
      expect.objectContaining({
        title: 'Babcina zupa',
        recipe: 'r-dom',
        id: 'r-dom',
        household: true,
      }),
    ]);
  });

  it('z pamięcią tury rewizję sprawdza RAZ na turę (Etap 4B)', async () => {
    const memo = createTurnMemo();
    await service.snapshot(memo);
    await service.search(context({ memo }), query());
    await service.planningPool({
      householdId: HOME,
      weekStart: '2026-08-31',
      memo,
    });
    expect(revisionQuery).toHaveBeenCalledTimes(1);
  });
});
