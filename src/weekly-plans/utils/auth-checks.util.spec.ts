import { PrismaService } from '../../prisma/prisma.service';
import { ensureMembership, ensureRecipeForHousehold } from './auth-checks.util';

const RECIPE = '7adf5ec0-e3e5-4b28-8bb4-5515c780948c';
const HOUSEHOLD = 'a00f55ec-8500-4b44-85e6-561bfba4dbad';
const USER = 'd4999c6e-ad7a-4810-b57e-9131ff1cea1b';

describe('ensureRecipeForHousehold', () => {
  const findFirst = jest.fn();
  const prisma = {
    recipe: { findFirst },
  } as unknown as PrismaService;

  beforeEach(() => findFirst.mockReset());

  it('pyta o przepis Z KATALOGU albo własny — nie o dowolny po id', async () => {
    findFirst.mockResolvedValue({ id: RECIPE });

    await ensureRecipeForHousehold(prisma, RECIPE, HOUSEHOLD);

    // To jest cała bramka: bez `OR` każdy przepis w bazie nadawałby się do
    // każdego planu, więc asystent domu A wstawiłby prywatny przepis domu B.
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: RECIPE,
        OR: [{ isCatalog: true }, { householdId: HOUSEHOLD }],
      },
      select: { id: true },
    });
  });

  it('przepis spoza katalogu i spoza domu → RECIPE_NOT_FOUND 404', async () => {
    findFirst.mockResolvedValue(null);

    await expect(
      ensureRecipeForHousehold(prisma, RECIPE, HOUSEHOLD),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'RECIPE_NOT_FOUND' },
    });
  });

  it.each([
    ['recipeId', 'nie-uuid', HOUSEHOLD, /recipeId must be a UUID/],
    ['householdId', RECIPE, 'hh-1', /householdId must be a UUID/],
  ])(
    'nie-UUID w %s zatrzymuje się przed Prismą (dawniej P2023 → 500)',
    async (_field, recipeId, householdId, detail) => {
      await expect(
        ensureRecipeForHousehold(prisma, recipeId, householdId),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'VALIDATION_ERROR' },
      });
      await expect(
        ensureRecipeForHousehold(prisma, recipeId, householdId),
      ).rejects.toThrow(detail);
      expect(findFirst).not.toHaveBeenCalled();
    },
  );
});

describe('ensureMembership', () => {
  const findUnique = jest.fn();
  const prisma = {
    membership: { findUnique },
  } as unknown as PrismaService;

  beforeEach(() => findUnique.mockReset());

  it('brak członkostwa → NOT_HOUSEHOLD_MEMBER 403', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      ensureMembership(prisma, USER, HOUSEHOLD),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'NOT_HOUSEHOLD_MEMBER' },
    });
  });

  it('nie-UUID householdId zatrzymuje się przed zapytaniem', async () => {
    await expect(ensureMembership(prisma, USER, 'hh-1')).rejects.toMatchObject({
      response: { code: 'VALIDATION_ERROR' },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
