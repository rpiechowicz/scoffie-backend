import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type { RuntimeSettingsData } from '../src/admin/contract';
import {
  ADMIN_E2E_EMAIL,
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Sterowanie w locie (`/admin/settings`, ROADMAPA §5.12) i zapis odpowiedzi
 * na recenzje (`/admin/app-store/reviews/:id/response`) na żywej bazie.
 *
 * Najważniejsze: wyłącznik z panelu działa OD NASTĘPNEGO żądania do
 * `/agent` — bez restartu, bez czekania na odświeżenie co 30 s.
 */
describe('Panel — sterowanie (/admin/settings) i odpowiedzi na recenzje', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let admin: AdminE2ESession;
  let adminWithoutStepUp: AdminE2ESession;
  let userToken: string;
  let userId: string;

  const originals = { ...process.env };
  const server = () => app.getHttpServer();
  const put = (key: string, body: object, session = admin) =>
    request(server())
      .put(`/admin/settings/${key}`)
      .set('Cookie', session.cookie)
      .send(body);
  const del = (key: string, session = admin) =>
    request(server())
      .delete(`/admin/settings/${key}`)
      .set('Cookie', session.cookie)
      .send({ reason: 'powrót do Railwaya' });
  const settings = async () =>
    (
      await request(server())
        .get('/admin/settings')
        .set('Cookie', admin.cookie)
        .expect(200)
    ).body as RuntimeSettingsData;
  const agentList = () =>
    request(server())
      .get('/agent/conversations')
      .set({ Authorization: `Bearer ${userToken}` });

  beforeAll(async () => {
    for (const key of [
      'ADMIN_ASC_KEY_ID',
      'ADMIN_ASC_PRIVATE_KEY',
      'APPLE_ISSUER_ID',
      'OPS_ALERT_WEBHOOK_URL',
      'AI_ALLOWED_USERS',
    ]) {
      delete process.env[key];
    }
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_LIMIT_MESSAGES_PER_MONTH = '40';
    restoreGate = useAdminDevGate();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    await prisma.runtimeSetting.deleteMany({});
    admin = await createAdminSession(prisma, { stepUp: true });
    adminWithoutStepUp = await createAdminSession(prisma);

    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const login = await request(server())
      .post('/auth/dev')
      .send({ displayName: `Ster ${stamp}`, email: `ster-${stamp}@a3.local` })
      .expect(201);
    userToken = (login.body as { accessToken: string }).accessToken;
    userId = (login.body as { user: { id: string } }).user.id;
  });

  afterAll(async () => {
    await prisma.runtimeSetting.deleteMany({});
    await prisma.user.deleteMany({ where: { id: userId } });
    await cleanupAdmins(prisma);
    await app.close();
    restoreGate();
    process.env = originals;
  });

  it('bez sesji każda z nowych tras to 404 jak brak trasy', async () => {
    await request(server()).get('/admin/settings').expect(404);
    await request(server())
      .put('/admin/settings/AI_ENABLED')
      .send({ value: 'false', reason: 'powód testu' })
      .expect(404);
    await request(server())
      .post('/admin/app-store/reviews/abc/response')
      .send({ body: 'Dzięki' })
      .expect(404);
  });

  it('lista: biała lista kluczy, wartość z env i efektywna, bez nadpisań', async () => {
    const data = await settings();
    expect(data.settings.map((s) => s.key)).toEqual([
      'AI_ENABLED',
      'AI_MAX_TURN_COST_USD',
      'AI_GLOBAL_DAILY_BUDGET_USD',
      'AI_LIMIT_MESSAGES_PER_MONTH',
      'AI_LIMIT_PLANS_PER_MONTH',
      'AI_TRIAL_MESSAGES',
      'AI_TRIAL_PLANS',
      'AI_ALLOWED_USERS',
      'AI_CARDS_MODE',
      'THROTTLE_DEFAULT_LIMIT',
      'THROTTLE_IP_LIMIT',
      'THROTTLE_AUTH_LIMIT',
      'THROTTLE_AGENT_MESSAGE_LIMIT',
      'THROTTLE_AGENT_POLL_LIMIT',
    ]);
    expect(data.settings[0]).toMatchObject({
      kind: 'boolean',
      envValue: 'true',
      override: null,
      effective: 'true',
      updatedBy: null,
    });
    const messages = data.settings.find(
      (s) => s.key === 'AI_LIMIT_MESSAGES_PER_MONTH',
    )!;
    expect(messages).toMatchObject({ envValue: '40', effective: '40' });
  });

  it('wyłącznik: bez step-upu 403, po zapisie /agent od razu 503 AI_DISABLED, po DELETE wraca', async () => {
    await agentList().expect(200);

    const denied = await put(
      'AI_ENABLED',
      { value: 'false', reason: 'awaria dostawcy' },
      adminWithoutStepUp,
    ).expect(403);
    expect(denied.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await agentList().expect(200);

    await put('AI_ENABLED', {
      value: 'false',
      reason: 'awaria dostawcy',
    }).expect(204);
    const off = await agentList().expect(503);
    expect(off.body).toMatchObject({ code: 'AI_DISABLED' });

    const data = await settings();
    expect(data.settings[0]).toMatchObject({
      envValue: 'true',
      override: 'false',
      effective: 'false',
      updatedBy: ADMIN_E2E_EMAIL,
      reason: 'awaria dostawcy',
    });

    await del('AI_ENABLED', adminWithoutStepUp).expect(403);
    await del('AI_ENABLED').expect(204);
    await agentList().expect(200);
    await del('AI_ENABLED').expect(404);

    const audit = await prisma.adminAuditLog.findMany({
      where: { targetType: 'RuntimeSetting', targetId: 'AI_ENABLED' },
      orderBy: { createdAt: 'asc' },
      select: { action: true, result: true, reason: true, details: true },
    });
    expect(audit.map((a) => [a.action, a.result])).toEqual([
      ['settings.set', 'SUCCESS'],
      ['settings.clear', 'SUCCESS'],
      ['settings.clear', 'FAILED'],
    ]);
    expect(audit[0]).toMatchObject({
      reason: 'awaria dostawcy',
      details: { value: 'false', previous: null },
    });
  });

  it('limit z panelu działa bez restartu i znika po DELETE', async () => {
    await put('AI_LIMIT_MESSAGES_PER_MONTH', {
      value: ' 12 ',
      reason: 'test limitu',
    }).expect(204);
    let row = (await settings()).settings.find(
      (s) => s.key === 'AI_LIMIT_MESSAGES_PER_MONTH',
    )!;
    expect(row).toMatchObject({ override: '12', effective: '12' });
    await del('AI_LIMIT_MESSAGES_PER_MONTH').expect(204);
    row = (await settings()).settings.find(
      (s) => s.key === 'AI_LIMIT_MESSAGES_PER_MONTH',
    )!;
    expect(row).toMatchObject({ override: null, effective: '40' });
  });

  it('lista osób: audyt bez adresów, tylko liczba', async () => {
    await put('AI_ALLOWED_USERS', {
      value: 'Ala@Example.com, bob@example.com',
      reason: 'beta rodzinna',
    }).expect(204);
    const row = (await settings()).settings.find(
      (s) => s.key === 'AI_ALLOWED_USERS',
    )!;
    expect(row.effective).toBe('ala@example.com,bob@example.com');
    // Konto testu nie jest na liście — to samo 503, co wyłączony asystent,
    // ale tylko przy zakładaniu rozmowy (odczyt listy zostaje otwarty).
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { targetType: 'RuntimeSetting', targetId: 'AI_ALLOWED_USERS' },
      select: { details: true },
    });
    expect(JSON.stringify(audit.details)).not.toContain('@');
    await del('AI_ALLOWED_USERS').expect(204);
  });

  it('zła wartość 400, klucz spoza białej listy 404 (sekrety nigdy)', async () => {
    const bad = await put('AI_ENABLED', {
      value: 'tak',
      reason: 'zła wartość',
    }).expect(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    await put('AI_MAX_TURN_COST_USD', {
      value: '-1',
      reason: 'zła wartość',
    }).expect(400);
    await put('AI_ALLOWED_USERS', {
      value: 'nie-adres',
      reason: 'zła wartość',
    }).expect(400);
    await put('ANTHROPIC_API_KEY', {
      value: 'sk-x',
      reason: 'próba sekretu',
    }).expect(404);
    await put('AI_ENABLED', { value: 'false' }).expect(400);
    expect(await prisma.runtimeSetting.count()).toBe(0);
    await agentList().expect(200);
  });

  it('odpowiedź na recenzję: step-up, walidacja, bez klucza ASC czytelne 503', async () => {
    const respond = (body: object, session = admin) =>
      request(server())
        .post('/admin/app-store/reviews/00000029-abcd/response')
        .set('Cookie', session.cookie)
        .send(body);
    const denied = await respond(
      { body: 'Dzięki!' },
      adminWithoutStepUp,
    ).expect(403);
    expect(denied.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await respond({ body: '   ' }).expect(400);
    await respond({ body: 'x'.repeat(5971) }).expect(400);
    const off = await respond({ body: 'Dzięki!' }).expect(503);
    expect(off.body.message).toContain('ADMIN_ASC');
    await request(server())
      .post('/admin/app-store/reviews/zła%20id/response')
      .set('Cookie', admin.cookie)
      .send({ body: 'Dzięki!' })
      .expect(400);
    await request(server())
      .delete('/admin/app-store/reviews/00000029-abcd/response')
      .set('Cookie', admin.cookie)
      .expect(503);
  });
});
