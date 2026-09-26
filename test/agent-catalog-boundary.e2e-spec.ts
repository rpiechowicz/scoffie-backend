import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AgentCatalogService,
  catalogHouseholdId,
} from '../src/agent/search/agent-catalog.service';
import { loadDigestRecipes } from '../src/agent/catalog-digest';
import { RecipeSearchQuery } from '../src/agent/search/catalog-search';
import { catalogOwnerUserId } from '../src/common/catalog-owner';

/**
 * Granica katalogu dla asystenta (workstream, Etap 1) na żywej bazie.
 *
 * Wspólny indeks asystenta to KATALOG (`isCatalog: true`), a nie „wszystko,
 * co należy do gospodarstwa katalogowego". Do 26.09.2026 indeks i digest
 * filtrowały po samym `householdId`, więc prywatny przepis konta
 * katalogowego (np. wpisany przez admina przez aplikację, `isCatalog: false`)
 * stawał się kandydatem dla KAŻDEGO domu — z numerem `R…` i w digeście.
 */
describe('Asystent: granica katalogu E2E', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let catalog: AgentCatalogService;
  const createdRecipeIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const createdUserIds: string[] = [];
  const TITLE = `Tajny gulasz administratora ${Date.now()}`;
  let privateRecipeId: string;
  let otherHouseholdId: string;
  let otherUserId: string;

  const query = (text: string): RecipeSearchQuery => ({
    text,
    mealType: null,
    tags: [],
    includeIngredients: [],
    excludeIngredients: [],
    maxPrepMinutes: null,
    maxKcalPerServing: null,
    minProteinPerServing: null,
    sort: 'BEST_FIT',
    limit: 10,
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    catalog = moduleRef.get(AgentCatalogService);

    const catalogHousehold = await prisma.household.findUniqueOrThrow({
      where: { id: catalogHouseholdId() },
      select: { createdById: true },
    });
    const recipe = await prisma.recipe.create({
      data: {
        title: TITLE,
        householdId: catalogHouseholdId(),
        // Autor = właściciel konta katalogowego (to samo, co przy imporcie).
        authorId: catalogHousehold.createdById ?? catalogOwnerUserId(),
        isCatalog: false,
        mealType: 'DINNER',
        suitableMealTypes: ['DINNER'],
        nutritionKcal: 600,
        servings: 2,
        prepTimeMinutes: 20,
      },
    });
    privateRecipeId = recipe.id;
    createdRecipeIds.push(recipe.id);

    const user = await prisma.user.create({
      data: {
        displayName: 'Obcy dom',
        email: `catalog-boundary-${Date.now()}@agent.local`,
        authProvider: 'DEV',
      },
    });
    otherUserId = user.id;
    createdUserIds.push(user.id);
    const household = await prisma.household.create({
      data: { name: 'Obcy dom', createdById: user.id },
    });
    otherHouseholdId = household.id;
    createdHouseholdIds.push(household.id);
    await prisma.membership.create({
      data: { userId: user.id, householdId: household.id, role: 'OWNER' },
    });
  });

  afterAll(async () => {
    await prisma.recipe.deleteMany({ where: { id: { in: createdRecipeIds } } });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await moduleRef.close();
  });

  it('prywatny przepis konta katalogowego nie trafia do wspólnego indeksu', async () => {
    const snapshot = await catalog.snapshot();
    expect(snapshot.byId.has(privateRecipeId)).toBe(false);
    expect(Object.values(snapshot.digest.index).includes(privateRecipeId)).toBe(
      false,
    );
    expect(snapshot.digest.text).not.toContain(TITLE);
  });

  it('digest (tryb AI_CATALOG_MODE=digest) też go nie ma', async () => {
    const recipes = await loadDigestRecipes(prisma, catalogHouseholdId());
    expect(recipes.some((recipe) => recipe.id === privateRecipeId)).toBe(false);
  });

  it('obcy dom nie znajduje go wyszukiwarką', async () => {
    const result = await catalog.search(
      {
        userId: otherUserId,
        householdId: otherHouseholdId,
        forUserIds: [],
        consentedUserIds: new Set([otherUserId]),
      },
      query('tajny gulasz administratora'),
    );
    expect(result.hits.some((hit) => hit.id === privateRecipeId)).toBe(false);
  });

  it('konto katalogowe dalej widzi własny prywatny przepis — jako swój, nie katalogowy', async () => {
    const result = await catalog.search(
      {
        userId: otherUserId,
        householdId: catalogHouseholdId(),
        forUserIds: [],
        consentedUserIds: new Set(),
      },
      query('tajny gulasz administratora'),
    );
    const hit = result.hits.find((entry) => entry.id === privateRecipeId);
    expect(hit).toBeDefined();
    // Własny przepis nie dostaje numeru katalogu — referencją jest id.
    expect(hit?.recipe).toBe(privateRecipeId);
  });
});
