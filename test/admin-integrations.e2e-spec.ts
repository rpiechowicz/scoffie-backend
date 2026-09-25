import { randomBytes } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type { AppStoreState, MailData, OpsData } from '../src/admin/contract';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Panel: poczta, System i App Store (`/admin/mail`, `/admin/ops`,
 * `/admin/app-store`) na żywej bazie.
 *
 * Integracje z zewnętrznymi serwisami sprawdzamy tu tylko w stanie `off`
 * (bez kluczy) — rozmowę z dostawcami pokrywa `integrations.spec.ts` na
 * podstawionym `fetch`. Sieć w e2e oznaczałaby test zależny od cudzego API.
 */
describe('Panel — integracje (/admin/mail, /admin/ops, /admin/app-store)', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let admin: AdminE2ESession;
  let adminWithoutStepUp: AdminE2ESession;

  const originals = { ...process.env };
  const TAG = `a2int-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const address = (key: string) => `${key}-${TAG}@a2.local`;
  const mailIds: string[] = [];

  const server = () => app.getHttpServer();
  const get = (path: string, session: AdminE2ESession = admin) =>
    request(server()).get(path).set('Cookie', session.cookie);

  const createMail = async (
    key: string,
    data: { status: 'SENT' | 'FAILED'; scrubbed?: boolean; createdAt?: Date },
  ) => {
    const mail = await prisma.mailMessage.create({
      data: {
        dedupeKey: `${TAG}:${key}`,
        template: 'WELCOME',
        to: data.scrubbed ? '' : address(key),
        payload: {},
        status: data.status,
        attempts: data.status === 'FAILED' ? 5 : 1,
        lastError: data.status === 'FAILED' ? 'resend 422' : null,
        subject: data.scrubbed ? null : 'Witaj',
        sentAt: data.status === 'SENT' ? new Date() : null,
        scrubbedAt: data.scrubbed ? new Date() : null,
        ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      },
      select: { id: true },
    });
    mailIds.push(mail.id);
    return mail.id;
  };

  beforeAll(async () => {
    for (const key of [
      'ADMIN_SENTRY_TOKEN',
      'ADMIN_RAILWAY_TOKEN',
      'ADMIN_ASC_KEY_ID',
      'ADMIN_ASC_PRIVATE_KEY',
      'APPLE_ISSUER_ID',
      'RESEND_API_KEY',
    ]) {
      delete process.env[key];
    }
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
  });

  afterAll(async () => {
    await prisma.mailMessage.deleteMany({ where: { id: { in: mailIds } } });
    await prisma.mailSuppression.deleteMany({
      where: { email: { endsWith: `${TAG}@a2.local` } },
    });
    await cleanupAdmins(prisma);
    await app.close();
    restoreGate();
    process.env = originals;
  });

  it('bez sesji każda z nowych tras to 404 jak brak trasy', async () => {
    for (const path of ['/admin/mail', '/admin/ops', '/admin/app-store']) {
      await request(server()).get(path).expect(404);
    }
    await request(server())
      .post('/admin/mail/suppressions')
      .send({ email: address('x'), reason: 'powód testu' })
      .expect(404);
  });

  it('skrzynka: filtry, retencja bez adresu, flaga wykluczenia, liczniki 30 dni', async () => {
    const before = (await get('/admin/mail').expect(200)).body as MailData;
    const failed = await createMail('failed', { status: 'FAILED' });
    const scrubbed = await createMail('scrubbed', {
      status: 'SENT',
      scrubbed: true,
    });
    await createMail('old', {
      status: 'SENT',
      createdAt: new Date(Date.now() - 40 * 86_400_000),
    });
    await prisma.mailSuppression.create({
      data: { email: address('failed'), reason: 'HARD_BOUNCE' },
    });

    const all = (await get(`/admin/mail?q=${TAG}`).expect(200))
      .body as MailData;
    // Wiersz po retencji nie ma już adresu — wyszukiwanie go nie znajdzie.
    expect(all.messages.map((m) => m.id)).toContain(failed);
    expect(all.messages.map((m) => m.id)).not.toContain(scrubbed);
    expect(all.messages).toHaveLength(2);
    const failedRow = all.messages.find((m) => m.id === failed)!;
    expect(failedRow).toMatchObject({
      status: 'FAILED',
      to: address('failed'),
      suppressed: true,
      lastError: 'resend 422',
    });
    const latest = (await get('/admin/mail').expect(200)).body as MailData;
    expect(latest.messages.find((m) => m.id === scrubbed)).toMatchObject({
      to: null,
      subject: null,
      suppressed: false,
    });
    // 40-dniowy wiersz jest na liście, ale nie w licznikach okna.
    expect(all.last30.FAILED - before.last30.FAILED).toBe(1);
    expect(all.last30.SENT - before.last30.SENT).toBe(1);
    // Wysyłka dzień po dniu: 30 dni, dzisiejszy FAILED i SENT w ostatnim.
    expect(all.daily).toHaveLength(30);
    const today = all.daily[29];
    const todayBefore = before.daily[29];
    expect(today.failed - todayBefore.failed).toBe(1);
    expect(today.sent - todayBefore.sent).toBe(1);
    expect(all.from).toContain('@');
    expect(failedRow).toHaveProperty('providerMessageId', null);
    expect(failedRow).toHaveProperty('nextAttemptAt', null);

    const onlyFailed = (
      await get(`/admin/mail?q=${TAG}&status=FAILED`).expect(200)
    ).body as MailData;
    expect(onlyFailed.messages.map((m) => m.id)).toEqual([failed]);

    await get('/admin/mail?status=NIE').expect(400);
    await get('/admin/mail?template=NIE').expect(400);
  });

  it('wykluczenie: dodanie z audytem, duplikat 409, zdjęcie tylko ze step-upem', async () => {
    const email = address('Reczny');
    const add = () =>
      request(server())
        .post('/admin/mail/suppressions')
        .set('Cookie', admin.cookie)
        .send({ email, reason: 'prośba osoby' });
    await add().expect(204);
    await add().expect(409);

    const row = await prisma.mailSuppression.findUniqueOrThrow({
      where: { email: email.toLowerCase() },
    });
    expect(row).toMatchObject({ reason: 'MANUAL', detail: 'prośba osoby' });

    const remove = (session: AdminE2ESession) =>
      request(server())
        .delete(`/admin/mail/suppressions/${encodeURIComponent(email)}`)
        .set('Cookie', session.cookie)
        .send({ reason: 'adres naprawiony' });
    const denied = await remove(adminWithoutStepUp).expect(403);
    expect(denied.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await remove(admin).expect(204);
    await remove(admin).expect(404);

    const audit = await prisma.adminAuditLog.findMany({
      where: { targetType: 'MailSuppression', targetId: email.toLowerCase() },
      orderBy: { createdAt: 'asc' },
      select: { action: true, result: true, reason: true },
    });
    expect(audit.map((a) => [a.action, a.result])).toEqual(
      expect.arrayContaining([
        ['mail.suppression.add', 'SUCCESS'],
        ['mail.suppression.remove', 'SUCCESS'],
      ]),
    );

    await request(server())
      .post('/admin/mail/suppressions')
      .set('Cookie', admin.cookie)
      .send({ email: 'nie-adres', reason: 'powód testu' })
      .expect(400);
  });

  it('bez kluczy integracje są `off` z nazwami zmiennych, nie 500', async () => {
    const mail = (await get('/admin/mail').expect(200)).body as MailData;
    expect(mail.resend).toEqual({ status: 'off', missing: ['RESEND_API_KEY'] });

    const ops = (await get('/admin/ops').expect(200)).body as OpsData;
    expect(ops).toEqual({
      sentry: { status: 'off', missing: ['ADMIN_SENTRY_TOKEN'] },
      railway: { status: 'off', missing: ['ADMIN_RAILWAY_TOKEN'] },
    });

    const asc = (await get('/admin/app-store').expect(200))
      .body as AppStoreState;
    expect(asc).toEqual({
      status: 'off',
      missing: ['ADMIN_ASC_KEY_ID', 'ADMIN_ASC_PRIVATE_KEY', 'APPLE_ISSUER_ID'],
    });
  });

  it('szczegóły usługi i logi: bez tokenu `off` / 503, zły id i okres 400', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const svc = await get(`/admin/ops/services/${id}?range=7d`).expect(200);
    expect(svc.body).toEqual({
      status: 'off',
      missing: ['ADMIN_RAILWAY_TOKEN'],
    });
    await get(`/admin/ops/services/${id}/logs?kind=build`).expect(503);

    await get('/admin/ops/services/nie-uuid').expect(400);
    await get(`/admin/ops/services/${id}?range=2y`).expect(400);
    await get(`/admin/ops/services/${id}/logs?kind=inne`).expect(400);
    await get(`/admin/ops/services/${id}/logs?deployment=nie-uuid`).expect(400);
    await request(server()).get(`/admin/ops/services/${id}`).expect(404);
  });
});
