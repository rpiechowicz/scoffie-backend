import { createPrivateKey, randomBytes, randomUUID, sign } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { purchaseIdentityHash } from '../src/config/purchase-identity';
import {
  TEST_LEAF_PRIVATE_KEY_PEM,
  TEST_ROOT_PEM,
  TEST_X5C,
} from '../src/billing/apple-jws-chain.spec-helper';
import type { SubscriptionsData } from '../src/admin/contract';
import {
  mrrSeriesPoints,
  percentChange,
} from '../src/admin/subscriptions/subscription-metrics';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Panel: subskrypcje (`/admin/subscriptions`) na żywej bazie.
 *
 * Liczby przychodu sprawdzamy jako PRZYROST wobec odczytu sprzed seeda — baza
 * testowa może mieć cudze wiersze, a MRR to suma. Ponowienie powiadomienia
 * Apple przechodzi PRAWDZIWE przetwarzanie: ładunek podpisany testowym
 * łańcuchem (korzeń przypięty przez `APPLE_ROOT_CA_PEM`, działa tylko poza
 * produkcją — jak w `test/billing.e2e-spec.ts`).
 */

const b64url = (input: Buffer | string): string =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const signJws = (payload: Record<string, unknown>): string => {
  const header = b64url(JSON.stringify({ alg: 'ES256', x5c: TEST_X5C }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`, 'ascii'), {
    key: createPrivateKey(TEST_LEAF_PRIVATE_KEY_PEM),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${body}.${b64url(signature)}`;
};

describe('Panel — subskrypcje (/admin/subscriptions)', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let admin: AdminE2ESession;
  let adminWithoutStepUp: AdminE2ESession;
  let baseline: SubscriptionsData;
  let data: SubscriptionsData;

  const originals = { ...process.env };
  const TAG = `a2sub-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const BUNDLE = 'app.scoffie.e2e.admin';
  const SOLO = 'app.scoffie.pro.solo.monthly';
  const DUET = 'app.scoffie.pro.duet.monthly';
  const FAMILY = 'app.scoffie.pro.family.monthly';
  const PRICE: Record<string, number> = {
    [SOLO]: 29.99,
    [DUET]: 39.99,
    [FAMILY]: 49.99,
  };
  const DAY = 24 * 60 * 60 * 1000;
  const stamp = () => `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const NOW = Date.now();
  const at = (days: number) => new Date(NOW + days * DAY);

  const createdUserIds: string[] = [];
  const createdSubscriptionIds: string[] = [];
  const createdNotificationUuids: string[] = [];
  const users: Record<string, { id: string; hash: string; name: string }> = {};
  const otx: Record<string, string> = {};
  /** Wiersze z przychodem, które seedujemy — wyrocznia dla punktów wykresu. */
  const revenue: { price: number; from: Date; until: Date | null }[] = [];
  const uuid = {
    pending: randomUUID(),
    renewedNow: randomUUID(),
    renewedBefore: randomUUID(),
    sandbox: randomUUID(),
    retryOk: randomUUID(),
    retryBad: randomUUID(),
  };
  let payerSubscriptionId = '';

  const server = () => app.getHttpServer();
  const get = (path: string, session: AdminE2ESession = admin) =>
    request(server()).get(path).set('Cookie', session.cookie);
  const post = (path: string, session: AdminE2ESession = admin) =>
    request(server()).post(path).set('Cookie', session.cookie).send({});

  const createUser = async (key: string) => {
    const appleSub = `a2-apple-${stamp()}`;
    const name = `${key} ${TAG}`;
    const user = await prisma.user.create({
      data: {
        displayName: name,
        email: `${key.toLowerCase()}-${stamp()}@a2.local`,
        authProvider: 'APPLE',
        appleSub,
        identityHash: purchaseIdentityHash('APPLE', appleSub),
      },
      select: { id: true, identityHash: true },
    });
    createdUserIds.push(user.id);
    users[key] = { id: user.id, hash: user.identityHash!, name };
    return users[key];
  };

  const createSubscription = async (
    key: string,
    data: {
      productId: string;
      status: 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'REVOKED';
      expiresAt: Date;
      graceExpiresAt?: Date | null;
      environment?: string;
      ownershipType?: string;
      autoRenewStatus?: boolean | null;
      operatorHoldAt?: Date | null;
      revokedAt?: Date | null;
      createdAt?: Date;
      provider?: 'APPLE' | 'MANUAL';
      /** Koniec płacenia do wyroczni wykresu; `null` = płaci dalej. */
      paysUntil?: Date | null;
      revenue?: boolean;
    },
  ) => {
    const payer = users[key];
    const originalTransactionId =
      data.provider === 'MANUAL' ? null : `a2-otx-${stamp()}`;
    const subscription = await prisma.subscription.create({
      data: {
        identityHash: payer.hash,
        purchaserUserId: payer.id,
        provider: data.provider ?? 'APPLE',
        productId: data.productId,
        originalTransactionId,
        status: data.status,
        expiresAt: data.expiresAt,
        graceExpiresAt: data.graceExpiresAt ?? null,
        environment:
          data.provider === 'MANUAL'
            ? null
            : (data.environment ?? 'Production'),
        ownershipType:
          data.provider === 'MANUAL'
            ? null
            : (data.ownershipType ?? 'PURCHASED'),
        autoRenewStatus: data.autoRenewStatus ?? true,
        operatorHoldAt: data.operatorHoldAt ?? null,
        revokedAt: data.revokedAt ?? null,
        messagesLimitSnapshot: 30,
        plansLimitSnapshot: 8,
        lastVerifiedAt: new Date(),
        ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      },
      select: { id: true, createdAt: true },
    });
    createdSubscriptionIds.push(subscription.id);
    if (originalTransactionId) otx[key] = originalTransactionId;
    if (data.revenue) {
      revenue.push({
        price: PRICE[data.productId],
        from: subscription.createdAt,
        until: data.paysUntil ?? null,
      });
    }
    return subscription.id;
  };

  const createNotification = async (
    notificationUuid: string,
    data: {
      notificationType: string;
      subtype?: string | null;
      originalTransactionId?: string | null;
      environment?: string | null;
      receivedAt: Date;
      processedAt?: Date | null;
      attempts?: number;
      error?: string | null;
      signedPayload?: string;
    },
  ) => {
    createdNotificationUuids.push(notificationUuid);
    await prisma.appleNotification.create({
      data: {
        notificationUuid,
        notificationType: data.notificationType,
        subtype: data.subtype ?? null,
        originalTransactionId: data.originalTransactionId ?? null,
        environment:
          data.environment === undefined ? 'Production' : data.environment,
        signedPayload: data.signedPayload ?? 'nie.jest.podpisem',
        receivedAt: data.receivedAt,
        processedAt: data.processedAt ?? null,
        attempts: data.attempts ?? 0,
        error: data.error ?? null,
      },
    });
  };

  const readData = async (session: AdminE2ESession = admin) =>
    (await get('/admin/subscriptions', session).expect(200))
      .body as SubscriptionsData;

  const countOf = (d: SubscriptionsData, productId: string) =>
    d.byProduct.find((p) => p.productId === productId)?.count ?? 0;

  beforeAll(async () => {
    process.env.APPLE_BUNDLE_ID = BUNDLE;
    process.env.APPLE_ENVIRONMENT = 'Production';
    process.env.APPLE_ACCEPT_SANDBOX = 'false';
    // Testowy korzeń — `readBillingEnv` przyjmuje go WYŁĄCZNIE poza produkcją.
    process.env.APPLE_ROOT_CA_PEM = TEST_ROOT_PEM;
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

    // Stan PRZED seedem — przychód liczymy jako przyrost.
    baseline = await readData();

    for (const key of [
      'Płatnik',
      'BezOdnowienia',
      'Łaska',
      'Chmura',
      'Tester',
      'Wstrzymany',
      'Odszedł',
      'Stały',
      'Zwrot',
    ]) {
      await createUser(key);
    }
    payerSubscriptionId = await createSubscription('Płatnik', {
      productId: SOLO,
      status: 'ACTIVE',
      expiresAt: at(20),
      revenue: true,
    });
    // Nadanie ręczne tej samej osobie — nie płaci, nigdzie się nie liczy.
    await createSubscription('Płatnik', {
      productId: FAMILY,
      status: 'ACTIVE',
      expiresAt: at(90),
      provider: 'MANUAL',
    });
    await createSubscription('BezOdnowienia', {
      productId: DUET,
      status: 'ACTIVE',
      expiresAt: at(8),
      autoRenewStatus: false,
      revenue: true,
    });
    await createSubscription('Łaska', {
      productId: SOLO,
      status: 'GRACE',
      expiresAt: at(-2),
      graceExpiresAt: at(3),
      revenue: true,
    });
    // Druga, słabsza przyczyna tej samej osoby — ryzyko ma JEDEN wiersz.
    await createSubscription('Łaska', {
      productId: DUET,
      status: 'ACTIVE',
      expiresAt: at(15),
      autoRenewStatus: false,
      revenue: true,
    });
    await createSubscription('Chmura', {
      productId: FAMILY,
      status: 'ACTIVE',
      expiresAt: at(25),
      ownershipType: 'FAMILY_SHARED',
    });
    await createSubscription('Tester', {
      productId: SOLO,
      status: 'ACTIVE',
      expiresAt: at(25),
      environment: 'Sandbox',
    });
    await createSubscription('Wstrzymany', {
      productId: SOLO,
      status: 'ACTIVE',
      expiresAt: at(12),
      operatorHoldAt: at(-1),
      revenue: true,
      paysUntil: at(-1),
    });
    await createSubscription('Odszedł', {
      productId: DUET,
      status: 'EXPIRED',
      expiresAt: at(-10),
      createdAt: at(-70),
      autoRenewStatus: false,
      revenue: true,
      paysUntil: at(-10),
    });
    await createSubscription('Stały', {
      productId: FAMILY,
      status: 'ACTIVE',
      expiresAt: at(5),
      createdAt: at(-45),
      revenue: true,
    });
    await createSubscription('Zwrot', {
      productId: SOLO,
      status: 'REVOKED',
      expiresAt: at(-20),
      revokedAt: at(-40),
      createdAt: at(-80),
      revenue: true,
      paysUntil: at(-40),
    });

    // Dziennik Apple.
    await createNotification(uuid.pending, {
      notificationType: 'DID_FAIL_TO_RENEW',
      subtype: 'GRACE_PERIOD',
      originalTransactionId: otx['Łaska'],
      receivedAt: new Date(NOW - 60 * 60 * 1000),
      attempts: 3,
      error: 'Timeout przy weryfikacji',
    });
    await createNotification(uuid.renewedNow, {
      notificationType: 'DID_RENEW',
      originalTransactionId: otx['Płatnik'],
      receivedAt: at(-5),
      processedAt: at(-5),
      attempts: 1,
    });
    await createNotification(uuid.renewedBefore, {
      notificationType: 'DID_RENEW',
      originalTransactionId: `a2-nieznana-${stamp()}`,
      receivedAt: at(-40),
      processedAt: at(-40),
      attempts: 1,
    });
    await createNotification(uuid.sandbox, {
      notificationType: 'DID_RENEW',
      environment: 'Sandbox',
      receivedAt: at(-3),
      processedAt: at(-3),
      attempts: 1,
    });
    // Do ponowienia: prawdziwy ładunek (odnowienie Solo płatnika o miesiąc)…
    const renewedUntil = at(50);
    await createNotification(uuid.retryOk, {
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      originalTransactionId: otx['Płatnik'],
      receivedAt: new Date(NOW - 2 * 60 * 60 * 1000),
      signedPayload: signJws({
        notificationUUID: uuid.retryOk,
        notificationType: 'DID_CHANGE_RENEWAL_STATUS',
        signedDate: NOW,
        data: {
          bundleId: BUNDLE,
          environment: 'Production',
          status: 1,
          signedTransactionInfo: signJws({
            transactionId: `9${Date.now()}`,
            originalTransactionId: otx['Płatnik'],
            bundleId: BUNDLE,
            productId: SOLO,
            purchaseDate: NOW - DAY,
            expiresDate: renewedUntil.getTime(),
            environment: 'Production',
            inAppOwnershipType: 'PURCHASED',
          }),
        },
      }),
    });
    // …i śmieć zamiast podpisu.
    await createNotification(uuid.retryBad, {
      notificationType: 'SUBSCRIBED',
      receivedAt: new Date(NOW - 3 * 60 * 60 * 1000),
      signedPayload: 'nie.jest.podpisem',
    });

    data = await readData();
  });

  afterAll(async () => {
    await prisma.appleNotification.deleteMany({
      where: { notificationUuid: { in: createdNotificationUuids } },
    });
    await prisma.subscription.deleteMany({
      where: { id: { in: createdSubscriptionIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await cleanupAdmins(prisma);
    await app?.close();
    restoreGate?.();
    process.env = { ...originals };
  });

  it('bez sesji — 404 jak nieistniejąca trasa', async () => {
    await request(server()).get('/admin/subscriptions').expect(404);
    await request(server())
      .post(`/admin/subscriptions/notifications/${uuid.pending}/retry`)
      .send({})
      .expect(404);
  });

  describe('przychód', () => {
    it('MRR: żywe App Store z produkcji, bez Chmury Rodzinnej, Sandboxa, nadań i blokad', () => {
      // Solo płatnika + We dwoje bez odnowienia + Solo w łasce + We dwoje
      // „Łaski" + Rodzina stała.
      const expected = 29.99 + 39.99 + 29.99 + 39.99 + 49.99;
      expect(data.mrrZl - baseline.mrrZl).toBeCloseTo(expected, 2);
      expect(data.arrZl).toBeCloseTo(data.mrrZl * 12, 2);
    });

    it('wykres: sześć miesięcy, koniec każdego odtworzony z wierszy, bieżący = MRR', () => {
      const points = mrrSeriesPoints(new Date());
      expect(data.mrrSeries.map((p) => p.month)).toEqual(
        points.map((p) => p.month),
      );
      expect(data.mrrSeries[5].value).toBe(data.mrrZl);
      for (const [index, point] of points.slice(0, 5).entries()) {
        const expected = revenue
          .filter(
            (span) =>
              span.from.getTime() <= point.at.getTime() &&
              (span.until === null ||
                span.until.getTime() > point.at.getTime()),
          )
          .reduce((sum, span) => sum + span.price, 0);
        expect(
          data.mrrSeries[index].value - baseline.mrrSeries[index].value,
        ).toBeCloseTo(expected, 2);
      }
    });

    it('trend m/m liczony z tych samych wierszy', () => {
      expect(Number.isFinite(data.mrrTrend)).toBe(true);
      if (baseline.mrrZl === 0 && baseline.mrrTrend === 0) {
        // Czysta baza: miesiąc temu płaciły Odszedł (We dwoje) i Stały
        // (Rodzina) — 89,98 zł; dziś 189,95 zł.
        expect(data.mrrTrend).toBe(percentChange(189.95, 89.98));
      }
    });

    it('produkty, Chmura Rodzinna i Sandbox', () => {
      expect(data.byProduct.map((p) => p.productId)).toEqual([
        SOLO,
        DUET,
        FAMILY,
      ]);
      expect(countOf(data, SOLO) - countOf(baseline, SOLO)).toBe(2);
      expect(countOf(data, DUET) - countOf(baseline, DUET)).toBe(2);
      expect(countOf(data, FAMILY) - countOf(baseline, FAMILY)).toBe(2);
      expect(data.familyShared - baseline.familyShared).toBe(1);
      expect(data.sandbox - baseline.sandbox).toBe(1);
    });

    it('ruch 30 dni: nowe, odnowienia z dziennika Apple, odejścia', () => {
      expect(data.movement.newSubs - baseline.movement.newSubs).toBe(5);
      expect(data.movement.renewals - baseline.movement.renewals).toBe(1);
      expect(data.movement.churned - baseline.movement.churned).toBe(1);
      expect(data.movement.trends).toHaveLength(3);
      if (
        baseline.movement.newSubs === 0 &&
        baseline.movement.renewals === 0 &&
        baseline.movement.churned === 0 &&
        baseline.movement.trends.every((t) => t === 0)
      ) {
        // Poprzednie 30 dni: Stały (nowy), jedno DID_RENEW, Zwrot (odejście).
        expect(data.movement.trends).toEqual([400, 0, 0]);
      }
    });
  });

  describe('ryzyko odejścia', () => {
    const mine = () =>
      data.risk.filter((r) => createdUserIds.includes(r.userId));

    it('blokada, łaska, brak odnowienia — po jednym wierszu na osobę, najpoważniejszy powód', () => {
      expect(mine()).toEqual([
        {
          userId: users.Wstrzymany.id,
          name: users.Wstrzymany.name,
          productId: SOLO,
          kind: 'operatorHold',
          until: null,
        },
        {
          userId: users['Łaska'].id,
          name: users['Łaska'].name,
          productId: SOLO,
          kind: 'grace',
          until: at(3).toISOString(),
        },
        {
          userId: users.BezOdnowienia.id,
          name: users.BezOdnowienia.name,
          productId: DUET,
          kind: 'autoRenewOff',
          until: at(8).toISOString(),
        },
      ]);
    });
  });

  describe('dziennik powiadomień Apple', () => {
    it('nieprzetworzone najpierw, płatnik po transakcji, bez surowego ładunku', () => {
      const list = data.notifications;
      const firstProcessed = list.findIndex((n) => n.processedAt !== null);
      const lastPending = list.map((n) => n.processedAt).lastIndexOf(null);
      if (firstProcessed !== -1)
        expect(lastPending).toBeLessThan(firstProcessed);

      const byId = new Map(list.map((n) => [n.notificationUuid, n]));
      expect(byId.get(uuid.pending)).toEqual({
        notificationUuid: uuid.pending,
        notificationType: 'DID_FAIL_TO_RENEW',
        subtype: 'GRACE_PERIOD',
        environment: 'Production',
        userName: users['Łaska'].name,
        receivedAt: expect.any(String),
        processedAt: null,
        attempts: 3,
        error: 'Timeout przy weryfikacji',
      });
      expect(byId.get(uuid.renewedNow)?.userName).toBe(users['Płatnik'].name);
      expect(byId.get(uuid.renewedBefore)?.userName).toBeNull();
      expect(byId.get(uuid.sandbox)?.environment).toBe('Sandbox');
      expect(JSON.stringify(list)).not.toContain('signedPayload');
      expect(JSON.stringify(list)).not.toContain('nie.jest.podpisem');
    });
  });

  describe('ponowienie powiadomienia', () => {
    const path = (id: string) =>
      `/admin/subscriptions/notifications/${id}/retry`;

    it('przetwarza NAPRAWDĘ (bez step-upu): wiersz zamknięty, subskrypcja odświeżona, audyt', async () => {
      await post(path(uuid.retryOk), adminWithoutStepUp).expect(204);

      const row = await prisma.appleNotification.findUnique({
        where: { notificationUuid: uuid.retryOk },
      });
      expect(row?.processedAt).not.toBeNull();
      expect(row?.error).toBeNull();
      expect(row?.attempts).toBe(1);
      const subscription = await prisma.subscription.findUnique({
        where: { id: payerSubscriptionId },
      });
      expect(subscription?.expiresAt?.toISOString()).toBe(at(50).toISOString());
      expect(subscription?.lastNotificationType).toBe(
        'DID_CHANGE_RENEWAL_STATUS',
      );

      const audit = await prisma.adminAuditLog.findFirst({
        where: {
          action: 'subscription.notification.retry',
          targetId: uuid.retryOk,
        },
      });
      expect(audit).toMatchObject({
        result: 'SUCCESS',
        targetType: 'AppleNotification',
        adminUserId: adminWithoutStepUp.adminUserId,
        details: { notificationType: 'DID_CHANGE_RENEWAL_STATUS', note: null },
      });
    });

    it('już przetworzone — 409, nic nie rusza', async () => {
      const res = await post(path(uuid.retryOk)).expect(409);
      expect(res.body.code).toBe('CONFLICT');
      const row = await prisma.appleNotification.findUnique({
        where: { notificationUuid: uuid.retryOk },
      });
      expect(row?.attempts).toBe(1);
    });

    it('podpis nie do potwierdzenia — 422, błąd w wierszu, audyt FAILED', async () => {
      const res = await post(path(uuid.retryBad)).expect(422);
      expect(res.body.code).toBe('BILLING_NOTIFICATION_INVALID');
      const row = await prisma.appleNotification.findUnique({
        where: { notificationUuid: uuid.retryBad },
      });
      expect(row?.processedAt).toBeNull();
      expect(row?.attempts).toBe(1);
      // Domena zapisuje `String(error)` — nazwę i komunikat, bez kodu.
      expect(row?.error).toMatch(/^AppleJwsError: /);
      const audit = await prisma.adminAuditLog.findFirst({
        where: {
          action: 'subscription.notification.retry',
          targetId: uuid.retryBad,
        },
      });
      expect(audit).toMatchObject({
        result: 'FAILED',
        errorCode: 'BILLING_NOTIFICATION_INVALID',
      });
    });

    it('nieznane — 404; śmieć zamiast id — 400', async () => {
      const missing = await post(path(randomUUID())).expect(404);
      expect(missing.body.code).toBe('NOT_FOUND');
      const bad = await post(path('zly%20id')).expect(400);
      expect(bad.body.code).toBe('VALIDATION_ERROR');
    });

    it('po ponowieniu ekran widzi zamknięte zdarzenie', async () => {
      const after = await readData();
      const retried = after.notifications.find(
        (n) => n.notificationUuid === uuid.retryOk,
      );
      expect(retried?.processedAt).not.toBeNull();
      expect(retried?.userName).toBe(users['Płatnik'].name);
    });
  });
});
