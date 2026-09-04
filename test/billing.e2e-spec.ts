import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createPrivateKey, sign } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { AppStoreServerClient } from '../src/billing/app-store-server.client';
import { SubscriptionsService } from '../src/billing/subscriptions.service';
import { AiUsageCountersService } from '../src/agent/ai-usage-counters.service';
import { purchaseIdentityHash } from '../src/config/purchase-identity';
import {
  TEST_LEAF_PRIVATE_KEY_PEM,
  TEST_ROOT_PEM,
  TEST_X5C,
} from '../src/billing/apple-jws-chain.spec-helper';

/**
 * PŁATNOŚCI NA ŻYWEJ BAZIE.
 *
 * Cały moduł płatności miał do tej pory dwa pliki testów jednostkowych z
 * ZAMOCKOWANĄ Prismą i ZAMOCKOWANYM weryfikatorem podpisu — czyli ani jednego
 * miejsca, w którym sprawdza się to, czego mock z definicji nie pokaże:
 * prawdziwy unikat w bazie, prawdziwy warunek `updateMany`, prawdziwy wyścig
 * dwóch żądań o ostatnią wiadomość miesiąca i prawdziwa warstwa HTTP.
 *
 * Ta suita chodzi po tym, co kosztuje pieniądze albo zaufanie:
 *   • ten sam paragon z drugiego konta,
 *   • powtórzone powiadomienie Apple (unikat na `notificationUUID`),
 *   • dostęp domownika z subskrypcji płatnika,
 *   • subskrypcja przeżywająca skasowanie konta,
 *   • dwa równoległe żądania o ostatnią wiadomość z puli,
 *   • ręczna blokada obsługi, której nie kasuje „Przywróć zakupy",
 *   • odmowa HTTP dla podpisu, którego nie da się potwierdzić.
 *
 * `PURCHASE_IDENTITY_PEPPER` i `APPLE_*` ustawiamy TU, przed zbudowaniem
 * modułu: konfiguracja płatności czyta się przy każdym użyciu, więc test może
 * ją podmienić bez restartu.
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

describe('Płatności E2E', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let subscriptions: SubscriptionsService;
  let counters: AiUsageCountersService;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const createdOriginalTxIds: string[] = [];
  const createdNotificationUuids: string[] = [];
  const createdScopeIds: string[] = [];

  const stamp = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  const NOW = new Date('2026-09-15T12:00:00.000Z');
  const BUNDLE = 'app.scoffie.e2e';
  const SOLO = 'app.scoffie.pro.solo.monthly';

  const originals = { ...process.env };

  const createUser = async (appleSub: string) => {
    const user = await prisma.user.create({
      data: {
        displayName: `Płatnik ${stamp()}`,
        email: `${stamp()}@billing.local`,
        authProvider: 'APPLE',
        appleSub,
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  };

  const createHousehold = async (userIds: string[]) => {
    const household = await prisma.household.create({
      data: {
        name: `Dom ${stamp()}`,
        memberships: { create: userIds.map((userId) => ({ userId })) },
      },
      select: { id: true },
    });
    createdHouseholdIds.push(household.id);
    return household.id;
  };

  const transaction = (over: Record<string, unknown> = {}) => ({
    transactionId: `9${stamp().replace(/\D/g, '').slice(0, 15)}`,
    bundleId: BUNDLE,
    productId: SOLO,
    purchaseDate: Date.parse('2026-09-01T00:00:00.000Z'),
    expiresDate: Date.parse('2026-10-01T00:00:00.000Z'),
    environment: 'Production',
    inAppOwnershipType: 'PURCHASED',
    ...over,
  });

  /**
   * Zamiast prawdziwego App Store Server API podstawiamy stan — pytanie o
   * Apple to jedyne, czego w teście nie da się wykonać naprawdę. WSZYSTKO
   * pozostałe (podpis, unikaty, zapisy, wyścigi) jest tu prawdziwe.
   */
  const fakeAppStore = {
    subscriptionState: jest.fn(),
  };

  beforeAll(async () => {
    process.env.BILLING_ENABLED = 'true';
    process.env.APPLE_ISSUER_ID = 'e2e-issuer';
    process.env.APPLE_BILLING_KEY_ID = 'e2e-key';
    process.env.APPLE_BILLING_PRIVATE_KEY = 'e2e-private-key';
    process.env.APPLE_BUNDLE_ID = BUNDLE;
    process.env.APPLE_ENVIRONMENT = 'Production';
    process.env.APPLE_ACCEPT_SANDBOX = 'false';
    process.env.PURCHASE_IDENTITY_PEPPER = `e2e-pepper-${stamp()}`;
    // Prawdziwych podpisów Apple nie da się trzymać w repozytorium, więc
    // podpisujemy własnym łańcuchem i przypinamy jego korzeń. `readBillingEnv`
    // przyjmuje tę zmienną WYŁĄCZNIE poza produkcją — patrz `rootCaPem`.
    process.env.APPLE_ROOT_CA_PEM = TEST_ROOT_PEM;
    process.env.AI_TIER_OVERRIDE = 'off';
    process.env.AI_TRIAL_MESSAGES = '5';

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppStoreServerClient)
      .useValue(fakeAppStore)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();

    prisma = moduleRef.get(PrismaService);
    subscriptions = moduleRef.get(SubscriptionsService);
    counters = moduleRef.get(AiUsageCountersService);
  });

  afterAll(async () => {
    await prisma.aiUsageCounter.deleteMany({
      where: { scopeId: { in: createdScopeIds } },
    });
    await prisma.appleNotification.deleteMany({
      where: { notificationUuid: { in: createdNotificationUuids } },
    });
    await prisma.subscription.deleteMany({
      where: { originalTransactionId: { in: createdOriginalTxIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app?.close();
    process.env = { ...originals };
  });

  beforeEach(() => {
    fakeAppStore.subscriptionState.mockReset();
  });

  it('ten sam paragon zgłoszony z DRUGIEGO konta nie przejmuje subskrypcji', async () => {
    // Unikat na `originalTransactionId` jest tu prawdziwy — w testach
    // jednostkowych ten sam scenariusz opierał się na atrapie `findUnique`.
    const originalTx = `2${stamp().replace(/\D/g, '').slice(0, 15)}`;
    createdOriginalTxIds.push(originalTx);
    const kupujacy = await createUser(`apple-${stamp()}`);
    const obcy = await createUser(`apple-${stamp()}`);

    fakeAppStore.subscriptionState.mockResolvedValue({
      originalTransactionId: originalTx,
      status: 1,
      transaction: transaction({ originalTransactionId: originalTx }),
      renewal: { originalTransactionId: originalTx, autoRenewStatus: 1 },
    });

    const jws = signJws(
      transaction({
        originalTransactionId: originalTx,
        appAccountToken: kupujacy,
      }),
    );
    const summary = await subscriptions.registerAppleTransaction(
      kupujacy,
      jws,
      NOW,
    );
    expect(summary.alive).toBe(true);
    createdScopeIds.push(subscriptions.scopeOf(summary.id));

    // Ten sam podpis, drugie konto. `appAccountToken` wskazuje kupującego.
    await expect(
      subscriptions.registerAppleTransaction(obcy, jws, NOW),
    ).rejects.toMatchObject({ status: 409 });

    const rows = await prisma.subscription.findMany({
      where: { originalTransactionId: originalTx },
    });
    expect(rows).toHaveLength(1);
  });

  it('POWTÓRZONE powiadomienie Apple nie przetwarza się drugi raz (prawdziwy unikat)', async () => {
    const originalTx = `2${stamp().replace(/\D/g, '').slice(0, 15)}`;
    createdOriginalTxIds.push(originalTx);
    const uuid = `e2e-${stamp()}`;
    createdNotificationUuids.push(uuid);

    const payload = {
      notificationUUID: uuid,
      notificationType: 'DID_RENEW',
      signedDate: NOW.getTime(),
      data: {
        bundleId: BUNDLE,
        environment: 'Production',
        status: 1,
        signedTransactionInfo: signJws(
          transaction({ originalTransactionId: originalTx }),
        ),
      },
    };

    const pierwsze = await request(app.getHttpServer())
      .post('/billing/apple/notifications')
      .send({ signedPayload: signJws(payload) });
    expect(pierwsze.status).toBe(200);
    expect(pierwsze.body.duplicate).toBe(false);

    const drugie = await request(app.getHttpServer())
      .post('/billing/apple/notifications')
      .send({ signedPayload: signJws(payload) });
    expect(drugie.status).toBe(200);
    expect(drugie.body.duplicate).toBe(true);

    const rows = await prisma.appleNotification.findMany({
      where: { notificationUuid: uuid },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(1);
  });

  it('powiadomienie z podpisem, którego nie da się potwierdzić, dostaje 400 i NIC nie zapisuje', async () => {
    const przed = await prisma.appleNotification.count();
    const odpowiedz = await request(app.getHttpServer())
      .post('/billing/apple/notifications')
      .send({ signedPayload: 'to.nie.jest-podpisany-token-apple' });
    expect(odpowiedz.status).toBe(400);
    expect(odpowiedz.body.code).toBe('BILLING_NOTIFICATION_INVALID');
    expect(await prisma.appleNotification.count()).toBe(przed);
  });

  it('DOMOWNIK płatnika ma PRO z jego subskrypcji, ze WSPÓLNEJ puli', async () => {
    const originalTx = `2${stamp().replace(/\D/g, '').slice(0, 15)}`;
    createdOriginalTxIds.push(originalTx);
    const appleSub = `apple-${stamp()}`;
    const platnik = await createUser(appleSub);
    const domownik = await createUser(`apple-${stamp()}`);
    const dom = await createHousehold([platnik, domownik]);

    fakeAppStore.subscriptionState.mockResolvedValue({
      originalTransactionId: originalTx,
      status: 1,
      transaction: transaction({ originalTransactionId: originalTx }),
      renewal: { originalTransactionId: originalTx, autoRenewStatus: 1 },
    });
    const summary = await subscriptions.registerAppleTransaction(
      platnik,
      signJws(
        transaction({
          originalTransactionId: originalTx,
          appAccountToken: platnik,
        }),
      ),
      NOW,
    );
    const scope = subscriptions.scopeOf(summary.id);
    createdScopeIds.push(scope);

    const planDomownika = await counters.resolvePlan(
      dom,
      { userId: domownik },
      NOW,
    );
    expect(planDomownika.tier).toBe('PRO');
    expect(planDomownika.source).toBe('SUBSCRIPTION');
    // Ta sama pula, co u płatnika — nie druga taka sama.
    const planPlatnika = await counters.resolvePlan(
      dom,
      { userId: platnik },
      NOW,
    );
    expect(planDomownika.quotaScopeId).toBe(planPlatnika.quotaScopeId);
    expect(planDomownika.quotaScopeId).toBe(scope);

    // Zakup wypełnił kolumnę hasza — od tego zależy całe wyliczanie planu.
    const wiersz = await prisma.user.findUnique({
      where: { id: platnik },
      select: { identityHash: true },
    });
    expect(wiersz?.identityHash).toBe(purchaseIdentityHash('APPLE', appleSub));
  });

  it('subskrypcja PRZEŻYWA skasowanie konta i wraca po ponownym zalogowaniu', async () => {
    const originalTx = `2${stamp().replace(/\D/g, '').slice(0, 15)}`;
    createdOriginalTxIds.push(originalTx);
    const appleSub = `apple-${stamp()}`;
    const platnik = await createUser(appleSub);

    fakeAppStore.subscriptionState.mockResolvedValue({
      originalTransactionId: originalTx,
      status: 1,
      transaction: transaction({ originalTransactionId: originalTx }),
      renewal: { originalTransactionId: originalTx, autoRenewStatus: 1 },
    });
    const summary = await subscriptions.registerAppleTransaction(
      platnik,
      signJws(
        transaction({
          originalTransactionId: originalTx,
          appAccountToken: platnik,
        }),
      ),
      NOW,
    );
    createdScopeIds.push(subscriptions.scopeOf(summary.id));

    await prisma.user.delete({ where: { id: platnik } });

    // `purchaserUserId` ma `SetNull`, więc wiersz zostaje — z haszem.
    const wiersz = await prisma.subscription.findUnique({
      where: { originalTransactionId: originalTx },
    });
    expect(wiersz).not.toBeNull();
    expect(wiersz?.purchaserUserId).toBeNull();
    expect(wiersz?.identityHash).toBe(purchaseIdentityHash('APPLE', appleSub));

    // Ta sama osoba wraca: nowe konto, ten sam `appleSub`, ten sam hasz.
    const znowu = await createUser(appleSub);
    const dom = await createHousehold([znowu]);
    await prisma.user.update({
      where: { id: znowu },
      data: { identityHash: purchaseIdentityHash('APPLE', appleSub) },
    });
    const plan = await counters.resolvePlan(dom, { userId: znowu }, NOW);
    expect(plan.tier).toBe('PRO');
  });

  it('DWA RÓWNOLEGŁE żądania o ostatnią wiadomość z puli — przechodzi dokładnie jedno', async () => {
    // To jest jedyny test w całym repozytorium, który sprawdza wyścig na
    // prawdziwym Postgresie. `tryConsume` opiera się na warunkowym
    // `updateMany(value < limit)`; z atrapą Prismy ten warunek nic nie znaczy.
    const scope = `e2e-scope-${stamp()}`;
    createdScopeIds.push(scope);
    const okres = '2026-09';

    const wyniki = await Promise.all(
      Array.from({ length: 8 }, () =>
        counters.tryConsume(prisma, scope, okres, 'messages', 3),
      ),
    );
    expect(wyniki.filter(Boolean)).toHaveLength(3);
    expect(await counters.read(scope, okres, 'messages')).toBe(3);
  });

  it('BLOKADA OBSŁUGI przeżywa uzgodnienie z Apple i zgłoszenie z telefonu', async () => {
    const originalTx = `2${stamp().replace(/\D/g, '').slice(0, 15)}`;
    createdOriginalTxIds.push(originalTx);
    const platnik = await createUser(`apple-${stamp()}`);
    const dom = await createHousehold([platnik]);

    fakeAppStore.subscriptionState.mockResolvedValue({
      originalTransactionId: originalTx,
      status: 1,
      transaction: transaction({ originalTransactionId: originalTx }),
      renewal: { originalTransactionId: originalTx, autoRenewStatus: 1 },
    });
    const jws = signJws(
      transaction({
        originalTransactionId: originalTx,
        appAccountToken: platnik,
      }),
    );
    const summary = await subscriptions.registerAppleTransaction(
      platnik,
      jws,
      NOW,
    );
    createdScopeIds.push(subscriptions.scopeOf(summary.id));
    expect(
      (await counters.resolvePlan(dom, { userId: platnik }, NOW)).tier,
    ).toBe('PRO');

    // Obsługa odbiera dostęp (zwrot załatwiony poza Apple).
    await prisma.subscription.update({
      where: { id: summary.id },
      data: {
        status: 'REVOKED',
        revokedAt: NOW,
        operatorHoldAt: NOW,
        operatorHoldReason: 'e2e',
      },
    });

    // Klient naciska „Przywróć zakupy" — telefon zgłasza tę samą transakcję,
    // a Apple dalej mówi ACTIVE. Przed poprawką to KASOWAŁO decyzję obsługi.
    await subscriptions.registerAppleTransaction(platnik, jws, NOW);

    const po = await prisma.subscription.findUnique({
      where: { id: summary.id },
    });
    expect(po?.status).toBe('ACTIVE');
    expect(po?.operatorHoldAt).not.toBeNull();
    expect(
      (await counters.resolvePlan(dom, { userId: platnik }, NOW)).tier,
    ).toBe('TRIAL');
  });

  it('subskrypcja ze ZŁEGO ŚRODOWISKA nie daje PRO, nawet gdy wiersz już jest', async () => {
    const originalTx = `2${stamp().replace(/\D/g, '').slice(0, 15)}`;
    createdOriginalTxIds.push(originalTx);
    const appleSub = `apple-${stamp()}`;
    const platnik = await createUser(appleSub);
    const dom = await createHousehold([platnik]);

    // Wiersz z sandboxa — taki, jaki zostawała po sobie literówka w
    // `APPLE_ENVIRONMENT`. Poprawienie zmiennej nie ruszało go w bazie.
    await prisma.subscription.create({
      data: {
        identityHash: purchaseIdentityHash('APPLE', appleSub)!,
        purchaserUserId: platnik,
        provider: 'APPLE',
        productId: SOLO,
        originalTransactionId: originalTx,
        status: 'ACTIVE',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        environment: 'Sandbox',
        messagesLimitSnapshot: 30,
        plansLimitSnapshot: 8,
      },
    });
    await prisma.user.update({
      where: { id: platnik },
      data: { identityHash: purchaseIdentityHash('APPLE', appleSub) },
    });

    expect(
      (await counters.resolvePlan(dom, { userId: platnik }, NOW)).tier,
    ).toBe('TRIAL');
  });
});
