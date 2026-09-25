import { randomBytes } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AdminWatchService } from '../src/admin/alerts/admin-watch.service';
import { AdminRateLimiter } from '../src/admin/admin-rate-limiter';
import type {
  GdprData,
  GdprRequestDetail,
  PushTestResult,
  SentryUserState,
  UserDetail,
} from '../src/admin/contract';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ApnsService } from '../src/notifications/apns.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

const DAY = 24 * 60 * 60_000;

/**
 * Karta osoby (testowy push, błędy Sentry) i rejestr wniosków RODO na żywej
 * bazie. APNs i Sentry są podstawione — żaden push nie wychodzi do Apple,
 * żadne zapytanie do Sentry.
 */
describe('Panel — push testowy, Sentry osoby, rejestr RODO', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let admin: AdminE2ESession;
  let adminWithoutStepUp: AdminE2ESession;
  let sendWithResult: jest.SpyInstance;

  const originals = { ...process.env };
  const TAG = `b3-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const OWNER_EMAIL = `owner-${TAG}@b3.local`;
  const ids: {
    owner?: string;
    stranger?: string;
    ownerDevice?: string;
    strangerDevice?: string;
  } = {};
  const gdprIds: string[] = [];

  const server = () => app.getHttpServer();
  const get = (path: string, session: AdminE2ESession = admin) =>
    request(server()).get(path).set('Cookie', session.cookie);
  const post = (path: string, body: object = {}, s = admin) =>
    request(server()).post(path).set('Cookie', s.cookie).send(body);

  beforeAll(async () => {
    for (const key of [
      'ADMIN_SENTRY_TOKEN',
      'ADMIN_RAILWAY_TOKEN',
      'RESEND_API_KEY',
      'OPS_ALERT_WEBHOOK_URL',
      'ADMIN_ALERTS',
    ]) {
      delete process.env[key];
    }
    process.env.ADMIN_BOOTSTRAP_EMAIL = OWNER_EMAIL;
    process.env.ADMIN_ALERT_EMAILS = `ops-${TAG}@b3.local`;
    restoreGate = useAdminDevGate();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    admin = await createAdminSession(prisma, { stepUp: true });
    adminWithoutStepUp = await createAdminSession(prisma);

    // APNs podstawiony: skonfigurowany, ale bez żadnego połączenia z Apple.
    const apns = moduleRef.get(ApnsService);
    jest.spyOn(apns, 'isConfigured').mockReturnValue(true);
    sendWithResult = jest
      .spyOn(apns, 'sendWithResult')
      .mockImplementation((_token, _payload, bundle, environment) =>
        Promise.resolve({
          status: 200,
          apnsId: 'APNS-E2E',
          reason: null,
          environment: environment ?? 'PRODUCTION',
          topic: bundle ?? 'app.scoffie',
        }),
      );

    const owner = await prisma.user.create({
      data: {
        displayName: `Właściciel ${TAG}`,
        email: OWNER_EMAIL,
        authProvider: 'DEV',
        identityHash: `e2e-${TAG}-o`,
        pushDevices: {
          create: {
            deviceToken: `tok-${TAG}-o`,
            platform: 'IOS',
            appBundleId: 'app.scoffie',
            apnsEnvironment: 'SANDBOX',
          },
        },
      },
      select: { id: true, pushDevices: { select: { id: true } } },
    });
    const stranger = await prisma.user.create({
      data: {
        displayName: `Obca ${TAG}`,
        email: `obca-${TAG}@b3.local`,
        authProvider: 'DEV',
        identityHash: `e2e-${TAG}-s`,
        pushDevices: {
          create: {
            deviceToken: `tok-${TAG}-s`,
            platform: 'IOS',
            appBundleId: 'app.scoffie',
          },
        },
      },
      select: { id: true, pushDevices: { select: { id: true } } },
    });
    ids.owner = owner.id;
    ids.ownerDevice = owner.pushDevices[0].id;
    ids.stranger = stranger.id;
    ids.strangerDevice = stranger.pushDevices[0].id;
  });

  afterAll(async () => {
    try {
      await prisma.adminAlert.deleteMany({
        where: { key: { in: gdprIds.map((id) => `gdpr-due:${id}`) } },
      });
      await prisma.mailMessage.deleteMany({
        where: { dedupeKey: { startsWith: 'ops-alert:gdpr-due:' } },
      });
      await prisma.gdprRequest.deleteMany({ where: { id: { in: gdprIds } } });
      await prisma.user.deleteMany({
        where: { id: { in: [ids.owner!, ids.stranger!].filter(Boolean) } },
      });
      await cleanupAdmins(prisma);
    } finally {
      jest.restoreAllMocks();
      await app.close();
      restoreGate();
      process.env = originals;
    }
  });

  // ——— push testowy ———

  const pushPath = (user: string, device: string) =>
    `/admin/users/${user}/devices/${device}/test-push`;

  it('bez sesji 404, bez step-upu 403 STEP_UP_REQUIRED — nic nie wychodzi', async () => {
    await request(server())
      .post(pushPath(ids.owner!, ids.ownerDevice!))
      .expect(404);
    const res = await post(
      pushPath(ids.owner!, ids.ownerDevice!),
      {},
      adminWithoutStepUp,
    ).expect(403);
    expect((res.body as { code: string }).code).toBe('STEP_UP_REQUIRED');
    expect(sendWithResult).not.toHaveBeenCalled();
  });

  it('karta właściciela ma `ownerAccount`, obcej osoby nie', async () => {
    const owner = (await get(`/admin/users/${ids.owner}`).expect(200))
      .body as UserDetail;
    const stranger = (await get(`/admin/users/${ids.stranger}`).expect(200))
      .body as UserDetail;
    expect(owner.ownerAccount).toBe(true);
    expect(stranger.ownerAccount).toBe(false);
  });

  it('urządzenie właściciela: wynik APNs, wpis w dzienniku bez tokenu', async () => {
    const res = await post(pushPath(ids.owner!, ids.ownerDevice!)).expect(200);
    const result = res.body as PushTestResult;
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      apnsId: 'APNS-E2E',
      environment: 'SANDBOX',
      topic: 'app.scoffie',
    });
    expect(sendWithResult).toHaveBeenCalledTimes(1);
    expect(res.headers['cache-control']).toBe('no-store');

    const entry = await prisma.adminAuditLog.findFirst({
      where: { action: 'user.push.test', targetId: ids.ownerDevice },
    });
    expect(entry).toMatchObject({
      result: 'SUCCESS',
      targetType: 'PushDevice',
    });
    expect(JSON.stringify(entry?.details)).not.toContain(`tok-${TAG}`);
  });

  it('obca osoba: bez potwierdzenia 403, z potwierdzeniem i powodem — wysyła', async () => {
    const path = pushPath(ids.stranger!, ids.strangerDevice!);
    await post(path).expect(403);
    await post(path, { confirmForeign: true }).expect(403);
    await post(path, { confirmForeign: false, reason: 'powód testu' }).expect(
      400,
    );
    expect(sendWithResult).toHaveBeenCalledTimes(1);

    await post(path, {
      confirmForeign: true,
      reason: 'zgłoszenie — brak pushy',
    }).expect(200);
    expect(sendWithResult).toHaveBeenCalledTimes(2);
    const entry = await prisma.adminAuditLog.findFirst({
      where: { action: 'user.push.test', targetId: ids.strangerDevice },
    });
    expect(entry?.reason).toBe('zgłoszenie — brak pushy');
  });

  it('urządzenie innej osoby pod cudzym id → 404; limit na minutę → 429', async () => {
    await post(pushPath(ids.owner!, ids.strangerDevice!)).expect(404);
    moduleRef.get(AdminRateLimiter).reset();
    for (let i = 0; i < 5; i += 1) {
      await post(pushPath(ids.owner!, ids.ownerDevice!)).expect(200);
    }
    await post(pushPath(ids.owner!, ids.ownerDevice!)).expect(429);
    moduleRef.get(AdminRateLimiter).reset();
  });

  // ——— Sentry osoby ———

  it('Sentry bez klucza → `off`; z kluczem na podstawionym fetch → problemy i zdarzenia', async () => {
    const off = (await get(`/admin/users/${ids.owner}/sentry`).expect(200))
      .body as SentryUserState;
    expect(off).toEqual({ status: 'off', missing: ['ADMIN_SENTRY_TOKEN'] });

    process.env.ADMIN_SENTRY_TOKEN = 'e2e-token';
    const urls: string[] = [];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: string | URL | Request) => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        );
        urls.push(url.href);
        if (url.pathname.endsWith('/projects/')) {
          return Promise.resolve(json([{ id: '1', slug: 'scoffie-ios' }]));
        }
        if (url.pathname.endsWith('/issues/')) {
          return Promise.resolve(json([]));
        }
        if (url.pathname.endsWith('/events/')) {
          return Promise.resolve(json({ data: [] }));
        }
        return Promise.reject(new Error(`nieoczekiwany ${url.href}`));
      });
    try {
      const state = (
        await get(`/admin/users/${ids.stranger}/sentry`).expect(200)
      ).body as SentryUserState;
      expect(state).toMatchObject({
        status: 'ok',
        data: { issues: [], events: [], eventsUnavailable: false },
      });
      expect(
        urls.some((u) =>
          u.includes(encodeURIComponent(`user.id:${ids.stranger}`)),
        ),
      ).toBe(true);
      // Pamięć 60 s: drugie wejście na kartę nie pyta Sentry.
      const before = fetchSpy.mock.calls.length;
      await get(`/admin/users/${ids.stranger}/sentry`).expect(200);
      expect(fetchSpy.mock.calls.length).toBe(before);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.ADMIN_SENTRY_TOKEN;
    }
    await get(
      '/admin/users/00000000-0000-4000-8000-000000000000/sentry',
    ).expect(404);
  });

  // ——— RODO ———

  it('rejestr RODO: pełny cykl z historią, bez adresu w dzienniku', async () => {
    const email = `wnioskodawca-${TAG}@b3.local`;
    const created = (
      await post('/admin/gdpr', {
        kind: 'ACCESS',
        channel: 'EMAIL',
        requesterEmail: `  ${email.toUpperCase()} `,
        userId: ids.stranger,
        notes: 'pisze z adresu konta',
      }).expect(201)
    ).body as GdprRequestDetail;
    gdprIds.push(created.id);
    expect(created).toMatchObject({
      kind: 'ACCESS',
      status: 'OPEN',
      requesterEmail: email,
      userId: ids.stranger,
      userName: `Obca ${TAG}`,
      extended: false,
    });
    expect(
      new Date(created.dueAt).getTime() -
        new Date(created.receivedAt).getTime(),
    ).toBe(30 * DAY);
    expect(created.history.map((h) => h.action)).toEqual(['gdpr.create']);

    const list = (await get('/admin/gdpr').expect(200)).body as GdprData;
    expect(list.items.map((i) => i.id)).toContain(created.id);
    expect(list.stats.open).toBeGreaterThanOrEqual(1);

    await post(`/admin/gdpr/${created.id}/status`, {
      status: 'IN_PROGRESS',
    }).expect(200);
    const extended = (
      await post(`/admin/gdpr/${created.id}/extend`, {
        reason: 'sprawa złożona — kilka kont',
      }).expect(200)
    ).body as GdprRequestDetail;
    expect(extended.extended).toBe(true);
    expect(extended.extensionReason).toBe('sprawa złożona — kilka kont');
    expect(
      new Date(extended.dueAt).getTime() -
        new Date(extended.receivedAt).getTime(),
    ).toBe(90 * DAY);
    await post(`/admin/gdpr/${created.id}/extend`, {
      reason: 'drugi raz nie wolno',
    }).expect(409);

    await post(`/admin/gdpr/${created.id}/close`, {
      status: 'DONE',
      resolution: 'x',
    }).expect(400);
    const closed = (
      await post(`/admin/gdpr/${created.id}/close`, {
        status: 'DONE',
        resolution: 'paczka wysłana szyfrowanym archiwum',
      }).expect(200)
    ).body as GdprRequestDetail;
    expect(closed).toMatchObject({
      status: 'DONE',
      resolution: 'paczka wysłana szyfrowanym archiwum',
    });
    expect(closed.closedAt).not.toBeNull();
    expect(closed.history.map((h) => h.action)).toEqual([
      'gdpr.create',
      'gdpr.status',
      'gdpr.extend',
      'gdpr.extend',
      'gdpr.close',
    ]);
    await post(`/admin/gdpr/${created.id}/close`, {
      status: 'REJECTED',
      resolution: 'drugie zamknięcie',
    }).expect(409);
    await post(`/admin/gdpr/${created.id}/status`, { status: 'OPEN' }).expect(
      409,
    );

    const audit = await prisma.adminAuditLog.findMany({
      where: { targetType: 'GdprRequest', targetId: created.id },
    });
    expect(JSON.stringify(audit)).not.toContain(email);
    expect(JSON.stringify(audit)).not.toContain('b3.local');

    const closedList = (await get('/admin/gdpr?state=closed').expect(200))
      .body as GdprData;
    expect(closedList.items.map((i) => i.id)).toContain(created.id);
    expect(closedList.stats.closed30d).toBeGreaterThanOrEqual(1);
  });

  it('walidacja: zły rodzaj, adres, konto, data z przyszłości', async () => {
    const base = { kind: 'ERASURE', channel: 'APP', requesterEmail: 'a@b.pl' };
    await post('/admin/gdpr', { ...base, kind: 'NOPE' }).expect(400);
    await post('/admin/gdpr', { ...base, requesterEmail: 'nie-adres' }).expect(
      400,
    );
    await post('/admin/gdpr', {
      ...base,
      userId: '00000000-0000-4000-8000-000000000000',
    }).expect(400);
    await post('/admin/gdpr', {
      ...base,
      receivedAt: new Date(Date.now() + 2 * DAY).toISOString(),
    }).expect(400);
    await get('/admin/gdpr/00000000-0000-4000-8000-000000000000').expect(404);
    await request(server()).get('/admin/gdpr').expect(404);
  });

  it('alert: < 7 dni do terminu → warning, po terminie → critical, zamknięcie → rozwiązany', async () => {
    const soon = (
      await post('/admin/gdpr', {
        kind: 'ERASURE',
        channel: 'EMAIL',
        requesterEmail: `soon-${TAG}@b3.local`,
        receivedAt: new Date(Date.now() - 26 * DAY).toISOString(),
      }).expect(201)
    ).body as GdprRequestDetail;
    const late = (
      await post('/admin/gdpr', {
        kind: 'ACCESS',
        channel: 'STORE',
        requesterEmail: `late-${TAG}@b3.local`,
        receivedAt: new Date(Date.now() - 32 * DAY).toISOString(),
      }).expect(201)
    ).body as GdprRequestDetail;
    gdprIds.push(soon.id, late.id);

    const data = (await get('/admin/gdpr').expect(200)).body as GdprData;
    expect(data.stats.dueSoon).toBeGreaterThanOrEqual(1);
    expect(data.stats.overdue).toBeGreaterThanOrEqual(1);
    // Po terminie nie da się już przedłużyć.
    await post(`/admin/gdpr/${late.id}/extend`, {
      reason: 'za późno na przedłużenie',
    }).expect(409);

    const watch = moduleRef.get(AdminWatchService);
    await watch.check();
    const alerts = await prisma.adminAlert.findMany({
      where: { key: { in: [`gdpr-due:${soon.id}`, `gdpr-due:${late.id}`] } },
    });
    const byKey = new Map(alerts.map((a) => [a.key, a]));
    expect(byKey.get(`gdpr-due:${soon.id}`)).toMatchObject({
      severity: 'warning',
      resolvedAt: null,
    });
    expect(byKey.get(`gdpr-due:${late.id}`)).toMatchObject({
      severity: 'critical',
      resolvedAt: null,
    });
    expect(JSON.stringify(alerts)).not.toContain('b3.local');

    await post(`/admin/gdpr/${late.id}/close`, {
      status: 'REJECTED',
      resolution: 'osoba nie potwierdziła tożsamości',
    }).expect(200);
    await watch.check(new Date(Date.now() + 1000));
    const after = await prisma.adminAlert.findUnique({
      where: { key: `gdpr-due:${late.id}` },
    });
    expect(after?.resolvedAt).not.toBeNull();
  });
});
