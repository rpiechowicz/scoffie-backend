import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';

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
  /** `/auth/refresh`: prób na JEDEN refresh token i bezpiecznik na IP. */
  const REFRESH_TOKEN_LIMIT = 2;
  const REFRESH_IP_LIMIT = 14;
  const original = {
    auth: process.env.THROTTLE_AUTH_LIMIT,
    def: process.env.THROTTLE_DEFAULT_LIMIT,
    ip: process.env.THROTTLE_IP_LIMIT,
    refresh: process.env.THROTTLE_AUTH_REFRESH_LIMIT,
    refreshIp: process.env.THROTTLE_AUTH_REFRESH_IP_LIMIT,
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
    process.env.THROTTLE_AUTH_REFRESH_LIMIT = String(REFRESH_TOKEN_LIMIT);
    process.env.THROTTLE_AUTH_REFRESH_IP_LIMIT = String(REFRESH_IP_LIMIT);

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
      ['THROTTLE_AUTH_REFRESH_LIMIT', original.refresh],
      ['THROTTLE_AUTH_REFRESH_IP_LIMIT', original.refreshIp],
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

  /**
   * `/auth/refresh` za NAT-em (workstream, Etap 1). Do 26.09.2026 odświeżanie
   * dzieliło z logowaniem limit 20/min na IP — sieć komórkowa z CGNAT, biuro
   * albo akademik to setki telefonów pod jednym adresem, więc po dwudziestym
   * odświeżeniu w minucie reszta dostawała 429, a telefon, któremu nie wyjdzie
   * odświeżenie, wylogowuje użytkownika. Limit idzie teraz za SESJĄ (hasz
   * przedstawionego refresh tokenu), a IP ma luźny bezpiecznik.
   */
  describe('/auth/refresh', () => {
    const sessions: { refreshToken: string }[] = [];
    const refresh = (refreshToken: string) =>
      request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken });
    /** Token, którego nie ma w bazie — 401, ale bez skutków dla rodzin. */
    const junk = () =>
      Array.from({ length: 64 }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join('');

    beforeAll(async () => {
      // Sesje z serwisu, nie z `/auth/dev` — logowanie ma tu limit 3/min.
      const auth = app.get(AuthService);
      for (let i = 0; i < 8; i += 1) {
        const stamp = `${Date.now()}-${i}-${Math.random().toString(16).slice(2, 6)}`;
        const session = await auth.loginDev({
          displayName: `NAT ${stamp}`,
          email: `nat-${stamp}@throttling.local`,
        });
        createdUserIds.push(session.user.id);
        if (session.household) createdHouseholdIds.push(session.household.id);
        sessions.push({ refreshToken: session.refreshToken });
      }
    });

    it('NAT-like burst: osiem sesji z jednego IP odświeża się bez 429', async () => {
      // Więcej niż THROTTLE_AUTH_LIMIT (3) — dawniej czwarta dostawała 429.
      for (const session of sessions) {
        const res = await refresh(session.refreshToken);
        // `POST` bez `@HttpCode` — kontrakt `/auth/refresh` to 201.
        expect(res.status).toBe(201);
      }
    });

    it('jedna sesja w pętli dostaje 429 po swoim limicie, inne dalej działają', async () => {
      const looping = junk();
      for (let i = 0; i < REFRESH_TOKEN_LIMIT; i += 1) {
        expect((await refresh(looping)).status).toBe(401);
      }
      const blocked = await refresh(looping);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      // Inna sesja z tego samego adresu nie płaci za cudzą pętlę.
      expect((await refresh(junk())).status).toBe(401);
    });

    it('bezpiecznik IP: świeże tokeny z jednego adresu też mają sufit', async () => {
      let blockedAt = -1;
      for (let i = 0; i <= REFRESH_IP_LIMIT; i += 1) {
        const res = await refresh(junk());
        if (res.status === 429) {
          blockedAt = i;
          break;
        }
        expect(res.status).toBe(401);
      }
      // Wcześniejsze przypadki zjadły część okna, więc sufit przychodzi
      // najpóźniej po REFRESH_IP_LIMIT żądaniach tego przypadku.
      expect(blockedAt).toBeGreaterThanOrEqual(0);
    });
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
