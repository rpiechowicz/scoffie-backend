import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { totpCode, totpStep } from '../src/admin/auth/totp';
import {
  ADMIN_E2E_EMAIL,
  createAdminSession,
  useAdminDevGate,
} from './admin-e2e.helper';
import { SoftwareAuthenticator } from './software-authenticator';

/**
 * Logowanie do panelu administratora na żywej bazie (ROADMAPA §4,
 * API-AUTH.md). Passkeye przechodzą przez PRAWDZIWY `@simplewebauthn/server`
 * — podpisuje je programowy uwierzytelniacz P-256, więc test sprawdza
 * wyzwanie, pochodzenie, RP ID, weryfikację użytkownika i podpis.
 *
 * Kolejność testów jest częścią scenariusza: pierwsze konto (bootstrap) →
 * passkey → TOTP i kody odzyskiwania → step-up → sesje → blokada.
 */
describe('Panel admina — logowanie (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV = {
    ADMIN_BOOTSTRAP_EMAIL: ADMIN_E2E_EMAIL,
    ADMIN_WEBAUTHN_RP_ID: 'localhost',
    ADMIN_WEBAUTHN_ORIGIN: 'http://localhost:5173',
  };
  const authenticator = new SoftwareAuthenticator(
    'localhost',
    'http://localhost:5173',
  );

  let bootstrapCookie = '';
  let passkeyId = '';
  let totpSecret = '';
  let recoveryCodes: string[] = [];

  const api = () => request(app.getHttpServer());
  const sessionCookie = (res: request.Response): string => {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = (raw ?? []).find((line) =>
      line.startsWith('__Host-scoffie_admin='),
    );
    if (!cookie) throw new Error('brak ciasteczka sesji panelu');
    return cookie.split(';')[0];
  };
  const wipeAdmins = async () => {
    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminLoginAttempt.deleteMany({});
    await prisma.adminWebAuthnChallenge.deleteMany({});
    await prisma.adminUser.deleteMany({});
  };
  /** Nowy krok TOTP „za pół minuty” — bez czekania na zegar. */
  const forgetTotpStep = () =>
    prisma.adminTotp.updateMany({ data: { lastUsedStep: null } });
  const currentCode = () => totpCode(totpSecret, totpStep(Date.now()));

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    if (!(process.env.ADMIN_TOTP_ENCRYPTION_KEY ?? '').trim()) {
      process.env.ADMIN_TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
        'base64',
      );
    }
    restoreGate = useAdminDevGate(ADMIN_E2E_EMAIL);
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    await wipeAdmins();
  });

  afterAll(async () => {
    await wipeAdmins();
    restoreGate();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
  });

  it('bez bramki Access każda trasa panelu to 404 nie do odróżnienia od braku trasy', async () => {
    const saved = process.env.ADMIN_ACCESS_DEV_EMAIL;
    delete process.env.ADMIN_ACCESS_DEV_EMAIL;
    try {
      const hidden = await api().get('/admin/auth/state').expect(404);
      const missing = await api().get('/admin/nie-ma-takiej-trasy').expect(404);
      expect(hidden.body.code).toBe(missing.body.code);
      expect(hidden.body.message).toBe('Cannot GET /admin/auth/state');
      expect(hidden.headers['x-robots-tag']).toBeUndefined();
    } finally {
      process.env.ADMIN_ACCESS_DEV_EMAIL = saved;
    }
  });

  it('pierwsze konto: passkey adresu z ADMIN_BOOTSTRAP_EMAIL otwiera sesję', async () => {
    const state = await api().get('/admin/auth/state').expect(200);
    expect(state.body).toMatchObject({
      email: ADMIN_E2E_EMAIL,
      bootstrap: true,
      methods: [],
      lockedUntil: null,
    });
    expect(state.headers['x-robots-tag']).toBe('noindex, nofollow');

    const options = await api()
      .post('/admin/auth/passkey/register/options')
      .send({ name: 'Mac' })
      .expect(201);
    expect(options.body.authenticatorSelection.userVerification).toBe(
      'required',
    );
    const res = await api()
      .post('/admin/auth/passkey/register')
      .send({ name: 'Mac', response: authenticator.register(options.body) })
      .expect(201);
    expect(res.body).toMatchObject({ name: 'Mac', lastUsedAt: null });
    passkeyId = res.body.id;
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    bootstrapCookie = sessionCookie(res);

    const me = await api()
      .get('/admin/session')
      .set('Cookie', bootstrapCookie)
      .expect(200);
    expect(me.body).toMatchObject({
      email: ADMIN_E2E_EMAIL,
      method: 'passkey',
      mustReenroll: false,
      setup: { passkeys: 1, totp: false, recoveryCodesLeft: 0 },
    });
    expect(me.body.stepUpUntil).not.toBeNull();

    const after = await api().get('/admin/auth/state').expect(200);
    expect(after.body).toMatchObject({
      bootstrap: false,
      methods: ['passkey'],
    });
  });

  it('drugi bootstrap jest niemożliwy, a ostatniego klucza nie da się usunąć', async () => {
    const again = await api()
      .post('/admin/auth/passkey/register/options')
      .send({})
      .expect(403);
    expect(again.body.code).toBe('NOT_ALLOWED');

    const last = await api()
      .delete(`/admin/auth/passkeys/${passkeyId}`)
      .set('Cookie', bootstrapCookie)
      .expect(409);
    expect(last.body.code).toBe('LAST_METHOD');
  });

  it('logowanie passkeyem: podrobiony podpis i powtórka odpadają', async () => {
    const first = await api()
      .post('/admin/auth/passkey/login/options')
      .send({})
      .expect(201);
    const forged = await api()
      .post('/admin/auth/passkey/login')
      .send({
        response: authenticator.authenticate(first.body, { tamper: true }),
      })
      .expect(401);
    expect(forged.body.code).toBe('PASSKEY_FAILED');

    const second = await api()
      .post('/admin/auth/passkey/login/options')
      .send({})
      .expect(201);
    const response = authenticator.authenticate(second.body);
    const ok = await api()
      .post('/admin/auth/passkey/login')
      .send({ response })
      .expect(201);
    expect(ok.body).toMatchObject({ method: 'passkey', mustReenroll: false });
    expect(sessionCookie(ok)).toMatch(/^__Host-scoffie_admin=/);

    const replay = await api()
      .post('/admin/auth/passkey/login')
      .send({ response })
      .expect(401);
    expect(replay.body.code).toBe('PASSKEY_FAILED');
  });

  it('TOTP: konfiguracja pierwszym kodem daje kody odzyskiwania, kod działa raz', async () => {
    const setup = await api()
      .post('/admin/auth/totp/setup')
      .set('Cookie', bootstrapCookie)
      .send({})
      .expect(201);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    totpSecret = setup.body.secret;

    const wrong = await api()
      .post('/admin/auth/totp/confirm')
      .set('Cookie', bootstrapCookie)
      .send({ code: '000000' === currentCode() ? '111111' : '000000' })
      .expect(401);
    expect(wrong.body.code).toBe('INVALID_CODE');

    const confirm = await api()
      .post('/admin/auth/totp/confirm')
      .set('Cookie', bootstrapCookie)
      .send({ code: currentCode() })
      .expect(201);
    recoveryCodes = confirm.body.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    const state = await api().get('/admin/auth/state').expect(200);
    expect(state.body.methods).toEqual(['passkey', 'totp', 'recovery']);

    await forgetTotpStep();
    const code = currentCode();
    const login = await api()
      .post('/admin/auth/totp/login')
      .send({ code })
      .expect(201);
    expect(login.body.method).toBe('totp');
    const replay = await api()
      .post('/admin/auth/totp/login')
      .send({ code })
      .expect(401);
    expect(replay.body.code).toBe('INVALID_CODE');
  });

  it('kod odzyskiwania: jednorazowy, a sesja widzi tylko konfigurację wejścia', async () => {
    const login = await api()
      .post('/admin/auth/recovery/login')
      .send({ code: recoveryCodes[0].toLowerCase() })
      .expect(201);
    expect(login.body).toMatchObject({
      method: 'recovery',
      mustReenroll: true,
    });
    expect(login.body.stepUpUntil).toBeNull();
    const cookie = sessionCookie(login);

    const blocked = await api()
      .get('/admin/auth/sessions')
      .set('Cookie', cookie)
      .expect(403);
    expect(blocked.body.code).toBe('NOT_ALLOWED');
    await api().get('/admin/session').set('Cookie', cookie).expect(200);
    await api().get('/admin/auth/passkeys').set('Cookie', cookie).expect(200);

    const again = await api()
      .post('/admin/auth/recovery/login')
      .send({ code: recoveryCodes[0] })
      .expect(401);
    expect(again.body.code).toBe('INVALID_CODE');
  });

  it('step-up: groźna akcja wymaga świeżego potwierdzenia, passkey je daje', async () => {
    const stale = await createAdminSession(prisma, { stepUp: false });
    const denied = await api()
      .post('/admin/auth/recovery/regenerate')
      .set('Cookie', stale.cookie)
      .send({})
      .expect(403);
    expect(denied.body.code).toBe('STEP_UP_REQUIRED');

    const options = await api()
      .post('/admin/auth/step-up/options')
      .set('Cookie', stale.cookie)
      .send({})
      .expect(201);
    const stepped = await api()
      .post('/admin/auth/step-up')
      .set('Cookie', stale.cookie)
      .send({ passkey: authenticator.authenticate(options.body) })
      .expect(201);
    expect(new Date(stepped.body.stepUpUntil).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const fresh = await api()
      .post('/admin/auth/recovery/regenerate')
      .set('Cookie', stale.cookie)
      .send({})
      .expect(201);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    // Stary komplet przestał działać.
    await api()
      .post('/admin/auth/recovery/login')
      .send({ code: recoveryCodes[1] })
      .expect(401);
    recoveryCodes = fresh.body.recoveryCodes;

    // Step-up kodem TOTP też działa.
    await forgetTotpStep();
    await api()
      .post('/admin/auth/step-up')
      .set('Cookie', stale.cookie)
      .send({ totp: currentCode() })
      .expect(201);
  });

  it('sesje: lista, unieważnienie innej sesji, wylogowanie kasuje ciasteczko', async () => {
    const other = await createAdminSession(prisma);
    const list = await api()
      .get('/admin/auth/sessions')
      .set('Cookie', bootstrapCookie)
      .expect(200);
    const ids = (list.body as { id: string; current: boolean }[]).map(
      (s) => s.id,
    );
    expect(ids).toContain(other.sessionId);
    expect(
      (list.body as { current: boolean }[]).filter((s) => s.current),
    ).toHaveLength(1);

    await api()
      .delete(`/admin/auth/sessions/${other.sessionId}`)
      .set('Cookie', bootstrapCookie)
      .expect(204);
    await api().get('/admin/session').set('Cookie', other.cookie).expect(404);

    const out = await api()
      .delete('/admin/session')
      .set('Cookie', bootstrapCookie)
      .expect(204);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(
      /Max-Age=0/,
    );
    await api()
      .get('/admin/session')
      .set('Cookie', bootstrapCookie)
      .expect(404);
    // Wylogowanie bez sesji też jest 204 — nie może się „nie udać”.
    await api().delete('/admin/session').expect(204);
  });

  it('klucz można usunąć, gdy zostaje TOTP; zdarzenia są w dzienniku audytu', async () => {
    const session = await createAdminSession(prisma, { stepUp: true });
    await api()
      .delete(`/admin/auth/passkeys/${passkeyId}`)
      .set('Cookie', session.cookie)
      .expect(204);
    const state = await api().get('/admin/auth/state').expect(200);
    expect(state.body.methods).toEqual(['totp', 'recovery']);

    const actions = await prisma.adminAuditLog.findMany({
      where: { result: 'SUCCESS' },
      select: { action: true },
    });
    const names = new Set(actions.map((row) => row.action));
    for (const action of [
      'auth.bootstrap',
      'auth.login',
      'auth.totp.enable',
      'auth.step-up',
      'auth.recovery.regenerate',
      'auth.session.revoke',
      'auth.logout',
      'auth.passkey.delete',
    ]) {
      expect(names).toContain(action);
    }
    const pending = await prisma.adminAuditLog.count({
      where: { result: 'PENDING' },
    });
    expect(pending).toBe(0);
  });

  it('blokada: po 5 złych kodach szósta próba to 429 LOCKED z terminem', async () => {
    await prisma.adminLoginAttempt.deleteMany({});
    const bad = currentCode() === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) {
      const res = await api()
        .post('/admin/auth/totp/login')
        .send({ code: bad })
        .expect(401);
      expect(res.body.code).toBe('INVALID_CODE');
    }
    const locked = await api()
      .post('/admin/auth/totp/login')
      .send({ code: bad })
      .expect(429);
    expect(locked.body.code).toBe('LOCKED');
    expect(new Date(locked.body.lockedUntil).getTime()).toBeGreaterThan(
      Date.now(),
    );
    // Nawet dobry kod nie przejdzie w czasie blokady.
    await forgetTotpStep();
    await api()
      .post('/admin/auth/totp/login')
      .send({ code: currentCode() })
      .expect(429);
    const state = await api().get('/admin/auth/state').expect(200);
    expect(state.body.lockedUntil).not.toBeNull();
  });
});
