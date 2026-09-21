import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * „Brakuje mi" ze szczegółu przepisu na żywej bazie.
 *
 * Testy jednostkowe pilnują reguł na mockach; tu sprawdzamy, że prawdziwe
 * zapytania (filtr po relacji w `updateMany`, klucz złożony upsertu,
 * przebudowa migawki) składają się w to, co widzi telefon: dopisane sumuje
 * się z planem pod jednym wierszem, kupione wraca do kupienia, a zdjęcie
 * dopisanego zostawia część z planu.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };

type StateItem = {
  productKey: string;
  totalAmount: number;
  isChecked: boolean;
  addedFrom: string[];
};

const PLAN_WEEK = '2026-09-21';
const EXTRAS_ONLY_WEEK = '2026-09-28';

describe('Dopisane do listy zakupów E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  let socket: Socket;
  let householdId: string;
  let recipe: {
    id: string;
    title: string;
    servings: number;
    ingredients: Array<{
      id: string;
      name: string;
      normalizedAmount: number;
      normalizedUnit: string;
    }>;
  };

  const ack = <T>(
    client: Socket,
    event: string,
    payload: unknown,
  ): Promise<WsEnvelope<T>> =>
    new Promise((resolve, reject) => {
      client
        .timeout(9000)
        .emit(event, payload, (err: Error | null, response: WsEnvelope<T>) => {
          if (err) reject(err);
          else resolve(response);
        });
    });

  const okData = <T>(envelope: WsEnvelope<T>): T => {
    if (!envelope.ok) throw new Error(`oczekiwano sukcesu: ${envelope.code}`);
    return envelope.data;
  };

  const productKeyOf = (ingredient: { name: string; normalizedUnit: string }) =>
    `${ingredient.name.trim().toLowerCase()}::${ingredient.normalizedUnit.trim().toLowerCase()}`;

  const listItems = async (weekStart: string): Promise<StateItem[]> =>
    okData(
      await ack<{ items: StateItem[] }>(
        socket,
        'weeklyPlans:getShoppingListState',
        { householdId, weekStart },
      ),
    ).items;

  const itemOf = async (weekStart: string, productKey: string) =>
    (await listItems(weekStart)).find((item) => item.productKey === productKey);

  const addExtras = (
    weekStart: string,
    data: { recipeId: string; servings: number; ingredientIds: string[] },
  ) =>
    ack(socket, 'weeklyPlans:addRecipeExtras', {
      householdId,
      weekStart,
      data,
    });

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

    // Kolacja z katalogu z co najmniej dwoma składnikami o RÓŻNYCH kluczach —
    // jeden dopisujemy, drugi pilnuje, że reszta listy zostaje nietknięta.
    const candidates = await prisma.recipe.findMany({
      where: {
        isCatalog: true,
        isActive: true,
        OR: [
          { suitableMealTypes: { has: 'DINNER' } },
          { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
        ],
      },
      select: {
        id: true,
        title: true,
        servings: true,
        ingredients: {
          select: {
            id: true,
            name: true,
            normalizedAmount: true,
            normalizedUnit: true,
          },
        },
      },
      take: 20,
    });
    const found = candidates.find(
      (candidate) =>
        new Set(candidate.ingredients.map(productKeyOf)).size ===
          candidate.ingredients.length && candidate.ingredients.length >= 2,
    );
    if (!found) throw new Error('katalog nie ma kolacji z dwoma składnikami');
    recipe = found;

    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `Ania ${stamp}`,
        email: `ania-${stamp}@extras.local`,
      })
      .expect(201);
    const session = res.body as { accessToken: string; user: { id: string } };
    createdUserIds.push(session.user.id);

    socket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: session.accessToken },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });

    householdId = okData(
      await ack<{ id: string }>(socket, 'households:create', {
        data: { name: `Dom zakupów ${Date.now()}` },
      }),
    ).id;
    createdHouseholdIds.push(householdId);

    okData(
      await ack(socket, 'weeklyPlans:upsertWeekSlot', {
        householdId,
        weekStart: PLAN_WEEK,
        data: {
          dayOfWeek: 'MON',
          mealType: 'DINNER',
          recipeId: recipe.id,
          participantIds: [],
          plannedServings: recipe.servings,
        },
      }),
    );
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.WS_AUTH_MODE;
    else process.env.WS_AUTH_MODE = originalMode;
    for (const client of sockets.splice(0)) client.disconnect();
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

  it('dopisane sumuje się z planem pod jednym wierszem i wraca do kupienia', async () => {
    const [first, second] = recipe.ingredients;
    const firstKey = productKeyOf(first);
    const planned = (await itemOf(PLAN_WEEK, firstKey))!;
    expect(planned.addedFrom).toEqual([]);

    okData(
      await ack(socket, 'weeklyPlans:setShoppingItemChecked', {
        householdId,
        weekStart: PLAN_WEEK,
        data: { productKey: firstKey, isChecked: true },
      }),
    );

    const result = okData(
      await addExtras(PLAN_WEEK, {
        recipeId: recipe.id,
        servings: recipe.servings,
        ingredientIds: [first.id],
      }),
    );
    expect(result).toEqual({ added: 1, productKeys: [firstKey] });

    const after = (await itemOf(PLAN_WEEK, firstKey))!;
    expect(after.totalAmount).toBeCloseTo(planned.totalAmount * 2, 1);
    expect(after.isChecked).toBe(false);
    expect(after.addedFrom).toEqual([recipe.title]);

    // Drugi składnik nie był dopisany — zostaje tak, jak policzył go plan.
    const untouched = (await itemOf(PLAN_WEEK, productKeyOf(second)))!;
    expect(untouched.addedFrom).toEqual([]);
  });

  it('ponowne dopisanie tego samego przepisu podmienia ilość, zamiast ją dublować', async () => {
    const [first] = recipe.ingredients;
    const firstKey = productKeyOf(first);
    const before = (await itemOf(PLAN_WEEK, firstKey))!.totalAmount;

    okData(
      await addExtras(PLAN_WEEK, {
        recipeId: recipe.id,
        servings: recipe.servings,
        ingredientIds: [first.id],
      }),
    );

    expect((await itemOf(PLAN_WEEK, firstKey))!.totalAmount).toBeCloseTo(
      before,
      2,
    );
  });

  it('zdjęcie dopisanego zostawia część z planu', async () => {
    const [first] = recipe.ingredients;
    const firstKey = productKeyOf(first);

    okData(
      await ack(socket, 'weeklyPlans:removeShoppingExtra', {
        householdId,
        weekStart: PLAN_WEEK,
        data: { productKey: firstKey },
      }),
    );

    const after = (await itemOf(PLAN_WEEK, firstKey))!;
    expect(after.totalAmount).toBeCloseTo(first.normalizedAmount, 1);
    expect(after.addedFrom).toEqual([]);
  });

  it('tydzień bez planu dostaje listę z samych dopisanych, na tyle porcji, na ile poproszono', async () => {
    const [first] = recipe.ingredients;

    okData(
      await addExtras(EXTRAS_ONLY_WEEK, {
        recipeId: recipe.id,
        servings: 1,
        ingredientIds: [first.id],
      }),
    );

    const items = await listItems(EXTRAS_ONLY_WEEK);
    expect(items).toHaveLength(1);
    expect(items[0].totalAmount).toBeCloseTo(
      first.normalizedAmount / Math.max(1, recipe.servings),
      1,
    );
  });

  it('nieznany przepis → RECIPE_NOT_FOUND', async () => {
    const response = await addExtras(PLAN_WEEK, {
      recipeId: '99999999-9999-4999-8999-999999999999',
      servings: 1,
      ingredientIds: [recipe.ingredients[0].id],
    });
    expect(response).toMatchObject({ ok: false, code: 'RECIPE_NOT_FOUND' });
  });
});
