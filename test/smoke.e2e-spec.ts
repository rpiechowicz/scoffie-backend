import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

type WsEnvelope<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      message?: string;
      code: string;
      status?: number;
      requestId?: string;
    };

type DevLoginResponse = {
  accessToken: string;
  user: { id: string; displayName: string };
  household: { id: string; name: string } | null;
};

describe('Smoke E2E', () => {
  let app: NestExpressApplication;
  // Sprzątanie po testach — jedno gospodarstwo + przepis; kaskady zabiorą
  // członkostwa, plan, listę. Użytkownicy z dev-loginu też (refresh tokeny
  // idą kaskadą po User).
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const createdRecipeIds: string[] = [];
  let prisma: PrismaService;
  let socket: Socket;
  let baseUrl: string;

  // Klucz tygodnia liczony w UTC — wersja na czasie lokalnym dawała na Macu
  // w CEST niedzielę (północ lokalna to 22:00 UTC dnia poprzedniego), a od
  // teraz backend odrzuca wszystko, co nie jest poniedziałkiem.
  const makeNextMonday = (): string => {
    const now = new Date();
    const day = now.getUTCDay(); // 0=Sun ... 6=Sat
    const daysUntilMonday = (8 - day) % 7 || 7;
    const nextMonday = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + daysUntilMonday,
      ),
    );
    return nextMonday.toISOString().slice(0, 10);
  };

  const waitForSocketConnect = async (client: Socket): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        client.off('connect_error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        client.off('connect', onConnect);
        reject(err);
      };
      client.once('connect', onConnect);
      client.once('connect_error', onError);
    });
  };

  const emitWithAck = async <T>(
    event: string,
    payload: unknown,
  ): Promise<WsEnvelope<T>> => {
    return await new Promise<WsEnvelope<T>>((resolve, reject) => {
      socket
        .timeout(7000)
        .emit(event, payload, (err: Error | null, ack: WsEnvelope<T>) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(ack);
        });
    });
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    // Te same rury co na produkcji (`main.ts`): bez tego e2e nie sprawdzał
    // walidacji DTO ani nagłówków, którymi żyje klient.
    configureApp(app);
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    socket?.disconnect();
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

  const opsHeaders = (): Record<string, string> =>
    process.env.OPS_TOKEN ? { 'x-ops-token': process.env.OPS_TOKEN } : {};

  it('GET /ops/health and /ops/metrics should return observability payload', async () => {
    const health = await request(app.getHttpServer())
      .get('/ops/health')
      .expect(200);
    expect(health.body.status).toBe('ok');
    expect(typeof health.body.timestamp).toBe('string');
    // Trasa jest publiczna i bez limitu żądań, więc `commit` ma być skrócony
    // do siedmiu znaków — pełny SHA wskazywałby obcemu dokładny punkt
    // w historii prywatnego repozytorium (audyt 12.09.2026, P1.15).
    expect((health.body.commit as string).length).toBeLessThanOrEqual(7);

    if (process.env.OPS_TOKEN) {
      // Bez nagłówka metryki są zamknięte — to mapa serwera, nie sonda.
      await request(app.getHttpServer()).get('/ops/metrics').expect(403);
    }

    const metrics = await request(app.getHttpServer())
      .get('/ops/metrics')
      .set(opsHeaders())
      .expect(200);
    expect(metrics.body).toEqual(
      expect.objectContaining({
        http: expect.any(Object),
        ws: expect.any(Object),
        caches: expect.objectContaining({
          recipesList: expect.any(Object),
        }),
      }),
    );
  });

  it('POST /auth/dev rejects unknown fields (global ValidationPipe is wired)', async () => {
    await request(app.getHttpServer())
      .post('/auth/dev')
      .send({ displayName: 'Whitelist Probe', unexpectedField: 1 })
      .expect(400);
  });

  it('POST /auth/refresh should rotate refresh tokens and reject reused tokens', async () => {
    const devLogin = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `Refresh User ${Date.now()}`,
        email: `${Date.now()}@refresh.local`,
      })
      .expect(201);

    expect(typeof devLogin.body.accessToken).toBe('string');
    expect(typeof devLogin.body.refreshToken).toBe('string');
    createdUserIds.push(devLogin.body.user.id as string);

    const originalRefreshToken = devLogin.body.refreshToken as string;

    const refreshResponse = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(201);

    expect(typeof refreshResponse.body.accessToken).toBe('string');
    expect(typeof refreshResponse.body.refreshToken).toBe('string');
    expect(refreshResponse.body.refreshToken).not.toBe(originalRefreshToken);

    // Klient POTWIERDZA odbiór pary, używając jej. Dopiero po tym powtórzenie
    // starego tokenu jest na pewno kopią, a nie zgubioną odpowiedzią z rotacji
    // (tę serwer ratuje w oknie `REFRESH_REUSE_GRACE_SECONDS` — patrz
    // `ws-auth.e2e-spec.ts`).
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refreshResponse.body.refreshToken as string })
      .expect(201);

    const reused = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(401);
    // Jeden kształt błędu HTTP: {code, message, requestId}, bez statusCode.
    expect(reused.body).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired refresh token',
      requestId: expect.any(String),
    });
    expect(reused.headers['x-request-id']).toBe(reused.body.requestId);
  });

  it('POST /auth/dev with an empty body returns VALIDATION_ERROR with details', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({})
      .expect(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.arrayContaining([expect.stringContaining('displayName')]),
      requestId: expect.any(String),
    });
  });

  it('weeklyPlans:upsertWeekSlot should emit weekChanged with changeVersion', async () => {
    const displayName = `E2E User ${Date.now()}`;
    const devLogin = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName,
        email: `${Date.now()}@e2e.local`,
        householdName: `E2E Home ${Date.now()}`,
      })
      .expect(201);

    const loginBody = devLogin.body as DevLoginResponse;
    expect(loginBody.user?.id).toBeTruthy();

    const userId = loginBody.user.id;
    createdUserIds.push(userId);
    const householdId =
      loginBody.household?.id ??
      (
        await prisma.household.create({
          data: {
            name: `E2E Created Home ${Date.now()}`,
            createdById: userId,
            memberships: {
              create: {
                userId,
                role: 'OWNER',
              },
            },
          },
          select: { id: true },
        })
      ).id;
    createdHouseholdIds.push(householdId);

    const recipe = await prisma.recipe.create({
      data: {
        title: 'E2E Recipe',
        description: 'E2E smoke recipe',
        mealType: 'BREAKFAST',
        difficulty: 'EASY',
        prepTimeMinutes: 10,
        servings: 1,
        authorId: userId,
        householdId,
        nutritionKcal: 100,
      },
      select: { id: true },
    });
    createdRecipeIds.push(recipe.id);

    // Tożsamość z tokenu w handshake'u — payloady niżej nie niosą userId.
    socket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: loginBody.accessToken },
    });
    await waitForSocketConnect(socket);

    const weekStart = makeNextMonday();
    const weekChangedPromise = new Promise<{
      householdId: string;
      weekStart: string;
      changeVersion?: number;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for weeklyPlans:weekChanged'));
      }, 7000);
      socket.once('weeklyPlans:weekChanged', (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      });
    });

    const ack = await emitWithAck<{ id: string }>(
      'weeklyPlans:upsertWeekSlot',
      {
        householdId,
        weekStart,
        data: {
          dayOfWeek: 'MON',
          mealType: 'BREAKFAST',
          recipeId: recipe.id,
        },
      },
    );

    expect(ack.ok).toBe(true);

    const changed = await weekChangedPromise;
    expect(changed.householdId).toBe(householdId);
    expect(changed.weekStart).toBe(weekStart);
    expect(typeof changed.changeVersion).toBe('number');

    // Ack błędu po sockecie ma ten sam kontrakt: kod, message == error,
    // status, requestId — tu: obce gospodarstwo.
    const foreign = await emitWithAck<unknown>('weeklyPlans:getByWeek', {
      householdId: '00000000-0000-4000-8000-000000000000',
      weekStart,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign).toMatchObject({
        code: 'NOT_HOUSEHOLD_MEMBER',
        status: 403,
        requestId: expect.any(String),
      });
      expect(foreign.message).toBe(foreign.error);
    }

    const metrics = await request(app.getHttpServer())
      .get('/ops/metrics')
      .set(opsHeaders())
      .expect(200);
    expect(metrics.body.ws?.totals?.totalConnections).toBeGreaterThanOrEqual(1);
    expect(
      metrics.body.http?.wsErrors?.byCode?.NOT_HOUSEHOLD_MEMBER,
    ).toBeGreaterThanOrEqual(1);
    // 401 z reużytego refresh tokenu wyżej ma się policzyć jako 4xx, nie 200.
    expect(metrics.body.http?.statuses?.['4xx']).toBeGreaterThanOrEqual(1);
  });
});
