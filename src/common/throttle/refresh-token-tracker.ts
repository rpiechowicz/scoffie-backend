import { createHash } from 'crypto';

/**
 * Tracker throttlera dla `POST /auth/refresh`: SESJA, nie adres.
 *
 * Do 26.09.2026 odświeżanie liczyło się po IP, razem z logowaniem
 * (`THROTTLE_AUTH_LIMIT`, 20/min). Za CGNAT-em sieci komórkowej, w biurze czy
 * akademiku setki telefonów mają jeden adres, więc po dwudziestym odświeżeniu
 * w minucie reszta dostawała 429 — a telefon, któremu odświeżenie nie wyjdzie,
 * wylogowuje użytkownika.
 *
 * Kluczem jest hasz PRZEDSTAWIONEGO refresh tokenu (bez weryfikacji — limit
 * to nie autoryzacja i nie może dokładać zapytania do bazy każdemu żądaniu).
 * Pętla w jednym kliencie wyczerpuje wtedy własny limit, a nie cudzy.
 * Losowe tokeny dają co prawda świeży klucz na każde żądanie — przed tym
 * broni luźny bezpiecznik na IP (`THROTTLE_AUTH_REFRESH_IP_LIMIT`), a samo
 * zgadywanie 256-bitowego tokenu i tak nie wchodzi w grę.
 *
 * Guard biegnie po parserze ciała (middleware Expressa), a przed walidacją
 * DTO, więc ciało może być czymkolwiek: bez tokenu liczymy po IP. Tokenu nie
 * logujemy ani nie trzymamy — do magazynu throttlera idzie wyłącznie hasz.
 */
export function refreshTokenTracker(req: Record<string, any>): Promise<string> {
  const request = req as { ip?: string; body?: unknown };
  const body =
    request.body && typeof request.body === 'object'
      ? (request.body as { refreshToken?: unknown })
      : {};
  const token =
    typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
  if (!token) return Promise.resolve(`ip:${request.ip ?? 'unknown'}`);
  const digest = createHash('sha256').update(token).digest('hex');
  return Promise.resolve(`refresh:${digest.slice(0, 32)}`);
}
