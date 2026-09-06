import { Logger } from '@nestjs/common';
import { AccessTokenVerdict } from '../auth/access-token.service';
import {
  AuthIoAdapter,
  clientIp,
  extractToken,
  WS_AUTH_EXPIRED_EVENT,
  WS_AUTH_EXPIRY_GRACE_MS,
  WsHandshakeError,
  WsHandshakeOutcome,
  WsHandshakeUnavailableError,
} from './ws-auth.adapter';

type FakeSocket = {
  id: string;
  data: Record<string, unknown>;
  handshake: { auth: Record<string, unknown>; headers: Record<string, string> };
  join: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  once: jest.Mock;
  listeners: Record<string, () => void>;
};

const makeSocket = (
  auth: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): FakeSocket => {
  const listeners: Record<string, () => void> = {};
  return {
    id: 'sock-1',
    data: {},
    handshake: { auth, headers },
    join: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
    once: jest.fn((event: string, cb: () => void) => {
      listeners[event] = cb;
    }),
    listeners,
  };
};

const GOOD: AccessTokenVerdict = {
  ok: true,
  userId: 'user-1',
  exp: null,
};

describe('clientIp', () => {
  const socketWith = (headers: Record<string, unknown>, address = '10.0.0.9') =>
    ({ handshake: { address, headers } }) as Parameters<typeof clientIp>[0];

  it('bierze OSTATNI wpis x-forwarded-for — ten dopisany przez proxy', () => {
    // Klient przysłał własny nagłówek z obcym adresem, proxy Railway dopisało
    // prawdziwy. Limit per IP ma liczyć ten prawdziwy, nie podstawiony.
    expect(
      clientIp(socketWith({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })),
    ).toBe('203.0.113.7');
    expect(
      clientIp(socketWith({ 'x-forwarded-for': ['1.1.1.1', ' 203.0.113.7 '] })),
    ).toBe('203.0.113.7');
  });

  it('bez nagłówka wraca adres gniazda, bez niczego — unknown', () => {
    expect(clientIp(socketWith({}))).toBe('10.0.0.9');
    expect(clientIp(socketWith({ 'x-forwarded-for': ' , ' }))).toBe('10.0.0.9');
    expect(clientIp({ handshake: { headers: {} } })).toBe('unknown');
  });
});

const makeAdapter = (opts: {
  verdict?: AccessTokenVerdict;
  verifyThrows?: Error;
  households?: string[];
  mode?: 'soft' | 'strict';
  now?: () => number;
}) => {
  const verify = opts.verifyThrows
    ? jest.fn().mockRejectedValue(opts.verifyThrows)
    : jest.fn().mockResolvedValue(opts.verdict ?? GOOD);
  const householdIds = jest
    .fn()
    .mockResolvedValue(opts.households ?? ['hh-1', 'hh-2']);
  const outcomes: WsHandshakeOutcome[] = [];
  // Konstruktor IoAdapter czyta tylko `getUnderlyingHttpServer` — atrapa
  // aplikacji wystarcza, serwer Socket.IO nie powstaje w tym teście.
  const app = { getUnderlyingHttpServer: () => ({}) } as never;
  const adapter = new AuthIoAdapter(app, {
    accessTokens: { verify, householdIds },
    onHandshake: (o) => outcomes.push(o),
    readMode: () => opts.mode ?? 'soft',
    now: opts.now,
  });
  return { adapter, verify, householdIds, outcomes };
};

/** Ścieżka runtime: middleware, potem `connection` uzbraja timer. */
const connectAuthenticated = async (
  adapter: AuthIoAdapter,
  socket: FakeSocket,
): Promise<void> => {
  await adapter.authenticate(socket as never);
  adapter.armExpiry(socket as never);
};

describe('extractToken', () => {
  it('woli handshake.auth.token, potem Authorization: Bearer', () => {
    expect(
      extractToken(
        makeSocket(
          { token: ' abc ' },
          { authorization: 'Bearer xyz' },
        ) as never,
      ),
    ).toBe('abc');
    expect(
      extractToken(makeSocket({}, { authorization: 'Bearer xyz' }) as never),
    ).toBe('xyz');
    expect(extractToken(makeSocket({ token: 42 }) as never)).toBeNull();
    expect(extractToken(makeSocket() as never)).toBeNull();
  });
});

describe('AuthIoAdapter.authenticate', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('poprawny token → socket.data, najpierw user:<id>, potem household:*, outcome token', async () => {
    const { adapter, householdIds, outcomes } = makeAdapter({});
    const socket = makeSocket({ token: 'good' });

    await adapter.authenticate(socket as never);

    expect(socket.data).toEqual({ mode: 'token', userId: 'user-1', exp: null });
    expect(socket.join).toHaveBeenNthCalledWith(1, 'user:user-1');
    expect(socket.join).toHaveBeenNthCalledWith(2, [
      'household:hh-1',
      'household:hh-2',
    ]);
    // Odczyt członkostw dopiero po wejściu do `user:<id>` — inaczej
    // równoległe `joinHousehold` mogłoby ominąć ten socket.
    expect(householdIds.mock.invocationCallOrder[0]).toBeGreaterThan(
      socket.join.mock.invocationCallOrder[0],
    );
    expect(outcomes).toEqual([{ outcome: 'token' }]);
  });

  it('bez członkostw dołącza tylko do user:<id>', async () => {
    const { adapter } = makeAdapter({ households: [] });
    const socket = makeSocket({ token: 'good' });
    await adapter.authenticate(socket as never);
    expect(socket.join).toHaveBeenCalledTimes(1);
    expect(socket.join).toHaveBeenCalledWith('user:user-1');
  });

  it('token, którego exp minął w trakcie weryfikacji → odmowa expired (disconnect w middleware to no-op)', async () => {
    const now = 1_000_000_000_000;
    const { adapter, outcomes } = makeAdapter({
      verdict: { ...GOOD, exp: now / 1000 - 1 },
      now: () => now,
    });
    const socket = makeSocket({ token: 'stale' });

    const error = await adapter
      .authenticate(socket as never)
      .catch((e: unknown) => e);

    expect((error as WsHandshakeError).data.reason).toBe('expired');
    expect(socket.join).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ outcome: 'rejected', reason: 'expired' }]);
  });

  it.each([
    ['soft', 'invalid'],
    ['soft', 'expired'],
    ['soft', 'user_gone'],
    ['strict', 'invalid'],
  ] as const)(
    'tryb %s, token odrzucony (%s) → WsHandshakeError z data.code UNAUTHORIZED',
    async (mode, reason) => {
      const { adapter, outcomes } = makeAdapter({
        mode,
        verdict: { ok: false, reason },
      });
      const socket = makeSocket({ token: 'bad' });

      const error = await adapter
        .authenticate(socket as never)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WsHandshakeError);
      expect((error as WsHandshakeError).data).toMatchObject({
        code: 'UNAUTHORIZED',
        reason,
        requestId: expect.any(String),
      });
      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.data.userId).toBeUndefined();
      expect(outcomes).toEqual([{ outcome: 'rejected', reason }]);
    },
  );

  it('tryb soft, brak tokenu → legacy: pokój legacy, bez userId, bez weryfikacji', async () => {
    const { adapter, verify, outcomes } = makeAdapter({ mode: 'soft' });
    const socket = makeSocket();

    await adapter.authenticate(socket as never);

    expect(verify).not.toHaveBeenCalled();
    expect(socket.data).toEqual({
      mode: 'legacy',
      userId: undefined,
      exp: undefined,
    });
    expect(socket.join).toHaveBeenCalledWith('legacy');
    expect(outcomes).toEqual([{ outcome: 'legacy' }]);
  });

  it('tryb strict, brak tokenu → odmowa missing', async () => {
    const { adapter, verify, outcomes } = makeAdapter({ mode: 'strict' });
    const socket = makeSocket();

    const error = await adapter
      .authenticate(socket as never)
      .catch((e: unknown) => e);

    expect((error as WsHandshakeError).data.reason).toBe('missing');
    expect((error as WsHandshakeError).message).toBe('Missing access token');
    expect(verify).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ outcome: 'rejected', reason: 'missing' }]);
  });

  it('token z nagłówka Authorization też przechodzi', async () => {
    const { adapter, verify } = makeAdapter({ mode: 'strict' });
    const socket = makeSocket({}, { authorization: 'Bearer hdr' });

    await adapter.authenticate(socket as never);

    expect(verify).toHaveBeenCalledWith('hdr');
    expect(socket.data.userId).toBe('user-1');
  });

  it('awaria weryfikacji (baza) → SERVICE_UNAVAILABLE, nie UNAUTHORIZED', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { adapter, outcomes } = makeAdapter({
      verifyThrows: new Error('db down'),
    });
    const socket = makeSocket({ token: 'good' });

    // Ta sama ścieżka co w middleware: odrzucenie przechodzi przez
    // `toExtendedError`, które jest prywatne — wołamy przez createIOServer? Nie:
    // sprawdzamy kontrakt przez instancję błędu i obserwatora.
    const error = await adapter
      .authenticate(socket as never)
      .catch((e: unknown) =>
        (
          adapter as unknown as {
            toExtendedError: (e: unknown) => Error & { data?: unknown };
          }
        ).toExtendedError(e),
      );

    expect(error).toBeInstanceOf(WsHandshakeUnavailableError);
    expect((error as WsHandshakeUnavailableError).data).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      requestId: expect.any(String),
    });
    expect(outcomes).toEqual([{ outcome: 'unavailable' }]);
    expect(socket.join).not.toHaveBeenCalled();
  });

  describe('timer wygaśnięcia', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('po exp emituje auth:expired i rozłącza bez zamykania engine', async () => {
      let now = 1_000_000_000_000;
      const { adapter } = makeAdapter({
        verdict: { ...GOOD, exp: now / 1000 + 60 },
        now: () => now,
      });
      const socket = makeSocket({ token: 'good' });
      await connectAuthenticated(adapter, socket);

      now += 59_000;
      jest.advanceTimersByTime(59_000);
      expect(socket.disconnect).not.toHaveBeenCalled();

      now += 1_000;
      jest.advanceTimersByTime(1_000);
      expect(socket.emit).toHaveBeenCalledWith(WS_AUTH_EXPIRED_EVENT, {
        code: 'UNAUTHORIZED',
        reason: 'expired',
      });
      // Karencja na ack handlera w toku — rozłączenie dopiero po niej.
      expect(socket.disconnect).not.toHaveBeenCalled();
      now += WS_AUTH_EXPIRY_GRACE_MS;
      jest.advanceTimersByTime(WS_AUTH_EXPIRY_GRACE_MS);
      expect(socket.disconnect).toHaveBeenCalledWith(false);
    });

    it('timer nie powstaje w middleware — dopiero armExpiry po connection', async () => {
      const now = 1_000_000_000_000;
      const { adapter } = makeAdapter({
        verdict: { ...GOOD, exp: now / 1000 + 60 },
        now: () => now,
      });
      const socket = makeSocket({ token: 'good' });
      await adapter.authenticate(socket as never);
      expect(jest.getTimerCount()).toBe(0);
      adapter.armExpiry(socket as never);
      expect(jest.getTimerCount()).toBe(1);
    });

    it('socket legacy nie dostaje timera', () => {
      const { adapter } = makeAdapter({});
      const socket = makeSocket();
      socket.data = { mode: 'legacy', exp: 123 };
      adapter.armExpiry(socket as never);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('exp dalej niż 2^31−1 ms (JWT 30 dni) nie rozłącza od razu — timer jest re-armowany', async () => {
      let now = 1_000_000_000_000;
      const thirtyDays = 30 * 24 * 3600;
      const { adapter } = makeAdapter({
        verdict: { ...GOOD, exp: now / 1000 + thirtyDays },
        now: () => now,
      });
      const socket = makeSocket({ token: 'good' });
      await connectAuthenticated(adapter, socket);

      // Pierwszy odcinek to klamp 2^31−1 ms; po nim socket ma nadal żyć.
      now += 2 ** 31 - 1;
      jest.advanceTimersByTime(2 ** 31 - 1);
      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(1);

      now += thirtyDays * 1000;
      jest.advanceTimersByTime(thirtyDays * 1000 + WS_AUTH_EXPIRY_GRACE_MS);
      expect(socket.disconnect).toHaveBeenCalledWith(false);
    });

    it('rozłączenie klienta czyści timer', async () => {
      const now = 1_000_000_000_000;
      const { adapter } = makeAdapter({
        verdict: { ...GOOD, exp: now / 1000 + 60 },
        now: () => now,
      });
      const socket = makeSocket({ token: 'good' });
      await connectAuthenticated(adapter, socket);
      expect(jest.getTimerCount()).toBe(1);

      socket.listeners.disconnect();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('token bez exp nie dostaje timera', async () => {
      const { adapter } = makeAdapter({ verdict: { ...GOOD, exp: null } });
      const socket = makeSocket({ token: 'good' });
      await connectAuthenticated(adapter, socket);
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
