import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecipesCacheService } from '../src/recipes/recipes-cache.service';
import type {
  Ingredient,
  RecipeDetail,
  RecipeListItem,
} from '../src/admin/contract';
import {
  addDays,
  mondayOf,
  warsawDateKey,
} from '../src/admin/common/warsaw-calendar';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

type RecipeList = { total: number; items: RecipeListItem[] };

/**
 * Panel administratora — katalog przepisów: lista, szczegół, składniki,
 * zablokowana edycja (D1) i wycofanie / przywrócenie przepisu. Na żywej bazie
 * z katalogiem; własne przepisy i składniki z unikalnym znacznikiem.
 */
describe('Panel administratora — katalog (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreEnv: () => void;
  let session: AdminE2ESession;
  let noStepUp: AdminE2ESession;

  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const userIds: string[] = [];
  const householdIds: string[] = [];
  const ingredientIds: string[] = [];

  const ids = {
    author: '',
    other: '',
    hAuthor: '',
    hOther: '',
    active: '',
    retired: '',
    private: '',
    ingMilk: '',
    ingOats: '',
  };
  const keys = { milk: `mleko-a3-${stamp}`, oats: `platki-a3-${stamp}` };

  const server = () => app.getHttpServer();
  const get = (path: string) =>
    request(server())
      .get(`/admin/catalog${path}`)
      .set('Cookie', session.cookie);
  const list = async (query = '') =>
    (await get(`/recipes${query}`).expect(200)).body as RecipeList;
  const setActive = (id: string, body: unknown, who = session) =>
    request(server())
      .post(`/admin/catalog/recipes/${id}/active`)
      .set('Cookie', who.cookie)
      .send(body as object);

  const createUser = async (label: string) => {
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@admin-a3.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const createHousehold = async (name: string, ownerId: string) => {
    const household = await prisma.household.create({
      data: {
        name: `${name} ${stamp}`,
        createdById: ownerId,
        memberships: { create: [{ userId: ownerId, role: 'OWNER' }] },
      },
      select: { id: true },
    });
    householdIds.push(household.id);
    return household.id;
  };

  const createIngredient = async (
    key: string,
    kcal: number | null,
  ): Promise<string> => {
    const ingredient = await prisma.ingredient.create({
      data: {
        name: `Składnik ${key}`,
        normalizedName: key,
        category: 'test',
        nutritionKcalPer100: kcal,
        nutritionProteinPer100: kcal === null ? null : 3.2,
        nutritionCarbsPer100: kcal === null ? null : 4.8,
        nutritionFatPer100: kcal === null ? null : 2,
        nutritionFiberPer100: kcal === null ? null : 0,
        allergens: kcal === null ? [] : ['MILK'],
        dietTags: kcal === null ? [] : ['DAIRY'],
      },
      select: { id: true },
    });
    ingredientIds.push(ingredient.id);
    return ingredient.id;
  };

  beforeAll(async () => {
    restoreEnv = useAdminDevGate();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    session = await createAdminSession(prisma, { stepUp: true });
    noStepUp = await createAdminSession(prisma, { stepUp: false });

    ids.author = await createUser('Autor');
    ids.other = await createUser('Sasiad');
    ids.hAuthor = await createHousehold('Dom autora', ids.author);
    ids.hOther = await createHousehold('Dom sąsiada', ids.other);

    ids.ingMilk = await createIngredient(keys.milk, 64);
    ids.ingOats = await createIngredient(keys.oats, null);

    const recipe = (data: {
      title: string;
      isCatalog: boolean;
      isActive?: boolean;
    }) =>
      prisma.recipe.create({
        data: {
          title: `${data.title} ${stamp}`,
          mealType: 'BREAKFAST',
          prepTimeMinutes: 10,
          servings: 2,
          nutritionKcal: 1_250,
          imageUrl: data.isCatalog ? null : 'https://img.scoffie.app/x.webp',
          isCatalog: data.isCatalog,
          isActive: data.isActive ?? true,
          authorId: ids.author,
          householdId: ids.hAuthor,
          allergens: ['MILK'],
          dietTags: ['DAIRY'],
          // Pisownia importu (`step`) w złej kolejności i pusty krok.
          sourceInstructions: [
            { step: 2, text: 'Zalej mlekiem.' },
            { step: 1, text: ' Wsyp płatki. ' },
            { step: 3, text: '   ' },
          ],
        },
        select: { id: true },
      });
    ids.active = (await recipe({ title: 'Owsianka A3', isCatalog: true })).id;
    ids.retired = (
      await recipe({ title: 'Wycofana A3', isCatalog: true, isActive: false })
    ).id;
    ids.private = (await recipe({ title: 'Prywatna A3', isCatalog: false })).id;

    // Kolejność linii = kolejność zapisu; mleko w ml, płatki w g.
    await prisma.recipeIngredient.create({
      data: {
        recipeId: ids.active,
        ingredientId: ids.ingOats,
        name: 'płatki',
        amount: 4,
        unit: 'łyżka',
        normalizedAmount: 40,
        normalizedUnit: 'g',
        department: 'test',
        createdAt: new Date(Date.now() - 1_000),
      },
    });
    for (const recipeId of [ids.active, ids.retired]) {
      await prisma.recipeIngredient.create({
        data: {
          recipeId,
          ingredientId: ids.ingMilk,
          name: 'mleko',
          amount: 250,
          unit: 'ml',
          normalizedAmount: 250,
          normalizedUnit: 'ml',
          department: 'test',
        },
      });
    }

    // Plany: bieżący tydzień (3 pozycje w dwóch domach — dwie w jednym
    // planie), przyszły (1), miniony (1 — historia, nie liczy się do „w
    // planach”). `inPlans` liczy PLANY, nie pozycje: 3, a nie 4.
    const monday = mondayOf(warsawDateKey(new Date()));
    const mondayKey = monday.toISOString().slice(0, 10);
    const week = (householdId: string, offsetDays: number) =>
      prisma.weeklyPlan.create({
        data: {
          householdId,
          weekStart: new Date(
            `${addDays(mondayKey, offsetDays)}T00:00:00.000Z`,
          ),
        },
        select: { id: true },
      });
    const current = await week(ids.hAuthor, 0);
    const currentOther = await week(ids.hOther, 0);
    const next = await week(ids.hAuthor, 7);
    const past = await week(ids.hAuthor, -7);
    await prisma.planItem.createMany({
      data: [
        {
          weeklyPlanId: current.id,
          recipeId: ids.active,
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
        },
        {
          weeklyPlanId: current.id,
          recipeId: ids.active,
          dayOfWeek: 'FRI',
          mealType: 'DINNER',
        },
        {
          weeklyPlanId: currentOther.id,
          recipeId: ids.active,
          dayOfWeek: 'TUE',
          mealType: 'BREAKFAST',
        },
        {
          weeklyPlanId: next.id,
          recipeId: ids.active,
          dayOfWeek: 'WED',
          mealType: 'BREAKFAST',
        },
        {
          weeklyPlanId: past.id,
          recipeId: ids.active,
          dayOfWeek: 'THU',
          mealType: 'BREAKFAST',
        },
      ],
    });
    await prisma.recipeFavorite.createMany({
      data: [
        { recipeId: ids.active, householdId: ids.hAuthor },
        { recipeId: ids.active, householdId: ids.hOther },
        { recipeId: ids.private, householdId: ids.hAuthor },
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      // Domy zabierają kaskadą przepisy, linie, plany i ulubione; składniki
      // (Restrict) dopiero po przepisach.
      await prisma.household.deleteMany({
        where: { id: { in: householdIds } },
      });
      await prisma.ingredient.deleteMany({
        where: { id: { in: ingredientIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await cleanupAdmins(prisma);
    }
    await app?.close();
    restoreEnv?.();
  });

  describe('bez sesji panelu', () => {
    it('każda trasa katalogu to 404 jak brak trasy', async () => {
      const id = randomUUID();
      await request(server()).get('/admin/catalog/recipes').expect(404);
      await request(server()).get(`/admin/catalog/recipes/${id}`).expect(404);
      await request(server()).get('/admin/catalog/ingredients').expect(404);
      await request(server())
        .put(`/admin/catalog/recipes/${id}`)
        .send({})
        .expect(404);
      await request(server())
        .post(`/admin/catalog/recipes/${id}/active`)
        .send({ isActive: false, reason: 'test bez sesji' })
        .expect(404);
    });
  });

  describe('GET /admin/catalog/recipes', () => {
    it('przepis katalogu: kcal na porcję, pozycje przyszłych planów, ulubione', async () => {
      const data = await list();
      expect(data.total).toBe(data.items.length);
      expect(data.items.find((r) => r.id === ids.active)).toEqual({
        id: ids.active,
        title: `Owsianka A3 ${stamp}`,
        imageUrl: '',
        isActive: true,
        mealType: 'BREAKFAST',
        prepTimeMinutes: 10,
        kcalPerServing: 625,
        inPlans: 3,
        favorites: 2,
      });
      // ⌘K liczy „w planach” tą samą funkcją — ta sama liczba.
      const found = (
        await request(server())
          .get(`/admin/search?q=${encodeURIComponent(`Owsianka A3 ${stamp}`)}`)
          .set('Cookie', session.cookie)
          .expect(200)
      ).body as { recipes: { id: string; inPlans: number }[] };
      expect(found.recipes.find((r) => r.id === ids.active)?.inPlans).toBe(3);
      // Przepis domu nie istnieje dla panelu.
      expect(data.items.some((r) => r.id === ids.private)).toBe(false);
      expect(data.items.find((r) => r.id === ids.retired)?.isActive).toBe(
        false,
      );
    });

    it('filtr aktywne / wycofane; total liczy pod filtrem', async () => {
      const active = await list('?active=true');
      const retired = await list('?active=false');
      const all = await list();
      expect(active.items.every((r) => r.isActive)).toBe(true);
      expect(retired.items.every((r) => !r.isActive)).toBe(true);
      expect(active.items.some((r) => r.id === ids.active)).toBe(true);
      expect(retired.items.some((r) => r.id === ids.retired)).toBe(true);
      expect(active.total + retired.total).toBe(all.total);
      await get('/recipes?active=tak').expect(400);
    });
  });

  describe('GET /admin/catalog/recipes/:id', () => {
    it('szczegół: kroki w kolejności, linie składników, slot bazowy', async () => {
      const res = await get(`/recipes/${ids.active}`).expect(200);
      const body = res.body as RecipeDetail;
      expect(body).toMatchObject({
        id: ids.active,
        description: '',
        difficulty: 'EASY',
        servings: 2,
        kcalPerServing: 625,
        inPlans: 3,
        favorites: 2,
        // Pusta kolumna = wiersz sprzed backfillu → slot bazowy.
        suitableMealTypes: ['BREAKFAST'],
        steps: ['Wsyp płatki.', 'Zalej mlekiem.'],
        ingredients: [
          { key: keys.oats, amount: 4, unit: 'łyżka' },
          { key: keys.milk, amount: 250, unit: 'ml' },
        ],
        allergens: ['MILK'],
        dietTags: ['DAIRY'],
      });
      expect(typeof body.updatedAt).toBe('string');
    });

    it('przepis domu i brak przepisu — 404, zły identyfikator — 400', async () => {
      const priv = await get(`/recipes/${ids.private}`).expect(404);
      expect((priv.body as { code: string }).code).toBe('RECIPE_NOT_FOUND');
      await get(`/recipes/${randomUUID()}`).expect(404);
      await get('/recipes/nie-uuid').expect(400);
    });
  });

  describe('GET /admin/catalog/ingredients', () => {
    it('podstawa z jednostek przepisów katalogu, makro bez danych = 0', async () => {
      const res = await get('/ingredients').expect(200);
      const byKey = new Map(
        (res.body as Ingredient[]).map((row) => [row.key, row]),
      );
      expect(byKey.get(keys.milk)).toEqual({
        key: keys.milk,
        name: `Składnik ${keys.milk}`,
        unit: 'ml',
        kcal: 64,
        protein: 3.2,
        carbs: 4.8,
        fat: 2,
        fiber: 0,
        gramsPerPiece: null,
        allergens: ['MILK'],
        dietTags: ['DAIRY'],
      });
      expect(byKey.get(keys.oats)).toMatchObject({
        unit: 'g',
        kcal: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        fiber: 0,
      });
    });
  });

  describe('PUT /admin/catalog/recipes/:id (D1)', () => {
    it('edycja zablokowana: 403 NOT_ALLOWED, przepis bez zmian', async () => {
      const res = await request(server())
        .put(`/admin/catalog/recipes/${ids.active}`)
        .set('Cookie', session.cookie)
        .send({ id: ids.active, title: 'Podmieniony tytuł' })
        .expect(403);
      expect((res.body as { code: string }).code).toBe('NOT_ALLOWED');
      const row = await prisma.recipe.findUniqueOrThrow({
        where: { id: ids.active },
      });
      expect(row.title).toBe(`Owsianka A3 ${stamp}`);
    });
  });

  describe('POST /admin/catalog/recipes/:id/active', () => {
    const REASON = 'Złe makro po zgłoszeniu użytkownika';

    it('bez świeżego potwierdzenia — 403 STEP_UP_REQUIRED, bez zmian', async () => {
      const res = await setActive(
        ids.active,
        { isActive: false, reason: REASON },
        noStepUp,
      ).expect(403);
      expect((res.body as { code: string }).code).toBe('STEP_UP_REQUIRED');
      expect(
        (await prisma.recipe.findUniqueOrThrow({ where: { id: ids.active } }))
          .isActive,
      ).toBe(true);
    });

    it('wycofanie: skutek w bazie, audyt z powodem i liczbą planów, cache', async () => {
      const cache = app.get(RecipesCacheService);
      const invalidate = jest.spyOn(cache, 'invalidateRecipesList');
      await setActive(ids.active, { isActive: false, reason: REASON }).expect(
        204,
      );
      expect(invalidate).toHaveBeenCalledTimes(1);
      invalidate.mockRestore();

      const row = await prisma.recipe.findUniqueOrThrow({
        where: { id: ids.active },
      });
      expect(row.isActive).toBe(false);
      // Pozycje w planach zostają (5 pozycji w 4 planach, w tym minionym).
      expect(
        await prisma.planItem.count({ where: { recipeId: ids.active } }),
      ).toBe(5);

      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: 'recipe.active.set', targetId: ids.active },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toMatchObject({
        result: 'SUCCESS',
        targetType: 'Recipe',
        adminUserId: session.adminUserId,
        reason: REASON,
        details: { from: true, to: false, inPlans: 3 },
      });

      const retired = await list('?active=false');
      expect(retired.items.some((r) => r.id === ids.active)).toBe(true);
    });

    it('przywrócenie', async () => {
      await setActive(ids.active, { isActive: true, reason: REASON }).expect(
        204,
      );
      expect(
        (await prisma.recipe.findUniqueOrThrow({ where: { id: ids.active } }))
          .isActive,
      ).toBe(true);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: 'recipe.active.set', targetId: ids.active },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.details).toEqual({ from: false, to: true, inPlans: 3 });
    });

    it('walidacja — 400; przepis domu — 404 z nieudanym wpisem audytu', async () => {
      await setActive(ids.active, { isActive: false }).expect(400);
      await setActive(ids.active, { isActive: false, reason: 'krót' }).expect(
        400,
      );
      await setActive(ids.active, { isActive: 'nie', reason: REASON }).expect(
        400,
      );
      await setActive(ids.active, {
        isActive: false,
        reason: REASON,
        title: 'x',
      }).expect(400);
      await setActive('nie-uuid', { isActive: false, reason: REASON }).expect(
        400,
      );

      const res = await setActive(ids.private, {
        isActive: false,
        reason: REASON,
      }).expect(404);
      expect((res.body as { code: string }).code).toBe('RECIPE_NOT_FOUND');
      expect(
        (await prisma.recipe.findUniqueOrThrow({ where: { id: ids.private } }))
          .isActive,
      ).toBe(true);
      const audit = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: 'recipe.active.set', targetId: ids.private },
      });
      expect(audit).toMatchObject({
        result: 'FAILED',
        errorCode: 'RECIPE_NOT_FOUND',
      });
    });
  });
});
