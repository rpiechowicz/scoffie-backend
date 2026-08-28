import { Logger } from '@nestjs/common';
import { AccessTokenVerdict } from '../auth/access-token.service';
import {
  AuthIoAdapter,
  extractToken,
  WS_AUTH_EXPIRED_EVENT,
  WsHandshakeError,
  WsHandshakeOutcome,
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
  householdIds: ['hh-1', 'hh-2'],
};

const makeAdapter = (opts: {
  verdict?: AccessTokenVerdict;
  mode?: 'soft' | 'strict';
  now?: () => number;
}) => {
  const verify = jest.fn().mockResolvedValue(opts.verdict ?? GOOD);
  const outcomes: WsHandshakeOutcome[] = [];
  // Konstruktor IoAdapter czyta tylko `getUnderlyingHttpServer` — atrapa
  // aplikacji wystarcza, serwer Socket.IO nie powstaje w tym teście.
  const app = { getUnderlyingHttpServer: () => ({}) } as never;
  const adapter = new AuthIoAdapter(app, {
    accessTokens: { verify },
    onHandshake: (o) => outcomes.push(o),
    readMode: () => opts.mode ?? 'soft',
    now: opts.now,
  });
  return { adapter, verify, outcomes };
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

  it('poprawny token → socket.data, pokoje user:/household:*, outcome token', async () => {
    const { adapter, outcomes } = makeAdapter({});
    const socket = makeSocket({ token: 'good' });

    await adapter.authenticate(socket as never);

    expect(socket.data).toEqual({ mode: 'token', userId: 'user-1', exp: null });
    expect(socket.join).toHaveBeenCalledWith([
      'user:user-1',
      'household:hh-1',
      'household:hh-2',
    ]);
    expect(outcomes).toEqual([{ outcome: 'token' }]);
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
      await adapter.authenticate(socket as never);

      now += 59_000;
      jest.advanceTimersByTime(59_000);
      expect(socket.disconnect).not.toHaveBeenCalled();

      now += 2_000;
      jest.advanceTimersByTime(2_000);
      expect(socket.emit).toHaveBeenCalledWith(WS_AUTH_EXPIRED_EVENT, {
        code: 'UNAUTHORIZED',
        reason: 'expired',
      });
      expect(socket.disconnect).toHaveBeenCalledWith(false);
    });

    it('exp dalej niż 2^31−1 ms (JWT 30 dni) nie rozłącza od razu — timer jest re-armowany', async () => {
      let now = 1_000_000_000_000;
      const thirtyDays = 30 * 24 * 3600;
      const { adapter } = makeAdapter({
        verdict: { ...GOOD, exp: now / 1000 + thirtyDays },
        now: () => now,
      });
      const socket = makeSocket({ token: 'good' });
      await adapter.authenticate(socket as never);

      // Pierwszy odcinek to klamp 2^31−1 ms; po nim socket ma nadal żyć.
      now += 2 ** 31 - 1;
      jest.advanceTimersByTime(2 ** 31 - 1);
      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(1);

      now += thirtyDays * 1000;
      jest.advanceTimersByTime(thirtyDays * 1000);
      expect(socket.disconnect).toHaveBeenCalledWith(false);
    });

    it('rozłączenie klienta czyści timer', async () => {
      const now = 1_000_000_000_000;
      const { adapter } = makeAdapter({
        verdict: { ...GOOD, exp: now / 1000 + 60 },
        now: () => now,
      });
      const socket = makeSocket({ token: 'good' });
      await adapter.authenticate(socket as never);
      expect(jest.getTimerCount()).toBe(1);

      socket.listeners.disconnect();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('token bez exp nie dostaje timera', async () => {
      const { adapter } = makeAdapter({ verdict: { ...GOOD, exp: null } });
      const socket = makeSocket({ token: 'good' });
      await adapter.authenticate(socket as never);
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
