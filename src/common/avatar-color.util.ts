/**
 * Przydział kolorów awatara — jedna definicja dla wszystkich miejsc, które
 * go potrzebują (koniec onboardingu w `UsersService`, dołączenie do
 * gospodarstwa w `HouseholdsService`).
 *
 * Liczba gradientów musi zgadzać się z paletą w `ProfileAvatar` po stronie
 * iOS — to serwer wybiera indeks, klient tylko go odczytuje.
 */
export const AVATAR_COLOR_COUNT = 12;

/**
 * Stabilny FNV-1a na id — ta sama funkcja, którą iOS liczy kolor dla kont
 * bez przydzielonego `avatarColor`. Dzięki temu serwer wie, jak takie konto
 * FAKTYCZNIE wygląda na ekranie, i może unikać jego odcienia przy
 * przydzielaniu kolorów pozostałym.
 */
export function fallbackAvatarColor(userId: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(userId.toLowerCase(), 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_COLOR_COUNT;
}

/**
 * Kolor, którym dana osoba realnie świeci w aplikacji: przydzielony indeks,
 * a dla kont sprzed tej zmiany — fallback z hasza id.
 */
export function effectiveAvatarColor(user: {
  id: string;
  avatarColor: number | null;
}): number {
  return user.avatarColor ?? fallbackAvatarColor(user.id);
}

/**
 * Pierwszy wolny kolor spoza `taken`. Gdy wszystkie zajęte (gospodarstwo
 * większe niż paleta), schodzimy do hasza id — powtórka jest wtedy
 * nieunikniona, ale nadal deterministyczna.
 */
export function pickFreeAvatarColor(
  taken: ReadonlySet<number>,
  userId: string,
): number {
  for (let index = 0; index < AVATAR_COLOR_COUNT; index += 1) {
    if (!taken.has(index)) {
      return index;
    }
  }
  return fallbackAvatarColor(userId);
}
