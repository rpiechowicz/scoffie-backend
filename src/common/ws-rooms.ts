import type { Server } from 'socket.io';
import { LEGACY_ROOM, householdRoom, userRoom } from './ws-socket';

/**
 * Broadcasty i pokoje per gospodarstwo.
 *
 * Do Fazy 0 każdy `server.emit` szedł do WSZYSTKICH socketów w systemie
 * (11 miejsc): lista domowników z e-mailami, klucze produktów, sloty planu
 * cudzych domów — a iOS filtrował po `householdId` u siebie. Teraz zdarzenie
 * gospodarstwa trafia do pokoju `household:<id>` (sockety z tokenem dołączają
 * do pokoi swoich członkostw przy handshake'u) oraz do pokoju `legacy`
 * (sockety bez tokenu w trybie `soft` — one nadal filtrują po stronie
 * klienta). W trybie `strict` pokój `legacy` jest pusty i wyciek znika.
 *
 * Pokoje żywych socketów aktualizuje się przy zmianie członkostwa przez
 * `server.in(user:<id>)` — user może mieć kilka socketów naraz (iOS tworzy
 * ich kilka), a `socketsJoin/socketsLeave` działają też przez adapter Redis,
 * gdyby kiedyś pojawiła się druga instancja.
 *
 * Kolejność ma znaczenie: JOIN przed emitem do nowego domu (nowy domownik ma
 * dostać `membersChanged`), EMIT przed LEAVE dla odchodzącego/usuwanego —
 * iOS wykrywa „usunięto mnie" po braku własnego id w `members` z tego
 * zdarzenia, więc musi je jeszcze dostać.
 */
type RoomServer = Pick<Server, 'to' | 'in'> | null | undefined;

export function broadcastToHousehold(
  server: RoomServer,
  householdId: string,
  event: string,
  body: unknown,
): void {
  server?.to([householdRoom(householdId), LEGACY_ROOM]).emit(event, body);
}

export function joinHousehold(
  server: RoomServer,
  userId: string,
  householdId: string,
): void {
  server?.in(userRoom(userId)).socketsJoin(householdRoom(householdId));
}

export function leaveHousehold(
  server: RoomServer,
  userId: string,
  householdId: string,
): void {
  server?.in(userRoom(userId)).socketsLeave(householdRoom(householdId));
}

/** Po `users:delete`: ważny JWT skasowanego konta nie może dalej pracować. */
export function disconnectUser(server: RoomServer, userId: string): void {
  server?.in(userRoom(userId)).disconnectSockets(true);
}

/**
 * Serwer socketów widziany spoza gatewayów — wpinany raz, jak
 * `setWsAuthObserver` w `ws-socket.ts`.
 *
 * Potrzebny, bo unieważnienie sesji zapada w `AuthService` (REST), a socket
 * żyje w warstwie WS. Statyczny rejestr zamiast wstrzykiwania: gatewaye
 * dostają ten sam egzemplarz serwera Socket.IO, a `AuthService` nie ma się
 * po co dowiadywać o istnieniu pięciu gatewayów.
 */
let sessionServer: RoomServer = undefined;

export function setSessionSocketServer(server: RoomServer): void {
  sessionServer = server;
}

/**
 * Zrywa WSZYSTKIE otwarte połączenia użytkownika po unieważnieniu sesji.
 *
 * AUDYT 12.09.2026 (P1.9). `tokenVersion` był sprawdzany WYŁĄCZNIE
 * w `AccessTokenService.verify`, a ten po stronie WS woła się jeden raz —
 * przy handshake'u. Handler bierze potem tożsamość z `socket.data`, więc po
 * wykryciu kradzieży (`revokeTokenFamily`) i po wylogowaniu ze wszystkich
 * urządzeń (`logoutEverywhere`) żądania REST atakującego dostawały 401,
 * ale JEGO OTWARTY SOCKET pracował dalej — aż do wygaśnięcia access tokenu,
 * czyli nawet godzinę. Przez ten czas czytał i zapisywał plan, listę zakupów
 * i przepisy domu. Komentarz przy `tokenVersion` obiecywał „unieważnia
 * natychmiast"; na kanale WS ta obietnica była nieprawdziwa.
 *
 * `setImmediate` jak przy `users:delete`: rozłączenie ma pójść PO odesłaniu
 * bieżącej odpowiedzi, żeby wołający dostał swój ack, a nie urwane połączenie.
 */
export function disconnectRevokedUser(userId: string): void {
  if (!sessionServer) return;
  setImmediate(() => disconnectUser(sessionServer, userId));
}
