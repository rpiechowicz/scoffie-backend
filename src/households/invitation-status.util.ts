/**
 * Co zaproszenie oznacza dla konkretnego użytkownika.
 *
 * Wydzielone z serwisu, bo kolejność tych warunków jest znacząca, a w metodzie
 * naszpikowanej zapytaniami do bazy nie dało się jej ani przeczytać, ani
 * przetestować. Pytanie „jaki to status" nie potrzebuje bazy — wystarczą cztery
 * fakty o zaproszeniu i o pytającym.
 */
export type InvitationStatus =
  | 'PENDING'
  | 'REQUIRES_LEAVE'
  | 'ALREADY_MEMBER'
  | 'EXPIRED'
  | 'REDEEMED'
  | 'DECLINED'
  | 'NOT_FOUND';

export interface InvitationStatusInput {
  redeemedAt: Date | null;
  declinedAt: Date | null;
  expiresAt: Date;
  /** Czy pytający jest już w gospodarstwie, do którego zaprasza ten link. */
  isAlreadyMember: boolean;
  /** Czy pytający należy do JAKIEGOŚ INNEGO gospodarstwa. */
  belongsToAnotherHousehold: boolean;
  now?: Date;
}

/**
 * Kolejność jest hierarchiczna i celowa:
 *
 * 1. `ALREADY_MEMBER` przed wszystkim — komuś, kto już tam jest, nie mówimy
 *    „wygasło", bo to sugerowałoby, że coś stracił.
 * 2. `REDEEMED` / `DECLINED` / `EXPIRED` — stany zamknięte, po których nie ma
 *    czego proponować.
 * 3. `REQUIRES_LEAVE` na końcu, bo to JEDYNY status, który wciąż jest
 *    zaproszeniem: różni się od `PENDING` tylko tym, że przyjęcie kosztuje
 *    wyjście z obecnego domu. Wcześniej tego rozróżnienia nie było i taki
 *    użytkownik dostawał `PENDING`, po czym przyjęcie po cichu dopisywało mu
 *    drugie członkostwo, którego aplikacja nigdzie nie pokazywała.
 */
export function resolveInvitationStatus(
  input: InvitationStatusInput,
): InvitationStatus {
  if (input.isAlreadyMember) return 'ALREADY_MEMBER';
  if (input.redeemedAt) return 'REDEEMED';
  if (input.declinedAt) return 'DECLINED';
  if (input.expiresAt.getTime() < (input.now ?? new Date()).getTime()) {
    return 'EXPIRED';
  }
  return input.belongsToAnotherHousehold ? 'REQUIRES_LEAVE' : 'PENDING';
}

/**
 * Czy to zaproszenie ma trafić do skrzynki adresata.
 *
 * Tylko takie, które adresat MOŻE jeszcze przyjąć. Odłożenie wykorzystanego
 * albo wygasłego dołożyłoby mu pozycję, w którą nigdy nie kliknie.
 */
export function shouldAddToInbox(status: InvitationStatus): boolean {
  return status === 'PENDING' || status === 'REQUIRES_LEAVE';
}
