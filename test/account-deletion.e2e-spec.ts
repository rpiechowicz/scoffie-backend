import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecipesService } from '../src/recipes/recipes.service';
import { UsersService } from '../src/users/users.service';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';
import { catalogOwnerUserId } from '../src/common/catalog-owner';

/**
 * Kasowanie konta na żywej bazie — to, czego mocki nie pokażą: kaskady.
 *
 * `Recipe.author` i `PlanItem.recipe` kasują kaskadą. Do tej poprawki
 * usunięcie konta domownika A zabierało z bazy przepisy gospodarstwa jego
 * autorstwa (także te, które asystent utworzył w jego turze), a z nimi
 * pozycje planu, uczestników i odhaczenia domownika B — bez ostrzeżenia i
 * bez broadcastu. Ta suita jest dowodem na żywych kluczach obcych, że plan B
 * przeżywa odejście A.
 */
const WEEK_START = '2026-10-05';

describe('Kasowanie konta E2E', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let users: UsersService;
  let recipes: RecipesService;
  let plans: WeeklyPlansService;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];

  const createUser = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@delete.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    users = moduleRef.get(UsersService);
    recipes = moduleRef.get(RecipesService);
    plans = moduleRef.get(WeeklyPlansService);
  });

  afterAll(async () => {
    await prisma.recipe.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await moduleRef.close();
  });

  it('przepis i plan domownika B przeżywają skasowanie konta autora A', async () => {
    const authorId = await createUser('Autor');
    const otherId = await createUser('Domownik');
    const household = await prisma.household.create({
      data: { name: `Dom kasowania ${Date.now()}`, createdById: authorId },
      select: { id: true },
    });
    createdHouseholdIds.push(household.id);
    await prisma.membership.createMany({
      data: [
        { userId: authorId, householdId: household.id, role: 'OWNER' },
        { userId: otherId, householdId: household.id, role: 'MEMBER' },
      ],
    });

    const ingredient = await prisma.ingredient.findFirst({
      where: { isActive: true, nutritionKcalPer100: { not: null } },
      select: { id: true },
    });
    if (!ingredient) throw new Error('baza dev nie ma składnika z makrami');

    const recipe = (await recipes.create(authorId, {
      householdId: household.id,
      title: `Danie autora ${Date.now()}`,
      mealType: 'DINNER',
      difficulty: 'EASY',
      prepTimeMinutes: 20,
      servings: 2,
      ingredients: [{ ingredientId: ingredient.id, amount: 200, unit: 'g' }],
    } as never)) as { id: string; authorId: string };
    expect(recipe.authorId).toBe(authorId);

    const applied = await plans.applyWeekPlan(
      otherId,
      household.id,
      WEEK_START,
      {
        slots: [{ dayOfWeek: 'MON', mealType: 'DINNER', recipeId: recipe.id }],
      } as never,
    );
    expect(applied.violations).toEqual([]);

    await users.deleteAccount(authorId);
    createdUserIds.splice(createdUserIds.indexOf(authorId), 1);

    const survivor = await prisma.recipe.findUnique({
      where: { id: recipe.id },
      select: { authorId: true, householdId: true, isActive: true },
    });
    expect(survivor).toEqual({
      authorId: catalogOwnerUserId(),
      householdId: household.id,
      isActive: true,
    });

    const items = await prisma.planItem.findMany({
      where: { weeklyPlan: { householdId: household.id }, recipeId: recipe.id },
      select: { dayOfWeek: true, mealType: true },
    });
    expect(items).toEqual([{ dayOfWeek: 'MON', mealType: 'DINNER' }]);

    // Dom został z B jako właścicielem — reguła awansu z household-cleanup.
    const remaining = await prisma.membership.findMany({
      where: { householdId: household.id },
      select: { userId: true, role: true },
    });
    expect(remaining).toEqual([{ userId: otherId, role: 'OWNER' }]);
  });

  it('konta bota importu nie da się skasować', async () => {
    await expect(
      users.deleteAccount(catalogOwnerUserId()),
    ).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
  });
});
