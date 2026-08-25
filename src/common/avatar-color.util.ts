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
 * Stabilny FNV-1a na id — DOKŁADNIE ta funkcja, którą iOS
 * (`ProfileAvatar.stableIndex`) liczy kolor dla kont bez przydzielonego
 * `avatarColor`. Dzięki temu serwer wie, jak takie konto FAKTYCZNIE wygląda
 * na ekranie, i może unikać jego odcienia przy przydzielaniu kolorów
 * pozostałym.
 *
 * Wariant 64-bitowy (BigInt), bo iOS haszuje na UInt64. Wcześniejsza wersja
 * 32-bitowa dawała inne indeksy niż klient (np. `d4999c6e…` → 8 tutaj,
 * 4 na iOS), więc serwer omijał nie ten odcień, którym konto świeci.
 */
export function fallbackAvatarColor(userId: string): number {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(userId.toLowerCase(), 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return Number(hash % BigInt(AVATAR_COLOR_COUNT));
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
