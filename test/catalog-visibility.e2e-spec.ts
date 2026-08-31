import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Rozdzielenie katalogu od przepisów gospodarstwa (Faza 0, krok 3 —
 * `isCatalog`) na żywej bazie.
 *
 * Do tej pory `Recipe` nie miał pojęcia widoczności: `findAll` czytał bez
 * `householdId`, a `ensureRecipeForHousehold` ignorowało swój argument. Dopóki
 * przepisy tworzył wyłącznie bot importu, nikt tego nie zauważył — z chwilą,
 * gdy pisać zacznie asystent, przepis domu A trafiłby na listę domu B.
 *
 * Ta suita sprawdza dokładnie to, czego testy jednostkowe (na mockach Prismy)
 * NIE udowodnią: że zapytanie naprawdę filtruje w Postgresie, oraz że cudzego
 * przepisu nie da się wstawić do własnego planu.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; message?: string; code: string };

type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

type RecipeRow = { id: string; title: string };

const WEEK_START = '2026-08-31';

describe('Widoczność katalogu E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const createdRecipeIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  let householdA: string;
  let householdB: string;
  let socketA: Socket;
  let socketB: Socket;
  let privateRecipeId: string;
  let catalogRecipeId: string;

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@catalog.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    return session;
  };

  const connect = (token: string): Socket => {
    const client = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token },
    });
    sockets.push(client);
    return client;
  };

  const waitConnect = (client: Socket): Promise<void> =>
    new Promise((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', (err: Error) => reject(err));
    });

  const ack = <T>(
    client: Socket,
    event: string,
    payload: unknown,
  ): Promise<WsEnvelope<T>> =>
    new Promise((resolve, reject) => {
      client
        .timeout(7000)
        .emit(event, payload, (err: Error | null, response: WsEnvelope<T>) => {
          if (err) reject(err);
          else resolve(response);
        });
    });

  const okData = <T>(envelope: WsEnvelope<T>): T => {
    if (!envelope.ok) {
      throw new Error(`oczekiwano sukcesu, dostano ${envelope.code}`);
    }
    return envelope.data;
  };

  const listRecipes = async (
    client: Socket,
    householdId: string,
  ): Promise<RecipeRow[]> =>
    okData(
      await ack<RecipeRow[]>(client, 'recipes:findAll', {
        householdId,
        filters: { householdId, page: 1, limit: 100 },
      }),
    );

  beforeAll(async () => {
    process.env.WS_AUTH_MODE = 'strict';
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);

    const catalogRecipe = await prisma.recipe.findFirst({
      where: { isCatalog: true, isActive: true },
      select: { id: true },
    });
    if (!catalogRecipe) throw new Error('baza dev nie ma katalogu');
    catalogRecipeId = catalogRecipe.id;

    const sessionA = await devLogin('Ala');
    const sessionB = await devLogin('Bartek');
    socketA = connect(sessionA.accessToken);
    socketB = connect(sessionB.accessToken);
    await Promise.all([waitConnect(socketA), waitConnect(socketB)]);

    householdA = okData(
      await ack<{ id: string }>(socketA, 'households:create', {
        data: { name: `Dom Ali ${Date.now()}` },
      }),
    ).id;
    householdB = okData(
      await ack<{ id: string }>(socketB, 'households:create', {
        data: { name: `Dom Bartka ${Date.now()}` },
      }),
    ).id;
    createdHouseholdIds.push(householdA, householdB);

    privateRecipeId = okData(
      await ack<{ id: string }>(socketA, 'recipes:create', {
        data: {
          householdId: householdA,
          title: `Sekretna zapiekanka Ali ${Date.now()}`,
          description: 'Prywatny przepis jednego domu.',
          mealType: 'DINNER',
          suitableMealTypes: ['DINNER'],
          difficulty: 'EASY',
          prepTimeMinutes: 30,
          servings: 2,
          nutritionKcal: 600,
          nutritionProtein: 25,
          nutritionFat: 20,
          nutritionCarbs: 70,
          nutritionFiber: 5,
          nutritionSalt: 1.5,
        },
      }),
    ).id;
    createdRecipeIds.push(privateRecipeId);
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.WS_AUTH_MODE;
    else process.env.WS_AUTH_MODE = originalMode;
    for (const client of sockets.splice(0)) client.disconnect();
    if (createdRecipeIds.length) {
      await prisma.recipe.deleteMany({
        where: { id: { in: createdRecipeIds } },
      });
    }
    if (createdHouseholdIds.length) {
      await prisma.household.deleteMany({
        where: { id: { in: createdHouseholdIds } },
      });
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('przepis utworzony przez użytkownika NIE trafia do wspólnego katalogu', async () => {
    const row = await prisma.recipe.findUnique({
      where: { id: privateRecipeId },
      select: { isCatalog: true },
    });
    // To jest cała różnica: przed Fazą 0 każdy `recipes:create` był de facto
    // wpisem do katalogu widocznego dla wszystkich gospodarstw.
    expect(row?.isCatalog).toBe(false);
  });

  it('autor widzi swój przepis na liście swojego domu', async () => {
    const recipes = await listRecipes(socketA, householdA);
    expect(recipes.map((r) => r.id)).toContain(privateRecipeId);
  });

  it('obcy dom NIE widzi go na swojej liście', async () => {
    const recipes = await listRecipes(socketB, householdB);
    expect(recipes.map((r) => r.id)).not.toContain(privateRecipeId);
  });

  it('katalog widzą oba domy — zawężenie nie zabrało nikomu wspólnych przepisów', async () => {
    const [forA, forB] = await Promise.all([
      listRecipes(socketA, householdA),
      listRecipes(socketB, householdB),
    ]);
    expect(forA.map((r) => r.id)).toContain(catalogRecipeId);
    expect(forB.map((r) => r.id)).toContain(catalogRecipeId);
  });

  it('odczyt cudzego przepisu po id to 404, nie 403', async () => {
    const response = await ack(socketB, 'recipes:findById', {
      id: privateRecipeId,
      householdId: householdB,
    });
    // 403 potwierdzałoby, że taki przepis istnieje.
    expect(response).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
  });

  it('cudzego przepisu nie da się wstawić do własnego planu', async () => {
    const response = await ack(socketB, 'weeklyPlans:upsertWeekSlot', {
      householdId: householdB,
      weekStart: WEEK_START,
      data: {
        dayOfWeek: 'MON',
        mealType: 'DINNER',
        recipeId: privateRecipeId,
        participantIds: [],
        plannedServings: 2,
      },
    });
    // Dawniej `ensureRecipeForHousehold` ignorowało `householdId`, więc każdy
    // przepis w bazie nadawał się do każdego planu.
    expect(response).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
  });

  it('własny przepis wchodzi do własnego planu bez przeszkód', async () => {
    const response = await ack(socketA, 'weeklyPlans:upsertWeekSlot', {
      householdId: householdA,
      weekStart: WEEK_START,
      data: {
        dayOfWeek: 'MON',
        mealType: 'DINNER',
        recipeId: privateRecipeId,
        participantIds: [],
        plannedServings: 2,
      },
    });
    expect(response.ok).toBe(true);
  });

  it('przepis z katalogu wchodzi do planu dowolnego domu', async () => {
    const response = await ack(socketB, 'weeklyPlans:upsertWeekSlot', {
      householdId: householdB,
      weekStart: WEEK_START,
      data: {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: catalogRecipeId,
        participantIds: [],
        plannedServings: 2,
      },
    });
    expect(response.ok).toBe(true);
  });
});
