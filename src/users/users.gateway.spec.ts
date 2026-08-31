import { Test, TestingModule } from '@nestjs/testing';
import { UsersGateway } from './users.gateway';
import { UsersService } from './users.service';
import { WsTelemetryService } from '../common/ws-telemetry.service';
import { AppException } from '../common/app-exception';

// Gateway użytkownika nie rozgłasza niczego — ma na własność tylko trzy rzeczy:
// tożsamość aktora (z socketu, nie z payloadu), kopertę zdarzenia (`data` musi
// być obiektem — bez tego handler wywracał się na `TypeError` → 500) i
// rozłączenie socketów skasowanego konta po `users:delete`. Reszta to
// przekazanie do serwisu, który sam waliduje zawartość `data`.

// Prawdziwe UUID v4: legacy `payload.userId` przechodzi przez `isUuid` w
// `actorId` (nie-UUID → UNAUTHORIZED zamiast P2023).
const USER = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const VICTIM = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const LEGACY_USER = '9b2f8c1e-4d3a-4b6f-8a1c-2e5d7f9a0b3c';

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

const PREFERENCES = { dietPreference: 'VEGAN' };
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

/** Handlery z kopertą `{ data }` — tylko one walidują payload. */
const DATA_HANDLERS = HANDLERS.filter((h) => 'data' in h.payload);
/** Handlery bez wejścia — muszą przeżyć `payload === undefined`. */
const BARE_HANDLERS = HANDLERS.filter((h) => !('data' in h.payload));

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
      getPreferences: jest.fn().mockResolvedValue({ dietPreference: 'NONE' }),
      updatePreferences: jest
        .fn()
        .mockResolvedValue({ dietPreference: 'VEGAN' }),
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

  const expectNoServiceCall = () => {
    for (const method of Object.values(usersService)) {
      expect(method).not.toHaveBeenCalled();
    }
  };

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
        expectNoServiceCall();
      });

      it('socket z tokenem: payload.userId jest ignorowane', async () => {
        const response = await call(handler, tokenClient(VICTIM), {
          userId: 'attacker',
          ...payload,
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(usersService[service]).toHaveBeenCalledTimes(1);
        expect(usersService[service]).toHaveBeenCalledWith(VICTIM, ...rest);
      });

      it('socket legacy (tryb soft): tożsamość z payloadu jak dawniej', async () => {
        const response = await call(handler, legacyClient(), {
          userId: LEGACY_USER,
          ...payload,
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(usersService[service]).toHaveBeenCalledWith(
          LEGACY_USER,
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

      it('socket legacy z userId nie-UUID → UNAUTHORIZED, nie P2023', async () => {
        const response = await call(handler, legacyClient(), {
          userId: 'legacy-user',
          ...payload,
        });

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

  describe.each(BARE_HANDLERS)(
    '$event — bez wejścia',
    ({ handler, service, rest }) => {
      it('przeżywa payload === undefined (socket z tokenem)', async () => {
        const response = await call(handler, tokenClient(USER), undefined);

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(usersService[service]).toHaveBeenCalledWith(USER, ...rest);
      });
    },
  );

  describe.each(DATA_HANDLERS)(
    '$event — walidacja koperty',
    ({ handler, service }) => {
      it('brak data → VALIDATION_ERROR 400 z details, serwis nietknięty', async () => {
        const response = await call(handler, tokenClient(USER), {});

        expect(response).toEqual(
          expect.objectContaining({
            ok: false,
            code: 'VALIDATION_ERROR',
            status: 400,
            details: ['data must be an object'],
          }),
        );
        expect(usersService[service]).not.toHaveBeenCalled();
      });

      it('payload === undefined → VALIDATION_ERROR, nie TypeError → 500', async () => {
        const response = await call(handler, tokenClient(USER), undefined);

        expect(response).toEqual(
          expect.objectContaining({ ok: false, code: 'VALIDATION_ERROR' }),
        );
        expect(usersService[service]).not.toHaveBeenCalled();
      });

      it.each([
        ['string', 'VEGAN'],
        ['liczba', 7],
        ['null', null],
        ['tablica', []],
      ])('data jako %s → VALIDATION_ERROR', async (_label, data) => {
        const response = await call(handler, tokenClient(USER), { data });

        expect(response).toEqual(
          expect.objectContaining({ ok: false, code: 'VALIDATION_ERROR' }),
        );
        expect(usersService[service]).not.toHaveBeenCalled();
      });

      it('anonimowy socket bez data → UNAUTHORIZED (tożsamość przed kopertą)', async () => {
        const response = await call(handler, anonClient(), {});

        expect(response).toEqual(
          expect.objectContaining({ ok: false, code: 'UNAUTHORIZED' }),
        );
        expectNoServiceCall();
      });

      it('nieznane pola na kopercie (stare buildy) nie są błędem', async () => {
        const response = await call(handler, tokenClient(USER), {
          userId: USER,
          householdId: 'hh-1',
          data: { displayName: 'Ania' },
        });

        expect(response).toEqual(expect.objectContaining({ ok: true }));
        expect(usersService[service]).toHaveBeenCalledWith(USER, {
          displayName: 'Ania',
        });
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
      expect(response).toEqual({
        ok: true,
        data: { dietPreference: 'VEGAN' },
      });
    });

    it('błąd walidacji z serwisu (zły enum w data) wraca w acku jako VALIDATION_ERROR', async () => {
      usersService.updatePreferences.mockRejectedValue(
        new AppException('VALIDATION_ERROR', 'zły enum', 400, [
          'dietPreference must be one of the following values: NONE, VEGAN',
        ]),
      );

      const response = await gateway.updatePreferences(tokenClient(USER), {
        data: { dietPreference: 'vegan' } as any,
      });

      expect(response).toEqual(
        expect.objectContaining({
          ok: false,
          code: 'VALIDATION_ERROR',
          status: 400,
          details: [
            'dietPreference must be one of the following values: NONE, VEGAN',
          ],
        }),
      );
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
      await gateway.deleteAccount(tokenClient(VICTIM), {
        userId: 'attacker',
      });
      await flushImmediate();

      expect(usersService.deleteAccount).toHaveBeenCalledWith(VICTIM);
      expect(inRoom).toHaveBeenCalledWith(`user:${VICTIM}`);
      expect(inRoom).not.toHaveBeenCalledWith('user:attacker');
    });

    it('w trybie legacy rozłącza sockety użytkownika z payloadu', async () => {
      await gateway.deleteAccount(legacyClient(), { userId: LEGACY_USER });
      await flushImmediate();

      expect(inRoom).toHaveBeenCalledWith(`user:${LEGACY_USER}`);
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
