import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type {
  AnnouncementRow,
  AnnouncementsData,
  FeatureFlagsData,
  HouseholdFlagsData,
} from '../src/admin/contract';
import type { MeFlagsResponse } from '../src/feature-flags/feature-flags.service';
import type { MeAnnouncementsResponse } from '../src/announcements/announcements.service';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

const IOS_UA = 'Scoffie/35 CFNetwork/1568.100.1 Darwin/24.0.0';
const ANDROID_UA = 'okhttp/4.12.0';

/**
 * Flagi funkcji per dom i komunikaty w aplikacji na żywej bazie:
 * panel (CRUD ze step-upem i audytem) i aplikacja (`/me/flags`,
 * `/me/announcements` — właściwe dla domu i platformy, nigdy cudze).
 */
describe('Flagi funkcji i komunikaty (/admin/flags, /admin/announcements, /me/*)', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let admin: AdminE2ESession;
  let adminWithoutStepUp: AdminE2ESession;
  const originals = { ...process.env };
  const server = () => app.getHttpServer();
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const FLAG = `e2e.beta-${stamp}`.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const OTHER_FLAG = `e2e.global-${stamp}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');

  type Person = { token: string; userId: string; householdId: string };
  let anna: Person;
  let marek: Person;
  let loner: { token: string; userId: string };

  const login = async (name: string) => {
    const res = await request(server())
      .post('/auth/dev')
      .send({ displayName: name, email: `${name}-${stamp}@flags.local` })
      .expect(201);
    return {
      token: (res.body as { accessToken: string }).accessToken,
      userId: (res.body as { user: { id: string } }).user.id,
    };
  };
  const withHome = async (name: string): Promise<Person> => {
    const person = await login(name);
    const household = await prisma.household.create({
      data: {
        name: `Dom ${name}`,
        createdById: person.userId,
        memberships: { create: { userId: person.userId, role: 'OWNER' } },
      },
      select: { id: true },
    });
    return { ...person, householdId: household.id };
  };
  const meFlags = async (token: string) =>
    (
      await request(server())
        .get('/me/flags')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body as MeFlagsResponse;
  const meAnnouncements = async (token: string, ua?: string) => {
    const req = request(server())
      .get('/me/announcements')
      .set('Authorization', `Bearer ${token}`);
    if (ua) void req.set('User-Agent', ua);
    return ((await req.expect(200)).body as MeAnnouncementsResponse)
      .announcements;
  };
  const adminCall = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    session: AdminE2ESession = admin,
  ) => request(server())[method](path).set('Cookie', session.cookie);

  beforeAll(async () => {
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    restoreGate = useAdminDevGate();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.appAnnouncement.deleteMany({});
    admin = await createAdminSession(prisma, { stepUp: true });
    adminWithoutStepUp = await createAdminSession(prisma);
    anna = await withHome('anna');
    marek = await withHome('marek');
    loner = await login('loner');
  });

  afterAll(async () => {
    await prisma.appAnnouncement.deleteMany({});
    await prisma.featureFlag.deleteMany({
      where: { key: { in: [FLAG, OTHER_FLAG] } },
    });
    // Pola mogą być puste, gdy `beforeAll` padł w połowie.
    const homes: (string | undefined)[] = [
      anna?.householdId,
      marek?.householdId,
    ];
    const users: (string | undefined)[] = [
      anna?.userId,
      marek?.userId,
      loner?.userId,
    ];
    const present = (ids: (string | undefined)[]) =>
      ids.filter((id): id is string => typeof id === 'string');
    await prisma.household.deleteMany({
      where: { id: { in: present(homes) } },
    });
    await prisma.user.deleteMany({ where: { id: { in: present(users) } } });
    await cleanupAdmins(prisma);
    await app.close();
    restoreGate();
    process.env = originals;
  });

  it('bez sesji panelu trasy to 404, bez tokenu aplikacji 401', async () => {
    await request(server()).get('/admin/flags').expect(404);
    await request(server()).get('/admin/announcements').expect(404);
    await request(server()).get('/me/flags').expect(401);
    await request(server()).get('/me/announcements').expect(401);
  });

  describe('flagi', () => {
    it('zapis bez step-upu jest odrzucony i nic nie tworzy', async () => {
      const res = await adminCall('post', '/admin/flags', adminWithoutStepUp)
        .send({
          key: FLAG,
          description: 'beta',
          enabled: false,
          rolloutPercent: 0,
          reason: 'test e2e flag',
        })
        .expect(403);
      expect(JSON.stringify(res.body)).toMatch(/STEP_UP/);
      expect(
        await prisma.featureFlag.findUnique({ where: { key: FLAG } }),
      ).toBeNull();
    });

    it('zły klucz i rollout poza zakresem to 400', async () => {
      await adminCall('post', '/admin/flags')
        .send({
          key: 'Zła Flaga',
          description: '',
          enabled: false,
          rolloutPercent: 0,
          reason: 'test e2e flag',
        })
        .expect(400);
      await adminCall('post', '/admin/flags')
        .send({
          key: FLAG,
          description: '',
          enabled: false,
          rolloutPercent: 101,
          reason: 'test e2e flag',
        })
        .expect(400);
    });

    it('tworzenie, lista, duplikat 409, audyt', async () => {
      await adminCall('post', '/admin/flags')
        .send({
          key: FLAG,
          description: 'Nowy plan tygodnia',
          enabled: false,
          rolloutPercent: 0,
          reason: 'start bety planu',
        })
        .expect(204);
      await adminCall('post', '/admin/flags')
        .send({
          key: OTHER_FLAG,
          description: 'Dla wszystkich',
          enabled: true,
          rolloutPercent: 0,
          reason: 'flaga globalna',
        })
        .expect(204);
      await adminCall('post', '/admin/flags')
        .send({
          key: FLAG,
          description: 'x',
          enabled: false,
          rolloutPercent: 0,
          reason: 'duplikat flagi',
        })
        .expect(409);

      const data = (await adminCall('get', '/admin/flags').expect(200))
        .body as FeatureFlagsData;
      const row = data.flags.find((f) => f.key === FLAG);
      expect(row).toMatchObject({
        description: 'Nowy plan tygodnia',
        enabled: false,
        rolloutPercent: 0,
        overridesOn: 0,
        overridesOff: 0,
      });
      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: 'flags.create', targetId: FLAG },
      });
      expect(audit).toMatchObject({
        result: 'SUCCESS',
        reason: 'start bety planu',
      });
    });

    it('aplikacja: globalna włączona, beta wyłączona; osoba bez domu też dostaje globalne', async () => {
      const flags = (await meFlags(anna.token)).flags;
      expect(flags[FLAG]).toBe(false);
      expect(flags[OTHER_FLAG]).toBe(true);
      const lonerFlags = (await meFlags(loner.token)).flags;
      expect(lonerFlags[OTHER_FLAG]).toBe(true);
      expect(lonerFlags[FLAG]).toBe(false);
    });

    it('nadpisanie domu działa od następnego żądania i tylko dla tego domu', async () => {
      await adminCall(
        'put',
        `/admin/flags/${FLAG}/households/${anna.householdId}`,
        adminWithoutStepUp,
      )
        .send({ enabled: true, reason: 'beta dla Anny' })
        .expect(403);
      await adminCall(
        'put',
        `/admin/flags/${FLAG}/households/${anna.householdId}`,
      )
        .send({ enabled: true, reason: 'beta dla Anny' })
        .expect(204);
      await adminCall(
        'put',
        `/admin/flags/${OTHER_FLAG}/households/${marek.householdId}`,
      )
        .send({ enabled: false, reason: 'Marek bez tej funkcji' })
        .expect(204);

      expect((await meFlags(anna.token)).flags[FLAG]).toBe(true);
      expect((await meFlags(marek.token)).flags[FLAG]).toBe(false);
      expect((await meFlags(marek.token)).flags[OTHER_FLAG]).toBe(false);
      expect((await meFlags(anna.token)).flags[OTHER_FLAG]).toBe(true);

      const home = (
        await adminCall(
          'get',
          `/admin/flags/households/${anna.householdId}`,
        ).expect(200)
      ).body as HouseholdFlagsData;
      expect(home.flags.find((f) => f.key === FLAG)).toMatchObject({
        override: true,
        effective: true,
        source: 'override',
      });
      const list = (await adminCall('get', '/admin/flags').expect(200))
        .body as FeatureFlagsData;
      expect(list.flags.find((f) => f.key === FLAG)?.overridesOn).toBe(1);
      expect(list.flags.find((f) => f.key === OTHER_FLAG)?.overridesOff).toBe(
        1,
      );
    });

    it('nieznany dom albo flaga to 404; zły uuid 400', async () => {
      await adminCall(
        'put',
        `/admin/flags/${FLAG}/households/00000000-0000-4000-8000-000000000000`,
      )
        .send({ enabled: true, reason: 'nie ma domu' })
        .expect(404);
      await adminCall(
        'put',
        `/admin/flags/nie.ma/households/${anna.householdId}`,
      )
        .send({ enabled: true, reason: 'nie ma flagi' })
        .expect(404);
      await adminCall('get', '/admin/flags/households/nie-uuid').expect(400);
    });

    it('rollout 100 % włącza wszystkim; zdjęcie nadpisania wraca do reguły', async () => {
      await adminCall('patch', `/admin/flags/${FLAG}`)
        .send({ rolloutPercent: 100, reason: 'rollout na wszystkich' })
        .expect(204);
      expect((await meFlags(marek.token)).flags[FLAG]).toBe(true);

      await adminCall(
        'delete',
        `/admin/flags/${OTHER_FLAG}/households/${marek.householdId}`,
      )
        .send({ reason: 'koniec wyjątku' })
        .expect(204);
      expect((await meFlags(marek.token)).flags[OTHER_FLAG]).toBe(true);
      await adminCall(
        'delete',
        `/admin/flags/${OTHER_FLAG}/households/${marek.householdId}`,
      )
        .send({ reason: 'koniec wyjątku' })
        .expect(404);

      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: 'flags.update', targetId: FLAG },
      });
      expect(audit?.details).toMatchObject({
        before: { rolloutPercent: 0 },
        after: { rolloutPercent: 100 },
      });
    });

    it('usunięcie flagi kasuje nadpisania i znika z /me/flags', async () => {
      await adminCall('delete', `/admin/flags/${FLAG}`)
        .send({ reason: 'koniec bety planu' })
        .expect(204);
      expect(
        await prisma.featureFlagHousehold.count({ where: { flagKey: FLAG } }),
      ).toBe(0);
      expect((await meFlags(anna.token)).flags).not.toHaveProperty(FLAG);
      await adminCall('delete', `/admin/flags/${FLAG}`)
        .send({ reason: 'koniec bety planu' })
        .expect(404);
    });
  });

  describe('komunikaty', () => {
    const base = {
      body: 'Dziś od 22:00 do 23:00 lista zakupów może się nie odświeżać.',
      severity: 'warning',
      dismissible: true,
      reason: 'prace serwisowe',
    };
    let forAll: AnnouncementRow;

    it('publikacja bez step-upu odrzucona; walidacja limitów i HTML', async () => {
      await adminCall('post', '/admin/announcements', adminWithoutStepUp)
        .send({ ...base, title: 'Przerwa', audience: 'all' })
        .expect(403);
      const tooLong = await adminCall('post', '/admin/announcements')
        .send({ ...base, title: 'x'.repeat(81), audience: 'all' })
        .expect(400);
      expect(JSON.stringify(tooLong.body)).toMatch(/tytuł/);
      await adminCall('post', '/admin/announcements')
        .send({ ...base, title: 'Ok', body: 'y'.repeat(401), audience: 'all' })
        .expect(400);
      await adminCall('post', '/admin/announcements')
        .send({ ...base, title: '<b>Uwaga</b>', audience: 'all' })
        .expect(400);
      await adminCall('post', '/admin/announcements')
        .send({ ...base, title: 'Dla domu', audience: 'households' })
        .expect(400);
      expect(await prisma.appAnnouncement.count()).toBe(0);
    });

    it('publikacja: wszyscy, iOS, dom Anny — każdy widzi tylko swoje', async () => {
      forAll = (
        await adminCall('post', '/admin/announcements')
          .send({ ...base, title: 'Przerwa techniczna', audience: 'all' })
          .expect(201)
      ).body as AnnouncementRow;
      expect(forAll).toMatchObject({ state: 'active', severity: 'warning' });
      await adminCall('post', '/admin/announcements')
        .send({
          ...base,
          title: 'Nowa wersja na iPhone’a',
          severity: 'info',
          audience: 'ios',
        })
        .expect(201);
      await adminCall('post', '/admin/announcements')
        .send({
          ...base,
          title: 'Twoja beta',
          severity: 'critical',
          dismissible: false,
          audience: 'households',
          householdIds: [anna.householdId],
        })
        .expect(201);

      const annaIos = await meAnnouncements(anna.token, IOS_UA);
      expect(annaIos.map((a) => a.title)).toEqual([
        'Twoja beta',
        'Przerwa techniczna',
        'Nowa wersja na iPhone’a',
      ]);
      expect(annaIos[0]).toEqual({
        id: expect.any(String) as string,
        title: 'Twoja beta',
        body: base.body,
        severity: 'critical',
        dismissible: false,
        startsAt: expect.any(String) as string,
        endsAt: null,
      });
      // Nic o odbiorcach — ani listy domów, ani audience.
      expect(JSON.stringify(annaIos)).not.toContain(anna.householdId);

      const marekAndroid = await meAnnouncements(marek.token, ANDROID_UA);
      expect(marekAndroid.map((a) => a.title)).toEqual(['Przerwa techniczna']);
      const marekIosHeader = (
        await request(server())
          .get('/me/announcements')
          .set('Authorization', `Bearer ${marek.token}`)
          .set('User-Agent', 'curl/8')
          .set('X-Client-Platform', 'ios')
          .expect(200)
      ).body as MeAnnouncementsResponse;
      expect(marekIosHeader.announcements.map((a) => a.title)).toEqual([
        'Przerwa techniczna',
        'Nowa wersja na iPhone’a',
      ]);
      const lonerUnknown = await meAnnouncements(loner.token, 'curl/8');
      expect(lonerUnknown.map((a) => a.title)).toEqual(['Przerwa techniczna']);
    });

    it('czwarty naraz to 409 — także zaplanowany, gdy pozostałe trwają do odwołania', async () => {
      await adminCall('post', '/admin/announcements')
        .send({ ...base, title: 'Czwarty', audience: 'all' })
        .expect(409);
      const later = new Date(Date.now() + 3 * 24 * 3600_000);
      // Pozostałe są bez końca — więc przyszły też koliduje.
      await adminCall('post', '/admin/announcements')
        .send({
          ...base,
          title: 'Później',
          audience: 'all',
          startsAt: later.toISOString(),
        })
        .expect(409);
    });

    it('zakończenie teraz: znika z aplikacji, trafia do zakończonych, audyt', async () => {
      await adminCall(
        'post',
        `/admin/announcements/${forAll.id}/end`,
        adminWithoutStepUp,
      )
        .send({ reason: 'prace skończone' })
        .expect(403);
      const ended = (
        await adminCall('post', `/admin/announcements/${forAll.id}/end`)
          .send({ reason: 'prace skończone' })
          .expect(200)
      ).body as AnnouncementRow;
      expect(ended.state).toBe('ended');
      await adminCall('post', `/admin/announcements/${forAll.id}/end`)
        .send({ reason: 'prace skończone' })
        .expect(409);

      const marekAndroid = await meAnnouncements(marek.token, ANDROID_UA);
      expect(marekAndroid).toEqual([]);

      const scheduledStart = new Date(Date.now() + 24 * 3600_000);
      await adminCall('post', '/admin/announcements')
        .send({
          ...base,
          title: 'Jutro',
          audience: 'all',
          startsAt: scheduledStart.toISOString(),
          endsAt: new Date(scheduledStart.getTime() + 3600_000).toISOString(),
        })
        .expect(201);

      const data = (await adminCall('get', '/admin/announcements').expect(200))
        .body as AnnouncementsData;
      expect(data.active.map((a) => a.title)).toEqual([
        'Twoja beta',
        'Nowa wersja na iPhone’a',
      ]);
      expect(data.scheduled.map((a) => a.title)).toEqual(['Jutro']);
      expect(data.ended.map((a) => a.id)).toEqual([forAll.id]);
      expect(data.limits).toEqual({ titleMax: 80, bodyMax: 400, maxActive: 3 });
      expect(
        (await meAnnouncements(marek.token, ANDROID_UA)).map((a) => a.title),
      ).toEqual([]);

      const audit = await prisma.adminAuditLog.findMany({
        where: {
          action: { in: ['announcements.create', 'announcements.end'] },
        },
        select: { action: true, result: true },
      });
      expect(
        audit.filter(
          (a) => a.action === 'announcements.end' && a.result === 'SUCCESS',
        ),
      ).toHaveLength(1);
      expect(
        audit.filter(
          (a) => a.action === 'announcements.create' && a.result === 'SUCCESS',
        ),
      ).toHaveLength(4);
    });
  });
});
