import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { BillingOpsController } from './billing-ops.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsReconcileService } from './subscriptions-reconcile.service';
import { BillingPreflightService } from './billing-preflight.service';

/**
 * Panel obsługi. Dwie rzeczy, które audyt znalazł tu jako CICHE:
 *
 * 1. Ręczne odebranie dostępu ustawiało `status` i `revokedAt` — czyli
 *    dokładnie te pola, które przepisuje każde uzgodnienie z Apple i każde
 *    zgłoszenie z telefonu. Klient odzyskiwał dostęp naciskając „Przywróć
 *    zakupy", a obsługa nie miała jak się o tym dowiedzieć.
 * 2. Nadanie ręczne przyjmowało DOWOLNY napis jako tożsamość. Literówka
 *    dawała 201 z identyfikatorem wiersza i nie robiła nic — bo `resolvePlan`
 *    szuka po haszach domowników, a taki wiersz nie pasował do nikogo.
 */

const SOLO = 'app.scoffie.pro.solo.monthly';
const HASH = 'c'.repeat(64);
// Trasy `:id` przechodzą przez `assertUuid`, więc atrapy muszą być UUID-ami.
const SUB = '11111111-1111-4111-8111-111111111111';
const SUB_MISSING = '22222222-2222-4222-8222-222222222222';

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

describe('BillingOpsController', () => {
  let prisma: {
    subscription: {
      updateMany: jest.Mock;
      create: jest.Mock;
      findUnique: jest.Mock;
    };
    user: { findUnique: jest.Mock; findFirst: jest.Mock };
    aiUsageCounter: { updateMany: jest.Mock; findMany: jest.Mock };
    appleNotification: { findMany: jest.Mock };
  };
  let subscriptions: { reconcile: jest.Mock; forUser: jest.Mock };
  let controller: BillingOpsController;

  beforeEach(() => {
    prisma = {
      subscription: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'sub-1',
          ...data,
        })),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      aiUsageCounter: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      appleNotification: { findMany: jest.fn().mockResolvedValue([]) },
    };
    subscriptions = {
      reconcile: jest.fn().mockResolvedValue(true),
      forUser: jest.fn().mockResolvedValue([]),
    };
    controller = new BillingOpsController(
      prisma as unknown as PrismaService,
      subscriptions as unknown as SubscriptionsService,
      {} as unknown as SubscriptionsReconcileService,
      {
        sprawdz: jest.fn().mockResolvedValue({ stan: 'ok' }),
      } as unknown as BillingPreflightService,
    );
  });

  describe('odebranie dostępu', () => {
    it('zostawia TRWAŁĄ blokadę, a nie tylko status do nadpisania', async () => {
      await controller.revoke(SUB, { reason: 'zwrot poza Apple' });
      const data = prisma.subscription.updateMany.mock.calls.at(-1)?.[0].data;
      expect(data.status).toBe('REVOKED');
      expect(data.operatorHoldAt).toBeInstanceOf(Date);
      expect(data.operatorHoldReason).toBe('zwrot poza Apple');
    });

    it('bez powodu wpisuje powód domyślny — pusty wiersz nic nie tłumaczy', async () => {
      await controller.revoke(SUB, {});
      const data = prisma.subscription.updateMany.mock.calls.at(-1)?.[0].data;
      expect(String(data.operatorHoldReason).length).toBeGreaterThan(0);
    });

    it('nieistniejąca subskrypcja to 404, nie ciche „zrobione"', async () => {
      prisma.subscription.updateMany.mockResolvedValue({ count: 0 });
      expect(await codeOf(() => controller.revoke(SUB_MISSING, {}))).toBe(
        'NOT_FOUND',
      );
    });

    it('literówka w id to 400 przed Prismą, nie P2023 z bazy', async () => {
      expect(await codeOf(() => controller.revoke('sub-x', {}))).toBe(
        'VALIDATION_ERROR',
      );
      expect(await codeOf(() => controller.unhold('sub-x'))).toBe(
        'VALIDATION_ERROR',
      );
      expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
    });

    it('zdjęcie blokady czyści kolumnę i od razu uzgadnia stan z Apple', async () => {
      const wynik = await controller.unhold(SUB);
      const data = prisma.subscription.updateMany.mock.calls.at(-1)?.[0].data;
      expect(data).toEqual({ operatorHoldAt: null, operatorHoldReason: null });
      expect(subscriptions.reconcile).toHaveBeenCalledWith(SUB);
      expect(wynik.held).toBe(false);
    });
  });

  describe('nadanie ręczne', () => {
    it('hasz, do którego nie ma żadnego konta, jest ODRZUCANY', async () => {
      expect(
        await codeOf(() =>
          controller.grant({ identityHash: HASH, productId: SOLO, months: 1 }),
        ),
      ).toBe('VALIDATION_ERROR');
      expect(prisma.subscription.create).not.toHaveBeenCalled();
    });

    it('hasz z istniejącym kontem przechodzi', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      const wynik = await controller.grant({
        identityHash: HASH,
        productId: SOLO,
        months: 1,
      });
      expect(wynik.identityHash).toBe(HASH);
      expect(prisma.subscription.create).toHaveBeenCalled();
    });

    it('`force` przepuszcza nadanie z wyprzedzeniem — świadomie, nie przypadkiem', async () => {
      const wynik = await controller.grant({
        identityHash: HASH,
        productId: SOLO,
        months: 0,
        force: true,
      });
      expect(wynik.identityHash).toBe(HASH);
      const data = prisma.subscription.create.mock.calls.at(-1)?.[0].data;
      // 0 miesięcy = konto recenzenta App Store, jedyny wariant bezterminowy.
      expect(data.neverExpires).toBe(true);
      expect(data.expiresAt).toBeNull();
    });

    it('po `userId` serwer LICZY hasz sam — mniej miejsc na literówkę', async () => {
      prisma.user.findUnique.mockResolvedValue({
        identityHash: null,
        appleSub: 'apple-sub-1',
        googleId: null,
        authProvider: 'APPLE',
      });
      const wynik = await controller.grant({
        userId: 'user-1',
        productId: SOLO,
        months: 3,
      });
      expect(wynik.identityHash).toHaveLength(64);
    });

    it('konto bez tożsamości zakupowej odmawia z czytelnym powodem', async () => {
      prisma.user.findUnique.mockResolvedValue({
        identityHash: null,
        appleSub: null,
        googleId: null,
        authProvider: 'DEV',
      });
      expect(
        await codeOf(() =>
          controller.grant({ userId: 'user-1', productId: SOLO, months: 1 }),
        ),
      ).toBe('VALIDATION_ERROR');
    });

    it('nieznany produkt odmawia zanim cokolwiek zapisze', async () => {
      expect(
        await codeOf(() =>
          controller.grant({
            identityHash: HASH,
            productId: 'app.scoffie.wymyslony',
            months: 1,
            force: true,
          }),
        ),
      ).toBe('VALIDATION_ERROR');
      expect(prisma.subscription.create).not.toHaveBeenCalled();
    });
  });

  it('lista zdarzeń, które się nie przetworzyły, jest w ogóle dostępna', async () => {
    // Wcześniej takie zdarzenie przepadało po cichu: Apple ponawia pięć razy
    // przez trzy doby i przestaje, a w kodzie nie było miejsca, w którym dałoby
    // się je zobaczyć.
    await controller.failedNotifications();
    const where =
      prisma.appleNotification.findMany.mock.calls.at(-1)?.[0].where;
    expect(where.OR).toEqual([{ processedAt: null }, { error: { not: null } }]);
  });
});
