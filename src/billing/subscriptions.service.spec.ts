import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  AppStoreNotFoundError,
  AppStoreServerClient,
  AppStoreUnavailableError,
} from './app-store-server.client';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Podpis jest sprawdzany w `apple-jws.verifier` i ma tam własne testy. Tutaj
 * podstawiamy go świadomie, żeby testować to, co robi SERWIS: komu przypisuje
 * subskrypcję, czego nie przepisuje i jak reaguje na zwrot pieniędzy, na
 * powtórzone powiadomienie i na awarię Apple.
 */
jest.mock('./apple-jws.verifier', () => {
  const actual = jest.requireActual('./apple-jws.verifier');
  return {
    ...actual,
    verifyTransaction: jest.fn(),
    verifyRenewalInfo: jest.fn(),
    verifyAppleJws: jest.fn(),
  };
});

import {
  verifyAppleJws,
  verifyRenewalInfo,
  verifyTransaction,
} from './apple-jws.verifier';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HASH = 'c'.repeat(64);
const OTHER_HASH = 'd'.repeat(64);
const ORIGINAL_TX = '2000000000000001';
const SOLO = 'app.scoffie.pro.solo.monthly';
const FAMILY = 'app.scoffie.pro.family.monthly';

const transaction = (over: Record<string, unknown> = {}) => ({
  transactionId: '2000000000000009',
  originalTransactionId: ORIGINAL_TX,
  bundleId: 'app.scoffie',
  productId: SOLO,
  purchaseDate: Date.parse('2026-09-01T00:00:00.000Z'),
  expiresDate: Date.parse('2026-10-01T00:00:00.000Z'),
  environment: 'Sandbox',
  inAppOwnershipType: 'PURCHASED',
  ...over,
});

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof AppException
      ? ((error.getResponse() as { code?: string }).code ?? 'BRAK-KODU')
      : `NIE-APP:${String(error)}`;
  }
  return 'BRAK-BLEDU';
};

describe('SubscriptionsService', () => {
  const originals = { ...process.env };
  let prisma: {
    user: { findUnique: jest.Mock };
    subscription: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
    };
    appleNotification: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let appStore: { subscriptionState: jest.Mock };
  let service: SubscriptionsService;

  beforeEach(() => {
    process.env.BILLING_ENABLED = 'true';
    process.env.APPLE_ISSUER_ID = 'issuer';
    process.env.APPLE_BILLING_KEY_ID = 'key';
    process.env.APPLE_BILLING_PRIVATE_KEY = 'klucz-testowy';
    process.env.APPLE_ENVIRONMENT = 'Sandbox';
    process.env.APPLE_BUNDLE_ID = 'app.scoffie';

    (verifyTransaction as jest.Mock).mockReturnValue(transaction());
    (verifyRenewalInfo as jest.Mock).mockReturnValue({
      originalTransactionId: ORIGINAL_TX,
      autoRenewStatus: 1,
    });
    (verifyAppleJws as jest.Mock).mockReturnValue({});

    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: USER,
          appleSub: 'sub-apple',
          googleId: null,
          identityHash: HASH,
          authProvider: 'APPLE',
        }),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'sub-1',
          neverExpires: false,
          createdAt: NOW,
          ...data,
        })),
        update: jest.fn().mockImplementation(({ data }) => ({
          id: 'sub-1',
          neverExpires: false,
          createdAt: NOW,
          ...data,
        })),
        findMany: jest.fn().mockResolvedValue([]),
      },
      appleNotification: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    appStore = {
      subscriptionState: jest.fn().mockResolvedValue({
        originalTransactionId: ORIGINAL_TX,
        status: 1,
        transaction: transaction(),
        renewal: { originalTransactionId: ORIGINAL_TX, autoRenewStatus: 1 },
      }),
    };
    service = new SubscriptionsService(
      prisma as unknown as PrismaService,
      appStore as unknown as AppStoreServerClient,
    );
  });

  afterEach(() => {
    process.env = { ...originals };
    jest.clearAllMocks();
  });

  describe('zgłoszenie zakupu', () => {
    it('zapisuje subskrypcję na TOŻSAMOŚCI, nie na koncie ani na domu', async () => {
      const summary = await service.registerAppleTransaction(USER, 'jws', NOW);
      expect(summary.alive).toBe(true);
      expect(summary.productName).toBe('Solo');
      const created = prisma.subscription.create.mock.calls[0][0].data;
      expect(created.identityHash).toBe(HASH);
      expect(created.purchaserUserId).toBe(USER);
      expect(created).not.toHaveProperty('householdId');
    });

    it('bierze stan z APPLE, nie z tego, co przysłał telefon', async () => {
      // Telefon mówi „kupione", Apple mówi „zwrócone" — wygrywa Apple.
      appStore.subscriptionState.mockResolvedValue({
        originalTransactionId: ORIGINAL_TX,
        status: 5,
        transaction: transaction({
          revocationDate: Date.parse('2026-09-02T00:00:00.000Z'),
        }),
        renewal: null,
      });
      const summary = await service.registerAppleTransaction(USER, 'jws', NOW);
      expect(summary.status).toBe('REVOKED');
      expect(summary.alive).toBe(false);
    });

    it('ten sam paragon z DRUGIEGO konta nie przejmuje subskrypcji', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        identityHash: OTHER_HASH,
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        messagesLimitSnapshot: 30,
        plansLimitSnapshot: 8,
      });
      expect(
        await codeOf(() =>
          service.registerAppleTransaction(OTHER_USER, 'jws', NOW),
        ),
      ).toBe('BILLING_TRANSACTION_TAKEN');
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('po skasowaniu konta i powrocie ta sama osoba odzyskuje subskrypcję', async () => {
      // Wiersz przeżył kasowanie konta z pustym `purchaserUserId`; hasz
      // tożsamości się zgadza, więc wraca do właściciela bez żadnej akcji.
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        identityHash: HASH,
        purchaserUserId: null,
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        messagesLimitSnapshot: 30,
        plansLimitSnapshot: 8,
      });
      const summary = await service.registerAppleTransaction(USER, 'jws', NOW);
      expect(summary.alive).toBe(true);
      expect(
        prisma.subscription.update.mock.calls[0][0].data.purchaserUserId,
      ).toBe(USER);
    });

    it('awaria Apple NIE zmienia stanu — telefon ma ponowić', async () => {
      appStore.subscriptionState.mockRejectedValue(
        new AppStoreUnavailableError('timeout'),
      );
      expect(
        await codeOf(() => service.registerAppleTransaction(USER, 'jws', NOW)),
      ).toBe('BILLING_UPSTREAM_UNAVAILABLE');
      expect(prisma.subscription.create).not.toHaveBeenCalled();
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('transakcja nieznana Apple jest odrzucana', async () => {
      appStore.subscriptionState.mockRejectedValue(
        new AppStoreNotFoundError('nie ma'),
      );
      expect(
        await codeOf(() => service.registerAppleTransaction(USER, 'jws', NOW)),
      ).toBe('BILLING_TRANSACTION_UNKNOWN');
    });

    it('wyłączone płatności odmawiają zanim cokolwiek policzą', async () => {
      process.env.BILLING_ENABLED = 'false';
      expect(
        await codeOf(() => service.registerAppleTransaction(USER, 'jws', NOW)),
      ).toBe('BILLING_DISABLED');
      expect(appStore.subscriptionState).not.toHaveBeenCalled();
    });

    it('konto bez zewnętrznej tożsamości nie może kupić', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: USER,
        appleSub: null,
        googleId: null,
        identityHash: null,
        authProvider: 'DEV',
      });
      expect(
        await codeOf(() => service.registerAppleTransaction(USER, 'jws', NOW)),
      ).toBe('BILLING_IDENTITY_MISSING');
    });
  });

  describe('migawka limitów', () => {
    it('nowy opłacony okres bierze limity BIEŻĄCEGO produktu', async () => {
      // Zmiana planu w dół obowiązuje od odnowienia, na które klient się zgodził.
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        identityHash: HASH,
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        messagesLimitSnapshot: 75,
        plansLimitSnapshot: 18,
      });
      await service.registerAppleTransaction(USER, 'jws', NOW);
      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.messagesLimitSnapshot).toBe(30);
    });

    it('W TRAKCIE opłaconego okresu limit może tylko rosnąć', async () => {
      appStore.subscriptionState.mockResolvedValue({
        originalTransactionId: ORIGINAL_TX,
        status: 1,
        transaction: transaction({ productId: FAMILY }),
        renewal: null,
      });
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        identityHash: HASH,
        // Ten sam koniec okresu = ten sam okres.
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        messagesLimitSnapshot: 30,
        plansLimitSnapshot: 8,
      });
      await service.registerAppleTransaction(USER, 'jws', NOW);
      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.messagesLimitSnapshot).toBe(75);
    });

    it('nieznany produkt nie kasuje migawki, którą już mamy', async () => {
      appStore.subscriptionState.mockResolvedValue({
        originalTransactionId: ORIGINAL_TX,
        status: 1,
        transaction: transaction({ productId: 'app.scoffie.pro.nowy' }),
        renewal: null,
      });
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        identityHash: HASH,
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        messagesLimitSnapshot: 50,
        plansLimitSnapshot: 12,
      });
      await service.registerAppleTransaction(USER, 'jws', NOW);
      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.messagesLimitSnapshot).toBe(50);
    });
  });

  describe('powiadomienia Apple', () => {
    const notification = (over: Record<string, unknown> = {}) => ({
      notificationUUID: 'uuid-1',
      notificationType: 'DID_RENEW',
      signedDate: Date.parse('2026-09-03T10:00:00.000Z'),
      data: {
        bundleId: 'app.scoffie',
        environment: 'Sandbox',
        status: 1,
        signedTransactionInfo: 'jws-tx',
        signedRenewalInfo: 'jws-renewal',
      },
      ...over,
    });

    it('zapisuje zdarzenie z surowym ładunkiem', async () => {
      (verifyAppleJws as jest.Mock).mockReturnValue(notification());
      const result = await service.recordNotification('payload', NOW);
      expect(result).toEqual({ uuid: 'uuid-1', duplicate: false });
      const data = prisma.appleNotification.create.mock.calls[0][0].data;
      expect(data.signedPayload).toBe('payload');
      expect(data.originalTransactionId).toBe(ORIGINAL_TX);
    });

    it('powtórzone zdarzenie NIE jest przetwarzane drugi raz', async () => {
      (verifyAppleJws as jest.Mock).mockReturnValue(notification());
      prisma.appleNotification.findUnique.mockResolvedValue({
        processedAt: new Date('2026-09-03T11:00:00.000Z'),
      });
      const result = await service.recordNotification('payload', NOW);
      expect(result.duplicate).toBe(true);
      expect(prisma.appleNotification.create).not.toHaveBeenCalled();
    });

    it('zapisane, ale nieprzetworzone zdarzenie da się ponowić', async () => {
      (verifyAppleJws as jest.Mock).mockReturnValue(notification());
      prisma.appleNotification.findUnique.mockResolvedValue({
        processedAt: null,
      });
      const result = await service.recordNotification('payload', NOW);
      expect(result.duplicate).toBe(false);
      expect(prisma.appleNotification.create).not.toHaveBeenCalled();
    });

    it('powiadomienie dla CUDZEJ aplikacji jest odrzucane', async () => {
      (verifyAppleJws as jest.Mock).mockReturnValue(
        notification({
          data: { bundleId: 'cudza.apka', signedTransactionInfo: 'jws-tx' },
        }),
      );
      await expect(
        service.recordNotification('payload', NOW),
      ).rejects.toMatchObject({ code: 'WRONG_BUNDLE' });
    });

    it('NIEZNANY typ zdarzenia nie odcina nikogo — stan bierze się z podpisu', async () => {
      // Mapowanie nieznanego typu „na wszelki wypadek" na EXPIRED odcinałoby
      // płacących przy każdej nowości u Apple.
      (verifyAppleJws as jest.Mock).mockReturnValue(
        notification({ notificationType: 'COS_NOWEGO' }),
      );
      prisma.appleNotification.findUnique.mockResolvedValue({
        notificationUuid: 'uuid-1',
        signedPayload: 'payload',
        processedAt: null,
      });
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        identityHash: HASH,
        lastNotificationAt: null,
        expiresAt: new Date('2026-09-01T00:00:00.000Z'),
        messagesLimitSnapshot: 30,
        plansLimitSnapshot: 8,
      });
      await service.processNotification('uuid-1', NOW);
      const data = prisma.subscription.update.mock.calls.at(-1)?.[0].data;
      expect(data.status).toBe('ACTIVE');
      expect(data.lastNotificationType).toBe('COS_NOWEGO');
    });

    it('zdarzenie STARSZE niż stan nie cofa nowszego stanu', async () => {
      (verifyAppleJws as jest.Mock).mockReturnValue(
        notification({
          notificationType: 'EXPIRED',
          signedDate: Date.parse('2026-09-01T00:00:00.000Z'),
        }),
      );
      prisma.appleNotification.findUnique.mockResolvedValue({
        notificationUuid: 'uuid-1',
        signedPayload: 'payload',
        processedAt: null,
      });
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        identityHash: HASH,
        lastNotificationAt: new Date('2026-09-02T00:00:00.000Z'),
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        messagesLimitSnapshot: 30,
        plansLimitSnapshot: 8,
      });
      await service.processNotification('uuid-1', NOW);
      expect(prisma.subscription.update).not.toHaveBeenCalled();
      const note = prisma.appleNotification.update.mock.calls.at(-1)?.[0].data;
      expect(note.processedAt).toEqual(NOW);
    });

    it('zdarzenie o NIEZNANEJ subskrypcji czeka, zamiast zgadywać właściciela', async () => {
      (verifyAppleJws as jest.Mock).mockReturnValue(notification());
      prisma.appleNotification.findUnique.mockResolvedValue({
        notificationUuid: 'uuid-1',
        signedPayload: 'payload',
        processedAt: null,
      });
      prisma.subscription.findUnique.mockResolvedValue(null);
      await service.processNotification('uuid-1', NOW);
      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(prisma.subscription.create).not.toHaveBeenCalled();
    });

    it('zwrot pieniędzy w zdarzeniu ucina dostęp', async () => {
      (verifyAppleJws as jest.Mock).mockReturnValue(
        notification({
          notificationType: 'REFUND',
          data: {
            bundleId: 'app.scoffie',
            status: 5,
            signedTransactionInfo: 'jws-tx',
          },
        }),
      );
      (verifyTransaction as jest.Mock).mockReturnValue(
        transaction({ revocationDate: Date.parse('2026-09-03T09:00:00.000Z') }),
      );
      prisma.appleNotification.findUnique.mockResolvedValue({
        notificationUuid: 'uuid-1',
        signedPayload: 'payload',
        processedAt: null,
      });
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        identityHash: HASH,
        lastNotificationAt: null,
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        messagesLimitSnapshot: 30,
        plansLimitSnapshot: 8,
      });
      await service.processNotification('uuid-1', NOW);
      const data = prisma.subscription.update.mock.calls.at(-1)?.[0].data;
      expect(data.status).toBe('REVOKED');
      expect(data.revokedAt).toEqual(new Date('2026-09-03T09:00:00.000Z'));
    });

    it('zdarzenie bez transakcji (TEST) przechodzi bez zmian stanu', async () => {
      (verifyAppleJws as jest.Mock).mockReturnValue({
        notificationUUID: 'uuid-1',
        notificationType: 'TEST',
        data: { bundleId: 'app.scoffie' },
      });
      prisma.appleNotification.findUnique.mockResolvedValue({
        notificationUuid: 'uuid-1',
        signedPayload: 'payload',
        processedAt: null,
      });
      await service.processNotification('uuid-1', NOW);
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });
  });

  describe('uzgadnianie', () => {
    it('awaria Apple zostawia stan nietknięty i mówi „nie udało się"', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        identityHash: HASH,
        purchaserUserId: USER,
        provider: 'APPLE',
        originalTransactionId: ORIGINAL_TX,
      });
      appStore.subscriptionState.mockRejectedValue(
        new AppStoreUnavailableError('padło'),
      );
      expect(await service.reconcile('sub-1', NOW)).toBe(false);
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('nadanie ręczne (MANUAL) nie jest uzgadniane z Apple', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        id: 'sub-1',
        provider: 'MANUAL',
        originalTransactionId: null,
      });
      expect(await service.reconcile('sub-1', NOW)).toBe(false);
      expect(appStore.subscriptionState).not.toHaveBeenCalled();
    });
  });
});
