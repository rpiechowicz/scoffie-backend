import { randomBytes } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type { AuditPage } from '../src/admin/contract';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/** Panel: dziennik audytu (`GET /admin/audit`) na żywej bazie. */
describe('Panel — dziennik audytu (/admin/audit)', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let admin: AdminE2ESession;

  const TAG = `a1aud-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const email = `reczny-${TAG}@a1.local`;

  const server = () => app.getHttpServer();
  const get = (path: string) =>
    request(server()).get(path).set('Cookie', admin.cookie);

  beforeAll(async () => {
    restoreGate = useAdminDevGate();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    admin = await createAdminSession(prisma, { stepUp: true });
  });

  afterAll(async () => {
    await prisma.mailSuppression.deleteMany({ where: { email } });
    await cleanupAdmins(prisma);
    await app.close();
    restoreGate();
  });

  it('bez sesji 404 jak brak trasy', async () => {
    await request(server()).get('/admin/audit').expect(404);
  });

  it('akcja panelu (wykluczenie poczty) → wpis w dzienniku, filtry, kursor', async () => {
    await request(server())
      .post('/admin/mail/suppressions')
      .set('Cookie', admin.cookie)
      .send({ email, reason: 'prośba osoby' })
      .expect(204);

    const all = (await get('/admin/audit').expect(200)).body as AuditPage;
    expect(all.actions).toContain('mail.suppression.add');
    const entry = all.entries.find((e) => e.targetId === email);
    expect(entry).toMatchObject({
      action: 'mail.suppression.add',
      targetType: 'MailSuppression',
      reason: 'prośba osoby',
      result: 'SUCCESS',
      adminEmail: 'admin-e2e@scoffie.local',
      errorCode: null,
    });
    expect(Date.parse(entry!.at)).not.toBeNaN();

    const filtered = (
      await get(
        '/admin/audit?action=mail.suppression.add&result=SUCCESS',
      ).expect(200)
    ).body as AuditPage;
    expect(filtered.entries.map((e) => e.id)).toContain(entry!.id);
    expect(
      filtered.entries.every((e) => e.action === 'mail.suppression.add'),
    ).toBe(true);
    const failed = (await get('/admin/audit?result=FAILED').expect(200))
      .body as AuditPage;
    expect(failed.entries.map((e) => e.id)).not.toContain(entry!.id);

    // Strony po jednym wpisie: kursor prowadzi dalej bez powtórek.
    const extra = await prisma.adminAuditLog.create({
      data: {
        adminUserId: admin.adminUserId,
        adminEmail: 'admin-e2e@scoffie.local',
        action: 'mail.suppression.add',
        targetType: 'MailSuppression',
        targetId: `drugi-${TAG}@a1.local`,
        result: 'FAILED',
        errorCode: 'CONFLICT',
        createdAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });
    const first = (
      await get('/admin/audit?action=mail.suppression.add&limit=1').expect(200)
    ).body as AuditPage;
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (
      await get(
        `/admin/audit?action=mail.suppression.add&limit=1&before=${first.nextCursor}`,
      ).expect(200)
    ).body as AuditPage;
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].id).not.toBe(first.entries[0].id);
    expect([first.entries[0].id, second.entries[0].id]).toEqual([
      entry!.id,
      extra.id,
    ]);
  });

  it('zły kursor, limit poza zakresem, obcy wynik → 400', async () => {
    await get('/admin/audit?before=smieci').expect(400);
    await get('/admin/audit?limit=0').expect(400);
    await get('/admin/audit?limit=201').expect(400);
    await get('/admin/audit?result=OK').expect(400);
  });
});
