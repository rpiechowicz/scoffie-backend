import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Walidacja wejścia WS (Faza 0, krok 2) na żywym serwerze: złe wejście od
 * klienta kończy się ackiem `VALIDATION_ERROR` z listą dozwolonych wartości,
 * serwis nie dotyka bazy (brak broadcastu, brak zmiany stanu), a licznik
 * `INTERNAL_ERROR` w metrykach nie rośnie. Do tego parytet kształtu błędu
 * HTTP ↔ WS i kontrakt `getByWeek` po przepisaniu na `PLAN_ITEM_INCLUDE`.
 *
 * Helpery są kopią z `ws-auth.e2e-spec.ts` (każda suita bootuje własny
 * `AppModule`; wspólny plik helperów byłby dla jest-e2e osobną „suitą bez
 * testów" bez zmiany `testRegex`).
 */
type WsEnvelope<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      message?: string;
      code: string;
      status?: number;
      details?: string[];
      requestId?: string;
    };

type Session = {
  accessToken: string;
  refreshToken: string;
  user: { id: string; displayName: string };
  household: { id: string; name: string } | null;
};

type PlanItem = {
  recipe: {
    allergens: unknown;
    dietTags: unknown;
    suitableMealTypes: unknown;
  };
};

type WeekPlan = {
  id: string;
  weekStart: string;
  items: PlanItem[];
};

describe('WS validation E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let session: Session;
  let householdId: string;
  let socket: Socket;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const createdRecipeIds: string[] = [];
  const sockets: Socket[] = [];
  const originalMode = process.env.WS_AUTH_MODE;

  const opsHeaders = (): Record<string, string> =>
    process.env.OPS_TOKEN ? { 'x-ops-token': process.env.OPS_TOKEN } : {};

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@ws-validation.local`,
      })
      .expect(201);
    const created = res.body as Session;
    createdUserIds.push(created.user.id);
    if (created.household) createdHouseholdIds.push(created.household.id);
    return created;
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

  const expectNoEvent = (
    client: Socket,
    event: string,
    windowMs = 500,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const onEvent = (payload: unknown) => {
        clearTimeout(timer);
        reject(new Error(`Unexpected ${event}: ${JSON.stringify(payload)}`));
      };
      const timer = setTimeout(() => {
        client.off(event, onEvent);
        resolve();
      }, windowMs);
      client.once(event, onEvent);
    });

  // Klucz tygodnia w UTC — backend odrzuca wszystko, co nie jest poniedziałkiem.
  const nextMonday = (offsetWeeks = 0): string => {
    const now = new Date();
    const daysUntilMonday = (8 - now.getUTCDay()) % 7 || 7;
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + daysUntilMonday + offsetWeeks * 7,
      ),
    )
      .toISOString()
      .slice(0, 10);
  };

  const metrics = async (): Promise<{
    http: { wsErrors: { total: number; byCode: Record<string, number> } };
  }> =>
    (
      await request(app.getHttpServer())
        .get('/ops/metrics')
        .set(opsHeaders())
        .expect(200)
    ).body;

  type WsErrorEnvelope = Extract<WsEnvelope<unknown>, { ok: false }>;

  /** Zwraca zawężoną kopertę błędu (funkcja asercji wymagałaby jawnego typu zmiennej). */
  const expectValidationError = (
    envelope: WsEnvelope<unknown>,
  ): WsErrorEnvelope => {
    expect(envelope).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
      status: 400,
      details: expect.any(Array),
      requestId: expect.any(String),
    });
    if (envelope.ok) throw new Error('expected ok:false');
    expect(envelope.details).not.toHaveLength(0);
    expect(envelope.message).toBe(envelope.error);
    return envelope;
  };

  beforeAll(async () => {
    process.env.WS_AUTH_MODE = 'strict';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);

    session = await devLogin('Validator');
    socket = connect(session.accessToken);
    await waitConnect(socket);
    // Dev-login nie zakłada gospodarstwa — powstaje przez WS, jak w ws-auth.
    const created = await ack<{ id: string }>(socket, 'households:create', {
      data: { name: `Dom walidacji ${Date.now()}` },
    });
    if (!created.ok) throw new Error(`households:create: ${created.code}`);
    householdId = created.data.id;
    createdHouseholdIds.push(householdId);
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

  describe('zły enum / typ w data → VALIDATION_ERROR z listą dozwolonych, stan bez zmian', () => {
    it("users:preferences:update dietPreference 'vegan' → details z NONE i VEGAN, preferences:get bez zmiany", async () => {
      const before = await ack(socket, 'users:preferences:get', {});
      expect(before.ok).toBe(true);

      const res = await ack(socket, 'users:preferences:update', {
        data: { dietPreference: 'vegan' },
      });
      const err = expectValidationError(res);
      expect(err.details).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/dietPreference.*NONE.*VEGAN/),
        ]),
      );

      const after = await ack(socket, 'users:preferences:get', {});
      expect(after).toEqual(before);
    });

    it("weeklyPlans:upsertWeekSlot dayOfWeek 'MONDAY' → VALIDATION_ERROR z 'MON', brak weekChanged", async () => {
      const silent = expectNoEvent(socket, 'weeklyPlans:weekChanged');
      const res = await ack(socket, 'weeklyPlans:upsertWeekSlot', {
        householdId,
        weekStart: nextMonday(),
        data: {
          dayOfWeek: 'MONDAY',
          mealType: 'DINNER',
          recipeId: '22222222-2222-4222-8222-222222222222',
        },
      });
      const err = expectValidationError(res);
      expect(err.details).toEqual(
        expect.arrayContaining([expect.stringMatching(/dayOfWeek.*\bMON\b/)]),
      );
      await silent;
    });

    it('weeklyPlans:upsertWeekSlot bez data → VALIDATION_ERROR (koperta), brak weekChanged', async () => {
      const silent = expectNoEvent(socket, 'weeklyPlans:weekChanged');
      const res = await ack(socket, 'weeklyPlans:upsertWeekSlot', {
        householdId,
        weekStart: nextMonday(),
      });
      const err = expectValidationError(res);
      expect(err.details).toEqual(
        expect.arrayContaining([
          expect.stringContaining('data must be an object'),
        ]),
      );
      await silent;
    });

    it("households:updateMemberRole role 'ADMIN' → VALIDATION_ERROR z 'OWNER'", async () => {
      const res = await ack(socket, 'households:updateMemberRole', {
        householdId,
        memberUserId: session.user.id,
        data: { role: 'ADMIN' },
      });
      const err = expectValidationError(res);
      expect(err.details).toEqual(
        expect.arrayContaining([expect.stringMatching(/role.*OWNER/)]),
      );
    });

    it("recipes:findAll filters.mealType 'BRUNCH' → VALIDATION_ERROR z listą MealType", async () => {
      const res = await ack(socket, 'recipes:findAll', {
        householdId,
        filters: { mealType: 'BRUNCH' },
      });
      const err = expectValidationError(res);
      expect(err.details).toEqual(
        expect.arrayContaining([expect.stringMatching(/mealType.*DINNER/)]),
      );
    });
  });

  describe('nie-UUID → VALIDATION_ERROR, nie INTERNAL_ERROR (P2023 nie dochodzi do Prismy)', () => {
    it("recipes:findById id 'not-a-uuid' → VALIDATION_ERROR, licznik INTERNAL_ERROR bez przyrostu", async () => {
      const before = (await metrics()).http.wsErrors.byCode.INTERNAL_ERROR ?? 0;

      const res = await ack(socket, 'recipes:findById', { id: 'not-a-uuid' });
      const err = expectValidationError(res);
      expect(err.details).toEqual(
        expect.arrayContaining([expect.stringContaining('id must be a UUID')]),
      );

      const afterMetrics = (await metrics()).http.wsErrors;
      expect(afterMetrics.byCode.INTERNAL_ERROR ?? 0).toBe(before);
      expect(afterMetrics.byCode.VALIDATION_ERROR).toBeGreaterThanOrEqual(1);
    });
  });

  describe('weeklyPlans:getByWeek — kontrakt po PLAN_ITEM_INCLUDE', () => {
    it('nowy tydzień → ok:true, items [], weekStart YYYY-MM-DD, id string', async () => {
      const res = await ack<WeekPlan>(socket, 'weeklyPlans:getByWeek', {
        householdId,
        weekStart: nextMonday(2),
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.items).toEqual([]);
      expect(typeof res.data.weekStart).toBe('string');
      expect(res.data.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(res.data.weekStart).toBe(nextMonday(2));
      expect(typeof res.data.id).toBe('string');
    });

    it('po upsertWeekSlot items[0].recipe ma tablice allergens, dietTags, suitableMealTypes', async () => {
      const recipe = await prisma.recipe.create({
        data: {
          title: 'WS validation E2E recipe',
          description: 'kontrakt getByWeek',
          mealType: 'DINNER',
          difficulty: 'EASY',
          prepTimeMinutes: 5,
          servings: 2,
          authorId: session.user.id,
          householdId,
          nutritionKcal: 100,
        },
        select: { id: true },
      });
      createdRecipeIds.push(recipe.id);

      const weekStart = nextMonday(1);
      const upsert = await ack(socket, 'weeklyPlans:upsertWeekSlot', {
        householdId,
        weekStart,
        data: { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: recipe.id },
      });
      expect(upsert.ok).toBe(true);

      const res = await ack<WeekPlan>(socket, 'weeklyPlans:getByWeek', {
        householdId,
        weekStart,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data.items).toHaveLength(1);
      const { recipe: planned } = res.data.items[0];
      expect(Array.isArray(planned.allergens)).toBe(true);
      expect(Array.isArray(planned.dietTags)).toBe(true);
      expect(Array.isArray(planned.suitableMealTypes)).toBe(true);
    });
  });

  describe('parytet kontraktu błędu HTTP ↔ WS', () => {
    it('POST /auth/dev {} i ack WS mają te same klucze {code, message, details, requestId} (WS + ok, error, status)', async () => {
      const http = await request(app.getHttpServer())
        .post('/auth/dev')
        .send({})
        .expect(400);
      const ws = await ack(socket, 'households:findById', { id: 'hh-1' });

      expect(http.body.code).toBe('VALIDATION_ERROR');
      expect(ws.ok).toBe(false);
      if (ws.ok) return;
      expect(ws.code).toBe('VALIDATION_ERROR');

      const httpKeys = Object.keys(http.body).sort();
      expect(httpKeys).toEqual(['code', 'details', 'message', 'requestId']);

      const wsKeys = Object.keys(ws).sort();
      expect(wsKeys).toEqual([
        'code',
        'details',
        'error',
        'message',
        'ok',
        'requestId',
        'status',
      ]);
      const wsOnly = ['ok', 'error', 'status'];
      expect(wsKeys.filter((key) => !wsOnly.includes(key))).toEqual(httpKeys);

      // Ten sam format `details` (class-validator), niezależnie od transportu.
      expect(http.body.details).toEqual(
        expect.arrayContaining([expect.stringContaining('displayName')]),
      );
      expect(ws.details).toEqual(
        expect.arrayContaining([expect.stringContaining('id must be a UUID')]),
      );
    });
  });
});
