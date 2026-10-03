import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';
import type { CookFeedbackData } from '../src/admin/contract';
import {
  AdminE2ESession,
  createAdminSession,
  useAdminDevGate,
} from './admin-e2e.helper';

/**
 * Gotuj na żywej bazie (3.10.2026, docs iOS Gotuj D21/D28 i §13.8):
 *
 * - `weeklyPlans:logCookedMeal` — „Zjedzone” po gotowaniu: odhacza danie
 *   z planu albo dopisuje ugotowane spoza planu OBOK tego, co stoi w porze,
 *   bez zmiany listy zakupów;
 * - `recipes:cookFeedback` — ocena gotowania, jedna na sesję;
 * - `GET /admin/cook/feedback` — to samo w panelu.
 *
 * Dom z DWOJGIEM domowników: reguła „porcji mniej niż domowników = tylko
 * gotujący” i alergen drugiej osoby nie dają się sprawdzić w domu solo.
 */
type WsEnvelope<T> =
  { ok: true; data: T } | { ok: false; error: string; code: string };

type PlanItem = {
  id: string;
  recipeId: string;
  dayOfWeek: string;
  mealType: string;
  plannedServings: number;
  cookedOffPlan: boolean;
  participantIds: string[];
  eatenByUserIds: string[];
};

type ShoppingItem = { productKey: string; totalAmount: number };

const WEEK_START = '2026-09-28';

describe('Gotuj: wpis spoza planu i oceny E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let restoreEnv: () => void;
  let admin: AdminE2ESession;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  let socket: Socket;
  let householdId: string;
  let aniaId: string;
  let marekId: string;
  /** Kolacje z katalogu bez alergenów — do wpisów bez bramki. */
  let dinners: string[];
  /** Kolacja z alergenem — bramka drugiego domownika. */
  let allergenDinner: { id: string; allergen: string };

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

  const devLogin = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@gotuj.local`,
      })
      .expect(201);
    const session = res.body as { accessToken: string; user: { id: string } };
    createdUserIds.push(session.user.id);
    return session;
  };

  const week = (data?: Record<string, unknown>) => ({
    householdId,
    weekStart: WEEK_START,
    ...(data ? { data } : {}),
  });

  const plan = async (data: Record<string, unknown>) =>
    okData(
      await ack<PlanItem>(socket, 'weeklyPlans:upsertWeekSlot', week(data)),
    );

  const logCooked = (data: Record<string, unknown>) =>
    ack<PlanItem>(socket, 'weeklyPlans:logCookedMeal', week(data));

  const shoppingList = async () =>
    okData(
      await ack<ShoppingItem[]>(socket, 'weeklyPlans:getShoppingList', week()),
    )
      .map((item) => `${item.productKey}=${item.totalAmount}`)
      .sort();

  const slot = (dayOfWeek: string, mealType: string) =>
    prisma.planItem.findMany({
      where: {
        weeklyPlan: { householdId },
        dayOfWeek: dayOfWeek as 'MON',
        mealType: mealType as 'DINNER',
      },
      select: {
        recipeId: true,
        cookedOffPlan: true,
        participants: { select: { userId: true } },
        consumptions: { select: { userId: true } },
      },
    });

  const feedback = (data: Record<string, unknown>, home = householdId) =>
    ack<{ sessionId: string; rating: string }>(socket, 'recipes:cookFeedback', {
      householdId: home,
      data,
    });

  beforeAll(async () => {
    process.env.WS_AUTH_MODE = 'strict';
    restoreEnv = useAdminDevGate();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    admin = await createAdminSession(prisma);

    const dinnerWhere = {
      isCatalog: true,
      isActive: true,
      ingredients: { some: {} },
      OR: [
        { suitableMealTypes: { has: 'DINNER' as const } },
        { mealType: 'DINNER' as const, suitableMealTypes: { isEmpty: true } },
      ],
    };
    dinners = (
      await prisma.recipe.findMany({
        where: { ...dinnerWhere, allergens: { isEmpty: true } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 8,
      })
    ).map((recipe) => recipe.id);
    if (dinners.length < 8) throw new Error('katalog dev: za mało kolacji');
    const withAllergen = await prisma.recipe.findFirst({
      where: { ...dinnerWhere, NOT: { allergens: { isEmpty: true } } },
      select: { id: true, allergens: true },
      orderBy: { id: 'asc' },
    });
    if (!withAllergen) throw new Error('katalog dev: brak kolacji z alergenem');
    allergenDinner = {
      id: withAllergen.id,
      allergen: withAllergen.allergens[0],
    };

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
        data: { name: `Dom Gotuj ${Date.now()}` },
      }),
    ).id;
    createdHouseholdIds.push(householdId);
    await prisma.membership.create({
      data: { userId: marekId, householdId, role: 'MEMBER' },
    });
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.WS_AUTH_MODE;
    else process.env.WS_AUTH_MODE = originalMode;
    restoreEnv();
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

  describe('weeklyPlans:logCookedMeal', () => {
    it('porcji mniej niż domowników — dopisane tylko dla gotującego, odhaczone, poza listą zakupów', async () => {
      const before = await shoppingList();
      const item = okData(
        await logCooked({
          dayOfWeek: 'MON',
          mealType: 'DINNER',
          recipeId: dinners[0],
          servings: 1,
        }),
      );

      expect(item.cookedOffPlan).toBe(true);
      expect(item.participantIds).toEqual([aniaId]);
      expect(item.eatenByUserIds).toEqual([aniaId]);
      expect(item.plannedServings).toBe(1);
      expect(await shoppingList()).toEqual(before);
    });

    it('ponowienie po utraconej odpowiedzi — ta sama pozycja, bez duplikatu', async () => {
      const again = okData(
        await logCooked({
          dayOfWeek: 'MON',
          mealType: 'DINNER',
          recipeId: dinners[0],
          servings: 1,
        }),
      );
      const rows = await slot('MON', 'DINNER');
      expect(rows).toHaveLength(1);
      expect(again.eatenByUserIds).toEqual([aniaId]);
    });

    it('w porze stoi inne danie — dopisujemy OBOK, nic nie znika, lista zakupów bez zmian (D28)', async () => {
      await plan({
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinners[1],
        participantIds: [],
      });
      const before = await shoppingList();
      expect(before.length).toBeGreaterThan(0);

      const item = okData(
        await logCooked({
          dayOfWeek: 'TUE',
          mealType: 'DINNER',
          recipeId: dinners[2],
          servings: 2,
        }),
      );

      // Porcji tyle, ilu domowników — danie dla całego domu („Wspólne”),
      // odhaczone tylko u gotującego; Marek odhaczy się sam.
      expect(item.participantIds).toEqual([]);
      expect(item.eatenByUserIds).toEqual([aniaId]);
      const rows = await slot('TUE', 'DINNER');
      expect(rows.map((r) => r.recipeId).sort()).toEqual(
        [dinners[1], dinners[2]].sort(),
      );
      const planned = rows.find((r) => r.recipeId === dinners[1])!;
      expect(planned.cookedOffPlan).toBe(false);
      expect(planned.consumptions).toEqual([]);
      expect(await shoppingList()).toEqual(before);
    });

    it('przepis jest już dziś w planie w innej porze — odhacza tam, bez nowej pozycji', async () => {
      await plan({
        dayOfWeek: 'WED',
        mealType: 'LUNCH',
        recipeId: dinners[3],
        participantIds: [],
      });
      const item = okData(
        await logCooked({
          dayOfWeek: 'WED',
          mealType: 'DINNER',
          recipeId: dinners[3].toUpperCase(), // jak iOS (`uuidString`)
          servings: 2,
        }),
      );
      expect(item.mealType).toBe('LUNCH');
      expect(item.cookedOffPlan).toBe(false);
      expect(item.eatenByUserIds).toEqual([aniaId]);
      expect(await slot('WED', 'DINNER')).toEqual([]);
    });

    it('alergen domownika przy „Wspólne” — wpis tylko dla gotującego zamiast odmowy', async () => {
      await prisma.userPreference.upsert({
        where: { userId: marekId },
        update: { allergens: [allergenDinner.allergen] },
        create: { userId: marekId, allergens: [allergenDinner.allergen] },
      });
      const item = okData(
        await logCooked({
          dayOfWeek: 'THU',
          mealType: 'DINNER',
          recipeId: allergenDinner.id,
          servings: 4,
        }),
      );
      expect(item.participantIds).toEqual([aniaId]);
      expect(item.eatenByUserIds).toEqual([aniaId]);
    });

    it('przepis dziś tylko dla domownika — gotujący dochodzi do audytorium, bez nowej pozycji', async () => {
      await plan({
        dayOfWeek: 'FRI',
        mealType: 'LUNCH',
        recipeId: dinners[4],
        participantIds: [marekId],
      });
      const item = okData(
        await logCooked({
          dayOfWeek: 'FRI',
          mealType: 'BREAKFAST',
          recipeId: dinners[4].toUpperCase(),
          servings: 1,
        }),
      );
      // Marek + Ania = cały dom → „Wspólne”; odhaczona tylko Ania.
      expect(item.mealType).toBe('LUNCH');
      expect(item.participantIds).toEqual([]);
      expect(item.eatenByUserIds).toEqual([aniaId]);
      expect(await slot('FRI', 'BREAKFAST')).toEqual([]);
    });

    it('gotujący ma w porze własne danie — ugotowane tylko dla niego, choć porcji na cały dom', async () => {
      await plan({
        dayOfWeek: 'SAT',
        mealType: 'DINNER',
        recipeId: dinners[5],
        participantIds: [aniaId],
      });
      const item = okData(
        await logCooked({
          dayOfWeek: 'SAT',
          mealType: 'DINNER',
          recipeId: dinners[6],
          servings: 2,
        }),
      );
      // „Wspólne” zasłoniłoby jej własne danie — w Kalendarzu by go nie było.
      expect(item.participantIds).toEqual([aniaId]);
      expect(item.eatenByUserIds).toEqual([aniaId]);
    });

    it('wyścig: przepis wpadł do porcji w międzyczasie — odhaczenie bez zmiany cudzej pozycji', async () => {
      const planned = await plan({
        dayOfWeek: 'SUN',
        mealType: 'DINNER',
        recipeId: dinners[7],
        participantIds: [marekId],
        plannedServings: 3,
      });
      const service = app.get(WeeklyPlansService);
      const result = await service.upsertWeekSlot(
        aniaId,
        householdId,
        WEEK_START,
        {
          dayOfWeek: 'SUN',
          mealType: 'DINNER',
          recipeId: dinners[7],
          participantIds: [],
        },
        {
          markEaten: async (tx, planItemId) => {
            await tx.planItemConsumption.create({
              data: { planItemId, userId: aniaId },
            });
          },
        },
      );
      expect(result.changeKind).toBe('NOOP');
      expect(result.id).toBe(planned.id);
      expect(result.participantIds).toEqual([marekId]);
      expect(result.plannedServings).toBe(3);
      expect(result.eatenByUserIds).toEqual([aniaId]);
    });

    it('wpis po gotowaniu nie odsłania listy schowanej po wyczyszczeniu historii', async () => {
      const weekStart = new Date(`${WEEK_START}T00:00:00.000Z`);
      await prisma.shoppingListArchiveState.upsert({
        where: { householdId_weekStart: { householdId, weekStart } },
        update: { currentArchiveId: null },
        create: { householdId, weekStart, currentArchiveId: null },
      });
      okData(
        await logCooked({
          dayOfWeek: 'SUN',
          mealType: 'LUNCH',
          recipeId: dinners[0],
          servings: 1,
        }),
      );
      expect(
        await prisma.shoppingListArchiveState.count({
          where: { householdId, weekStart, currentArchiveId: null },
        }),
      ).toBe(1);
    });

    it('zła porcja — VALIDATION_ERROR, nic nie zapisane', async () => {
      const result = await logCooked({
        dayOfWeek: 'FRI',
        mealType: 'DINNER',
        recipeId: dinners[0],
        servings: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR');
      expect(await slot('FRI', 'DINNER')).toEqual([]);
    });
  });

  describe('recipes:cookFeedback', () => {
    const sessionId = randomUUID();

    it('kciuk, potem uwagi z arkusza — jeden wiersz, ostatni stan wygrywa', async () => {
      okData(
        await feedback({
          sessionId,
          recipeId: dinners[0],
          scenarioVersion: 1,
          rating: 'DOWN',
          tags: [],
          extensions: { 't-kotlety': 120 },
          servings: 2,
        }),
      );
      const saved = okData(
        await feedback({
          sessionId,
          recipeId: dinners[0],
          scenarioVersion: 1,
          rating: 'DOWN',
          tags: ['Za długo', 'Za długo', ' Kotlety +4 min '],
          comment: '  Kotlety potrzebowały więcej czasu ',
          extensions: { 't-kotlety': 240, 't-ziemniaki': 0 },
          servings: 2,
        }),
      );
      expect(saved).toMatchObject({ sessionId, rating: 'DOWN' });

      const rows = await prisma.cookFeedback.findMany({
        where: { userId: aniaId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tags: ['Za długo', 'Kotlety +4 min'],
        comment: 'Kotlety potrzebowały więcej czasu',
        extensions: { 't-kotlety': 240 },
        servings: 2,
      });
    });

    it('zły kształt „+min” — VALIDATION_ERROR', async () => {
      const result = await feedback({
        sessionId: randomUUID(),
        recipeId: dinners[0],
        scenarioVersion: 1,
        rating: 'UP',
        tags: [],
        extensions: { 't-kotlety': 'dużo' },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('VALIDATION_ERROR');
    });

    it('cudzy dom — NOT_HOUSEHOLD_MEMBER, nic nie zapisane', async () => {
      const other = randomUUID();
      const result = await feedback(
        {
          sessionId: other,
          recipeId: dinners[0],
          scenarioVersion: 1,
          rating: 'UP',
          tags: [],
          extensions: {},
        },
        randomUUID(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_HOUSEHOLD_MEMBER');
      expect(
        await prisma.cookFeedback.count({ where: { sessionId: other } }),
      ).toBe(0);
    });

    it('panel: ocena w sumach, przepisach, timerach i na liście', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/cook/feedback?period=7')
        .set('Cookie', admin.cookie)
        .expect(200);
      const data = res.body as CookFeedbackData;
      const mine = data.items.find((item) => item.userId === aniaId);
      expect(mine).toMatchObject({
        recipeId: dinners[0],
        rating: 'DOWN',
        comment: 'Kotlety potrzebowały więcej czasu',
        extensions: [
          {
            timerId: 't-kotlety',
            timerLabel: null,
            stepTitle: null,
            seconds: 240,
          },
        ],
      });
      expect(
        data.byRecipe.find((r) => r.recipeId === dinners[0]),
      ).toMatchObject({ withExtensions: expect.any(Number) as number });
      expect(
        data.timers.find(
          (t) => t.recipeId === dinners[0] && t.timerId === 't-kotlety',
        ),
      ).toBeDefined();
      expect(data.daily).toHaveLength(7);
    });

    it('panel: nieznany okres — 400', async () => {
      await request(app.getHttpServer())
        .get('/admin/cook/feedback?period=365')
        .set('Cookie', admin.cookie)
        .expect(400);
    });
  });
});
