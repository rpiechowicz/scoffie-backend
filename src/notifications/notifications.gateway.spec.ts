import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsService } from './notifications.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

// Gateway ma jedną rzecz na własność: KTO rejestruje token urządzenia. Od Fazy 0
// tożsamość idzie z socketu (`actorId`), a `payload.userId` liczy się tylko dla
// socketów legacy — inaczej dowolny klient podpinałby swój telefon pod cudze
// powiadomienia. Reszta to przekazanie pól do serwisu.

const tokenClient = (userId: string) =>
  ({ data: { userId, mode: 'token' } }) as any;
const legacyClient = () => ({ data: { mode: 'legacy' } }) as any;
const anonClient = () => ({ data: {} }) as any;

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
        userId: 'attacker',
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

    it('socket z tokenem: payload.userId jest ignorowane, liczy się socket', async () => {
      const response = await gateway.registerDevice(tokenClient('victim'), {
        userId: 'attacker',
        data: { deviceToken: DEVICE },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: true }));
      expect(notificationsService.registerDevice).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'victim', deviceToken: DEVICE }),
      );
    });

    it('socket legacy (tryb soft): tożsamość z payload.userId jak dawniej', async () => {
      await gateway.registerDevice(legacyClient(), {
        userId: 'legacy-user',
        data: { deviceToken: DEVICE },
      } as any);

      expect(notificationsService.registerDevice).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'legacy-user', deviceToken: DEVICE }),
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

  describe('notifications:registerDevice — przekazanie do serwisu', () => {
    it('przekazuje pola urządzenia i parsuje apnsEnvironment', async () => {
      const response = await gateway.registerDevice(tokenClient('user-1'), {
        data: {
          deviceToken: DEVICE,
          platform: 'IOS',
          appBundleId: 'com.example.weeklymeals',
          apnsEnvironment: 'sandbox',
        },
      } as any);

      expect(response).toEqual({
        ok: true,
        data: { success: true, pushEnabled: true },
      });
      expect(notificationsService.registerDevice).toHaveBeenCalledWith({
        userId: 'user-1',
        deviceToken: DEVICE,
        platform: 'IOS',
        appBundleId: 'com.example.weeklymeals',
        apnsEnvironment: 'SANDBOX',
      });
    });

    it('brak data → pusty deviceToken, o wyniku decyduje serwis', async () => {
      notificationsService.registerDevice.mockResolvedValue({
        success: false,
        pushEnabled: false,
      });

      const response = await gateway.registerDevice(
        tokenClient('user-1'),
        {} as any,
      );

      expect(notificationsService.registerDevice).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', deviceToken: '' }),
      );
      expect(response).toEqual({
        ok: true,
        data: { success: false, pushEnabled: false },
      });
    });

    it('błąd serwisu wraca jako ok:false', async () => {
      notificationsService.registerDevice.mockRejectedValue(new Error('boom'));

      const response = await gateway.registerDevice(tokenClient('user-1'), {
        data: { deviceToken: DEVICE },
      } as any);

      expect(response).toEqual(expect.objectContaining({ ok: false }));
    });

    it('rejestracja urządzenia niczego nie rozgłasza', async () => {
      await gateway.registerDevice(tokenClient('user-1'), {
        data: { deviceToken: DEVICE },
      } as any);

      expect(emit).not.toHaveBeenCalled();
      expect(to).not.toHaveBeenCalled();
    });
  });
});
