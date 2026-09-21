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
import { allowWsHandshake } from './ws-rate-limit';
import { AppSocket, LEGACY_ROOM, householdRoom, userRoom } from './ws-socket';

export type WsHandshakeOutcome =
  | { outcome: 'token' }
  | { outcome: 'legacy' }
  | { outcome: 'rejected'; reason: AccessTokenFailureReason }
  /** Awaria weryfikacji (baza) — nie odmowa; klient ma próbować dalej. */
  | { outcome: 'unavailable' };

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
  rate_limited: 'Too many connection attempts',
};

/** `setTimeout` powyżej 2^31−1 ms (24,86 dnia) odpala natychmiast. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/**
 * Po `auth:expired` handler w toku ma jeszcze chwilę na ack — rozłączenie
 * w połowie mutacji zostawiałoby zapis bez odpowiedzi (iOS czekałby 3×6 s).
 */
export const WS_AUTH_EXPIRY_GRACE_MS = 1000;

/** Zdarzenie do klienta tuż przed rozłączeniem po wygaśnięciu tokenu. */
export const WS_AUTH_EXPIRED_EVENT = 'auth:expired';

type Dependencies = {
  accessTokens: Pick<AccessTokenService, 'verify' | 'householdIds'>;
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
 * `connect(withPayload:)` z odświeżonym tokenem). Timer uzbraja się dopiero
 * na `connection`, nie w middleware: socket zamknięty w trakcie weryfikacji
 * nigdy nie dostaje `disconnect`, więc timer z middleware wisiałby do `exp`.
 *
 * Awaria samej weryfikacji (baza) NIE jest odmową: klient dostaje
 * `SERVICE_UNAVAILABLE` i zostawia sobie auto-reconnect — `UNAUTHORIZED`
 * kazałby nowemu buildowi iOS zatrzymać reconnect i odświeżać token na darmo.
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
      // Limit per IP PRZED tokenem: odrzucenie tu nie kosztuje zapytania
      // do bazy, a to jest jedyna obrona przed zalewem samych połączeń.
      if (!allowWsHandshake(clientIp(socket), this.deps.now())) {
        next(this.toExtendedError(this.reject('rate_limited')));
        return;
      }
      this.authenticate(socket as AppSocket).then(
        () => next(),
        (error: unknown) => next(this.toExtendedError(error)),
      );
    });
    // Nasz listener jest zarejestrowany PRZED listenerami gatewayów Nesta
    // (`bindClientConnect` biegnie później), więc timer jest uzbrojony,
    // zanim jakikolwiek handler dostanie socket.
    server.on('connection', (socket) => this.armExpiry(socket as AppSocket));
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
    // jsonwebtoken liczy `exp` w pełnych sekundach, więc token przechodzi
    // weryfikację do ~1 s po czasie; po dłuższym `findUnique` `exp` może już
    // minąć — w middleware `disconnect(false)` jest no-opem, więc odmawiamy
    // od razu (klient odświeży token i połączy się ponownie).
    if (verdict.exp !== null && verdict.exp * 1000 <= this.deps.now()) {
      throw this.reject('expired');
    }

    socket.data.mode = 'token';
    socket.data.userId = verdict.userId;
    socket.data.exp = verdict.exp;
    // Najpierw `user:<id>`, potem odczyt członkostw: `joinHousehold` z
    // równoległego `households:create`/`acceptInvitation` adresuje sockety
    // przez `user:<id>`, więc albo odczyt widzi nowe członkostwo, albo join
    // już trafia w ten socket — bez okna, w którym ginie oba.
    await socket.join(userRoom(verdict.userId));
    const householdIds = await this.deps.accessTokens.householdIds(
      verdict.userId,
    );
    if (householdIds.length > 0) {
      await socket.join(householdIds.map(householdRoom));
      // Drugi odczyt PO dołączeniu (audyt 21.09.2026). Usunięcie domownika,
      // które zatwierdziło się po pierwszym odczycie, a `leaveHousehold`
      // wykonało przed `join` powyżej, zostawiało świeży socket w pokoju
      // cudzego już domu aż do wygaśnięcia tokenu — z planem, listą zakupów
      // i składem domu w broadcastach. Teraz: albo ten odczyt widzi usunięcie
      // i sam wyprowadza socket, albo `leaveHousehold` biegnie po nim i trafia
      // w socket, który w pokoju już jest.
      const current = new Set(
        await this.deps.accessTokens.householdIds(verdict.userId),
      );
      for (const householdId of householdIds) {
        if (!current.has(householdId)) {
          await socket.leave(householdRoom(householdId));
        }
      }
    }
    this.deps.onHandshake({ outcome: 'token' });
  }

  private reject(reason: AccessTokenFailureReason): WsHandshakeError {
    this.deps.onHandshake({ outcome: 'rejected', reason });
    return new WsHandshakeError(reason);
  }

  /** Publiczne dla testów; w runtime wołane z `connection`. */
  armExpiry(socket: AppSocket): void {
    const exp = socket.data.exp;
    if (!exp || socket.data.mode !== 'token') return;

    const arm = (delay: number, next: () => void): void => {
      const timer = setTimeout(next, delay);
      timer.unref?.();
      this.expiryTimers.set(socket, timer);
    };

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
        arm(WS_AUTH_EXPIRY_GRACE_MS, () => socket.disconnect(false));
        return;
      }
      arm(Math.min(remaining, MAX_TIMEOUT_MS), schedule);
    };

    schedule();
    socket.once('disconnect', () => {
      const timer = this.expiryTimers.get(socket);
      if (timer) clearTimeout(timer);
      this.expiryTimers.delete(socket);
    });
  }

  private toExtendedError(error: unknown): Error & { data?: unknown } {
    if (error instanceof WsHandshakeError) return error;
    // Awaria weryfikacji (np. baza) — to nie odmowa: klient zostaje przy
    // auto-reconnect z backoffem i wraca sam, gdy baza wróci.
    const unavailable = new WsHandshakeUnavailableError();
    this.deps.onHandshake({ outcome: 'unavailable' });
    this.logger.error(
      `handshake failed requestId=${unavailable.data.requestId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error.stack : undefined,
    );
    return unavailable;
  }
}

/**
 * Adres klienta — za proxy Railway OSTATNI wpis `x-forwarded-for`.
 *
 * Proxy DOPISUJE adres, z którego przyszło połączenie, na koniec listy;
 * wszystko wcześniej to treść nagłówka przysłana przez klienta. Pierwszy wpis
 * był więc wartością pod kontrolą atakującego: limit handshake'ów per IP
 * dało się ominąć, rotując nagłówek. Ostatni wpis to to samo, co Express z
 * `trust proxy 1` daje w `req.ip` dla HTTP — obie ścieżki liczą ten sam adres.
 */
export function clientIp(socket: {
  handshake?: { address?: string; headers?: Record<string, unknown> };
}): string {
  const forwarded = socket.handshake?.headers?.['x-forwarded-for'];
  const raw = Array.isArray(forwarded)
    ? forwarded[forwarded.length - 1]
    : typeof forwarded === 'string'
      ? forwarded
      : '';
  const last = String(raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .pop();
  return last || socket.handshake?.address || 'unknown';
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

/** Awaria po naszej stronie w trakcie handshake'u — klient ma spróbować później. */
export class WsHandshakeUnavailableError extends Error {
  readonly data: {
    code: 'SERVICE_UNAVAILABLE';
    message: string;
    requestId: string;
  };

  constructor() {
    super('Authentication temporarily unavailable');
    this.name = 'WsHandshakeUnavailableError';
    this.data = {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Authentication temporarily unavailable',
      requestId: randomUUID(),
    };
  }
}
