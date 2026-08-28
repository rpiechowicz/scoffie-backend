import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { randomUUID } from 'node:crypto';
import type { Server, ServerOptions } from 'socket.io';
import {
  AccessTokenFailureReason,
  AccessTokenService,
  parseBearer,
} from '../auth/access-token.service';
import { resolveWsAuthMode, WsAuthMode } from '../config/ws-auth-mode';
import { AppSocket, LEGACY_ROOM, householdRoom, userRoom } from './ws-socket';

export type WsHandshakeOutcome =
  | { outcome: 'token' }
  | { outcome: 'legacy' }
  | { outcome: 'rejected'; reason: AccessTokenFailureReason };

export type WsHandshakeObserver = (outcome: WsHandshakeOutcome) => void;

/** Kształt `err.data` w `connect_error` — ten sam kontrakt co ack błędu. */
export type WsHandshakeRejection = {
  code: 'UNAUTHORIZED';
  message: string;
  reason: AccessTokenFailureReason;
  requestId: string;
};

const REJECTION_MESSAGES: Record<AccessTokenFailureReason, string> = {
  missing: 'Missing access token',
  invalid: 'Invalid access token',
  expired: 'Access token expired',
  user_gone: 'User no longer exists',
};

/** `setTimeout` powyżej 2^31−1 ms (24,86 dnia) odpala natychmiast. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Zdarzenie do klienta tuż przed rozłączeniem po wygaśnięciu tokenu. */
export const WS_AUTH_EXPIRED_EVENT = 'auth:expired';

type Dependencies = {
  accessTokens: Pick<AccessTokenService, 'verify'>;
  onHandshake?: WsHandshakeObserver;
  /** Czytany per handshake — e2e przełącza tryb w jednym procesie. */
  readMode?: () => WsAuthMode;
  now?: () => number;
};

/**
 * Uwierzytelnienie WebSocketu w JEDNYM miejscu.
 *
 * Pięć gatewayów dzieli jeden serwer Socket.IO (ten sam port, bez
 * namespace'u), więc `handleConnection` każdego z nich biegnie 5× na socket;
 * middleware `server.use` biegnie raz, PRZED `connection`, i odrzuca handshake
 * czysto: klient dostaje `connect_error` z `{message, data:{code, reason}}`,
 * a nie `connect` i zaraz `disconnect`. Guard per handler nie wchodzi w grę —
 * wyjątek z guarda omija ack (`exception`), a iOS czeka wtedy 3×6 s.
 *
 * Wynik handshake'u ląduje w `socket.data` (`ws-socket.ts`), pokoje
 * `user:<id>` + `household:<id>` (albo `legacy`) w `socket.rooms`, a timer
 * wygaśnięcia rozłącza socket, gdy minie `exp` tokenu (`disconnect(false)`:
 * pakiet DISCONNECT bez zamykania engine — klient socket.io-client-swift nie
 * wpada wtedy w auto-reconnect ze starym payloadem, tylko woła
 * `connect(withPayload:)` z odświeżonym tokenem).
 */
export class AuthIoAdapter extends IoAdapter {
  private readonly logger = new Logger(AuthIoAdapter.name);
  private readonly deps: Required<Dependencies>;
  private readonly expiryTimers = new WeakMap<object, NodeJS.Timeout>();

  constructor(app: INestApplicationContext, deps: Dependencies) {
    super(app);
    this.deps = {
      accessTokens: deps.accessTokens,
      onHandshake: deps.onHandshake ?? (() => undefined),
      readMode: deps.readMode ?? (() => resolveWsAuthMode(process.env)),
      now: deps.now ?? (() => Date.now()),
    };
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    server.use((socket, next) => {
      this.authenticate(socket as AppSocket).then(
        () => next(),
        (error: unknown) => next(toExtendedError(error)),
      );
    });
    return server;
  }

  /** Publiczne dla testów: ten sam kod, co w middleware. */
  async authenticate(socket: AppSocket): Promise<void> {
    const mode = this.deps.readMode();
    const token = extractToken(socket);

    if (!token) {
      if (mode === 'strict') {
        throw this.reject('missing');
      }
      socket.data.mode = 'legacy';
      socket.data.userId = undefined;
      socket.data.exp = undefined;
      await socket.join(LEGACY_ROOM);
      this.deps.onHandshake({ outcome: 'legacy' });
      return;
    }

    const verdict = await this.deps.accessTokens.verify(token);
    if (!verdict.ok) {
      throw this.reject(verdict.reason);
    }

    socket.data.mode = 'token';
    socket.data.userId = verdict.userId;
    socket.data.exp = verdict.exp;
    await socket.join([
      userRoom(verdict.userId),
      ...verdict.householdIds.map(householdRoom),
    ]);
    this.armExpiry(socket);
    this.deps.onHandshake({ outcome: 'token' });
  }

  private reject(reason: AccessTokenFailureReason): WsHandshakeError {
    this.deps.onHandshake({ outcome: 'rejected', reason });
    return new WsHandshakeError(reason);
  }

  private armExpiry(socket: AppSocket): void {
    const exp = socket.data.exp;
    if (!exp) return;

    const schedule = (): void => {
      const remaining = exp * 1000 - this.deps.now();
      if (remaining <= 0) {
        this.logger.log(
          `access token expired for user ${socket.data.userId ?? '?'} — disconnecting socket ${socket.id}`,
        );
        socket.emit(WS_AUTH_EXPIRED_EVENT, {
          code: 'UNAUTHORIZED',
          reason: 'expired',
        });
        socket.disconnect(false);
        return;
      }
      const timer = setTimeout(schedule, Math.min(remaining, MAX_TIMEOUT_MS));
      timer.unref?.();
      this.expiryTimers.set(socket, timer);
    };

    schedule();
    socket.once('disconnect', () => {
      const timer = this.expiryTimers.get(socket);
      if (timer) clearTimeout(timer);
      this.expiryTimers.delete(socket);
    });
  }
}

/** `handshake.auth.token` (connect payload) albo `Authorization: Bearer`. */
export function extractToken(socket: AppSocket): string | null {
  const auth = socket.handshake?.auth as { token?: unknown } | undefined;
  if (typeof auth?.token === 'string' && auth.token.trim()) {
    return auth.token.trim();
  }
  return parseBearer(socket.handshake?.headers?.authorization);
}

export class WsHandshakeError extends Error {
  readonly data: WsHandshakeRejection;

  constructor(reason: AccessTokenFailureReason) {
    super(REJECTION_MESSAGES[reason]);
    this.name = 'WsHandshakeError';
    this.data = {
      code: 'UNAUTHORIZED',
      message: REJECTION_MESSAGES[reason],
      reason,
      requestId: randomUUID(),
    };
  }
}

function toExtendedError(error: unknown): Error & { data?: unknown } {
  if (error instanceof WsHandshakeError) return error;
  // Awaria weryfikacji (np. baza) — odmowa bez zdradzania szczegółów; log
  // z requestId, żeby dało się to odnaleźć.
  const rejection = new WsHandshakeError('invalid');
  new Logger(AuthIoAdapter.name).error(
    `handshake failed requestId=${rejection.data.requestId}: ${
      error instanceof Error ? error.message : String(error)
    }`,
    error instanceof Error ? error.stack : undefined,
  );
  return rejection;
}
