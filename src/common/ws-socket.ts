import { HttpStatus, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { AppException } from './app-exception';
import { isUuid } from './uuid';

// Kopia `DefaultEventsMap` z socket.io (`dist/typed-events`), której pakiet nie
// eksportuje przez `exports` — typowanie strukturalne, więc zgodna 1:1.
type DefaultEventsMap = Record<string, (...args: any[]) => void>;

/**
 * Tożsamość socketu — ustawiana RAZ przy handshake'u przez `AuthIoAdapter`
 * (`src/common/ws-auth.adapter.ts`), nigdy przez handler.
 *
 * - `token`: JWT zweryfikowany, `userId` z `sub`; `payload.userId` z klienta
 *   jest ignorowane (a rozjazd liczony w metrykach).
 * - `legacy`: socket bez tokenu wpuszczony w trybie `WS_AUTH_MODE=soft`
 *   (stare buildy iOS) — tożsamość nadal z `payload.userId`, jak przed Fazą 0.
 */
export type WsIdentityMode = 'token' | 'legacy';

export type WsSocketData = {
  userId?: string;
  /** `exp` tokenu w sekundach od epoki; `null` dla tokenu bez `exp`. */
  exp?: number | null;
  mode?: WsIdentityMode;
};

export type AppSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  WsSocketData
>;

/** Pokój socketów bez tokenu (tryb `soft`) — dostają broadcasty jak dawniej. */
export const LEGACY_ROOM = 'legacy';
export const userRoom = (userId: string): string => `user:${userId}`;
export const householdRoom = (householdId: string): string =>
  `household:${householdId}`;

export type WsAuthObserver = {
  /** Handler wykonany dla socketu legacy z tożsamością z payloadu. */
  onLegacyAct(): void;
  /** Socket z tokenem przysłał `payload.userId` inny niż `sub` tokenu. */
  onPayloadMismatch(): void;
};

let observer: WsAuthObserver | null = null;

/** Metryki bez DI — wpinane przez `ObservabilityModule`, jak `setWsErrorObserver`. */
export function setWsAuthObserver(next: WsAuthObserver | null): void {
  observer = next;
}

const logger = new Logger('WsAuth');

/**
 * Jedyne źródło „kto to robi” w handlerach WS.
 *
 * Socket z tokenem → `socket.data.userId` (payloadowe `userId` ignorowane).
 * Socket legacy (tryb `soft`, bez tokenu) → `payload.userId` jak dawniej.
 * Inaczej → `UNAUTHORIZED` 401; rzut wewnątrz `wsRespond` trafia do acka
 * (guard albo dekorator rzucający omijałby ack — iOS czekałby 3×6 s).
 */
export function actorId(
  client: Pick<AppSocket, 'data'> | undefined,
  payload?: { userId?: unknown } | null,
): string {
  const data = client?.data;
  const authed = data?.userId;
  const declared =
    typeof payload?.userId === 'string' ? payload.userId.trim() : '';

  if (authed) {
    if (declared && declared !== authed) {
      observer?.onPayloadMismatch();
      logger.warn(
        `payload.userId ${declared} ignored — socket authenticated as ${authed}`,
      );
    }
    return authed;
  }

  if (data?.mode === 'legacy' && declared) {
    // Nie-UUID trafiałby do `findUnique` po kolumnie `@db.Uuid` → P2023 → 500.
    if (!isUuid(declared)) {
      throw new AppException(
        'UNAUTHORIZED',
        'payload.userId is not a valid user id',
        HttpStatus.UNAUTHORIZED,
        ['invalid'],
      );
    }
    observer?.onLegacyAct();
    return declared;
  }

  throw new AppException(
    'UNAUTHORIZED',
    'Socket is not authenticated',
    HttpStatus.UNAUTHORIZED,
    ['missing'],
  );
}
