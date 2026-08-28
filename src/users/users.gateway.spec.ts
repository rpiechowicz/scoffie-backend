import { Test, TestingModule } from '@nestjs/testing';
import { UsersGateway } from './users.gateway';
import { UsersService } from './users.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';

// Gateway użytkownika nie rozgłasza niczego — ma na własność tylko dwie rzeczy:
// tożsamość aktora (z socketu, nie z payloadu) i rozłączenie socketów
// skasowanego konta po `users:delete`. Reszta to przekazanie do serwisu.

const USER = 'user-1';

const tokenClient = (userId: string) =>
  ({ data: { userId, mode: 'token' } }) as any;
const legacyClient = () => ({ data: { mode: 'legacy' } }) as any;
const anonClient = () => ({ data: {} }) as any;

/** `setImmediate` w gatewayu odracza rozłączenie za ack — tu czekamy na nie. */
const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

type HandlerCase = {
  event: string;
  handler: keyof UsersGateway;
  service: string;
  payload: Record<string, unknown>;
  /** Argumenty, jakich serwis ma dostać PO userId. */
  rest: unknown[];
};

const PREFERENCES = { dietTags: ['VEGAN'] };
const PROFILE = { displayName: 'Ania' };

const HANDLERS: HandlerCase[] = [
  { event: 'users:me', handler: 'me', service: 'getMe', payload: {}, rest: [] },
  {
    event: 'users:preferences:get',
    handler: 'getPreferences',
    service: 'getPreferences',
    payload: {},
    rest: [],
  },
  {
    event: 'users:preferences:update',
    handler: 'updatePreferences',
    service: 'updatePreferences',
    payload: { data: PREFERENCES },
    rest: [PREFERENCES],
  },
  {
    event: 'users:profile:update',
    handler: 'updateProfile',
    service: 'updateProfile',
    payload: { data: PROFILE },
    rest: [PROFILE],
  },
  {
    event: 'users:delete',
    handler: 'deleteAccount',
    service: 'deleteAccount',
    payload: {},
    rest: [],
  },
  {
    event: 'users:onboarding:complete',
    handler: 'completeOnboarding',
    service: 'completeOnboarding',
    payload: {},
    rest: [],
  },
];

describe('UsersGateway', () => {
  let gateway: UsersGateway;
  let usersService: Record<string, jest.Mock>;
  let emit: jest.Mock;
  let to: jest.Mock;
  let inRoom: jest.Mock;
  let socketsJoin: jest.Mock;
  let socketsLeave: jest.Mock;
  let disconnectSockets: jest.Mock;

  const call = (name: keyof UsersGateway, client: unknown, payload: unknown) =>
    (gateway[name] as any).call(gateway, client, payload) as Promise<any>;

  beforeEach(async () => {
    usersService = {
      getMe: jest.fn().mockResolvedValue({ id: USER }),
      getPreferences: jest.fn().mockResolvedValue({ dietTags: [] }),
      updatePreferences: jest.fn().mockResolvedValue({ dietTags: ['VEGAN'] }),
      updateProfile: jest.fn().mockResolvedValue({ id: USER }),
      deleteAccount: jest.fn().mockResolvedValue({ id: USER }),
      completeOnboarding: jest.fn().mockResolvedValue({ id: USER }),
    };

    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    socketsJoin = jest.fn();
    socketsLeave = jest.fn();
    disconnectSockets = jest.fn();
    inRoom = jest
      .fn()
      .mockReturnValue({ socketsJoin, socketsLeave, disconnectSockets });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersGateway,
        { provide: UsersService, useValue: usersService },
        {
          provide: WsTelemetryService,
          useValue: { onConnect: jest.fn(), onDisconnect: jest.fn() },
        },
      ],
    }).compile();

    gateway = module.get<UsersGateway>(UsersGateway);
    (gateway as any).server = { emit, to, in: inRoom };
  });

  afterEach(async () => {
    // Nie zostawiaj odroczonego rozłączenia następnemu testowi.
    await flushImmediate();
  });

  describe.each(HANDLERS)(
    '$event — tożsamość z socketu',
    ({ handler, service, payload, rest }) => {
      it('socket bez tożsamości → UNAUTHORIZED 401 w acku, serwis nietknięty', async () => {
        const response = await call(handler, anonClient(), {
          userId: 'attacker',
          ...payload,
        });

        expect(response).toEqual(
          expect.objectContaining({
            ok: false,
            code: 'UNAUTHORIZED',
            status: 401,
          }),
        );
        for (const method of Object.values(usersService)) {
          expect(method).not.toHaveBeenCalled();
        }
      });

      it('socket z tokenem: payload.userId jest ignorowane', async () => {
        const response = await call(handler, tokenClient('victim'), {
          userId: 'attacker',
          ...payload,
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(usersService[service]).toHaveBeenCalledTimes(1);
        expect(usersService[service]).toHaveBeenCalledWith('victim', ...rest);
      });

      it('socket legacy (tryb soft): tożsamość z payloadu jak dawniej', async () => {
        const response = await call(handler, legacyClient(), {
          userId: 'legacy-user',
          ...payload,
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(usersService[service]).toHaveBeenCalledWith(
          'legacy-user',
          ...rest,
        );
      });

      it('socket legacy bez userId w payloadzie → UNAUTHORIZED', async () => {
        const response = await call(handler, legacyClient(), { ...payload });

        expect(response).toEqual(
          expect.objectContaining({ ok: false, code: 'UNAUTHORIZED' }),
        );
        expect(usersService[service]).not.toHaveBeenCalled();
      });

      it('niczego nie rozgłasza', async () => {
        await call(handler, tokenClient(USER), { userId: USER, ...payload });

        expect(emit).not.toHaveBeenCalled();
        expect(to).not.toHaveBeenCalled();
      });
    },
  );

  describe('users:me', () => {
    it('zwraca profil z serwisu w kopercie ok', async () => {
      usersService.getMe.mockResolvedValue({ id: USER, email: 'a@b.c' });

      const response = await gateway.me(tokenClient(USER), {});

      expect(response).toEqual({
        ok: true,
        data: { id: USER, email: 'a@b.c' },
      });
    });
  });

  describe('users:preferences:update', () => {
    it('przekazuje data serwisowi i oddaje jego wynik', async () => {
      const response = await gateway.updatePreferences(tokenClient(USER), {
        data: PREFERENCES as any,
      });

      expect(usersService.updatePreferences).toHaveBeenCalledWith(
        USER,
        PREFERENCES,
      );
      expect(response).toEqual({ ok: true, data: { dietTags: ['VEGAN'] } });
    });
  });

  describe('users:delete', () => {
    it('po udanym skasowaniu rozłącza wszystkie sockety użytkownika — po acku', async () => {
      const response = await gateway.deleteAccount(tokenClient(USER), {});

      expect(response).toEqual({ ok: true, data: { id: USER } });
      // Ack już policzony, rozłączenie jeszcze nie — inaczej socket.io porzuciłby ack.
      expect(disconnectSockets).not.toHaveBeenCalled();

      await flushImmediate();

      expect(inRoom).toHaveBeenCalledWith(`user:${USER}`);
      expect(disconnectSockets).toHaveBeenCalledWith(true);
      expect(socketsJoin).not.toHaveBeenCalled();
      expect(socketsLeave).not.toHaveBeenCalled();
    });

    it('rozłącza konto z tokenu, nie z payloadu', async () => {
      await gateway.deleteAccount(tokenClient('victim'), {
        userId: 'attacker',
      });
      await flushImmediate();

      expect(usersService.deleteAccount).toHaveBeenCalledWith('victim');
      expect(inRoom).toHaveBeenCalledWith('user:victim');
      expect(inRoom).not.toHaveBeenCalledWith('user:attacker');
    });

    it('w trybie legacy rozłącza sockety użytkownika z payloadu', async () => {
      await gateway.deleteAccount(legacyClient(), { userId: 'legacy-user' });
      await flushImmediate();

      expect(inRoom).toHaveBeenCalledWith('user:legacy-user');
      expect(disconnectSockets).toHaveBeenCalledWith(true);
    });

    it('przy błędzie serwisu nie rozłącza socketów', async () => {
      usersService.deleteAccount.mockRejectedValue(new Error('boom'));

      const response = await gateway.deleteAccount(tokenClient(USER), {});
      await flushImmediate();

      expect(response).toEqual(expect.objectContaining({ ok: false }));
      expect(inRoom).not.toHaveBeenCalled();
      expect(disconnectSockets).not.toHaveBeenCalled();
    });

    it('bez tożsamości nie rozłącza nikogo', async () => {
      await gateway.deleteAccount(anonClient(), { userId: USER });
      await flushImmediate();

      expect(inRoom).not.toHaveBeenCalled();
      expect(disconnectSockets).not.toHaveBeenCalled();
    });
  });
});
