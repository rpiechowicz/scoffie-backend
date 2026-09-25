import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import type { FunnelStepKey, GrowthData } from '../src/admin/contract';
import { activityDayKey } from '../src/auth/user-activity.service';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Ekran „Wzrost” (ROADMAPA §5.8) na żywej bazie: zapis aktywności dziennej
 * przy uwierzytelnionym żądaniu (raz na dobę), lejek z zasianymi osobami
 * (asercje na PRZYROSTACH — cudze dane w bazie ich nie psują), DAU i kohorty,
 * kasowanie konta zabiera aktywność.
 */
describe('Panel administratora — wzrost (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let users: UsersService;
  let restoreEnv: () => void;
  let session: AdminE2ESession;

  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const userIds: string[] = [];
  const householdIds: string[] = [];
  const subscriptionIds: string[] = [];

  const server = () => app.getHttpServer();
  const growth = async (period = '7') =>
    (
      await request(server())
        .get(`/admin/growth?period=${period}`)
        .set('Cookie', session.cookie)
        .expect(200)
    ).body as GrowthData;
  const usersAt = (data: GrowthData) =>
    Object.fromEntries(data.funnel.map((s) => [s.key, s.users])) as Record<
      FunnelStepKey,
      number
    >;

  const createUser = async (
    label: string,
    extra: { onboardingCompletedAt?: Date; identityHash?: string } = {},
  ) => {
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@growth.local`,
        authProvider: 'DEV',
        ...extra,
      },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const createHousehold = async (ownerId: string) => {
    const household = await prisma.household.create({
      data: {
        name: `Dom ${stamp}`,
        createdById: ownerId,
        memberships: { create: [{ userId: ownerId, role: 'OWNER' }] },
      },
      select: { id: true },
    });
    householdIds.push(household.id);
    return household.id;
  };

  const activityRows = (userId: string) =>
    prisma.userActivityDay.findMany({ where: { userId } });

  /** Zapis aktywności idzie poza ścieżką odpowiedzi — czekamy na niego. */
  const waitForActivity = async (userId: string) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = await activityRows(userId);
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return activityRows(userId);
  };

  beforeAll(async () => {
    restoreEnv = useAdminDevGate();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    users = app.get(UsersService);
    session = await createAdminSession(prisma);
  });

  afterAll(async () => {
    await prisma.subscription.deleteMany({
      where: { id: { in: subscriptionIds } },
    });
    await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await cleanupAdmins(prisma);
    restoreEnv();
    await app.close();
  });

  it('uwierzytelnione żądanie zapisuje aktywność raz na osobę i dobę (Warszawa)', async () => {
    const userId = await createUser('Aktywna');
    const token = jwt.sign({ sub: userId });

    for (let i = 0; i < 3; i += 1) {
      await request(server())
        .get('/me/export')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }
    const rows = await waitForActivity(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].date.toISOString().slice(0, 10)).toBe(
      activityDayKey(new Date()),
    );

    // Eksport danych osoby (RODO art. 15) oddaje też doby aktywności.
    const exported = await request(server())
      .get('/me/export')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(exported.body.activityDays).toEqual([activityDayKey(new Date())]);
  });

  it('żądanie bez ważnego tokenu nie zapisuje aktywności', async () => {
    const userId = await createUser('Bez tokenu');
    await request(server())
      .get('/me/export')
      .set('Authorization', 'Bearer zly-token')
      .expect(401);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await activityRows(userId)).toHaveLength(0);
  });

  it('lejek: przyrosty na każdym kroku z zasianymi osobami, DAU i kohorta tygodnia', async () => {
    const before = usersAt(await growth('7'));
    const now = new Date();
    const later = (minutes: number) =>
      new Date(now.getTime() + minutes * 60_000);

    // Pełna ścieżka: kreator → dom → plan → zgoda → tura → zakup.
    const hash = `growth-hash-${stamp}`;
    const full = await createUser('Pelna', {
      onboardingCompletedAt: later(1),
      identityHash: hash,
    });
    const fullHousehold = await createHousehold(full);
    const recipe = await prisma.recipe.create({
      data: {
        title: `Owsianka ${stamp}`,
        mealType: 'BREAKFAST',
        householdId: fullHousehold,
        authorId: full,
      },
      select: { id: true },
    });
    const plan = await prisma.weeklyPlan.create({
      data: {
        householdId: fullHousehold,
        weekStart: new Date('2026-09-21T00:00:00.000Z'),
      },
      select: { id: true },
    });
    await prisma.planItem.create({
      data: {
        weeklyPlanId: plan.id,
        recipeId: recipe.id,
        dayOfWeek: 'MON',
        mealType: 'BREAKFAST',
        createdAt: later(10),
      },
    });
    await prisma.consentEvent.create({
      data: {
        userId: full,
        kind: 'AI_ASSISTANT',
        action: 'GRANTED',
        documentVersion: '1',
        createdAt: later(20),
      },
    });
    const conversation = await prisma.agentConversation.create({
      data: { userId: full, householdId: fullHousehold },
      select: { id: true },
    });
    await prisma.agentTurn.create({
      data: {
        conversationId: conversation.id,
        userId: full,
        userMessageId: randomUUID(),
        requestId: `growth-${stamp}`,
        status: 'DONE',
        createdAt: later(30),
      },
    });
    const subscription = await prisma.subscription.create({
      data: {
        identityHash: hash,
        provider: 'APPLE',
        productId: 'app.scoffie.pro.solo.monthly',
        originalTransactionId: `growth-${stamp}`,
        status: 'ACTIVE',
        environment: 'Production',
        createdAt: later(60),
        expiresAt: later(60 * 24 * 30),
      },
      select: { id: true },
    });
    subscriptionIds.push(subscription.id);
    // Sandbox to testy — nie jest zakupem.
    const sandboxHash = `growth-sandbox-${stamp}`;
    const tester = await createUser('Tester', {
      onboardingCompletedAt: later(1),
      identityHash: sandboxHash,
    });
    const sandbox = await prisma.subscription.create({
      data: {
        identityHash: sandboxHash,
        provider: 'APPLE',
        productId: 'app.scoffie.pro.solo.monthly',
        originalTransactionId: `growth-sb-${stamp}`,
        status: 'ACTIVE',
        environment: 'Sandbox',
      },
      select: { id: true },
    });
    subscriptionIds.push(sandbox.id);
    // Kreator i dom, bez planu.
    const halfway = await createUser('Polowa', {
      onboardingCompletedAt: later(5),
    });
    await createHousehold(halfway);
    // Sama rejestracja.
    await createUser('Start');

    const data = await growth('7');
    const after = usersAt(data);
    const delta = Object.fromEntries(
      Object.entries(after).map(([key, value]) => [
        key,
        value - before[key as FunnelStepKey],
      ]),
    );
    // Osoby z testów wyżej (Aktywna, Bez tokenu) doszły przed odczytem `before`.
    expect(delta).toEqual({
      registered: 4,
      onboarded: 3,
      household: 2,
      plan: 1,
      aiConsent: 1,
      firstTurn: 1,
      purchase: 1,
    });
    expect(tester).toBeTruthy();
    expect(data.period).toBe('7');
    const purchase = data.funnel.find((s) => s.key === 'purchase');
    expect(purchase?.medianSecondsToStep).not.toBeNull();
    expect(data.funnel[0].pctOfStart).toBe(100);

    // DAU dzisiaj widzi osobę z pierwszego testu; 30 dób, ostatnia = dziś.
    expect(data.active).toHaveLength(30);
    const today = data.active[data.active.length - 1];
    expect(today.dau).toBeGreaterThanOrEqual(1);
    expect(today.mau).toBeGreaterThanOrEqual(today.wau);
    expect(today.wau).toBeGreaterThanOrEqual(today.dau);

    // Kohorta bieżącego tygodnia: wszystkie zasiane osoby, tydzień 0 liczony,
    // przyszłe tygodnie puste.
    expect(data.cohorts).toHaveLength(12);
    const current = data.cohorts[data.cohorts.length - 1];
    expect(current.users).toBeGreaterThanOrEqual(6);
    expect(current.weeks[0]).toBeGreaterThan(0);
    expect(current.weeks.slice(1).every((w) => w === null)).toBe(true);
    expect(data.activitySince).not.toBeNull();
  });

  it('zły okres → 400', async () => {
    await request(server())
      .get('/admin/growth?period=14')
      .set('Cookie', session.cookie)
      .expect(400);
  });

  it('kasowanie konta usuwa aktywność (kaskada, RODO)', async () => {
    const userId = await createUser('Do usuniecia');
    await request(server())
      .get('/me/export')
      .set('Authorization', `Bearer ${jwt.sign({ sub: userId })}`)
      .expect(200);
    expect(await waitForActivity(userId)).toHaveLength(1);

    await users.deleteAccount(userId);

    expect(await activityRows(userId)).toHaveLength(0);
  });
});
