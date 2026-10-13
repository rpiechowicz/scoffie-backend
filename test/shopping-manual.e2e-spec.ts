import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Produkty dopisane ręcznie (arkusz „Dodaj produkty”) na żywej bazie.
 *
 * Testy jednostkowe pilnują reguł na mockach; tu sprawdzamy, że prawdziwe
 * zapytania (upsert po kluczu złożonym, `startsWith` w `updateMany`,
 * przeliczenie migawki, aliasy katalogu) składają się w to, co widzi
 * telefon: jeden wiersz na produkt, część dopisana opisana w `manual`,
 * kupione wraca do kupienia, a zdjęcie zostawia część z planu.
 */
type WsEnvelope<T> =
  { ok: true; data: T } | { ok: false; error: string; code: string };

type StateItem = {
  productKey: string;
  name: string;
  unit: string;
  department: string;
  totalAmount: number;
  isChecked: boolean;
  manual: {
    amount: number | null;
    unit: string | null;
    addedById: string | null;
  } | null;
};

type State = {
  items: StateItem[];
  recentProducts: Array<{
    name: string;
    ingredientId: string | null;
    amount: number | null;
    unit: string | null;
  }>;
};

const PLAN_WEEK = '2026-10-05';
const EMPTY_WEEK = '2026-10-12';

describe('Dopisane ręcznie do listy zakupów E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  let socket: Socket;
  let userId: string;
  let householdId: string;
  /** Składnik planu w g/ml, bez masy sztuki — jego klucz da się policzyć wprost. */
  let planned: {
    ingredientId: string;
    name: string;
    amount: number;
    unit: string;
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
    if (!envelope.ok) {
      throw new Error(`oczekiwano sukcesu: ${envelope.code} ${envelope.error}`);
    }
    return envelope.data;
  };

  const state = async (weekStart: string): Promise<State> =>
    okData(
      await ack<State>(socket, 'weeklyPlans:getShoppingListState', {
        householdId,
        weekStart,
      }),
    );

  const itemOf = async (weekStart: string, productKey: string) =>
    (await state(weekStart)).items.find(
      (item) => item.productKey === productKey,
    );

  const addProducts = (weekStart: string, items: object[]) =>
    ack<{ added: number }>(socket, 'weeklyPlans:addShoppingProducts', {
      householdId,
      weekStart,
      data: { items },
    });

  const plannedKey = () =>
    `${planned.name.trim().toLowerCase()}::${planned.unit}`;

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

    // Kolacja z katalogu ze składnikiem w ml (albo g) bez masy sztuki, który
    // w przepisie występuje raz — ten składnik dopisujemy z ilością.
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
        servings: true,
        ingredients: {
          select: {
            name: true,
            normalizedAmount: true,
            normalizedUnit: true,
            ingredient: {
              select: { id: true, gramsPerPiece: true, isActive: true },
            },
          },
        },
      },
      take: 60,
    });
    let recipeId: string | null = null;
    let servings = 2;
    for (const candidate of candidates) {
      const hit = candidate.ingredients.find(
        (line) =>
          (line.normalizedUnit === 'ml' || line.normalizedUnit === 'g') &&
          !line.ingredient.gramsPerPiece &&
          line.ingredient.isActive &&
          candidate.ingredients.filter(
            (other) =>
              other.name.trim().toLowerCase() ===
              line.name.trim().toLowerCase(),
          ).length === 1,
      );
      if (hit && hit.normalizedAmount != null && hit.normalizedUnit) {
        recipeId = candidate.id;
        servings = candidate.servings;
        planned = {
          ingredientId: hit.ingredient.id,
          name: hit.name,
          amount: hit.normalizedAmount,
          unit: hit.normalizedUnit,
        };
        break;
      }
    }
    if (!recipeId)
      throw new Error('katalog nie ma kolacji ze składnikiem w g/ml');

    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `Ania ${stamp}`,
        email: `ania-${stamp}@manual.local`,
      })
      .expect(201);
    const session = res.body as { accessToken: string; user: { id: string } };
    userId = session.user.id;
    createdUserIds.push(userId);

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
        data: { name: `Dom dopisanych ${Date.now()}` },
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
          recipeId,
          participantIds: [],
          plannedServings: servings,
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

  it('katalog oddaje produkty z rewizją, a przy tej samej rewizji — nic', async () => {
    const first = okData(
      await ack<{
        revision: string;
        products: Array<{ id: string; department: string }> | null;
      }>(socket, 'weeklyPlans:shoppingProducts', {}),
    );
    expect(first.products?.length).toBeGreaterThan(100);
    expect(first.products?.some((p) => p.id === planned.ingredientId)).toBe(
      true,
    );

    const again = okData(
      await ack<{ revision: string; products: unknown }>(
        socket,
        'weeklyPlans:shoppingProducts',
        { revision: first.revision },
      ),
    );
    expect(again).toEqual({ revision: first.revision, products: null });
  });

  it('dopisany z ilością sumuje się z planem w jednym wierszu i wraca do kupienia', async () => {
    const key = plannedKey();
    const before = (await itemOf(PLAN_WEEK, key))!;
    expect(before.manual).toBeNull();
    okData(
      await ack(socket, 'weeklyPlans:setShoppingItemChecked', {
        householdId,
        weekStart: PLAN_WEEK,
        data: { productKey: key, isChecked: true },
      }),
    );

    const addAmount = planned.unit === 'ml' ? 500 : 250;
    expect(
      okData(
        await addProducts(PLAN_WEEK, [
          {
            ingredientId: planned.ingredientId,
            amount: addAmount,
            unit: planned.unit,
          },
        ]),
      ),
    ).toEqual({ added: 1 });

    const after = (await state(PLAN_WEEK)).items.filter(
      (item) => item.productKey.split('::')[0] === key.split('::')[0],
    );
    expect(after).toHaveLength(1);
    expect(after[0].totalAmount).toBeCloseTo(before.totalAmount + addAmount, 1);
    expect(after[0].isChecked).toBe(false);
    expect(after[0].manual).toEqual({
      amount: addAmount,
      unit: planned.unit,
      addedById: userId,
    });
  });

  it('ponowne dopisanie bez ilości niczego nie odejmuje, a z ilością — dokłada', async () => {
    const key = plannedKey();
    const before = (await itemOf(PLAN_WEEK, key))!;

    okData(
      await addProducts(PLAN_WEEK, [{ ingredientId: planned.ingredientId }]),
    );
    expect((await itemOf(PLAN_WEEK, key))!.totalAmount).toBeCloseTo(
      before.totalAmount,
      2,
    );

    okData(
      await addProducts(PLAN_WEEK, [
        { ingredientId: planned.ingredientId, amount: 100, unit: planned.unit },
      ]),
    );
    expect((await itemOf(PLAN_WEEK, key))!.totalAmount).toBeCloseTo(
      before.totalAmount + 100,
      2,
    );
  });

  it('zmiana ilości i zdjęcie dopisanego zostawiają część z planu', async () => {
    const key = plannedKey();
    const result = okData(
      await ack<{ productKey: string }>(
        socket,
        'weeklyPlans:setShoppingProductAmount',
        {
          householdId,
          weekStart: PLAN_WEEK,
          data: { productKey: key, amount: 50, unit: planned.unit },
        },
      ),
    );
    expect(result).toEqual({ productKey: key });
    const changed = (await itemOf(PLAN_WEEK, key))!;
    expect(changed.manual?.amount).toBe(50);

    okData(
      await ack(socket, 'weeklyPlans:removeShoppingExtra', {
        householdId,
        weekStart: PLAN_WEEK,
        data: { productKey: key },
      }),
    );
    const after = (await itemOf(PLAN_WEEK, key))!;
    expect(after.manual).toBeNull();
    expect(after.totalAmount).toBeCloseTo(changed.totalAmount - 50, 1);
  });

  it('własny produkt bez ilości stoi w swoim dziale bez jednostki; nazwa z katalogu idzie jako katalog', async () => {
    okData(
      await addProducts(EMPTY_WEEK, [
        { name: '  Karma   dla kota ', department: 'Inne' },
        { name: 'MLEKO', amount: 1, unit: 'l' },
      ]),
    );

    const current = await state(EMPTY_WEEK);
    const cat = current.items.find((item) => item.name === 'Karma dla kota')!;
    expect(cat).toMatchObject({
      productKey: 'karma dla kota::',
      unit: '',
      totalAmount: 0,
      department: 'Inne',
      manual: { amount: null, unit: null, addedById: userId },
    });
    const milk = current.items.find((item) => item.productKey === 'mleko::ml')!;
    expect(milk).toMatchObject({ name: 'Mleko', totalAmount: 1000 });

    const recent = current.recentProducts.map((product) => product.name);
    expect(recent.slice(0, 2).sort()).toEqual(['Karma dla kota', 'Mleko']);
    expect(
      current.recentProducts.find((product) => product.name === 'Mleko')
        ?.ingredientId,
    ).not.toBeNull();
  });

  it('dwa dopisania tego samego produktu naraz sumują się, bez zgubionej aktualizacji', async () => {
    await Promise.all([
      addProducts(EMPTY_WEEK, [{ name: 'Baterie AA', amount: 4, unit: 'szt' }]),
      addProducts(EMPTY_WEEK, [{ name: 'baterie aa', amount: 2, unit: 'szt' }]),
    ]).then((results) => results.map(okData));

    const batteries = (await itemOf(EMPTY_WEEK, 'baterie aa::szt'))!;
    expect(batteries.totalAmount).toBe(6);
  });

  it('lista schowana po wyczyszczeniu historii pokazuje się po dopisaniu', async () => {
    okData(
      await ack(socket, 'weeklyPlans:deleteAllShoppingListArchives', {
        householdId,
        weekStart: EMPTY_WEEK,
      }),
    );
    expect((await state(EMPTY_WEEK)).items).toHaveLength(0);

    okData(await addProducts(EMPTY_WEEK, [{ name: 'Chleb żytni' }]));
    expect(
      (await state(EMPTY_WEEK)).items.some(
        (item) => item.productKey === 'chleb żytni::',
      ),
    ).toBe(true);
  });

  it('ilość bez jednostki → VALIDATION_ERROR i nic się nie zapisuje', async () => {
    const response = await addProducts(EMPTY_WEEK, [
      { name: 'Ser żółty', amount: 2 },
    ]);
    expect(response).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(
      (await state(EMPTY_WEEK)).items.some((item) =>
        item.productKey.startsWith('ser żółty::'),
      ),
    ).toBe(false);
  });
});
