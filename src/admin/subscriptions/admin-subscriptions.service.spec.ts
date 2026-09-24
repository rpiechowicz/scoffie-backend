import { AppleJwsError } from '../../billing/apple-jws.verifier';
import type { SubscriptionsService } from '../../billing/subscriptions.service';
import { AppException } from '../../common/app-exception';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  AdminSubscriptionsService,
  assertNotificationId,
} from './admin-subscriptions.service';

describe('AdminSubscriptionsService.retryNotification', () => {
  const findUnique = jest.fn();
  const processNotification = jest.fn();
  const service = new AdminSubscriptionsService(
    { appleNotification: { findUnique } } as unknown as PrismaService,
    { processNotification } as unknown as SubscriptionsService,
  );

  beforeEach(() => {
    findUnique.mockReset();
    processNotification.mockReset();
  });

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof AppException) {
        return `${error.getStatus()} ${error.code}`;
      }
      throw error;
    }
    return 'ok';
  };

  it('nieznane powiadomienie → 404, bez wołania domeny', async () => {
    findUnique.mockResolvedValue(null);
    expect(await codeOf(service.retryNotification('n-1'))).toBe(
      '404 NOT_FOUND',
    );
    expect(processNotification).not.toHaveBeenCalled();
  });

  it('już przetworzone → 409 — drugie przetworzenie mogłoby cofnąć nowszy stan', async () => {
    findUnique.mockResolvedValue({
      processedAt: new Date(),
      notificationType: 'DID_RENEW',
    });
    expect(await codeOf(service.retryNotification('n-1'))).toBe('409 CONFLICT');
    expect(processNotification).not.toHaveBeenCalled();
  });

  it('podpis nie do potwierdzenia → 422 BILLING_NOTIFICATION_INVALID', async () => {
    findUnique.mockResolvedValue({
      processedAt: null,
      notificationType: 'DID_RENEW',
    });
    processNotification.mockRejectedValue(
      new AppleJwsError('SIGNATURE', 'zły podpis'),
    );
    expect(await codeOf(service.retryNotification('n-1'))).toBe(
      '422 BILLING_NOTIFICATION_INVALID',
    );
  });

  it('inny błąd domeny leci dalej bez przebrania', async () => {
    findUnique.mockResolvedValue({
      processedAt: null,
      notificationType: 'DID_RENEW',
    });
    processNotification.mockRejectedValue(new Error('baza leży'));
    await expect(service.retryNotification('n-1')).rejects.toThrow('baza leży');
  });

  it('sukces: typ zdarzenia i notatka, z którą domena je zamknęła', async () => {
    findUnique
      .mockResolvedValueOnce({ processedAt: null, notificationType: 'TEST' })
      .mockResolvedValueOnce({ error: 'Subskrypcja jeszcze nieznana.' });
    processNotification.mockResolvedValue(undefined);
    await expect(service.retryNotification('n-1')).resolves.toEqual({
      notificationType: 'TEST',
      note: 'Subskrypcja jeszcze nieznana.',
    });
    expect(processNotification).toHaveBeenCalledWith('n-1');
  });
});

describe('assertNotificationId', () => {
  it('przepuszcza UUID od Apple i bezpieczne identyfikatory', () => {
    expect(assertNotificationId('002e14d5-51f5-4503-b5a8-c3a1af68eb20')).toBe(
      '002e14d5-51f5-4503-b5a8-c3a1af68eb20',
    );
    expect(assertNotificationId('e2e-1727-abc')).toBe('e2e-1727-abc');
  });

  it('odrzuca śmieci 400 VALIDATION_ERROR', () => {
    for (const bad of ['', 'a b', 'x'.repeat(129), '../etc', 42, null]) {
      expect(() => assertNotificationId(bad)).toThrow(AppException);
    }
  });
});
