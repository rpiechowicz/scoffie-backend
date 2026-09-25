import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AuthProvider } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { GoogleIdentityService } from '../src/auth/google-identity.service';
import {
  makeFakeGoogle,
  TEST_GOOGLE_CLIENT_ID,
} from '../src/auth/google-id-token.spec-helper';
import { purchaseIdentityHash } from '../src/config/purchase-identity';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * `POST /auth/google` na żywej bazie. Token Google jest PRAWDZIWIE
 * weryfikowany przez `google-auth-library` — podstawiamy tylko certyfikaty
 * (własna para kluczy), więc bez sieci.
 */
const CLIENT_IDS_BEFORE = process.env.GOOGLE_OAUTH_CLIENT_IDS;
process.env.GOOGLE_OAUTH_CLIENT_IDS = TEST_GOOGLE_CLIENT_ID;
// Limit logowania to przedmiot `throttling.e2e-spec.ts`, nie tej suity.
const AUTH_LIMIT_BEFORE = process.env.THROTTLE_AUTH_LIMIT;
process.env.THROTTLE_AUTH_LIMIT = '10000';

describe('Logowanie przez Google (e2e, żywa baza)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const google = makeFakeGoogle();
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const createdEmails: string[] = [];
  const createdSubs: string[] = [];

  const newSub = () => {
    const sub = `9${stamp}${createdSubs.length}`;
    createdSubs.push(sub);
    return sub;
  };
  const newEmail = (label: string) => {
    const email = `google-${label}-${stamp}@audyt.local`;
    createdEmails.push(email);
    return email;
  };
  const loginGoogle = (idToken: string, extra: object = {}) =>
    request(app.getHttpServer())
      .post('/auth/google')
      .send({ idToken, platform: 'android', ...extra });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    app.get(GoogleIdentityService)._overrideCerts(google.certs);
  }, 60_000);

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: {
        OR: [
          { googleId: { in: createdSubs } },
          { email: { in: createdEmails } },
        ],
      },
    });
    await app.close();
    if (CLIENT_IDS_BEFORE === undefined) {
      delete process.env.GOOGLE_OAUTH_CLIENT_IDS;
    } else {
      process.env.GOOGLE_OAUTH_CLIENT_IDS = CLIENT_IDS_BEFORE;
    }
    if (AUTH_LIMIT_BEFORE === undefined) {
      delete process.env.THROTTLE_AUTH_LIMIT;
    } else {
      process.env.THROTTLE_AUTH_LIMIT = AUTH_LIMIT_BEFORE;
    }
  });

  it('nowe konto: koperta jak /auth/apple, provider GOOGLE, identityHash z GOOGLE:sub, sesja się odświeża', async () => {
    const sub = newSub();
    const email = newEmail('nowy');
    const res = await loginGoogle(
      google.sign({
        sub,
        email,
        email_verified: true,
        name: 'Ola Google',
        picture: 'https://lh3.googleusercontent.com/a/ola',
        nonce: 'nonce-abcdef12',
      }),
      { nonce: 'nonce-abcdef12' },
    ).expect(201);

    expect(Object.keys(res.body).sort()).toEqual([
      'accessToken',
      'household',
      'refreshToken',
      'user',
    ]);
    expect(res.body.user).toMatchObject({
      displayName: 'Ola Google',
      email,
      provider: 'GOOGLE',
      avatarUrl: 'https://lh3.googleusercontent.com/a/ola',
    });
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: res.body.user.id as string },
    });
    expect(row.googleId).toBe(sub);
    expect(row.emailVerified).toBe(true);
    expect(row.identityHash).toBe(purchaseIdentityHash('GOOGLE', sub));

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: res.body.refreshToken })
      .expect(201);

    // Drugie logowanie tym samym kontem Google = to samo konto.
    const again = await loginGoogle(google.sign({ sub, email })).expect(201);
    expect(again.body.user.id).toBe(res.body.user.id);
  });

  it('łączy z kontem Apple po potwierdzonym adresie i nie rusza provider/appleSub/identityHash', async () => {
    const email = newEmail('apple');
    const apple = await prisma.user.create({
      data: {
        appleSub: `apple-${randomUUID()}`,
        authProvider: AuthProvider.APPLE,
        email,
        emailVerified: true,
        displayName: 'Konto Apple',
        identityHash: 'hash-apple-e2e',
      },
    });
    const sub = newSub();

    const res = await loginGoogle(
      google.sign({ sub, email: email.toUpperCase(), email_verified: true }),
    ).expect(201);

    expect(res.body.user).toMatchObject({ id: apple.id, provider: 'APPLE' });
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: apple.id },
    });
    expect(row.googleId).toBe(sub);
    expect(row.appleSub).toBe(apple.appleSub);
    expect(row.authProvider).toBe(AuthProvider.APPLE);
    expect(row.identityHash).toBe('hash-apple-e2e');
    expect(row.email).toBe(email);
  });

  it('nie łączy z kontem o niepotwierdzonym adresie ani gdy Google adresu nie potwierdza', async () => {
    const email = newEmail('niepotw');
    const unverified = await prisma.user.create({
      data: {
        appleSub: `apple-${randomUUID()}`,
        authProvider: AuthProvider.APPLE,
        email,
        emailVerified: false,
        displayName: 'Niepotwierdzony',
      },
    });
    const first = await loginGoogle(
      google.sign({ sub: newSub(), email, email_verified: true }),
    ).expect(201);
    expect(first.body.user.id).not.toBe(unverified.id);
    expect(first.body.user.provider).toBe('GOOGLE');

    const email2 = newEmail('googleniepotw');
    const verifiedApple = await prisma.user.create({
      data: {
        appleSub: `apple-${randomUUID()}`,
        authProvider: AuthProvider.APPLE,
        email: email2,
        emailVerified: true,
        displayName: 'Potwierdzony',
      },
    });
    const second = await loginGoogle(
      google.sign({ sub: newSub(), email: email2, email_verified: false }),
    ).expect(201);
    expect(second.body.user.id).not.toBe(verifiedApple.id);
    const untouched = await prisma.user.findUniqueOrThrow({
      where: { id: verifiedApple.id },
    });
    expect(untouched.googleId).toBeNull();
  });

  it('dwa równoległe pierwsze logowania tym samym kontem → jedno konto', async () => {
    const sub = newSub();
    const token = google.sign({ sub, email: newEmail('wyscig') });
    const [a, b] = await Promise.all([loginGoogle(token), loginGoogle(token)]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.user.id).toBe(b.body.user.id);
    expect(await prisma.user.count({ where: { googleId: sub } })).toBe(1);
  });

  it('zły aud, zły nonce, obcy podpis → 401 APPLE_IDENTITY_INVALID z requestId', async () => {
    const bad = [
      loginGoogle(
        google.sign({ sub: newSub(), aud: 'obcy.apps.googleusercontent.com' }),
      ),
      loginGoogle(google.sign({ sub: newSub(), nonce: 'nonce-dobry-1' }), {
        nonce: 'nonce-zly-000',
      }),
      loginGoogle(makeFakeGoogle().sign({ sub: newSub() })),
    ];
    for (const res of await Promise.all(bad)) {
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'APPLE_IDENTITY_INVALID' });
      expect(typeof res.body.requestId).toBe('string');
    }
  });

  it('bez GOOGLE_OAUTH_CLIENT_IDS → 503 SERVICE_UNAVAILABLE, Apple i reszta żyją', async () => {
    const saved = process.env.GOOGLE_OAUTH_CLIENT_IDS;
    delete process.env.GOOGLE_OAUTH_CLIENT_IDS;
    try {
      const res = await loginGoogle(google.sign({ sub: newSub() }));
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      await request(app.getHttpServer()).get('/ops/health').expect(200);
    } finally {
      process.env.GOOGLE_OAUTH_CLIENT_IDS = saved;
    }
  });
});
