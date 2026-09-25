import { randomBytes, randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type {
  CatalogInsights,
  DatabaseData,
  RuntimeSettingChange,
  RuntimeSettingsData,
  TrafficState,
} from '../src/admin/contract';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Panel — runda 5: jakość i popularność katalogu (`/admin/catalog/insights`),
 * stan bazy (`/admin/ops/database`), ruch z Cloudflare (`/admin/traffic`,
 * na podstawionym `fetch`) i nowe pozycje Sterowania z historią zmian.
 */
describe('Panel — katalog: jakość, baza danych, ruch, sterowanie', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let admin: AdminE2ESession;

  const originals = { ...process.env };
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const userIds: string[] = [];
  const householdIds: string[] = [];
  const ingredientIds: string[] = [];
  const ids = {
    user: '',
    household: '',
    good: '',
    gappy: '',
    lonely: '',
    private: '',
    oats: '',
    egg: '',
    milk: '',
  };

  const server = () => app.getHttpServer();
  const get = (path: string) =>
    request(server()).get(path).set('Cookie', admin.cookie);

  const ingredient = async (
    key: string,
    data: { kcal: number | null; gramsPerPiece?: number | null },
  ) => {
    const row = await prisma.ingredient.create({
      data: {
        name: `Składnik ${key}`,
        normalizedName: key,
        category: 'test',
        nutritionKcalPer100: data.kcal,
        nutritionProteinPer100: data.kcal === null ? null : 5,
        nutritionCarbsPer100: data.kcal === null ? null : 10,
        nutritionFatPer100: data.kcal === null ? null : 3,
        nutritionFiberPer100: data.kcal === null ? null : 0,
        gramsPerPiece: data.gramsPerPiece ?? null,
      },
      select: { id: true },
    });
    ingredientIds.push(row.id);
    return row.id;
  };

  const line = (
    ingredientId: string,
    unit: 'g' | 'ml' | 'szt',
    amount: number,
  ) => ({
    ingredientId,
    name: 'linia',
    amount,
    unit,
    normalizedAmount: amount,
    normalizedUnit: unit,
    department: 'test',
  });

  beforeAll(async () => {
    for (const key of [
      'ADMIN_CLOUDFLARE_TOKEN',
      'ADMIN_CLOUDFLARE_ZONE_ID',
      'AI_CARDS_MODE',
      'THROTTLE_AGENT_POLL_LIMIT',
    ]) {
      delete process.env[key];
    }
    restoreGate = useAdminDevGate();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.runtimeSetting.deleteMany({
      where: { key: { in: ['AI_CARDS_MODE', 'THROTTLE_AGENT_POLL_LIMIT'] } },
    });
    admin = await createAdminSession(prisma, { stepUp: true });

    const user = await prisma.user.create({
      data: {
        displayName: `Insights ${stamp}`,
        email: `insights-${stamp}@admin-b4.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    ids.user = user.id;
    userIds.push(user.id);
    const household = await prisma.household.create({
      data: {
        name: `Dom insights ${stamp}`,
        createdById: ids.user,
        memberships: { create: [{ userId: ids.user, role: 'OWNER' }] },
      },
      select: { id: true },
    });
    ids.household = household.id;
    householdIds.push(household.id);

    ids.milk = await ingredient(`mleko-b4-${stamp}`, { kcal: 64 });
    ids.oats = await ingredient(`platki-b4-${stamp}`, { kcal: null });
    ids.egg = await ingredient(`jajko-b4-${stamp}`, { kcal: 140 });

    const recipe = async (data: {
      title: string;
      isCatalog?: boolean;
      imageUrl?: string | null;
      kcal: number;
      protein: number;
      fat: number;
      carbs: number;
      steps: boolean;
      lines: ReturnType<typeof line>[];
    }) =>
      (
        await prisma.recipe.create({
          data: {
            title: `${data.title} ${stamp}`,
            mealType: 'BREAKFAST',
            suitableMealTypes: ['BREAKFAST'],
            prepTimeMinutes: 10,
            servings: 2,
            nutritionKcal: data.kcal,
            nutritionProtein: data.protein,
            nutritionFat: data.fat,
            nutritionCarbs: data.carbs,
            imageUrl:
              data.imageUrl === undefined
                ? 'https://img.scoffie.app/b4.webp'
                : data.imageUrl,
            isCatalog: data.isCatalog ?? true,
            authorId: ids.user,
            householdId: ids.household,
            sourceInstructions: data.steps
              ? [{ step: 1, text: 'Wymieszaj.' }]
              : [],
            ingredients: { create: data.lines },
          },
          select: { id: true },
        })
      ).id;

    // 4·10 + 4·50 + 9·10 = 330 kcal — spójne.
    ids.good = await recipe({
      title: 'Dobra B4',
      kcal: 330,
      protein: 10,
      fat: 10,
      carbs: 50,
      steps: true,
      lines: [line(ids.milk, 'ml', 200)],
    });
    ids.gappy = await recipe({
      title: 'Dziurawa B4',
      imageUrl: null,
      kcal: 0,
      protein: 0,
      fat: 0,
      carbs: 0,
      steps: false,
      lines: [line(ids.oats, 'g', 40), line(ids.egg, 'szt', 2)],
    });
    ids.lonely = await recipe({
      title: 'Samotna B4',
      kcal: 330,
      protein: 10,
      fat: 10,
      carbs: 50,
      steps: true,
      lines: [line(ids.milk, 'ml', 100)],
    });
    ids.private = await recipe({
      title: 'Prywatna B4',
      isCatalog: false,
      imageUrl: null,
      kcal: 0,
      protein: 0,
      fat: 0,
      carbs: 0,
      steps: false,
      lines: [],
    });

    // Plan: dobra ×2 (dwa sloty), dziurawa ×1; zjedzona dobra; ulubiona dobra.
    const plan = await prisma.weeklyPlan.create({
      data: {
        householdId: ids.household,
        weekStart: new Date('2026-09-21T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const item = await prisma.planItem.create({
      data: {
        weeklyPlanId: plan.id,
        recipeId: ids.good,
        dayOfWeek: 'MON',
        mealType: 'BREAKFAST',
      },
      select: { id: true },
    });
    await prisma.planItem.create({
      data: {
        weeklyPlanId: plan.id,
        recipeId: ids.good,
        dayOfWeek: 'TUE',
        mealType: 'BREAKFAST',
      },
    });
    await prisma.planItem.create({
      data: {
        weeklyPlanId: plan.id,
        recipeId: ids.gappy,
        dayOfWeek: 'WED',
        mealType: 'BREAKFAST',
      },
    });
    await prisma.planItemConsumption.create({
      data: { planItemId: item.id, userId: ids.user },
    });
    await prisma.recipeFavorite.create({
      data: { recipeId: ids.good, householdId: ids.household },
    });

    // Propozycja: dobra jako NOWA, dziurawa jako KEPT (nie liczy się).
    const conversation = await prisma.agentConversation.create({
      data: { userId: ids.user, householdId: ids.household },
      select: { id: true },
    });
    await prisma.agentProposal.create({
      data: {
        conversationId: conversation.id,
        turnId: randomUUID(),
        userId: ids.user,
        householdId: ids.household,
        kind: 'PLAN_WEEK',
        weekStart: new Date('2026-09-21T00:00:00.000Z'),
        action: {},
        card: {
          kind: 'PLAN_WEEK',
          days: [
            {
              slots: [
                { recipeId: ids.good, change: 'NEW' },
                { recipeId: ids.gappy, change: 'KEPT' },
              ],
            },
          ],
        },
        baselineHash: `b4-${stamp}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    // „Czego nie jem”: jajko u jednej osoby.
    await prisma.userPreference.create({
      data: { userId: ids.user, excludedIngredientIds: [ids.egg] },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.household.deleteMany({
        where: { id: { in: householdIds } },
      });
      await prisma.ingredient.deleteMany({
        where: { id: { in: ingredientIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.runtimeSetting.deleteMany({
        where: { key: { in: ['AI_CARDS_MODE', 'THROTTLE_AGENT_POLL_LIMIT'] } },
      });
      await cleanupAdmins(prisma);
    }
    await app?.close();
    restoreGate?.();
    process.env = originals;
  });

  it('bez sesji nowe trasy to 404', async () => {
    for (const path of [
      '/admin/catalog/insights',
      '/admin/ops/database',
      '/admin/traffic',
      '/admin/settings/changes',
    ]) {
      await request(server()).get(path).expect(404);
    }
  });

  it('jakość: luki przepisów katalogu, bez prywatnych', async () => {
    const body = (await get('/admin/catalog/insights').expect(200))
      .body as CatalogInsights;
    const byId = new Map(body.recipes.map((row) => [row.id, row]));
    expect(byId.has(ids.good)).toBe(false);
    expect(byId.has(ids.lonely)).toBe(false);
    expect(byId.has(ids.private)).toBe(false);
    const gappy = byId.get(ids.gappy);
    expect(gappy?.gaps).toEqual([
      'no-image',
      'zero-macros',
      'ingredient-no-nutrition',
      'piece-no-grams',
      'no-steps',
    ]);
    expect(gappy?.ingredients).toEqual(
      expect.arrayContaining([`Składnik platki-b4-${stamp}`]),
    );
    expect(gappy?.ingredients).toContain(`Składnik jajko-b4-${stamp}`);
    for (const kind of [
      'no-image',
      'zero-macros',
      'ingredient-no-nutrition',
      'piece-no-grams',
      'no-steps',
    ] as const) {
      expect(body.gaps[kind]).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(body.gaps)).toHaveLength(8);
  });

  it('popularność: plany, zjedzone, ulubione, propozycje, nieużyte, wykluczenia', async () => {
    const { popularity } = (await get('/admin/catalog/insights').expect(200))
      .body as CatalogInsights;
    const count = (list: { id: string; count: number }[], id: string) =>
      list.find((row) => row.id === id)?.count;
    expect(popularity.days).toBe(30);
    expect(count(popularity.planned, ids.good)).toBe(2);
    expect(count(popularity.eaten, ids.good)).toBe(1);
    expect(count(popularity.favorites, ids.good)).toBe(1);
    expect(count(popularity.proposed, ids.good)).toBe(1);
    expect(popularity.proposed.some((row) => row.id === ids.gappy)).toBe(false);
    expect(popularity.neverUsedTotal).toBeGreaterThanOrEqual(1);
    expect(popularity.planned.every((row) => row.id !== ids.private)).toBe(
      true,
    );
    const egg = popularity.excludedIngredients.find(
      (row) => row.key === `jajko-b4-${stamp}`,
    );
    expect(egg).toEqual({
      key: `jajko-b4-${stamp}`,
      name: `Składnik jajko-b4-${stamp}`,
      count: 1,
    });
    // Tylko liczby — żadnych identyfikatorów osób.
    expect(JSON.stringify(popularity)).not.toContain(ids.user);
  });

  it('baza danych: liczby, tabele, migracje — bez tekstów zapytań', async () => {
    const body = (await get('/admin/ops/database').expect(200))
      .body as DatabaseData;
    expect(body.sizeBytes).toBeGreaterThan(0);
    expect(body.tables.length).toBeGreaterThan(0);
    expect(body.tables.length).toBeLessThanOrEqual(10);
    for (const table of body.tables) {
      expect(typeof table.totalBytes).toBe('number');
      expect(typeof table.rowsEstimate).toBe('number');
    }
    expect(body.connections.length).toBeGreaterThan(0);
    expect(body.maxConnections).toBeGreaterThan(0);
    expect(body.migrations.last?.name).toMatch(/^\d{14}_/);
    expect(body.migrations.applied).toBeGreaterThan(0);
    expect(body.migrations.failed).toEqual([]);
    // Kontener e2e zwykle nie ma pg_stat_statements (`null`); z nim —
    // tylko znormalizowany DML, przycięty (DDL i SET bywają z literałami).
    for (const slow of body.slowQueries ?? []) {
      expect(slow.query.length).toBeLessThanOrEqual(200);
      expect(slow.query).toMatch(/^(SELECT|INSERT|UPDATE|DELETE|WITH)[^A-Z_]/i);
    }
    for (const long of body.longQueries) {
      expect(Object.keys(long).sort()).toEqual(
        ['seconds', 'state', 'waitEventType'].sort(),
      );
    }
    // Tekst żadnego zapytania z pg_stat_activity (także tego, który właśnie
    // czytał widok) nie wychodzi do panelu.
    const text = JSON.stringify({ ...body, slowQueries: null });
    expect(text).not.toMatch(/SELECT|pg_stat_activity|FROM /i);
  });

  it('ruch: off bez zmiennych, ok na podstawionym fetch', async () => {
    expect((await get('/admin/traffic').expect(200)).body).toEqual({
      status: 'off',
      missing: ['ADMIN_CLOUDFLARE_TOKEN', 'ADMIN_CLOUDFLARE_ZONE_ID'],
    });

    process.env.ADMIN_CLOUDFLARE_TOKEN = 'cf-e2e';
    process.env.ADMIN_CLOUDFLARE_ZONE_ID = `zone-${stamp}`;
    const today = new Date().toISOString().slice(0, 10);
    const realFetch = globalThis.fetch;
    const fetchMock = jest.fn((url: string | URL | Request) => {
      const target =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (target !== 'https://api.cloudflare.com/client/v4/graphql') {
        return realFetch(url);
      }
      const zone =
        fetchMock.mock.calls.length === 1
          ? {
              days: [
                {
                  dimensions: { date: today },
                  sum: { requests: 42, pageViews: 7 },
                  uniq: { uniques: 5 },
                },
              ],
            }
          : {
              paths: [{ count: 9, dimensions: { clientRequestPath: '/' } }],
              countries: [
                { count: 9, dimensions: { clientCountryName: 'PL' } },
              ],
              invites: [{ count: 2, dimensions: { date: today } }],
            };
      return Promise.resolve(
        new Response(JSON.stringify({ data: { viewer: { zones: [zone] } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const state = (await get('/admin/traffic').expect(200))
        .body as TrafficState;
      expect(state.status).toBe('ok');
      if (state.status !== 'ok') return;
      expect(state.data.days).toHaveLength(30);
      expect(state.data.days[29]).toEqual({
        date: today,
        requests: 42,
        visitors: 5,
        pageViews: 7,
      });
      expect(state.data.paths).toEqual([{ name: '/', count: 9 }]);
      expect(state.data.invites?.total).toBe(2);
      // Drugie odczytanie w oknie cache nie pyta Cloudflare.
      await get('/admin/traffic').expect(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.ADMIN_CLOUDFLARE_TOKEN;
      delete process.env.ADMIN_CLOUDFLARE_ZONE_ID;
    }
  });

  it('sterowanie: tryb kart i limit throttlera walidowane, historia zmian', async () => {
    const put = (key: string, value: string) =>
      request(server())
        .put(`/admin/settings/${key}`)
        .set('Cookie', admin.cookie)
        .send({ value, reason: 'test rundy 5' });

    await put('AI_CARDS_MODE', 'lenient').expect(400);
    await put('THROTTLE_AGENT_POLL_LIMIT', '0').expect(400);
    await put('THROTTLE_ADMIN_LIMIT', '5').expect(404);
    await put('AI_CARDS_MODE', 'soft').expect(204);
    await put('THROTTLE_AGENT_POLL_LIMIT', '77').expect(204);

    const data = (await get('/admin/settings').expect(200))
      .body as RuntimeSettingsData;
    const cards = data.settings.find((s) => s.key === 'AI_CARDS_MODE');
    expect(cards).toMatchObject({
      kind: 'choice',
      options: ['off', 'soft', 'strict'],
      override: 'soft',
      effective: 'soft',
    });
    expect(
      data.settings.find((s) => s.key === 'THROTTLE_AGENT_POLL_LIMIT'),
    ).toMatchObject({ kind: 'number', override: '77', effective: '77' });

    await request(server())
      .delete('/admin/settings/AI_CARDS_MODE')
      .set('Cookie', admin.cookie)
      .send({ reason: 'powrót do Railwaya' })
      .expect(204);

    const changes = (await get('/admin/settings/changes?days=1').expect(200))
      .body as RuntimeSettingChange[];
    const mine = changes.filter((c) =>
      ['AI_CARDS_MODE', 'THROTTLE_AGENT_POLL_LIMIT'].includes(c.key),
    );
    expect(mine.slice(-3)).toEqual([
      expect.objectContaining({
        key: 'AI_CARDS_MODE',
        action: 'set',
        value: 'soft',
      }),
      expect.objectContaining({
        key: 'THROTTLE_AGENT_POLL_LIMIT',
        action: 'set',
        value: '77',
      }),
      expect.objectContaining({
        key: 'AI_CARDS_MODE',
        action: 'clear',
        value: null,
        previous: 'soft',
      }),
    ]);
    await get('/admin/settings/changes?days=0').expect(400);
  });
});
