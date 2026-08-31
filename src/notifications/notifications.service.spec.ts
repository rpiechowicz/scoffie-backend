import { Logger } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

// Spec pokrywa WEJŚCIE `registerDevice`: walidacja `RegisterDeviceDto` ma
// zatrzymać złe dane, zanim Prisma cokolwiek zobaczy (liczba w `deviceToken`
// kończyła się `token.replace is not a function` → 500, `platform: 'ANDROID'`
// wywracał enum Prismy). Asystent AI (Faza 1) woła tę samą metodę in-process,
// więc te reguły nie mogą siedzieć tylko w gatewayu.

const USER = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const DEVICE = 'abcdef0123456789';

const validationError = (details?: unknown) => ({
  response: expect.objectContaining({
    code: 'VALIDATION_ERROR',
    ...(details ? { details } : {}),
  }),
});

describe('NotificationsService.registerDevice', () => {
  let service: NotificationsService;
  let upsert: jest.Mock;
  let isConfigured: jest.Mock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    upsert = jest.fn().mockResolvedValue({});
    isConfigured = jest.fn().mockReturnValue(true);
    const prisma = { pushDevice: { upsert } } as any;
    const apns = { isConfigured, defaultEnvironment: 'SANDBOX' } as any;
    service = new NotificationsService(prisma, apns);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  describe('poprawne wejście', () => {
    it('zapisuje urządzenie z domyślną platformą IOS i bez środowiska', async () => {
      const result = await service.registerDevice(USER, {
        deviceToken: DEVICE,
      });

      expect(result).toEqual({ success: true, pushEnabled: true });
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceToken: DEVICE },
          create: expect.objectContaining({
            userId: USER,
            deviceToken: DEVICE,
            platform: 'IOS',
            apnsEnvironment: null,
          }),
        }),
      );
      // Brak środowiska w `update` = nie nadpisuj tego, co już wiemy o tokenie.
      const call = upsert.mock.calls[0][0] as {
        update: Record<string, unknown>;
      };
      expect(call.update).not.toHaveProperty('apnsEnvironment');
    });

    it('apnsEnvironment "sandbox" (lowercase) → SANDBOX; "development" też → SANDBOX', async () => {
      await service.registerDevice(USER, {
        deviceToken: DEVICE,
        apnsEnvironment: ' sandbox ',
      } as any);
      await service.registerDevice(USER, {
        deviceToken: DEVICE,
        apnsEnvironment: 'development',
      } as any);

      expect(upsert.mock.calls[0][0]).toMatchObject({
        create: { apnsEnvironment: 'SANDBOX' },
        update: { apnsEnvironment: 'SANDBOX' },
      });
      expect(upsert.mock.calls[1][0]).toMatchObject({
        create: { apnsEnvironment: 'SANDBOX' },
        update: { apnsEnvironment: 'SANDBOX' },
      });
    });

    it('PRODUCTION przechodzi bez zmian, platform i appBundleId trafiają do zapisu', async () => {
      await service.registerDevice(USER, {
        deviceToken: DEVICE,
        platform: 'IOS',
        appBundleId: 'com.example.weeklymeals',
        apnsEnvironment: 'PRODUCTION',
      });

      expect(upsert.mock.calls[0][0]).toMatchObject({
        create: {
          platform: 'IOS',
          appBundleId: 'com.example.weeklymeals',
          apnsEnvironment: 'PRODUCTION',
        },
        update: {
          platform: 'IOS',
          appBundleId: 'com.example.weeklymeals',
          apnsEnvironment: 'PRODUCTION',
        },
      });
    });

    it('normalizuje token w formacie z nawiasami i spacjami', async () => {
      await service.registerDevice(USER, {
        deviceToken: '<abcd ef01 2345 6789>',
      });

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deviceToken: DEVICE } }),
      );
    });

    it('pushEnabled odzwierciedla konfigurację APNs, nie wynik zapisu', async () => {
      isConfigured.mockReturnValue(false);

      const result = await service.registerDevice(USER, {
        deviceToken: DEVICE,
      });

      expect(result).toEqual({ success: true, pushEnabled: false });
      expect(upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('złe wejście → VALIDATION_ERROR, Prisma nietknięta', () => {
    it('dto undefined (brak data w payloadzie)', async () => {
      await expect(
        service.registerDevice(USER, undefined as any),
      ).rejects.toMatchObject(
        validationError(
          expect.arrayContaining([
            expect.stringContaining('deviceToken must be a string'),
          ]),
        ),
      );
      expect(upsert).not.toHaveBeenCalled();
    });

    it('deviceToken: 123 (liczba) — kiedyś TypeError na token.replace → 500', async () => {
      await expect(
        service.registerDevice(USER, { deviceToken: 123 } as any),
      ).rejects.toMatchObject(
        validationError(
          expect.arrayContaining([
            expect.stringContaining('deviceToken must be a string'),
          ]),
        ),
      );
      expect(upsert).not.toHaveBeenCalled();
    });

    it('deviceToken pusty string', async () => {
      await expect(
        service.registerDevice(USER, { deviceToken: '' }),
      ).rejects.toMatchObject(
        validationError(
          expect.arrayContaining(['deviceToken should not be empty']),
        ),
      );
      expect(upsert).not.toHaveBeenCalled();
    });

    it('deviceToken z samych nawiasów i spacji (pusty po normalizacji) — kiedyś ok:true z success:false', async () => {
      await expect(
        service.registerDevice(USER, { deviceToken: '< >' }),
      ).rejects.toMatchObject(
        validationError(['deviceToken should not be empty']),
      );
      expect(upsert).not.toHaveBeenCalled();
    });

    it('deviceToken dłuższy niż 512 znaków', async () => {
      await expect(
        service.registerDevice(USER, { deviceToken: 'a'.repeat(513) }),
      ).rejects.toMatchObject(validationError());
      expect(upsert).not.toHaveBeenCalled();
    });

    it('platform ANDROID → komunikat z listą dozwolonych (IOS)', async () => {
      await expect(
        service.registerDevice(USER, {
          deviceToken: DEVICE,
          platform: 'ANDROID',
        } as any),
      ).rejects.toMatchObject(
        validationError(['platform must be one of the following values: IOS']),
      );
      expect(upsert).not.toHaveBeenCalled();
    });

    it('apnsEnvironment "staging" → komunikat z listą dozwolonych', async () => {
      await expect(
        service.registerDevice(USER, {
          deviceToken: DEVICE,
          apnsEnvironment: 'staging',
        } as any),
      ).rejects.toMatchObject(
        validationError([
          'apnsEnvironment must be one of the following values: SANDBOX, DEVELOPMENT, PRODUCTION',
        ]),
      );
      expect(upsert).not.toHaveBeenCalled();
    });

    it('apnsEnvironment nie-string (obiekt) → VALIDATION_ERROR, nie ciche undefined', async () => {
      await expect(
        service.registerDevice(USER, {
          deviceToken: DEVICE,
          apnsEnvironment: { env: 'SANDBOX' },
        } as any),
      ).rejects.toMatchObject(validationError());
      expect(upsert).not.toHaveBeenCalled();
    });

    it('appBundleId dłuższy niż 255 znaków', async () => {
      await expect(
        service.registerDevice(USER, {
          deviceToken: DEVICE,
          appBundleId: 'x'.repeat(256),
        }),
      ).rejects.toMatchObject(
        validationError(
          expect.arrayContaining([
            expect.stringContaining('appBundleId must be shorter'),
          ]),
        ),
      );
      expect(upsert).not.toHaveBeenCalled();
    });

    it('nieznane pole w data (halucynacja asystenta) → VALIDATION_ERROR', async () => {
      await expect(
        service.registerDevice(USER, {
          deviceToken: DEVICE,
          pushToken: DEVICE,
        } as any),
      ).rejects.toMatchObject(
        validationError(['property pushToken should not exist']),
      );
      expect(upsert).not.toHaveBeenCalled();
    });
  });
});
