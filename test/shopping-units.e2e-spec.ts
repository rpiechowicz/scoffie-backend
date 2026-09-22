import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { SHOPPING_LIST_RULES_VERSION } from '../src/weekly-plans/services/shopping-list.service';

/**
 * Jedna jednostka na produkt — na żywej bazie i prawdziwym katalogu.
 *
 * Zgłoszenie z 22.09.2026: tydzień z przepisem, który ma cebulę w gramach,
 * i drugim, który ma ją w sztukach, pokazywał „Cebula (g)” i „Cebula (szt)”.
 * Testy jednostkowe pilnują reguły na atrapach; tu sprawdzamy, że masa sztuki
 * naprawdę dojeżdża z `Ingredient` przez relację, że dopisane sprzed
 * poprawki (klucz `cebula::g`) składają się w ten sam wiersz, i że migawka
 * zbudowana według starszych reguł przelicza się przy odczycie.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };

type StateItem = {
  productKey: string;
  name: string;
  unit: string;
  totalAmount: number;
  addedFrom: string[];
};

type CatalogRecipe = {
  id: string;
  title: string;
  servings: number;
  cebula: { id: string; normalizedAmount: number };
};

const WEEK = '2026-09-21';
const CEBULA = 'cebula';

describe('Jedna jednostka na produkt na liście zakupów E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  let socket: Socket;
  let householdId: string;
  let gramsPerPiece: number;
  let inGrams: CatalogRecipe;
  let inPieces: CatalogRecipe;

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

  const listItems = async (): Promise<StateItem[]> =>
    okData(
      await ack<{ items: StateItem[] }>(
        socket,
        'weeklyPlans:getShoppingListState',
        { householdId, weekStart: WEEK },
      ),
    ).items;

  const onionRows = async () =>
    (await listItems()).filter((item) =>
      item.productKey.startsWith(`${CEBULA}::`),
    );

  /** Sztuki na liście: w górę do połówki, jak `roundShoppingAmount`. */
  const pieces = (amount: number) => Math.ceil(amount * 2 - 0.000_001) / 2;

  /** Kolacja z katalogu, która ma cebulę w podanej jednostce. */
  const dinnerWithOnionIn = async (
    unit: 'g' | 'szt',
  ): Promise<CatalogRecipe> => {
    const found = await prisma.recipe.findFirst({
      where: {
        isCatalog: true,
        isActive: true,
        OR: [
          { suitableMealTypes: { has: 'DINNER' } },
          { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
        ],
        ingredients: {
          some: { ingredient: { name: CEBULA }, normalizedUnit: unit },
        },
      },
      orderBy: { title: 'asc' },
      select: {
        id: true,
        title: true,
        servings: true,
        ingredients: {
          where: { ingredient: { name: CEBULA } },
          select: { id: true, normalizedAmount: true },
        },
      },
    });
    if (!found) {
      throw new Error(`katalog nie ma kolacji z cebulą w jednostce ${unit}`);
    }
    return { ...found, cebula: found.ingredients[0] };
  };

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

    const onion = await prisma.ingredient.findUniqueOrThrow({
      where: { name: CEBULA },
      select: { gramsPerPiece: true },
    });
    if (!onion.gramsPerPiece) throw new Error('cebula bez masy sztuki');
    gramsPerPiece = onion.gramsPerPiece;
    inGrams = await dinnerWithOnionIn('g');
    inPieces = await dinnerWithOnionIn('szt');

    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `Ola ${stamp}`,
        email: `ola-${stamp}@units.local`,
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
        data: { name: `Dom jednostek ${Date.now()}` },
      }),
    ).id;
    createdHouseholdIds.push(householdId);

    for (const [dayOfWeek, recipe] of [
      ['MON', inGrams],
      ['TUE', inPieces],
    ] as const) {
      okData(
        await ack(socket, 'weeklyPlans:upsertWeekSlot', {
          householdId,
          weekStart: WEEK,
          data: {
            dayOfWeek,
            mealType: 'DINNER',
            recipeId: recipe.id,
            participantIds: [],
            plannedServings: recipe.servings,
          },
        }),
      );
    }
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

  it('cebula w gramach i w sztukach to jeden wiersz w sztukach', async () => {
    const rows = await onionRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productKey: `${CEBULA}::szt`,
      name: 'Cebula',
      unit: 'szt',
      totalAmount: pieces(
        inGrams.cebula.normalizedAmount / gramsPerPiece +
          inPieces.cebula.normalizedAmount,
      ),
    });
  });

  it('dopisana cebula sprzed poprawki (klucz w gramach) składa się w ten sam wiersz i schodzi razem z nim', async () => {
    const before = (await onionRows())[0].totalAmount;
    // Wiersz dokładnie taki, jaki zapisywał kod sprzed ujednolicenia.
    await prisma.shoppingListExtra.create({
      data: {
        householdId,
        weekStart: new Date(`${WEEK}T00:00:00.000Z`),
        recipeId: inGrams.id,
        productKey: `${CEBULA}::g`,
        name: 'Cebula',
        unit: 'g',
        department: 'Warzywa',
        amount: gramsPerPiece * 2,
      },
    });
    await prisma.shoppingList.updateMany({
      where: { householdId },
      data: { isStale: true },
    });

    const rows = await onionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].productKey).toBe(`${CEBULA}::szt`);
    expect(rows[0].totalAmount).toBeCloseTo(before + 2, 5);
    expect(rows[0].addedFrom).toEqual([inGrams.title]);

    const removed = okData(
      await ack<{ removed: number }>(
        socket,
        'weeklyPlans:removeShoppingExtra',
        {
          householdId,
          weekStart: WEEK,
          data: { productKey: `${CEBULA}::szt` },
        },
      ),
    );
    expect(removed).toEqual({ removed: 1 });
    expect((await onionRows())[0].totalAmount).toBeCloseTo(before, 5);
  });

  it('„brakuje mi” dopisuje cebulę w sztukach, pod kluczem wiersza z planu', async () => {
    const result = okData(
      await ack<{ added: number; productKeys: string[] }>(
        socket,
        'weeklyPlans:addRecipeExtras',
        {
          householdId,
          weekStart: WEEK,
          data: {
            recipeId: inGrams.id,
            servings: inGrams.servings,
            ingredientIds: [inGrams.cebula.id],
          },
        },
      ),
    );

    expect(result).toEqual({ added: 1, productKeys: [`${CEBULA}::szt`] });
    expect(await onionRows()).toHaveLength(1);
  });

  it('migawka zbudowana według starszych reguł przelicza się przy pierwszym odczycie', async () => {
    const list = await prisma.shoppingList.findFirstOrThrow({
      where: { householdId },
      select: { id: true },
    });
    // Stan listy sprzed wdrożenia: wiersz w gramach, wersja 0, nie „stale”.
    await prisma.shoppingListItem.create({
      data: {
        shoppingListId: list.id,
        productKey: `${CEBULA}::g`,
        name: 'Cebula (g)',
        unit: 'g',
        department: 'Warzywa',
        totalAmount: 330,
        isChecked: false,
      },
    });
    await prisma.shoppingList.update({
      where: { id: list.id },
      data: { isStale: false, rulesVersion: 0 },
    });

    const rows = await onionRows();

    expect(rows.map((row) => row.productKey)).toEqual([`${CEBULA}::szt`]);
    const after = await prisma.shoppingList.findUniqueOrThrow({
      where: { id: list.id },
      select: { rulesVersion: true, isStale: true },
    });
    expect(after).toEqual({
      rulesVersion: SHOPPING_LIST_RULES_VERSION,
      isStale: false,
    });
  });
});
