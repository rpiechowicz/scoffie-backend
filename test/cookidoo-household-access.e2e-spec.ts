import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { CookidooServiceClient } from '../src/integrations/cookidoo-service.client';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * AUDYT 5.09.2026, 2.2.4 — poświadczenia Cookidoo domu (e2e, żywa baza).
 *
 * Połączenie z Cookidoo jest jedno na dom, ale hasło jest czyjeś. Dotąd każdy
 * domownik mógł je nadpisać swoim kontem albo skasować, a `status` pokazywał
 * wszystkim e-mail cudzego konta. Teraz: pierwsze podłączenie — każdy;
 * nadpisanie i rozłączenie — autor połączenia albo właściciel domu; e-mail
 * w całości tylko dla nich, reszta widzi maskę.
 *
 * Mikroserwis Cookidoo podmieniony: walidacja hasła u Vorwerka nie jest
 * przedmiotem tej suity, a licznik wywołań pokazuje, że odmowa zapada PRZED
 * wysłaniem hasła.
 */
type Session = { accessToken: string; user: { id: string } };

describe('Poświadczenia Cookidoo domu — kto zarządza (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const env = { ...process.env };
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const validated: string[] = [];
  /** Wstrzyknięcie w środek walidacji u Vorwerka (sekundy na prod). */
  let duringValidation: (() => Promise<unknown>) | null = null;

  const devLogin = async (label: string): Promise<Session> => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@cookidoo.local`,
      })
      .expect(201);
    const session = res.body as Session & { household: { id: string } | null };
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    return session;
  };

  const http = () => request(app.getHttpServer());
  const auth = (s: Session) => ({ Authorization: `Bearer ${s.accessToken}` });
  const connect = (s: Session, email: string) =>
    http()
      .post('/integrations/cookidoo/connect')
      .set(auth(s))
      .send({ email, password: 'tajne-haslo' });
  const status = (s: Session) =>
    http().get('/integrations/cookidoo/status').set(auth(s));
  const disconnect = (s: Session) =>
    http().delete('/integrations/cookidoo').set(auth(s));

  let owner: Session;
  let autor: Session;
  let domownik: Session;
  let drugiWlasciciel: Session;
  let householdId: string;

  const stored = () =>
    prisma.cookidooIntegration.findUnique({
      where: { householdId },
      select: { connectedById: true },
    });

  beforeAll(async () => {
    process.env.THROTTLE_AUTH_LIMIT = '10000';
    // Uwaga: `connect` ma stały limit 5 na 10 minut NA OSOBĘ
    // (`COOKIDOO_CONNECT_LIMIT`, tracker `user:<id>`) — żadna osoba w suicie
    // nie robi więcej niż trzech prób.
    delete process.env.COOKIDOO_INTEGRATION_ENABLED;
    process.env.COOKIDOO_ENCRYPTION_KEY ??=
      'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CookidooServiceClient)
      .useValue({
        validateCredentials: async (email: string) => {
          validated.push(email);
          const hook = duringValidation;
          duringValidation = null;
          if (hook) await hook();
          return { subscription: null };
        },
        addToWeek: () => Promise.resolve({}),
      })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    owner = await devLogin('Wlasciciel');
    autor = await devLogin('Autor');
    domownik = await devLogin('Domownik');
    drugiWlasciciel = await devLogin('DrugiWlasciciel');
    // Dom zakładany wprost: ma to być NAJSTARSZE członkostwo każdego z nich
    // (tak serwis wybiera dom), więc dev-login nie może mieć własnego domu.
    for (const s of [owner, autor, domownik, drugiWlasciciel]) {
      await prisma.membership.deleteMany({ where: { userId: s.user.id } });
    }
    const household = await prisma.household.create({
      data: { name: `Dom Cookidoo ${Date.now()}`, createdById: owner.user.id },
      select: { id: true },
    });
    householdId = household.id;
    createdHouseholdIds.push(householdId);
    await prisma.membership.createMany({
      data: [
        { userId: owner.user.id, householdId, role: 'OWNER' },
        { userId: autor.user.id, householdId, role: 'MEMBER' },
        { userId: domownik.user.id, householdId, role: 'MEMBER' },
        { userId: drugiWlasciciel.user.id, householdId, role: 'OWNER' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.cookidooIntegration.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) delete process.env[key];
    }
    Object.assign(process.env, env);
  });

  it('pierwsze podłączenie domu: zwykły domownik, jak dotąd', async () => {
    const res = await connect(autor, 'autor.konta@example.com').expect(201);
    expect(res.body).toMatchObject({ connected: true, canManage: true });
    expect((await stored())?.connectedById).toBe(autor.user.id);
  });

  it('status: autor widzi pełny e-mail, inny domownik maskę', async () => {
    const own = await status(autor).expect(200);
    expect(own.body).toMatchObject({
      login: 'autor.konta@example.com',
      canManage: true,
    });
    const other = await status(domownik).expect(200);
    expect(other.body).toMatchObject({
      connected: true,
      login: 'a•••@e•••.com',
      connectedById: autor.user.id,
      canManage: false,
    });
    expect(JSON.stringify(other.body)).not.toContain('autor.konta');
  });

  it('status: właściciel domu widzi pełny e-mail', async () => {
    const res = await status(owner).expect(200);
    expect(res.body).toMatchObject({
      login: 'autor.konta@example.com',
      canManage: true,
    });
  });

  it('inny domownik NIE nadpisuje połączenia — 403 przed wysłaniem hasła', async () => {
    const before = validated.length;
    const res = await connect(domownik, 'domownik@example.com').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(validated.length).toBe(before);
    expect((await stored())?.connectedById).toBe(autor.user.id);
  });

  it('inny domownik NIE rozłącza — 403, poświadczenia zostają', async () => {
    const res = await disconnect(domownik).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(await stored()).not.toBeNull();
  });

  it('autor nadpisuje własne połączenie', async () => {
    await connect(autor, 'autor.nowe@example.com').expect(201);
    expect((await stored())?.connectedById).toBe(autor.user.id);
    const res = await status(owner).expect(200);
    expect(res.body.login).toBe('autor.nowe@example.com');
  });

  it('właściciel rozłącza cudze połączenie', async () => {
    await disconnect(owner).expect(200);
    expect(await stored()).toBeNull();
    // Dziennik zgód: REVOKED dla AUTORA hasła, nie dla rozłączającego.
    const latest = (userId: string) =>
      prisma.consentEvent.findFirst({
        where: { userId, kind: 'COOKIDOO' },
        orderBy: { createdAt: 'desc' },
        select: { action: true, source: true },
      });
    expect(await latest(autor.user.id)).toEqual({
      action: 'REVOKED',
      source: 'COOKIDOO_DISCONNECT',
    });
    expect(await latest(owner.user.id)).toBeNull();
  });

  it('po rozłączeniu dom znów może podłączyć każdy; właściciel nadpisuje', async () => {
    await disconnect(domownik).expect(200);
    await connect(domownik, 'domownik@example.com').expect(201);
    expect((await stored())?.connectedById).toBe(domownik.user.id);
    await connect(owner, 'wlasciciel@example.com').expect(201);
    expect((await stored())?.connectedById).toBe(owner.user.id);
    // Domownik, który podłączył wcześniej, nie jest już autorem.
    await disconnect(domownik).expect(403);
  });

  // ─── review 7.10.2026: rola zmienia się w trakcie walidacji u Vorwerka ───
  // Rola czytana przed `validateCredentials` mogła być nieaktualna, gdy
  // przychodził zapis. Teraz zapis czyta członkostwo od nowa, pod blokadą.

  it('właściciel zdegradowany W TRAKCIE walidacji nie nadpisuje cudzego połączenia', async () => {
    duringValidation = () =>
      prisma.membership.update({
        where: {
          userId_householdId: { userId: drugiWlasciciel.user.id, householdId },
        },
        data: { role: 'MEMBER' },
      });
    const res = await connect(drugiWlasciciel, 'drugi@example.com').expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect((await stored())?.connectedById).toBe(owner.user.id);
  });

  it('usunięty z domu W TRAKCIE walidacji niczego nie zapisuje', async () => {
    await disconnect(owner).expect(200);
    duringValidation = () =>
      prisma.membership.delete({
        where: {
          userId_householdId: { userId: domownik.user.id, householdId },
        },
      });
    await connect(domownik, 'usuniety@example.com').expect(403);
    expect(await stored()).toBeNull();
  });
});
