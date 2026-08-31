import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Throttler HTTP (Faza 0, krok 3) na żywym serwerze.
 *
 * Osobna suita, bo limity trzeba zejść do wartości, przy których 429 da się
 * wywołać kilkoma żądaniami — a `THROTTLE_AUTH_LIMIT=3` w suicie `ws-auth`
 * (13 dev-loginów w kilka sekund) wywróciłby ją natychmiast. Limity są
 * czytane z env PER ŻĄDANIE, więc wystarczy podmienić zmienną przed
 * bootowaniem aplikacji i przywrócić po sobie.
 */
describe('Throttling E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];

  const AUTH_LIMIT = 3;
  const original = {
    auth: process.env.THROTTLE_AUTH_LIMIT,
    def: process.env.THROTTLE_DEFAULT_LIMIT,
    ip: process.env.THROTTLE_IP_LIMIT,
  };

  const opsHeaders = (): Record<string, string> =>
    process.env.OPS_TOKEN ? { 'x-ops-token': process.env.OPS_TOKEN } : {};

  const devLogin = (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@throttling.local`,
      });
  };

  beforeAll(async () => {
    process.env.THROTTLE_AUTH_LIMIT = String(AUTH_LIMIT);
    // Siatka po IP nie może przeszkodzić w teście limitu `/auth/*`.
    process.env.THROTTLE_DEFAULT_LIMIT = '1000';
    process.env.THROTTLE_IP_LIMIT = '1000';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdHouseholdIds.length) {
      await prisma.household.deleteMany({
        where: { id: { in: createdHouseholdIds } },
      });
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    for (const [key, value] of [
      ['THROTTLE_AUTH_LIMIT', original.auth],
      ['THROTTLE_DEFAULT_LIMIT', original.def],
      ['THROTTLE_IP_LIMIT', original.ip],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
  });

  it('po przekroczeniu limitu `/auth/*` wraca 429 w kontrakcie aplikacji', async () => {
    for (let i = 0; i < AUTH_LIMIT; i += 1) {
      const res = await devLogin('Limit');
      expect(res.status).toBe(201);
      const session = res.body as {
        user: { id: string };
        household: { id: string } | null;
      };
      createdUserIds.push(session.user.id);
      if (session.household) createdHouseholdIds.push(session.household.id);
    }

    const blocked = await devLogin('Limit');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      requestId: expect.any(String),
    });
    // iOS ponawia po tej liczbie — bez niej zostaje mu zgadywanie.
    expect(blocked.body.details?.[0]).toMatch(/^retryAfterSeconds:\d+$/);
    // Kontrakt błędu jest jeden dla całej aplikacji: `message` do pokazania,
    // `code` do decyzji. `ThrottlerException` dałaby tu `HTTP_ERROR`.
    expect(typeof blocked.body.message).toBe('string');
    expect(blocked.headers['x-request-id']).toBeDefined();
  });

  it('`/ops/health` nie jest limitowane — 429 wywróciłby healthcheck Railway', async () => {
    for (let i = 0; i < AUTH_LIMIT + 5; i += 1) {
      await request(app.getHttpServer()).get('/ops/health').expect(200);
    }
  });

  it('429 z guardu widać w metrykach (interceptor logujący ich nie widzi)', async () => {
    const res = await request(app.getHttpServer())
      .get('/ops/metrics')
      .set(opsHeaders())
      .expect(200);

    const throttled = (res.body as { http: { throttled: { total: number } } })
      .http.throttled;
    expect(throttled.total).toBeGreaterThan(0);
  });
});
