import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Serwerowy bilans dnia na żywej bazie.
 *
 * Testy jednostkowe pilnują wzorów; tutaj sprawdzamy, że cała droga —
 * plan → audytorium → odhaczone → sumy — składa się poprawnie na prawdziwych
 * przepisach i w gospodarstwie z DWOJGIEM domowników. Reguła „własne danie
 * wygrywa ze wspólnym" nie da się sensownie sprawdzić w domu jednoosobowym,
 * a to ona decyduje, czy ktoś nie dostanie dwóch obiadów do jednego celu.
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };

type DayBalance = {
  dayOfWeek: string;
  planned: { kcal: number; protein: number };
  eaten: { kcal: number };
  meals: number;
};

type Balance = {
  weekStart: string;
  userId: string;
  householdMemberCount: number;
  days: DayBalance[];
};

const WEEK_START = '2026-09-21';

describe('Bilans tygodnia E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  let socket: Socket;
  let householdId: string;
  let aniaId: string;
  let marekId: string;
  let dinnerA: string;
  let dinnerB: string;
  let kcalPerServingA: number;

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

  const devLogin = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@balance.local`,
      })
      .expect(201);
    const session = res.body as { accessToken: string; user: { id: string } };
    createdUserIds.push(session.user.id);
    return session;
  };

  const balanceFor = async (memberUserId?: string): Promise<Balance> =>
    okData(
      await ack<Balance>(socket, 'weeklyPlans:balance', {
        householdId,
        weekStart: WEEK_START,
        ...(memberUserId ? { memberUserId } : {}),
      }),
    );

  const monday = (balance: Balance) =>
    balance.days.find((day) => day.dayOfWeek === 'MON')!;

  const plan = (data: Record<string, unknown>) =>
    ack(socket, 'weeklyPlans:upsertWeekSlot', {
      householdId,
      weekStart: WEEK_START,
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

    const recipes = await prisma.recipe.findMany({
      where: {
        isCatalog: true,
        isActive: true,
        nutritionKcal: { gt: 0 },
        OR: [
          { suitableMealTypes: { has: 'DINNER' } },
          { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
        ],
      },
      select: { id: true, servings: true, nutritionKcal: true },
      take: 2,
    });
    if (recipes.length < 2) throw new Error('katalog dev nie ma dwóch kolacji');
    dinnerA = recipes[0].id;
    dinnerB = recipes[1].id;
    kcalPerServingA =
      recipes[0].nutritionKcal / Math.max(1, recipes[0].servings);

    const ania = await devLogin('Ania');
    const marek = await devLogin('Marek');
    aniaId = ania.user.id;
    marekId = marek.user.id;

    socket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: ania.accessToken },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });

    householdId = okData(
      await ack<{ id: string }>(socket, 'households:create', {
        data: { name: `Dom bilansu ${Date.now()}` },
      }),
    ).id;
    createdHouseholdIds.push(householdId);

    // Drugi domownik wprost w bazie — zaproszenia są przedmiotem innej suity,
    // a bez dwóch osób nie da się sprawdzić reguły „własne bije wspólne".
    await prisma.membership.create({
      data: { userId: marekId, householdId, role: 'MEMBER' },
    });
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

  it('pusty tydzień to siedem dni zer, nie brak odpowiedzi', async () => {
    const balance = await balanceFor();
    expect(balance.days).toHaveLength(7);
    expect(balance.householdMemberCount).toBe(2);
    expect(monday(balance).planned.kcal).toBe(0);
  });

  it('wspólna kolacja liczy się każdemu jako jedna porcja', async () => {
    okData(
      await plan({
        dayOfWeek: 'MON',
        mealType: 'DINNER',
        recipeId: dinnerA,
        participantIds: [],
      }),
    );

    const dlaAni = monday(await balanceFor(aniaId));
    const dlaMarka = monday(await balanceFor(marekId));

    // Reguła auto: 2 porcje na 2 osoby = 1 porcja na osobę. Dodanie domownika
    // NIE zmienia makr — rośnie i licznik, i mianownik.
    expect(dlaAni.planned.kcal).toBe(Math.round(kcalPerServingA));
    expect(dlaMarka.planned.kcal).toBe(Math.round(kcalPerServingA));
  });

  it('własne danie wygrywa ze wspólnym — nikt nie dostaje dwóch kolacji', async () => {
    okData(
      await plan({
        dayOfWeek: 'MON',
        mealType: 'DINNER',
        recipeId: dinnerB,
        participantIds: [aniaId],
      }),
    );

    const dlaAni = monday(await balanceFor(aniaId));
    const dlaMarka = monday(await balanceFor(marekId));

    // Ania je tylko swoje, Marek tylko wspólne — po jednej pozycji na osobę,
    // mimo że w slocie stoją dwa dania.
    expect(dlaAni.meals).toBe(1);
    expect(dlaMarka.meals).toBe(1);
    expect(dlaMarka.planned.kcal).toBe(Math.round(kcalPerServingA));
    expect(dlaAni.planned.kcal).not.toBe(dlaMarka.planned.kcal);
  });

  it('zjedzone liczy się osobno od zaplanowanego', async () => {
    const przed = monday(await balanceFor(aniaId));
    expect(przed.eaten.kcal).toBe(0);

    okData(
      await ack(socket, 'weeklyPlans:setMealEaten', {
        householdId,
        weekStart: WEEK_START,
        data: {
          dayOfWeek: 'MON',
          mealType: 'DINNER',
          recipeId: dinnerB,
          isEaten: true,
        },
      }),
    );

    const po = monday(await balanceFor(aniaId));
    // Zaplanowane bez zmian — plan nie jest dowodem, że ktoś zjadł.
    expect(po.planned.kcal).toBe(przed.planned.kcal);
    expect(po.eaten.kcal).toBe(przed.planned.kcal);
    // Odhaczenie Ani nie liczy się Markowi.
    expect(monday(await balanceFor(marekId)).eaten.kcal).toBe(0);
  });

  it('ręczna zmiana porcji przesuwa udział na osobę', async () => {
    const przed = monday(await balanceFor(marekId));

    okData(
      await plan({
        dayOfWeek: 'MON',
        mealType: 'DINNER',
        recipeId: dinnerA,
        participantIds: [],
        plannedServings: 4,
      }),
    );

    // 4 porcje na 2 osoby = 2 porcje na osobę, czyli dwa razy tyle.
    const po = monday(await balanceFor(marekId));
    expect(po.planned.kcal).toBe(przed.planned.kcal * 2);
  });

  it('bez `memberUserId` liczy bilans wołającego', async () => {
    const wlasny = await balanceFor();
    expect(wlasny.userId).toBe(aniaId);
  });

  it('obcy domownik → PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD', async () => {
    const response = await ack(socket, 'weeklyPlans:balance', {
      householdId,
      weekStart: WEEK_START,
      memberUserId: '99999999-9999-4999-8999-999999999999',
    });
    expect(response).toMatchObject({
      ok: false,
      code: 'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
    });
  });
});
