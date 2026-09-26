import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type {
  DashboardData,
  SearchResults,
  UserDetail,
  UserList,
  UserListItem,
} from '../src/admin/contract';
import { activityDayKey } from '../src/auth/user-activity.service';
import { SUBSCRIPTION_PRODUCTS } from '../src/config/subscription-products';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Panel administratora na żywej bazie: pulpit, lista i karta osoby,
 * wyszukiwarka i akcje na koncie (zdrowie, wylogowanie, eksport, ponowienie
 * maila, usunięcie). Dane osób seeduje sam test ze znacznikiem `stamp`
 * i po sobie sprząta — baza ma tylko katalog i migracje.
 *
 * Czego nie da się dowieść mockiem: że filtry i plan domu liczą się w SQL tak,
 * jak wynika z danych, że akcje idą drogą domeny (tokeny naprawdę
 * unieważnione, konto naprawdę skasowane) i że każda zostawia ślad w
 * `AdminAuditLog`.
 */
describe('Panel admina — użytkownicy, pulpit, wyszukiwarka', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let session: AdminE2ESession;
  let plainSession: AdminE2ESession;
  let savedAppleEnv: string | undefined;

  // Same litery a–f i cyfry: znacznik przechodzi przez normalizację bez zmian.
  const stamp = `e2ea1${randomBytes(4).toString('hex')}`;
  const DAY = 24 * 60 * 60 * 1000;

  const ids = {
    owner: '',
    member: '',
    loner: '',
    household: '',
    subscription: '',
    failedMail: '',
    rootToken: '',
  };
  const lonerEmail = `zolc-${stamp}@example.com`;

  const server = () => app.getHttpServer();
  const get = (path: string, s: AdminE2ESession | null = session) => {
    const req = request(server()).get(path);
    return s ? req.set('Cookie', s.cookie) : req;
  };
  const post = (path: string, body: object = {}, s = session) =>
    request(server()).post(path).set('Cookie', s.cookie).send(body);

  const auditOf = (action: string, targetId: string) =>
    prisma.adminAuditLog.findMany({
      where: { action, targetId },
      orderBy: { createdAt: 'desc' },
    });

  const byId = (items: UserListItem[], id: string) =>
    items.find((item) => item.id === id);

  beforeAll(async () => {
    restoreGate = useAdminDevGate();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    // Subskrypcja z testu jest „Production" (tylko taka liczy się do MRR),
    // a lokalnie backend przyjmuje wyłącznie Sandbox — bez tego domena
    // (`subscriptionAlive`) słusznie uznałaby ją za martwą. Czytane per
    // wywołanie, więc wystarczy ustawić po starcie.
    savedAppleEnv = process.env.APPLE_ENVIRONMENT;
    process.env.APPLE_ENVIRONMENT = 'Production';

    session = await createAdminSession(prisma, { stepUp: true });
    plainSession = await createAdminSession(prisma);

    const now = Date.now();
    const identityHash = `e2e-${stamp}`;
    const owner = await prisma.user.create({
      data: {
        displayName: `Właścicielka ${stamp}`,
        email: `${stamp}@privaterelay.appleid.com`,
        authProvider: 'DEV',
        identityHash,
        onboardingCompletedAt: new Date(now - DAY),
        lastLoginAt: new Date(now - 2 * DAY),
        lastSeenAt: new Date(now),
        yearOfBirth: 1990,
        weightKg: 64.5,
      },
      select: { id: true },
    });
    ids.owner = owner.id;
    const member = await prisma.user.create({
      data: {
        displayName: `Domownik ${stamp}`,
        authProvider: 'DEV',
        lastLoginAt: new Date(now - 10 * DAY),
        lastSeenAt: new Date(now - 10 * DAY),
      },
      select: { id: true },
    });
    ids.member = member.id;
    // Aktywność liczy się z dób w aplikacji (`UserActivityDay`), nie z
    // `lastLoginAt`: właścicielka była dziś (logowała się 2 dni temu),
    // domownik — 10 dni temu.
    const activityDay = (at: number) =>
      new Date(`${activityDayKey(new Date(at))}T00:00:00.000Z`);
    await prisma.userActivityDay.createMany({
      data: [
        { userId: owner.id, date: activityDay(now) },
        { userId: member.id, date: activityDay(now - 10 * DAY) },
      ],
    });
    const loner = await prisma.user.create({
      data: {
        displayName: `Żółć ${stamp}`,
        email: lonerEmail,
        authProvider: 'DEV',
        yearOfBirth: 1985,
        heightCm: 180,
      },
      select: { id: true },
    });
    ids.loner = loner.id;

    const household = await prisma.household.create({
      data: {
        name: `Dom ${stamp}`,
        createdById: owner.id,
        memberships: {
          create: [
            { userId: owner.id, role: 'OWNER' },
            { userId: member.id, role: 'MEMBER' },
          ],
        },
      },
      select: { id: true },
    });
    ids.household = household.id;

    await prisma.consentEvent.create({
      data: {
        userId: owner.id,
        kind: 'AI_ASSISTANT',
        action: 'GRANTED',
        documentVersion: '2099-01-01',
        appVersion: '1.0',
      },
    });
    await prisma.pushDevice.create({
      data: {
        userId: owner.id,
        deviceToken: `token-${stamp}`,
        platform: 'IOS',
        appBundleId: 'app.scoffie.ios',
        apnsEnvironment: 'SANDBOX',
      },
    });
    const failed = await prisma.mailMessage.create({
      data: {
        dedupeKey: `e2e-${stamp}-welcome`,
        template: 'WELCOME',
        to: `${stamp}@privaterelay.appleid.com`,
        userId: owner.id,
        payload: {},
        status: 'FAILED',
        attempts: 5,
        lastError: 'HTTP_500',
      },
      select: { id: true },
    });
    ids.failedMail = failed.id;

    // Jedna sesja z rotacją (korzeń → głowa) i jedna wygasła — ta nie jest
    // już sesją i karta jej nie pokazuje.
    const root = await prisma.refreshToken.create({
      data: {
        userId: owner.id,
        tokenHash: `root-${stamp}`,
        replacedByHash: `head-${stamp}`,
        expiresAt: new Date(now + 30 * DAY),
        createdAt: new Date(now - 2 * DAY),
        revokedAt: new Date(now - DAY),
        revokedReason: 'ROTATED',
      },
      select: { id: true },
    });
    ids.rootToken = root.id;
    await prisma.refreshToken.create({
      data: {
        userId: owner.id,
        tokenHash: `head-${stamp}`,
        expiresAt: new Date(now + 30 * DAY),
        createdAt: new Date(now - DAY),
      },
    });
    await prisma.refreshToken.create({
      data: {
        userId: owner.id,
        tokenHash: `old-${stamp}`,
        expiresAt: new Date(now - DAY),
        createdAt: new Date(now - 40 * DAY),
      },
    });
  });

  afterAll(async () => {
    try {
      await prisma.mailMessage.deleteMany({
        where: {
          OR: [
            { dedupeKey: { startsWith: `e2e-${stamp}` } },
            { userId: { in: [ids.owner, ids.member, ids.loner] } },
            { to: lonerEmail },
          ],
        },
      });
      if (ids.subscription) {
        await prisma.subscription.deleteMany({
          where: { id: ids.subscription },
        });
      }
      await prisma.household.deleteMany({ where: { id: ids.household } });
      await prisma.user.deleteMany({
        where: { id: { in: [ids.owner, ids.member, ids.loner] } },
      });
      await cleanupAdmins(prisma);
    } finally {
      await app.close();
      restoreGate();
      if (savedAppleEnv === undefined) delete process.env.APPLE_ENVIRONMENT;
      else process.env.APPLE_ENVIRONMENT = savedAppleEnv;
    }
  });

  it('bez sesji panelu — 404 jak brak trasy', async () => {
    for (const path of [
      '/admin/dashboard',
      '/admin/users',
      `/admin/users/${ids.owner}`,
      `/admin/search?q=${stamp}`,
    ]) {
      await get(path, null).expect(404);
    }
    await request(server())
      .post(`/admin/users/${ids.owner}/logout-everywhere`)
      .expect(404);
  });

  it('pulpit: serie 30 dób, dzisiejsze liczby i MRR z nowej subskrypcji', async () => {
    const before = (await get('/admin/dashboard').expect(200))
      .body as DashboardData;

    const sub = await prisma.subscription.create({
      data: {
        identityHash: `e2e-${stamp}`,
        purchaserUserId: ids.owner,
        provider: 'APPLE',
        productId: 'app.scoffie.pro.duet.monthly',
        originalTransactionId: `otx-${stamp}`,
        status: 'ACTIVE',
        environment: 'Production',
        ownershipType: 'PURCHASED',
        autoRenewStatus: true,
        expiresAt: new Date(Date.now() + 20 * DAY),
      },
      select: { id: true },
    });
    ids.subscription = sub.id;

    const after = (await get('/admin/dashboard').expect(200))
      .body as DashboardData;

    expect(after.days).toHaveLength(30);
    expect(after.today.newUsers).toBe(after.days[29].newUsers);
    expect(after.today.newUsers).toBeGreaterThanOrEqual(3);
    expect(after.loggedInToday).toBeGreaterThanOrEqual(1);
    // Trend z dób aktywności całej bazy testowej — liczba, bez stałej wartości.
    expect(after.loggedInTrend).toEqual(
      expect.objectContaining({ d1: expect.any(Number) }),
    );
    expect(after.households).toBeGreaterThanOrEqual(1);
    expect(after.attention.mailsFailed).toBeGreaterThanOrEqual(1);
    expect(after.mrrSpark).toHaveLength(14);
    expect(after.subsSpark).toHaveLength(14);
    expect(after.activeSubs).toBe(before.activeSubs + 1);
    expect(after.mrrZl).toBeCloseTo(
      before.mrrZl +
        SUBSCRIPTION_PRODUCTS['app.scoffie.pro.duet.monthly'].pricePln,
      2,
    );
    expect(after.production.migrations.applied).toBeGreaterThan(0);
    expect(after.production.migrations.latest).toMatch(/^\d{14}_/);
    expect(Array.isArray(after.topRecipes)).toBe(true);
  });

  it('lista: plan domu, płatnik, ukryty adres i przekrój bazy', async () => {
    const res = await get(`/admin/users?q=${stamp}`).expect(200);
    const list = res.body as UserList;
    expect(list.total).toBe(3);
    expect(list.items).toHaveLength(3);
    expect(list.stats.total).toBeGreaterThanOrEqual(3);
    expect(list.stats.paying).toBeGreaterThanOrEqual(1);
    expect(list.stats.aiConsent).toBeGreaterThanOrEqual(1);

    const owner = byId(list.items, ids.owner);
    expect(owner).toMatchObject({
      householdId: ids.household,
      householdName: `Dom ${stamp}`,
      role: 'OWNER',
      hiddenEmail: true,
      paying: true,
      plan: {
        kind: 'subscription',
        productId: 'app.scoffie.pro.duet.monthly',
      },
    });
    expect(typeof owner?.avatarColor).toBe('number');
    // Domownik korzysta z planu płatnika, ale sam nie płaci.
    expect(byId(list.items, ids.member)).toMatchObject({
      role: 'MEMBER',
      paying: false,
      email: null,
      hiddenEmail: false,
      plan: { kind: 'subscription' },
    });
    expect(byId(list.items, ids.loner)).toMatchObject({
      householdId: null,
      role: null,
      plan: null,
      paying: false,
    });
  });

  it('lista: filtry zawężają w bazie, literówka w fladze = 400', async () => {
    const only = async (query: string) =>
      (
        (await get(`/admin/users?q=${stamp}&${query}`).expect(200))
          .body as UserList
      ).items.map((item) => item.id);

    expect(await only('noHousehold=true')).toEqual([ids.loner]);
    expect(await only('subscribed=true')).toEqual([ids.owner]);
    expect(await only('onboarding=true')).toEqual([ids.owner]);
    expect(await only('active7=true')).toEqual([ids.owner]);
    // „Ostatnio w aplikacji” obok ostatniego pełnego logowania.
    const list = (await get(`/admin/users?q=${stamp}`).expect(200))
      .body as UserList;
    const ownerItem = list.items.find((item) => item.id === ids.owner);
    expect(ownerItem?.lastSeenAt).not.toBeNull();
    expect(Date.parse(ownerItem!.lastSeenAt!)).toBeGreaterThan(
      Date.parse(ownerItem!.lastLoginAt!),
    );
    expect(list.items[0].id).toBe(ids.owner);
    expect((await only('active7=false')).sort()).toEqual(
      [ids.member, ids.loner].sort(),
    );
    await get(`/admin/users?onboarding=tak`).expect(400);
    await get(`/admin/users?page=2`).expect(400);
  });

  it('karta osoby: subskrypcja, urządzenia, sesje jako rodziny, zgody, maile', async () => {
    const res = await get(`/admin/users/${ids.owner}`).expect(200);
    const detail = res.body as UserDetail;
    expect(detail.id).toBe(ids.owner);
    expect(detail.householdMembers).toBe(2);
    expect(detail.subscription).toMatchObject({
      id: ids.subscription,
      productId: 'app.scoffie.pro.duet.monthly',
      status: 'ACTIVE',
      environment: 'Production',
      ownershipType: 'PURCHASED',
    });
    expect(detail.pushDevices).toEqual([
      expect.objectContaining({
        appBundleId: 'app.scoffie.ios',
        apnsEnvironment: 'SANDBOX',
        isActive: true,
      }),
    ]);
    // Łańcuch rotacji = jedna sesja (id korzenia), wygasła rodzina znika.
    expect(detail.sessions).toEqual([
      expect.objectContaining({
        id: ids.rootToken,
        revokedAt: null,
        revokedReason: null,
      }),
    ]);
    expect(detail.consents).toEqual([
      expect.objectContaining({ kind: 'AI_ASSISTANT', action: 'GRANTED' }),
    ]);
    expect(detail.mails).toEqual([
      expect.objectContaining({
        id: ids.failedMail,
        template: 'WELCOME',
        status: 'FAILED',
        attempts: 5,
      }),
    ]);
    expect(detail.assistant.turns).toBe(0);
    expect(detail.assistant.daily.length).toBeGreaterThanOrEqual(1);
    expect(detail.stepsSource).toBeNull();
    expect(detail.memoryNotes).toBe(0);
    // Dane o zdrowiu tylko po „Odsłoń".
    expect(detail).not.toHaveProperty('weightKg');
    expect(detail).not.toHaveProperty('yearOfBirth');
  });

  it('karta osoby: zły id = 400, nieistniejąca osoba = 404 NOT_FOUND', async () => {
    await get('/admin/users/nie-uuid').expect(400);
    const res = await get(
      '/admin/users/00000000-0000-4000-8000-000000000000',
    ).expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('wyszukiwarka: osoba bez polskich znaków, dom po nazwie, za krótkie = pusto', async () => {
    const people = (await get(`/admin/search?q=zolc ${stamp}`).expect(200))
      .body as SearchResults;
    expect(people.users.map((user) => user.id)).toEqual([ids.loner]);

    const homes = (await get(`/admin/search?q=dom ${stamp}`).expect(200))
      .body as SearchResults;
    expect(homes.households).toEqual([
      expect.objectContaining({
        id: ids.household,
        plan: {
          kind: 'subscription',
          productId: 'app.scoffie.pro.duet.monthly',
        },
        cookidoo: null,
      }),
    ]);
    expect(homes.households[0].members).toHaveLength(2);

    const empty = (await get('/admin/search?q=a').expect(200))
      .body as SearchResults;
    expect(empty).toEqual({ users: [], households: [], recipes: [] });
  });

  it('dane o zdrowiu: bez step-upu 403, z powodem — wartości, w dzienniku bez wartości', async () => {
    const denied = await post(
      `/admin/users/${ids.owner}/health`,
      { reason: 'Zgłoszenie z supportu #1' },
      plainSession,
    ).expect(403);
    expect(denied.body.code).toBe('STEP_UP_REQUIRED');

    await post(`/admin/users/${ids.owner}/health`, { reason: 'x' }).expect(400);

    const res = await post(`/admin/users/${ids.owner}/health`, {
      reason: 'Zgłoszenie z supportu #1',
    }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      yearOfBirth: 1990,
      weightKg: 64.5,
      goal: 'HEALTHY',
      dietPreference: 'NONE',
      allergens: [],
    });
    expect(Date.parse(res.body.revealedUntil)).toBeGreaterThan(Date.now());

    const [entry] = await auditOf('user.health.reveal', ids.owner);
    expect(entry).toMatchObject({
      result: 'SUCCESS',
      targetType: 'User',
      reason: 'Zgłoszenie z supportu #1',
      adminUserId: session.adminUserId,
    });
    expect(JSON.stringify(entry.details)).not.toContain('64.5');
    expect(JSON.stringify(entry.details)).not.toContain('1990');
  });

  it('wyloguj zewsząd: tokeny unieważnione drogą domeny, wpis w dzienniku', async () => {
    const res = await post(
      `/admin/users/${ids.owner}/logout-everywhere`,
    ).expect(200);
    expect(res.body.closed).toBeGreaterThanOrEqual(1);

    const alive = await prisma.refreshToken.count({
      where: { userId: ids.owner, revokedAt: null },
    });
    expect(alive).toBe(0);
    const [entry] = await auditOf('user.logout-everywhere', ids.owner);
    expect(entry).toMatchObject({ result: 'SUCCESS', targetType: 'User' });
  });

  it('eksport RODO: step-up, paczka jako plik, wpis w dzienniku', async () => {
    const denied = await post(
      `/admin/users/${ids.member}/export`,
      { reason: 'Wniosek z art. 15' },
      plainSession,
    ).expect(403);
    expect(denied.body.code).toBe('STEP_UP_REQUIRED');

    const res = await post(`/admin/users/${ids.member}/export`, {
      reason: 'Wniosek z art. 15',
    }).expect(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="scoffie-dane-${ids.member}.json"`,
    );
    expect(res.headers['content-type']).toMatch(/^application\/json;/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.format).toBeDefined();

    const [entry] = await auditOf('user.export', ids.member);
    expect(entry).toMatchObject({
      result: 'SUCCESS',
      targetType: 'User',
      reason: 'Wniosek z art. 15',
    });
  });

  it('ponowienie maila: FAILED wraca do kolejki, drugi raz = 409', async () => {
    const saved = process.env.MAIL_ENABLED;
    process.env.MAIL_ENABLED = 'true';
    try {
      await post(`/admin/mails/${ids.failedMail}/retry`).expect(204);
      const mail = await prisma.mailMessage.findUniqueOrThrow({
        where: { id: ids.failedMail },
        select: { status: true, attempts: true },
      });
      expect(mail.status).not.toBe('FAILED');
      expect(mail.attempts).toBeGreaterThanOrEqual(5);

      const again = await post(`/admin/mails/${ids.failedMail}/retry`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('CONFLICT');
    } finally {
      if (saved === undefined) delete process.env.MAIL_ENABLED;
      else process.env.MAIL_ENABLED = saved;
    }
    const entries = await auditOf('mail.retry', ids.failedMail);
    expect(entries.map((entry) => entry.result).sort()).toEqual([
      'FAILED',
      'SUCCESS',
    ]);
    expect(entries.every((entry) => entry.targetType === 'MailMessage')).toBe(
      true,
    );
  });

  it('usunięcie konta: step-up, konto znika drogą domeny, porażka też w dzienniku', async () => {
    const denied = await request(server())
      .delete(`/admin/users/${ids.loner}`)
      .set('Cookie', plainSession.cookie)
      .send({ reason: 'Prośba osoby mailem' })
      .expect(403);
    expect(denied.body.code).toBe('STEP_UP_REQUIRED');

    await request(server())
      .delete(`/admin/users/${ids.loner}`)
      .set('Cookie', session.cookie)
      .send({ reason: 'Prośba osoby mailem' })
      .expect(204);
    expect(
      await prisma.user.findUnique({ where: { id: ids.loner } }),
    ).toBeNull();
    const [entry] = await auditOf('user.delete', ids.loner);
    expect(entry).toMatchObject({
      result: 'SUCCESS',
      targetType: 'User',
      reason: 'Prośba osoby mailem',
    });

    const missing = '00000000-0000-4000-8000-00000000a1a1';
    await request(server())
      .delete(`/admin/users/${missing}`)
      .set('Cookie', session.cookie)
      .send({ reason: 'Prośba osoby mailem' })
      .expect(404);
    const [failed] = await auditOf('user.delete', missing);
    expect(failed).toMatchObject({ result: 'FAILED', errorCode: 'NOT_FOUND' });
  });
});
