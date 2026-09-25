import { randomBytes, randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdminWatchService } from '../src/admin/alerts/admin-watch.service';
import type {
  AlertsData,
  DailyReportPreview,
  DailyReportSendResult,
} from '../src/admin/contract';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Centrum alertów i raport dzienny (`/admin/alerts`, `/admin/reports/daily`)
 * na żywej bazie. Reguły Railway/Sentry/Resend mają testy jednostkowe na
 * podstawionych danych (`alert-rules.spec.ts`) — tu bez kluczy, więc
 * przebieg `AdminWatchService.check()` uruchamia wyłącznie reguły poczty.
 */
describe('Panel — alerty i raport dzienny', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let admin: AdminE2ESession;
  let adminWithoutStepUp: AdminE2ESession;

  const originals = { ...process.env };
  const TAG = `a2al-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const OPS = `ops-${TAG}@a2.local`;

  const server = () => app.getHttpServer();
  const get = (path: string, session: AdminE2ESession = admin) =>
    request(server()).get(path).set('Cookie', session.cookie);

  beforeAll(async () => {
    for (const key of [
      'ADMIN_SENTRY_TOKEN',
      'ADMIN_RAILWAY_TOKEN',
      'RESEND_API_KEY',
      'OPS_ALERT_WEBHOOK_URL',
      'ADMIN_DAILY_REPORT',
      'ADMIN_ALERTS',
      'ADMIN_REPORT_EMAILS',
    ]) {
      delete process.env[key];
    }
    process.env.MAIL_ENABLED = 'true';
    process.env.MAIL_TRANSPORT = 'stub';
    process.env.MAIL_STUB_DIR = join(tmpdir(), `scoffie-${TAG}`);
    process.env.ADMIN_ALERT_EMAILS = OPS;
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
    await prisma.adminAlert.deleteMany({ where: { key: { contains: TAG } } });
    await prisma.adminAlert.deleteMany({ where: { key: 'mail-failed' } });
    await prisma.mailMessage.deleteMany({
      where: {
        OR: [
          { dedupeKey: { contains: TAG } },
          { dedupeKey: { startsWith: 'ops-alert:' } },
          { dedupeKey: { startsWith: 'daily-report:' } },
        ],
      },
    });
    await cleanupAdmins(prisma);
    await app.close();
    restoreGate();
    process.env = originals;
  });

  it('bez sesji każda trasa to 404 jak brak trasy', async () => {
    await request(server()).get('/admin/alerts').expect(404);
    await request(server()).get('/admin/reports/daily/preview').expect(404);
    await request(server()).post('/admin/reports/daily/send').expect(404);
  });

  it('alert z bazy jest na liście otwartych, zamknięty w historii', async () => {
    const open = await prisma.adminAlert.create({
      data: {
        key: `deploy-failed:${TAG}:d1`,
        kind: 'deploy-failed',
        severity: 'critical',
        title: 'scoffie-backend: wdrożenie padło',
        detail: 'Ostatnie wdrożenie ma status FAILED.',
      },
    });
    const closed = await prisma.adminAlert.create({
      data: {
        key: `crash-free:${TAG}`,
        kind: 'crash-free',
        severity: 'warning',
        title: 'iOS: crash-free poniżej 99 %',
        detail: '98 %',
        resolvedAt: new Date(),
      },
    });

    const all = (await get('/admin/alerts').expect(200)).body as AlertsData;
    expect(all.open.map((a) => a.id)).toContain(open.id);
    expect(all.open.map((a) => a.id)).not.toContain(closed.id);
    expect(all.recent.map((a) => a.id)).toContain(closed.id);
    expect(all.open.find((a) => a.id === open.id)).toMatchObject({
      severity: 'critical',
      resolvedAt: null,
      acknowledgedAt: null,
    });
    expect(all.channels).toEqual({
      webhook: false,
      emails: [OPS],
      mail: true,
      enabled: true,
    });
    expect(all.report).toMatchObject({ enabled: false, emails: [OPS] });

    const onlyOpen = (await get('/admin/alerts?state=open').expect(200))
      .body as AlertsData;
    expect(onlyOpen.recent).toEqual([]);
    expect(onlyOpen.open.map((a) => a.id)).toContain(open.id);
    await get('/admin/alerts?state=nie').expect(400);
  });

  it('„Przyjąłem” zapisuje kto i kiedy, z wpisem w dzienniku audytu', async () => {
    const alert = await prisma.adminAlert.create({
      data: {
        key: `mail-domain:${TAG}`,
        kind: 'mail-domain',
        severity: 'critical',
        title: 'Domena niezweryfikowana',
        detail: 'x',
      },
    });
    const ack = () =>
      request(server())
        .post(`/admin/alerts/${alert.id}/ack`)
        .set('Cookie', adminWithoutStepUp.cookie);
    // Bez step-upu — przyjęcie niczego nie zmienia na produkcji.
    await ack().expect(204);
    await ack().expect(204);
    const row = await prisma.adminAlert.findUniqueOrThrow({
      where: { id: alert.id },
    });
    expect(row.acknowledgedAt).not.toBeNull();
    expect(row.acknowledgedBy).toBe('admin-e2e@scoffie.local');
    expect(row.resolvedAt).toBeNull();

    const audit = await prisma.adminAuditLog.findMany({
      where: { action: 'alert.ack', targetId: alert.id },
      select: { result: true },
    });
    expect(audit.map((a) => a.result)).toEqual(['SUCCESS', 'SUCCESS']);

    await request(server())
      .post(`/admin/alerts/${randomUUID()}/ack`)
      .set('Cookie', admin.cookie)
      .expect(404);
  });

  it('przebieg sprawdzeń: wykrywa, mail do operatora raz, rozwiązuje', async () => {
    const watch = moduleRef.get(AdminWatchService);
    const failed = await prisma.mailMessage.create({
      data: {
        dedupeKey: `${TAG}:failed`,
        template: 'WELCOME',
        to: `x-${TAG}@a2.local`,
        payload: {},
        status: 'FAILED',
        attempts: 5,
      },
    });

    await watch.check();
    const opened = await prisma.adminAlert.findUniqueOrThrow({
      where: { key: 'mail-failed' },
    });
    expect(opened).toMatchObject({ severity: 'warning', resolvedAt: null });
    const alertMails = () =>
      prisma.mailMessage.findMany({
        where: {
          template: 'OPS_ALERT',
          dedupeKey: { startsWith: 'ops-alert:mail-failed:' },
        },
        select: { to: true, userId: true },
      });
    expect(await alertMails()).toEqual([{ to: OPS, userId: null }]);

    // Drugi przebieg: ten sam problem — bez drugiego wiersza i maila.
    await watch.check();
    expect(
      await prisma.adminAlert.count({ where: { key: 'mail-failed' } }),
    ).toBe(1);
    expect(await alertMails()).toHaveLength(1);

    const data = (await get('/admin/alerts').expect(200)).body as AlertsData;
    expect(data.lastCheckAt).not.toBeNull();

    // Problem znika → alert zamknięty.
    await prisma.mailMessage.delete({ where: { id: failed.id } });
    await prisma.mailMessage.updateMany({
      where: { status: 'FAILED' },
      data: { status: 'SKIPPED' },
    });
    await watch.check();
    const resolved = await prisma.adminAlert.findUniqueOrThrow({
      where: { key: 'mail-failed' },
    });
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it('„Ponów” działa dla maila do operatora bez konta, ale nie dla cudzego', async () => {
    const make = (template: string, key: string) =>
      prisma.mailMessage.create({
        data: {
          dedupeKey: `${TAG}:${key}`,
          template,
          to: OPS,
          payload: {},
          status: 'FAILED',
          attempts: 5,
        },
        select: { id: true },
      });
    const ops = await make('OPS_ALERT', 'retry-ops');
    const orphan = await make('WELCOME', 'retry-orphan');
    const retry = (id: string) =>
      request(server())
        .post(`/admin/mails/${id}/retry`)
        .set('Cookie', admin.cookie);
    await retry(ops.id).expect(204);
    await retry(orphan.id).expect(409);
  });

  it('podgląd raportu: 200 z HTML-em, zła data 400', async () => {
    const preview = (await get('/admin/reports/daily/preview').expect(200))
      .body as DailyReportPreview;
    expect(preview.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(preview.subject).toContain('Scoffie wczoraj');
    expect(preview.html).toContain('<!DOCTYPE html>');
    expect(preview.html).toContain('Nowe konta');

    const dated = (
      await get('/admin/reports/daily/preview?date=2026-09-01').expect(200)
    ).body as DailyReportPreview;
    expect(dated.day).toBe('2026-09-01');
    await get('/admin/reports/daily/preview?date=wczoraj').expect(400);
    await get('/admin/reports/daily/preview?date=2999-01-01').expect(400);
  });

  it('wysyłka: bez step-upu 403, ze step-upem w kolejce i w audycie', async () => {
    const send = (session: AdminE2ESession) =>
      request(server())
        .post('/admin/reports/daily/send')
        .set('Cookie', session.cookie)
        .send({});
    const denied = await send(adminWithoutStepUp).expect(403);
    expect(denied.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const sent = (await send(admin).expect(201)).body as DailyReportSendResult;
    expect(sent).toMatchObject({ queued: 1, recipients: [OPS] });
    const row = await prisma.mailMessage.findFirstOrThrow({
      where: {
        template: 'DAILY_REPORT',
        dedupeKey: { startsWith: `daily-report:${sent.day}:manual-` },
      },
      select: { to: true, userId: true },
    });
    expect(row).toEqual({ to: OPS, userId: null });

    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: 'daily-report.send', targetId: sent.day },
      select: { result: true },
    });
    expect(audit.result).toBe('SUCCESS');
  });
});
