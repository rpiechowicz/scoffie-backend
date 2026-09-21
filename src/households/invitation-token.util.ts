import { createHash, randomBytes } from 'crypto';

/**
 * Token zaproszenia: co idzie do linku, a co do bazy.
 *
 * W bazie leży WYŁĄCZNIE `sha256(token)`. Zrzut tabeli (backup, replika,
 * podgląd w panelu) nie może być kompletem działających wejść do domów —
 * ta sama zasada co przy `RefreshToken.tokenHash`.
 *
 * Bez peppera, świadomie. Pepper chroni wejścia, które da się zgadnąć
 * (hasła, krótkie kody); tu wejściem jest 128 losowych bitów, więc haszu nie
 * da się odwrócić przeszukiwaniem i sekret nie dokłada nic. Za to kosztowałby:
 * istniejących wierszy nie dałoby się przeliczyć w migracji SQL (baza nie zna
 * sekretów), a rotacja peppera gasiłaby po cichu wszystkie otwarte linki.
 */

const INBOX_HANDLE =
  /^inv_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 16 losowych bajtów — 128 bitów wystarcza, a dłuższy token tylko wydłuża link. */
export function generateInvitationToken(): {
  token: string;
  tokenHash: string;
} {
  const token = randomBytes(16).toString('hex');
  return { token, tokenHash: hashInvitationToken(token) };
}

/**
 * Uchwyt skrzynki: `inv_<id zaproszenia>`.
 *
 * Skrzynka („przyszło do mnie zaproszenie") oddawała kiedyś surowy token,
 * żeby telefon mógł zaproszenie potem przyjąć. Po haszowaniu nie ma go skąd
 * wziąć, więc skrzynka pracuje na `invitation.id`. Uchwyt jedzie w tym samym
 * polu `token` co dotąd — wydane buildy iOS dekodują je jako wymagane
 * i odsyłają bez zaglądania do środka — ale NIE jest sekretem: działa tylko
 * dla adresata (`invitedUserId`), co sprawdza `invitationLookup`.
 *
 * Z prawdziwym tokenem się nie pomyli: token to hex, a `_` hexem nie jest.
 */
export function toInboxHandle(invitationId: string): string {
  return `inv_${invitationId}`;
}

export function parseInboxHandle(value: string): string | null {
  return INBOX_HANDLE.exec(value)?.[1].toLowerCase() ?? null;
}

/**
 * Warunek wyszukania zaproszenia po tym, co przysłał klient.
 *
 * Token z linku → po haszu. Uchwyt skrzynki → po id, ale TYLKO gdy zaproszenie
 * leży w skrzynce pytającego; dla każdego innego wygląda jak nieistniejące.
 * Id zaproszenia nie jest tajne (leży w bazie, w kluczach poczty), więc samo
 * nie może niczego otwierać.
 */
export function invitationLookup(
  userId: string,
  tokenOrHandle: string,
): { tokenHash: string } | { id: string; invitedUserId: string } {
  const invitationId = parseInboxHandle(tokenOrHandle);
  return invitationId
    ? { id: invitationId, invitedUserId: userId }
    : { tokenHash: hashInvitationToken(tokenOrHandle) };
}
