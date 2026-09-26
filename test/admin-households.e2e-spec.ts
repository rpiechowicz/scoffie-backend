import { createHash, randomBytes, randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { AiUsageCountersService } from '../src/agent/ai-usage-counters.service';
import { purchaseIdentityHash } from '../src/config/purchase-identity';
import { fallbackAvatarColor } from '../src/common/avatar-color.util';
import { catalogHouseholdId } from '../src/common/catalog-owner';
import type { HouseholdDetail, HouseholdListItem } from '../src/admin/contract';
import {
  ADMIN_E2E_EMAIL,
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Panel: gospodarstwa (`/admin/households`) na żywej bazie.
 *
 * Najważniejsze pytanie tej suity: czy plan i pula, które widzi panel, to
 * DOKŁADNIE to, co liczy asystent. Dlatego każdy rodzaj planu (próba,
 * nadanie operatora, subskrypcja, łaska płatnicza, Sandbox na produkcji,
 * Chmura Rodzinna, blokada operatora) jest porównany z
 * `AiUsageCountersService.resolvePlan` na tych samych wierszach.
 */
describe('Panel — gospodarstwa (/admin/households)', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let counters: AiUsageCountersService;
  let restoreGate: () => void;
  let admin: AdminE2ESession;
  let adminWithoutStepUp: AdminE2ESession;

  const originals = { ...process.env };
  const TAG = `a2hh-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const VIEWER_EMAIL = 'viewer-a2-households@scoffie.local';
  const stamp = () => `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const createdSubscriptionIds: string[] = [];
  const createdScopeIds: string[] = [];

  const ids = {
    trial: '',
    override: '',
    subscription: '',
    grace: '',
    sandbox: '',
    family: '',
    hold: '',
  };
  const users: Record<string, { id: string; hash: string | null }> = {};
  let subscriptionId = '';
  let graceSubscriptionId = '';
  let familySubscriptionId = '';
  let subscriptionExpiresAt = new Date();
  let graceExpiresAt = new Date();

  const server = () => app.getHttpServer();
  const get = (path: string, session: AdminE2ESession = admin) =>
    request(server()).get(path).set('Cookie', session.cookie);
  const post = (
    path: string,
    body: Record<string, unknown>,
    session: AdminE2ESession = admin,
  ) => request(server()).post(path).set('Cookie', session.cookie).send(body);

  const createUser = async (
    key: string,
    options: {
      appleSub?: string | null;
      lastLoginAt?: Date | null;
      avatarColor?: number | null;
    } = {},
  ) => {
    const appleSub =
      options.appleSub === undefined ? `a2-apple-${stamp()}` : options.appleSub;
    const hash = appleSub ? purchaseIdentityHash('APPLE', appleSub) : null;
    const user = await prisma.user.create({
      data: {
        displayName: `${key} ${TAG}`,
        email: `${key.toLowerCase()}-${stamp()}@a2.local`,
        authProvider: appleSub ? 'APPLE' : 'DEV',
        appleSub,
        identityHash: hash,
        lastLoginAt: options.lastLoginAt ?? null,
        // Lista domów sortuje po „ostatnio w aplikacji”; w teście oba razem.
        lastSeenAt: options.lastLoginAt ?? null,
        avatarColor: options.avatarColor ?? null,
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    users[key] = { id: user.id, hash };
    return users[key];
  };

  const createHousehold = async (
    name: string,
    members: { key: string; role: 'OWNER' | 'MEMBER'; joinedAt?: Date }[],
    extra: {
      tierOverride?: 'PRO' | 'TRIAL' | null;
      enabledMealTypes?: (
        | 'BREAKFAST'
        | 'SECOND_BREAKFAST'
        | 'LUNCH'
        | 'AFTERNOON_SNACK'
        | 'DINNER'
        | 'SNACK'
      )[];
      mealSlotTimes?: Record<string, number | string> | null;
    } = {},
  ) => {
    const household = await prisma.household.create({
      data: {
        name: `${name} ${TAG}`,
        tierOverride: extra.tierOverride ?? null,
        ...(extra.enabledMealTypes
          ? { enabledMealTypes: extra.enabledMealTypes }
          : {}),
        ...(extra.mealSlotTimes ? { mealSlotTimes: extra.mealSlotTimes } : {}),
        memberships: {
          create: members.map((member) => ({
            userId: users[member.key].id,
            role: member.role,
            ...(member.joinedAt ? { createdAt: member.joinedAt } : {}),
          })),
        },
      },
      select: { id: true },
    });
    createdHouseholdIds.push(household.id);
    return household.id;
  };

  const createSubscription = async (
    payerKey: string,
    data: {
      productId: string;
      status: 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'REVOKED';
      expiresAt: Date;
      graceExpiresAt?: Date | null;
      environment?: string;
      ownershipType?: string;
      autoRenewStatus?: boolean | null;
      operatorHoldAt?: Date | null;
      messagesLimitSnapshot?: number | null;
    },
  ) => {
    const payer = users[payerKey];
    const subscription = await prisma.subscription.create({
      data: {
        identityHash: payer.hash!,
        purchaserUserId: payer.id,
        provider: 'APPLE',
        productId: data.productId,
        originalTransactionId: `a2-otx-${stamp()}`,
        status: data.status,
        expiresAt: data.expiresAt,
        graceExpiresAt: data.graceExpiresAt ?? null,
        environment: data.environment ?? 'Production',
        ownershipType: data.ownershipType ?? 'PURCHASED',
        autoRenewStatus: data.autoRenewStatus ?? true,
        operatorHoldAt: data.operatorHoldAt ?? null,
        messagesLimitSnapshot: data.messagesLimitSnapshot ?? null,
        lastVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    createdSubscriptionIds.push(subscription.id);
    createdScopeIds.push(`sub:${subscription.id}`);
    return subscription.id;
  };

  const setCounter = async (
    scopeId: string,
    periodKey: string,
    kind: string,
    value: number,
  ) => {
    if (!createdScopeIds.includes(scopeId)) createdScopeIds.push(scopeId);
    await prisma.aiUsageCounter.upsert({
      where: { scopeId_periodKey_kind: { scopeId, periodKey, kind } },
      create: { scopeId, periodKey, kind, value },
      update: { value },
    });
  };

  const listItem = async (id: string): Promise<HouseholdListItem> => {
    const res = await get('/admin/households').expect(200);
    const body = res.body as { total: number; items: HouseholdListItem[] };
    const item = body.items.find((h) => h.id === id);
    if (!item) throw new Error(`brak domu ${id} na liście`);
    return item;
  };

  /** Pula panelu = pula asystenta dla wskazanej osoby (`resolvePlan` + licznik). */
  const expectSameAsAssistant = async (
    pool: HouseholdListItem['pool'],
    householdId: string,
    actorKey: string,
  ) => {
    const plan = await counters.resolvePlan(householdId, {
      userId: users[actorKey].id,
    });
    expect(pool.scopeId).toBe(plan.quotaScopeId);
    expect(pool.messages.limit).toBe(plan.messagesLimit);
    expect(pool.plans.limit).toBe(plan.plansLimit);
    expect(pool.resetsAt).toBe(plan.resetsAt);
    expect(pool.messages.used).toBe(
      await counters.read(plan.quotaScopeId, plan.periodKey, 'messages'),
    );
    expect(pool.plans.used).toBe(
      await counters.read(plan.quotaScopeId, plan.periodKey, 'plans'),
    );
  };

  beforeAll(async () => {
    process.env.AI_TIER_OVERRIDE = 'off';
    process.env.AI_TRIAL_MESSAGES = '5';
    process.env.AI_TRIAL_PLANS = '1';
    process.env.AI_HOUSEHOLD_MONTHLY_COST_USD = '14';
    delete process.env.AI_LIMIT_MESSAGES_PER_MONTH;
    delete process.env.AI_LIMIT_PLANS_PER_MONTH;
    // Serwer „produkcyjny": Sandbox nie daje PRO — jak na Railwayu.
    process.env.APPLE_ENVIRONMENT = 'Production';
    process.env.APPLE_ACCEPT_SANDBOX = 'false';
    restoreGate = useAdminDevGate();

    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    counters = moduleRef.get(AiUsageCountersService);

    admin = await createAdminSession(prisma, { stepUp: true });
    adminWithoutStepUp = await createAdminSession(prisma);

    const now = Date.now();
    // ——— próba: dwie osoby, druga bez tożsamości zakupowej ———
    await createUser('Ania', { lastLoginAt: new Date(now - 3 * DAY) });
    await createUser('Bartek', {
      appleSub: null,
      lastLoginAt: new Date(now - HOUR),
    });
    ids.trial = await createHousehold('Próba', [
      { key: 'Bartek', role: 'MEMBER', joinedAt: new Date(now - 5 * DAY) },
      { key: 'Ania', role: 'OWNER', joinedAt: new Date(now - 6 * DAY) },
    ]);
    await setCounter(`trial:${users.Ania.hash}`, 'trial', 'messages', 1);
    await setCounter(`trial:user:${users.Bartek.id}`, 'trial', 'messages', 4);
    await setCounter(`trial:user:${users.Bartek.id}`, 'trial', 'plans', 1);

    // ——— nadanie operatora, mimo żywej Rodziny właściciela ———
    await createUser('Celina', {
      lastLoginAt: new Date(now - 2 * HOUR),
      avatarColor: 3,
    });
    await createUser('Czesiek', { lastLoginAt: null, avatarColor: null });
    await createUser('Obcy', {});
    ids.override = await createHousehold(
      'Nadanie',
      [
        { key: 'Celina', role: 'OWNER' },
        { key: 'Czesiek', role: 'MEMBER' },
      ],
      {
        tierOverride: 'PRO',
        enabledMealTypes: ['DINNER', 'BREAKFAST', 'SNACK', 'LUNCH'],
        mealSlotTimes: { BREAKFAST: 450, DINNER: 1140, LUNCH: 'śmieć' },
      },
    );
    await createSubscription('Celina', {
      productId: 'app.scoffie.pro.family.monthly',
      status: 'ACTIVE',
      expiresAt: new Date(now + 20 * DAY),
    });
    const monthKey = counters.monthKey(new Date());
    await setCounter(ids.override, monthKey, 'messages', 7);
    await setCounter(ids.override, monthKey, 'plans', 2);
    await setCounter(ids.override, monthKey, 'costMicroUsd', 2_500_000);
    await setCounter(
      ids.override,
      counters.dayKey(new Date()),
      'costMicroUsd',
      900_000,
    );

    // Szczegół domu: Cookidoo z błędem, zaproszenia, ulubione, pamięć, plany.
    await prisma.cookidooIntegration.create({
      data: {
        householdId: ids.override,
        emailEncrypted: 'v1:SEKRET-EMAIL',
        passwordEncrypted: 'v1:SEKRET-HASLO',
        status: 'AUTH_FAILED',
        connectedById: users.Celina.id,
        lastVerifiedAt: new Date(now - DAY),
        lastErrorCode: 'COOKIDOO_AUTH_FAILED',
      },
    });
    const token = (label: string) =>
      createHash('sha256').update(`${label}-${stamp()}`).digest('hex');
    await prisma.invitation.createMany({
      data: [
        {
          tokenHash: token('przyjete'),
          householdId: ids.override,
          createdById: users.Celina.id,
          invitedUserId: users.Czesiek.id,
          redeemedById: users.Czesiek.id,
          redeemedAt: new Date(now - 9 * DAY),
          expiresAt: new Date(now - 3 * DAY),
          createdAt: new Date(now - 10 * DAY),
        },
        {
          tokenHash: token('odrzucone'),
          householdId: ids.override,
          createdById: users.Celina.id,
          invitedUserId: users.Obcy.id,
          declinedAt: new Date(now - 2 * DAY),
          expiresAt: new Date(now + 4 * DAY),
          createdAt: new Date(now - 3 * DAY),
        },
        {
          tokenHash: token('otwarte'),
          householdId: ids.override,
          createdById: users.Celina.id,
          expiresAt: new Date(now + 6 * DAY),
          createdAt: new Date(now - DAY),
        },
      ],
    });
    const recipes = await prisma.recipe.findMany({
      where: { isCatalog: true },
      take: 2,
      select: { id: true },
    });
    await prisma.recipeFavorite.createMany({
      data: recipes.map((recipe) => ({
        recipeId: recipe.id,
        householdId: ids.override,
      })),
    });
    await prisma.agentMemory.createMany({
      data: ['Kuba nie je ryb', 'W środy jemy u teściów', 'Lubimy ostre'].map(
        (text) => ({
          householdId: ids.override,
          text,
          textNormalized: text.toLowerCase(),
        }),
      ),
    });
    const planned = await prisma.weeklyPlan.create({
      data: {
        householdId: ids.override,
        weekStart: new Date('2026-09-21T00:00:00.000Z'),
      },
      select: { id: true },
    });
    await prisma.planItem.create({
      data: {
        weeklyPlanId: planned.id,
        recipeId: recipes[0].id,
        dayOfWeek: 'MON',
        mealType: 'DINNER',
      },
    });
    await prisma.weeklyPlan.create({
      data: {
        householdId: ids.override,
        weekStart: new Date('2026-09-28T00:00:00.000Z'),
      },
    });

    // ——— subskrypcja domownika (We dwoje) z migawką limitu ———
    await createUser('Darek', { lastLoginAt: new Date(now - 4 * DAY) });
    await createUser('Ewa', { lastLoginAt: new Date(now - 30 * 60 * 1000) });
    ids.subscription = await createHousehold('Subskrypcja', [
      { key: 'Ewa', role: 'OWNER' },
      { key: 'Darek', role: 'MEMBER' },
    ]);
    subscriptionExpiresAt = new Date(now + 10 * DAY);
    subscriptionId = await createSubscription('Darek', {
      productId: 'app.scoffie.pro.duet.monthly',
      status: 'ACTIVE',
      expiresAt: subscriptionExpiresAt,
      autoRenewStatus: false,
      messagesLimitSnapshot: 60,
    });
    const period = `okres:${subscriptionExpiresAt.toISOString().slice(0, 10)}`;
    await setCounter(`sub:${subscriptionId}`, period, 'messages', 12);
    await setCounter(`sub:${subscriptionId}`, period, 'plans', 2);

    // ——— łaska płatnicza (Solo) ———
    await createUser('Franek', { lastLoginAt: new Date(now - 5 * DAY) });
    ids.grace = await createHousehold('Łaska', [
      { key: 'Franek', role: 'OWNER' },
    ]);
    graceExpiresAt = new Date(now + 5 * DAY);
    graceSubscriptionId = await createSubscription('Franek', {
      productId: 'app.scoffie.pro.solo.monthly',
      status: 'GRACE',
      expiresAt: new Date(now - 2 * DAY),
      graceExpiresAt,
    });

    // ——— Sandbox na produkcji — PRO nie ma ———
    await createUser('Grażyna', { lastLoginAt: new Date(now - 6 * DAY) });
    ids.sandbox = await createHousehold('Sandbox', [
      { key: 'Grażyna', role: 'OWNER' },
    ]);
    await createSubscription('Grażyna', {
      productId: 'app.scoffie.pro.solo.monthly',
      status: 'ACTIVE',
      expiresAt: new Date(now + 15 * DAY),
      environment: 'Sandbox',
    });

    // ——— Chmura Rodzinna — daje PRO, jak w domenie ———
    await createUser('Henio', { lastLoginAt: new Date(now - 7 * DAY) });
    ids.family = await createHousehold('Chmura', [
      { key: 'Henio', role: 'OWNER' },
    ]);
    familySubscriptionId = await createSubscription('Henio', {
      productId: 'app.scoffie.pro.family.monthly',
      status: 'ACTIVE',
      expiresAt: new Date(now + 25 * DAY),
      ownershipType: 'FAMILY_SHARED',
    });

    // ——— blokada operatora — PRO odebrane ———
    await createUser('Iza', { lastLoginAt: new Date(now - 8 * DAY) });
    ids.hold = await createHousehold('Blokada', [
      { key: 'Iza', role: 'OWNER' },
    ]);
    await createSubscription('Iza', {
      productId: 'app.scoffie.pro.solo.monthly',
      status: 'ACTIVE',
      expiresAt: new Date(now + 12 * DAY),
      operatorHoldAt: new Date(now - DAY),
    });
  });

  afterAll(async () => {
    await prisma.aiUsageCounter.deleteMany({
      where: { scopeId: { in: createdScopeIds } },
    });
    await prisma.subscription.deleteMany({
      where: { id: { in: createdSubscriptionIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await cleanupAdmins(prisma, [ADMIN_E2E_EMAIL, VIEWER_EMAIL]);
    await app?.close();
    restoreGate?.();
    process.env = { ...originals };
  });

  describe('bramka', () => {
    it('bez sesji każda trasa to 404 jak nieistniejąca', async () => {
      const id = ids.override;
      await request(server()).get('/admin/households').expect(404);
      await request(server()).get(`/admin/households/${id}`).expect(404);
      await request(server())
        .post(`/admin/households/${id}/tier`)
        .send({ tier: 'PRO', reason: 'bez sesji' })
        .expect(404);
      await request(server())
        .post(`/admin/households/${id}/cost-reset`)
        .send({ reason: 'bez sesji' })
        .expect(404);
    });

    it('rola bez uprawnienia — też 404', async () => {
      const restore = useAdminDevGate(VIEWER_EMAIL);
      try {
        const viewer = await createAdminSession(prisma, {
          email: VIEWER_EMAIL,
          role: 'VIEWER',
          stepUp: true,
        });
        await get('/admin/households', viewer).expect(404);
        await post(
          `/admin/households/${ids.trial}/tier`,
          { tier: 'PRO', reason: 'rola bez prawa' },
          viewer,
        ).expect(404);
      } finally {
        restore();
      }
    });
  });

  describe('lista', () => {
    it('kształt, liczba wszystkich domów i kolejność po najświeższym logowaniu', async () => {
      const res = await get('/admin/households').expect(200);
      const body = res.body as { total: number; items: HouseholdListItem[] };
      // Gospodarstwo katalogu (bot importu) nie jest domem osoby — ani na
      // liście, ani w `total`.
      expect(body.total).toBe(
        await prisma.household.count({
          where: { id: { not: catalogHouseholdId() } },
        }),
      );
      expect(body.items.map((item) => item.id)).not.toContain(
        catalogHouseholdId(),
      );
      const mine = body.items
        .filter((item) => createdHouseholdIds.includes(item.id))
        .map((item) => item.id);
      // Ewa 30 min temu, Bartek 1 h, Celina 2 h, Darek/Ewa… — dom liczy
      // najświeższego domownika.
      expect(mine).toEqual([
        ids.subscription,
        ids.trial,
        ids.override,
        ids.grace,
        ids.sandbox,
        ids.family,
        ids.hold,
      ]);
      const trial = body.items.find((item) => item.id === ids.trial)!;
      expect(trial.lastLoginAt).not.toBeNull();
      expect(new Date(trial.createdAt).getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
    });

    it('próba: pula domownika, który zużył najwięcej — ta sama, co u asystenta', async () => {
      const item = await listItem(ids.trial);
      expect(item.plan).toEqual({ kind: 'trial' });
      expect(item.pool).toEqual({
        scopeId: `trial:user:${users.Bartek.id}`,
        messages: { used: 4, limit: 5 },
        plans: { used: 1, limit: 1 },
        resetsAt: null,
      });
      await expectSameAsAssistant(item.pool, ids.trial, 'Bartek');
      // Właściciel pierwszy, rola i kolor, którym osoba świeci w aplikacji.
      expect(item.members.map((m) => [m.userId, m.role])).toEqual([
        [users.Ania.id, 'OWNER'],
        [users.Bartek.id, 'MEMBER'],
      ]);
      expect(item.members[1].avatarColor).toBe(
        fallbackAvatarColor(users.Bartek.id),
      );
      expect(item.cookidoo).toBeNull();
    });

    it('nadanie operatora bije żywą Rodzinę — pula domu w miesiącu', async () => {
      const item = await listItem(ids.override);
      expect(item.plan).toEqual({ kind: 'override' });
      expect(item.pool).toMatchObject({
        scopeId: ids.override,
        messages: { used: 7, limit: 30 },
        plans: { used: 2, limit: 8 },
      });
      await expectSameAsAssistant(item.pool, ids.override, 'Celina');
      expect(item.cookidoo).toBe('AUTH_FAILED');
      expect(item.members[0]).toEqual({
        userId: users.Celina.id,
        displayName: `Celina ${TAG}`,
        role: 'OWNER',
        avatarColor: 3,
      });
    });

    it('subskrypcja domownika: zakres umowy, okres do odnowienia, migawka limitu', async () => {
      const item = await listItem(ids.subscription);
      expect(item.plan).toEqual({
        kind: 'subscription',
        productId: 'app.scoffie.pro.duet.monthly',
      });
      expect(item.pool).toEqual({
        scopeId: `sub:${subscriptionId}`,
        messages: { used: 12, limit: 60 },
        plans: { used: 2, limit: 12 },
        resetsAt: subscriptionExpiresAt.toISOString(),
      });
      await expectSameAsAssistant(item.pool, ids.subscription, 'Ewa');
    });

    it('łaska płatnicza daje PRO; Sandbox i blokada — próba; Chmura Rodzinna — PRO', async () => {
      const grace = await listItem(ids.grace);
      expect(grace.plan).toEqual({
        kind: 'subscription',
        productId: 'app.scoffie.pro.solo.monthly',
      });
      expect(grace.pool.scopeId).toBe(`sub:${graceSubscriptionId}`);
      await expectSameAsAssistant(grace.pool, ids.grace, 'Franek');

      const sandbox = await listItem(ids.sandbox);
      expect(sandbox.plan).toEqual({ kind: 'trial' });
      expect(sandbox.pool.scopeId).toBe(`trial:${users.Grażyna.hash}`);
      await expectSameAsAssistant(sandbox.pool, ids.sandbox, 'Grażyna');

      const family = await listItem(ids.family);
      expect(family.plan).toEqual({
        kind: 'subscription',
        productId: 'app.scoffie.pro.family.monthly',
      });
      expect(family.pool.scopeId).toBe(`sub:${familySubscriptionId}`);
      await expectSameAsAssistant(family.pool, ids.family, 'Henio');

      const hold = await listItem(ids.hold);
      expect(hold.plan).toEqual({ kind: 'trial' });
      await expectSameAsAssistant(hold.pool, ids.hold, 'Iza');
    });
  });

  describe('karta domu', () => {
    it('pory, godziny, zaproszenia z nazwiskami, koszt wobec sufitu, Cookidoo, liczby', async () => {
      const res = await get(`/admin/households/${ids.override}`).expect(200);
      const body = res.body as HouseholdDetail;
      expect(body.plan).toEqual({ kind: 'override' });
      expect(body.enabledMealTypes).toEqual([
        'BREAKFAST',
        'LUNCH',
        'DINNER',
        'SNACK',
      ]);
      // Śmieć w kolumnie odpada, reszta zostaje.
      expect(body.mealSlotTimes).toEqual({ BREAKFAST: 450, DINNER: 1140 });
      expect(body.costMonthUsd).toBe(2.5);
      expect(body.costCapUsd).toBe(14);
      expect(body.cookidooInfo).toEqual({
        connectedByName: `Celina ${TAG}`,
        lastVerifiedAt: expect.any(String),
        lastErrorCode: 'COOKIDOO_AUTH_FAILED',
      });
      expect(body.weeklyPlans).toBe(1);
      expect(body.favorites).toBe(2);
      expect(body.memoryNotes).toBe(3);

      expect(body.invitations).toHaveLength(3);
      const [open, declined, redeemed] = body.invitations;
      expect(open).toMatchObject({
        createdByName: `Celina ${TAG}`,
        invitedUserName: null,
        redeemedByName: null,
        redeemedAt: null,
        declinedAt: null,
      });
      expect(declined).toMatchObject({
        invitedUserName: `Obcy ${TAG}`,
        declinedAt: expect.any(String),
      });
      expect(redeemed).toMatchObject({
        redeemedByName: `Czesiek ${TAG}`,
        redeemedAt: expect.any(String),
      });

      // Ani poświadczeń Cookidoo, ani tokenów zaproszeń.
      const raw = JSON.stringify(body);
      expect(raw).not.toContain('SEKRET');
      expect(raw).not.toContain('tokenHash');
      expect(raw).not.toMatch(/[0-9a-f]{64}/);
    });

    it('dom bez godzin i bez Cookidoo — null, a nie pusta mapa', async () => {
      const res = await get(`/admin/households/${ids.grace}`).expect(200);
      const body = res.body as HouseholdDetail;
      expect(body.mealSlotTimes).toBeNull();
      expect(body.cookidooInfo).toBeNull();
      expect(body.enabledMealTypes).toEqual(['BREAKFAST', 'LUNCH', 'DINNER']);
      expect(body.costMonthUsd).toBe(0);
      expect(body.invitations).toEqual([]);
    });

    it('nieistniejący dom — 404 HOUSEHOLD_NOT_FOUND; śmieć zamiast id — 400', async () => {
      const missing = await get(`/admin/households/${randomUUID()}`).expect(
        404,
      );
      expect(missing.body.code).toBe('HOUSEHOLD_NOT_FOUND');
      const bad = await get('/admin/households/nie-uuid').expect(400);
      expect(bad.body.code).toBe('VALIDATION_ERROR');
    });

    it('gospodarstwo katalogu — 404 jak nieistniejące, także przy zapisach', async () => {
      const catalog = catalogHouseholdId();
      const tierOf = () =>
        prisma.household.findUnique({
          where: { id: catalog },
          select: { tierOverride: true },
        });
      const before = await tierOf();
      const detail = await get(`/admin/households/${catalog}`).expect(404);
      expect(detail.body.code).toBe('HOUSEHOLD_NOT_FOUND');
      const tier = await post(`/admin/households/${catalog}/tier`, {
        tier: 'PRO',
        reason: 'pomyłka w id',
      }).expect(404);
      expect(tier.body.code).toBe('HOUSEHOLD_NOT_FOUND');
      const reset = await post(`/admin/households/${catalog}/cost-reset`, {
        reason: 'pomyłka w id',
      }).expect(404);
      expect(reset.body.code).toBe('HOUSEHOLD_NOT_FOUND');
      expect(await tierOf()).toEqual(before);
    });
  });

  describe('nadanie PRO', () => {
    const tierOf = async (id: string) =>
      (
        await prisma.household.findUnique({
          where: { id },
          select: { tierOverride: true },
        })
      )?.tierOverride ?? null;

    it('bez świeżego step-upu — 403 STEP_UP_REQUIRED i nic się nie zmienia', async () => {
      const res = await post(
        `/admin/households/${ids.trial}/tier`,
        { tier: 'PRO', reason: 'beta-tester' },
        adminWithoutStepUp,
      ).expect(403);
      expect(res.body.code).toBe('STEP_UP_REQUIRED');
      expect(await tierOf(ids.trial)).toBeNull();
    });

    it('walidacja: tylko PRO albo null, powód 5–500 znaków, nic ponad', async () => {
      const path = `/admin/households/${ids.trial}/tier`;
      for (const body of [
        { tier: 'TRIAL', reason: 'beta-tester' },
        { reason: 'beta-tester' },
        { tier: 'PRO' },
        { tier: 'PRO', reason: 'abc' },
        { tier: 'PRO', reason: 'x'.repeat(501) },
        { tier: 'PRO', reason: 'beta-tester', months: 3 },
      ]) {
        await post(path, body).expect(400);
      }
      await post('/admin/households/nie-uuid/tier', {
        tier: 'PRO',
        reason: 'beta-tester',
      }).expect(400);
      expect(await tierOf(ids.trial)).toBeNull();
    });

    it('nadaje i zdejmuje: skutek w bazie, plan u asystenta, audyt z powodem i {from,to}', async () => {
      await post(`/admin/households/${ids.trial}/tier`, {
        tier: 'PRO',
        reason: 'beta-tester rodziny',
      }).expect(204);
      expect(await tierOf(ids.trial)).toBe('PRO');
      const granted = await counters.resolvePlan(ids.trial, {
        userId: users.Ania.id,
      });
      expect(granted.source).toBe('GRANTED');
      const detail = (await get(`/admin/households/${ids.trial}`).expect(200))
        .body as HouseholdDetail;
      expect(detail.plan).toEqual({ kind: 'override' });
      expect(detail.pool.scopeId).toBe(ids.trial);

      const grantAudit = await prisma.adminAuditLog.findFirst({
        where: {
          action: 'household.tier.set',
          targetId: ids.trial,
          result: 'SUCCESS',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(grantAudit).toMatchObject({
        adminUserId: admin.adminUserId,
        sessionId: admin.sessionId,
        targetType: 'Household',
        reason: 'beta-tester rodziny',
        details: { from: null, to: 'PRO' },
      });
      expect(grantAudit?.finishedAt).not.toBeNull();

      await post(`/admin/households/${ids.trial}/tier`, {
        tier: null,
        reason: 'koniec bety',
      }).expect(204);
      expect(await tierOf(ids.trial)).toBeNull();
      expect((await listItem(ids.trial)).plan).toEqual({ kind: 'trial' });
      const revokeAudit = await prisma.adminAuditLog.findFirst({
        where: {
          action: 'household.tier.set',
          targetId: ids.trial,
          result: 'SUCCESS',
          reason: 'koniec bety',
        },
      });
      expect(revokeAudit?.details).toEqual({ from: 'PRO', to: null });
    });

    it('nieistniejący dom — 404 i wpis FAILED z kodem', async () => {
      const id = randomUUID();
      const res = await post(`/admin/households/${id}/tier`, {
        tier: 'PRO',
        reason: 'literówka w id',
      }).expect(404);
      expect(res.body.code).toBe('HOUSEHOLD_NOT_FOUND');
      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: 'household.tier.set', targetId: id },
      });
      expect(audit).toMatchObject({
        result: 'FAILED',
        errorCode: 'HOUSEHOLD_NOT_FOUND',
      });
    });
  });

  describe('reset kosztu', () => {
    it('bez step-upu — 403; z nim zeruje licznik miesiąca (nie doby) i zostawia audyt', async () => {
      const monthKey = counters.monthKey(new Date());
      const path = `/admin/households/${ids.override}/cost-reset`;
      const denied = await post(
        path,
        { reason: 'koszt nabity przez błąd' },
        adminWithoutStepUp,
      ).expect(403);
      expect(denied.body.code).toBe('STEP_UP_REQUIRED');
      expect(await counters.read(ids.override, monthKey, 'costMicroUsd')).toBe(
        2_500_000,
      );
      await post(path, { reason: 'x' }).expect(400);

      await post(path, { reason: 'koszt nabity przez błąd' }).expect(204);
      expect(await counters.read(ids.override, monthKey, 'costMicroUsd')).toBe(
        0,
      );
      // Sufit dobowy zostaje — tak samo jak w `/ops`.
      expect(
        await counters.read(
          ids.override,
          counters.dayKey(new Date()),
          'costMicroUsd',
        ),
      ).toBe(900_000);

      const detail = (
        await get(`/admin/households/${ids.override}`).expect(200)
      ).body as HouseholdDetail;
      expect(detail.costMonthUsd).toBe(0);

      const audit = await prisma.adminAuditLog.findFirst({
        where: {
          action: 'household.cost.reset',
          targetId: ids.override,
          result: 'SUCCESS',
        },
      });
      expect(audit).toMatchObject({
        reason: 'koszt nabity przez błąd',
        details: { periodKey: monthKey, reset: 1 },
      });
    });

    it('nieistniejący dom — 404', async () => {
      const res = await post(`/admin/households/${randomUUID()}/cost-reset`, {
        reason: 'literówka w id',
      }).expect(404);
      expect(res.body.code).toBe('HOUSEHOLD_NOT_FOUND');
    });
  });
});
