import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { REFRESH_ABSOLUTE_DAYS } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * ABSOLUTNY KRES SESJI REFRESH (audyt 5.09.2026, 2.3.1) — e2e, żywa baza.
 *
 * Okno `REFRESH_TOKEN_DAYS` przesuwa się z każdą rotacją, więc bez kresu
 * rodzina tokenów żyła bez końca. `RefreshToken.sessionStartedAt` = chwila
 * logowania; rotacja i ratunek zgubionej rotacji ją KOPIUJĄ, a po
 * `REFRESH_ABSOLUTE_DAYS` od niej `/auth/refresh` odmawia tym samym 401 co
 * wygasły token — bez kasowania rodziny i bez podbijania `tokenVersion`
 * (to koniec sesji, nie dowód kradzieży).
 *
 * Okno łaski i rotacja w transakcji — bez zmian; ich polityki pilnują
 * `auth-session-lifecycle`, `auth-refresh-after-grace` i `auth-session-audit`.
 */
const AUTH_LIMIT_BEFORE = process.env.THROTTLE_AUTH_LIMIT;
process.env.THROTTLE_AUTH_LIMIT = '10000';

type Session = { accessToken: string; refreshToken: string; userId: string };

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Absolutny kres sesji refresh (e2e, żywa baza)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];

  const login = async (label: string, email?: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `Kres ${label}`,
        email: email ?? `kres-${label}-${stamp}@audit.local`,
      })
      .expect(201);
    const userId = res.body.user.id as string;
    if (!createdUserIds.includes(userId)) createdUserIds.push(userId);
    return {
      accessToken: res.body.accessToken as string,
      refreshToken: res.body.refreshToken as string,
      userId,
    };
  };

  const refresh = (token: string) =>
    request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: token });

  const rows = (userId: string) =>
    prisma.refreshToken.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  const tokenVersion = async (userId: string) =>
    (
      await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { tokenVersion: true },
      })
    ).tokenVersion;

  /** Cofa początek sesji całej rodziny o `days` dni (jakby logowanie było dawno). */
  const ageSession = (userId: string, days: number) =>
    prisma.refreshToken.updateMany({
      where: { userId },
      data: { sessionStartedAt: new Date(Date.now() - days * DAY_MS) },
    });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    if (AUTH_LIMIT_BEFORE === undefined) delete process.env.THROTTLE_AUTH_LIMIT;
    else process.env.THROTTLE_AUTH_LIMIT = AUTH_LIMIT_BEFORE;
  });

  it('logowanie zaczyna sesję, a rotacja przenosi jej początek na następcę', async () => {
    const session = await login('rotacja');
    const [first] = await rows(session.userId);
    expect(
      Math.abs(first.sessionStartedAt.getTime() - first.createdAt.getTime()),
    ).toBeLessThan(5_000);

    const rotated = await refresh(session.refreshToken).expect(201);
    const again = await refresh(rotated.body.refreshToken as string).expect(
      201,
    );
    expect(again.body.refreshToken).toBeDefined();

    const all = await rows(session.userId);
    expect(all).toHaveLength(3);
    for (const row of all) {
      expect(row.sessionStartedAt.toISOString()).toBe(
        first.sessionStartedAt.toISOString(),
      );
    }
  });

  it('sesja po kresie: 401 jak wygasły token, rodzina i tokenVersion nietknięte', async () => {
    const session = await login('kres');
    await ageSession(session.userId, REFRESH_ABSOLUTE_DAYS + 1);
    const versionBefore = await tokenVersion(session.userId);

    const res = await refresh(session.refreshToken).expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');

    const after = await rows(session.userId);
    expect(after).toHaveLength(1);
    expect(after[0].revokedAt).toBeNull();
    expect(await tokenVersion(session.userId)).toBe(versionBefore);
    // Dostęp wydany wcześniej działa do swojego końca (to nie kradzież).
    await request(app.getHttpServer())
      .get('/me/consents')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
  });

  it('dzień przed kresem sesja dalej się odświeża', async () => {
    const session = await login('przed-kresem');
    await ageSession(session.userId, REFRESH_ABSOLUTE_DAYS - 1);
    await refresh(session.refreshToken).expect(201);
  });

  it('nowe logowanie po kresie zaczyna NOWĄ sesję', async () => {
    const email = `kres-ponowne-${Date.now()}@audit.local`;
    const old = await login('ponowne', email);
    await ageSession(old.userId, REFRESH_ABSOLUTE_DAYS + 1);
    await refresh(old.refreshToken).expect(401);

    const fresh = await login('ponowne', email);
    expect(fresh.userId).toBe(old.userId);
    await refresh(fresh.refreshToken).expect(201);
  });

  it('ratunek zgubionej rotacji kopiuje początek sesji; po kresie ratunku nie ma', async () => {
    const session = await login('ratunek');
    const started = (await rows(session.userId))[0].sessionStartedAt;
    // Rotacja, której odpowiedź „nie dojechała": klient ponawia STARYM tokenem
    // w oknie łaski i dostaje świeżą parę.
    await refresh(session.refreshToken).expect(201);
    const recovered = await refresh(session.refreshToken).expect(201);
    expect(recovered.body.refreshToken).toBeDefined();
    for (const row of await rows(session.userId)) {
      expect(row.sessionStartedAt.toISOString()).toBe(started.toISOString());
    }

    // Ta sama sytuacja po kresie: 401 bez nowej pary i bez kasowania rodziny.
    await ageSession(session.userId, REFRESH_ABSOLUTE_DAYS + 1);
    const countBefore = (await rows(session.userId)).length;
    const versionBefore = await tokenVersion(session.userId);
    await refresh(session.refreshToken).expect(401);
    const after = await rows(session.userId);
    expect(after).toHaveLength(countBefore);
    expect(after.filter((row) => row.revokedReason === 'REUSE')).toHaveLength(
      0,
    );
    expect(await tokenVersion(session.userId)).toBe(versionBefore);
  });
});
