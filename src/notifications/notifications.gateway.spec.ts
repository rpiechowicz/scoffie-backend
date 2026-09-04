import { Test, TestingModule } from '@nestjs/testing';
import { AppException } from '../common/app-exception';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

// Gateway ma dwie rzeczy na własność: KTO rejestruje token urządzenia i czy
// koperta zdarzenia ma właściwy kształt. Tożsamość idzie z socketu (`actorId`),
// a `payload.userId` liczy się tylko dla socketów legacy — inaczej dowolny
// klient podpinałby swój telefon pod cudze powiadomienia. Koperta: brak `data`
// albo `data` nie-obiekt kończy się VALIDATION_ERROR w acku, zanim serwis
// cokolwiek zobaczy. Zawartość `data` waliduje serwis (patrz jego spec) —
// tu jest zamockowany, więc dostaje ją surową.

const tokenClient = (userId: string) =>
  ({ data: { userId, mode: 'token' } }) as any;
const legacyClient = () => ({ data: { mode: 'legacy' } }) as any;
const anonClient = () => ({ data: {} }) as any;

const VICTIM = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ATTACKER = '9b2e6c1a-4d3f-4a8b-9c7d-1e2f3a4b5c6d';
const LEGACY_USER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const USER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const DEVICE = 'abcdef0123456789';

describe('NotificationsGateway', () => {
  let gateway: NotificationsGateway;
  let emit: jest.Mock;
  let to: jest.Mock;
  let notificationsService: Record<string, jest.Mock>;

  beforeEach(async () => {
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    const socketsJoin = jest.fn();
    const socketsLeave = jest.fn();
    const disconnectSockets = jest.fn();
    const inRoom = jest
      .fn()
      .mockReturnValue({ socketsJoin, socketsLeave, disconnectSockets });
    notificationsService = {
      registerDevice: jest
        .fn()
        .mockResolvedValue({ success: true, pushEnabled: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsGateway,
        { provide: NotificationsService, useValue: notificationsService },
        {
          provide: WsTelemetryService,
          useValue: { onConnect: jest.fn(), onDisconnect: jest.fn() },
        },
      ],
    }).compile();

    gateway = module.get<NotificationsGateway>(NotificationsGateway);
    (gateway as any).server = { emit, to, in: inRoom };
  });

  describe('notifications:registerDevice — tożsamość', () => {
    it('socket bez tożsamości dostaje UNAUTHORIZED w acku, serwis nietknięty', async () => {
      const response = await gateway.registerDevice(anonClient(), {
        userId: ATTACKER,
        data: { deviceToken: DEVICE },
      } as any);

      expect(response).toEqual(
        expect.objectContaining({
          ok: false,
          code: 'UNAUTHORIZED',
          status: 401,
        }),
      );
      expect(notificationsService.registerDevice).not.toHaveBeenCalled();
    });

    it('anonimowy socket ze złą kopertą: UNAUTHORIZED ma pierwszeństwo przed VALIDATION_ERROR', async () => {
      const response = await gateway.registerDevice(anonClient(), {} as any);

      expect(response).toEqual(
        expect.objectContaining({ ok: false, code: 'UNAUTHORIZED' }),
      );
      expect(notificationsService.registerDevice).not.toHaveBeenCalled();
    });

    it('socket z tokenem: payload.userId jest ignorowane, liczy się socket', async () => {
      const response = await gateway.registerDevice(tokenClient(VICTIM), {
        userId: ATTACKER,
        data: { deviceToken: DEVICE },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(notificationsService.registerDevice).toHaveBeenCalledWith(
        VICTIM,
        expect.objectContaining({ deviceToken: DEVICE }),
      );
    });

    it('socket legacy (tryb soft): tożsamość z payload.userId jak dawniej', async () => {
      await gateway.registerDevice(legacyClient(), {
        userId: LEGACY_USER,
        data: { deviceToken: DEVICE },
      } as any);

      expect(notificationsService.registerDevice).toHaveBeenCalledWith(
        LEGACY_USER,
        expect.objectContaining({ deviceToken: DEVICE }),
      );
    });

    it('socket legacy bez payload.userId też dostaje UNAUTHORIZED', async () => {
      const response = await gateway.registerDevice(legacyClient(), {
        data: { deviceToken: DEVICE },
      } as any);

      expect(response).toEqual(
        expect.objectContaining({ ok: false, code: 'UNAUTHORIZED' }),
      );
      expect(notificationsService.registerDevice).not.toHaveBeenCalled();
    });
  });

  describe('notifications:registerDevice — koperta', () => {
    it('brak data → VALIDATION_ERROR w acku, serwis nietknięty', async () => {
      const response = await gateway.registerDevice(
        tokenClient(USER),
        {} as any,
      );

      expect(response).toEqual(
        expect.objectContaining({
          ok: false,
          code: 'VALIDATION_ERROR',
          status: 400,
          details: expect.arrayContaining([
            expect.stringContaining('data must be an object'),
          ]),
        }),
      );
      expect(notificationsService.registerDevice).not.toHaveBeenCalled();
    });

    it('payload undefined (klient nic nie wysłał) → VALIDATION_ERROR, nie TypeError', async () => {
      const response = await gateway.registerDevice(
        tokenClient(USER),
        undefined as any,
      );

      expect(response).toEqual(
        expect.objectContaining({ ok: false, code: 'VALIDATION_ERROR' }),
      );
      expect(notificationsService.registerDevice).not.toHaveBeenCalled();
    });

    it('data jako string → VALIDATION_ERROR, serwis nietknięty', async () => {
      const response = await gateway.registerDevice(tokenClient(USER), {
        data: DEVICE,
      } as any);

      expect(response).toEqual(
        expect.objectContaining({ ok: false, code: 'VALIDATION_ERROR' }),
      );
      expect(notificationsService.registerDevice).not.toHaveBeenCalled();
    });

    it('nieznane pola na kopercie (stare buildy iOS) nie są błędem', async () => {
      const response = await gateway.registerDevice(tokenClient(USER), {
        householdId: '00000000-0000-4000-8000-000000000000',
        weekStart: '2026-08-31',
        data: { deviceToken: DEVICE },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(notificationsService.registerDevice).toHaveBeenCalledTimes(1);
    });
  });

  describe('notifications:registerDevice — przekazanie do serwisu', () => {
    it('przekazuje data surowe; apnsEnvironment "sandbox" (lowercase) przechodzi przez kopertę', async () => {
      const response = await gateway.registerDevice(tokenClient(USER), {
        data: {
          deviceToken: DEVICE,
          platform: 'IOS',
          appBundleId: 'app.scoffie',
          apnsEnvironment: 'sandbox',
        },
      } as any);

      expect(response).toEqual({
        ok: true,
        data: { success: true, pushEnabled: true },
      });
      // Zawartość `data` normalizuje i waliduje serwis (jedno miejsce), więc
      // gateway oddaje ją taką, jaka przyszła — z lowercase włącznie.
      expect(notificationsService.registerDevice).toHaveBeenCalledWith(USER, {
        deviceToken: DEVICE,
        platform: 'IOS',
        appBundleId: 'app.scoffie',
        apnsEnvironment: 'sandbox',
      });
    });

    it('błąd walidacji z serwisu (np. platform ANDROID) wraca jako VALIDATION_ERROR z listą', async () => {
      // Serwis zamockowany — symulujemy jego odpowiedź, żeby sprawdzić, że
      // koperta ack przenosi `details` bez zmian.
      const detail = 'platform must be one of the following values: IOS';
      notificationsService.registerDevice.mockRejectedValue(
        new AppException('VALIDATION_ERROR', detail, 400, [detail]),
      );

      const response = await gateway.registerDevice(tokenClient(USER), {
        data: { deviceToken: DEVICE, platform: 'ANDROID' },
      } as any);

      expect(response).toEqual(
        expect.objectContaining({
          ok: false,
          code: 'VALIDATION_ERROR',
          status: 400,
          details: [detail],
        }),
      );
    });

    it('błąd serwisu wraca jako ok:false', async () => {
      notificationsService.registerDevice.mockRejectedValue(new Error('boom'));

      const response = await gateway.registerDevice(tokenClient(USER), {
        data: { deviceToken: DEVICE },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: false }));
    });

    it('rejestracja urządzenia niczego nie rozgłasza', async () => {
      await gateway.registerDevice(tokenClient(USER), {
        data: { deviceToken: DEVICE },
      } as any);

      expect(emit).not.toHaveBeenCalled();
      expect(to).not.toHaveBeenCalled();
    });
  });
});
