import { DEFAULT_TIME_ZONE } from './quiet-hours.util';

/**
 * Teksty powiadomień. Wydzielone z `NotificationsService`, bo od kiedy jedno
 * powiadomienie opisuje CAŁĄ serię zmian, składanie zdania przestało być
 * jednym `switch`em i zrobiło się osobną decyzją — co z paczki jest ważne, a
 * co da się zwinąć do liczby.
 */

export type PlanChangeAction =
  | 'UPSERT_SLOT'
  | 'REMOVE_SLOT'
  | 'SAVE_PLAN'
  | 'CLEAR_PLAN'
  | (string & {});

export interface PlanChangeEvent {
  action: PlanChangeAction;
  weekStart?: string | null;
  dayOfWeek?: string | null;
  mealType?: string | null;
}

export type ShoppingChangeAction =
  | 'SET_ITEM_CHECKED'
  | 'ARCHIVE_LIST'
  | 'SELECT_ARCHIVE'
  | 'DELETE_ARCHIVE'
  | 'DELETE_ALL_ARCHIVES'
  | (string & {});

export interface ShoppingChangeEvent {
  action: ShoppingChangeAction;
  isChecked?: boolean | null;
}

export interface PushCopy {
  title: string;
  body: string;
}

/** Odmiana przez liczbę: 1 zmiana, 2–4 zmiany, 5+ zmian. */
export function polishPlural(
  count: number,
  one: string,
  few: string,
  many: string,
): string {
  if (count === 1) return one;
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return few;
  }
  return many;
}

/** Imię autora zmiany — z `displayName` albo z części e-maila przed `@`. */
export function extractFirstName(raw?: string | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'Ktoś';

  let candidate = trimmed;
  const atIndex = candidate.indexOf('@');
  if (atIndex >= 0) {
    candidate = candidate.slice(0, atIndex);
  }

  const token =
    candidate.split(/[\s._\-+]+/).find((part) => part.length > 0) ?? '';

  const cleaned = token.trim();
  if (!cleaned) return 'Ktoś';

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Nazwa slotu w bierniku — wchodzi w zdania typu „Marek zmienił Kolację na
 * środę". Stąd „Kolację", a nie „Kolacja".
 */
export function mapMealType(value?: string | null): string {
  switch ((value ?? '').toUpperCase()) {
    case 'BREAKFAST':
      return 'Śniadanie';
    case 'SECOND_BREAKFAST':
      return 'II śniadanie';
    case 'LUNCH':
      return 'Obiad';
    case 'AFTERNOON_SNACK':
      return 'Podwieczorek';
    case 'DINNER':
      return 'Kolację';
    case 'SNACK':
      return 'Przekąskę';
    default:
      return 'Posiłek';
  }
}

export function mapDayOfWeek(value?: string | null): string {
  switch ((value ?? '').toUpperCase()) {
    case 'MON':
      return 'Poniedziałek';
    case 'TUE':
      return 'Wtorek';
    case 'WED':
      return 'Środę';
    case 'THU':
      return 'Czwartek';
    case 'FRI':
      return 'Piątek';
    case 'SAT':
      return 'Sobotę';
    case 'SUN':
      return 'Niedzielę';
    default:
      return 'wybrany dzień';
  }
}

/**
 * Poniedziałek tygodnia ISO, w którym leży dana data kalendarzowa.
 *
 * Operujemy na „gołych" datach zakotwiczonych w UTC, a nie na momentach w
 * czasie: `weekStart` z bazy to dzień, nie chwila, a porównywanie chwil z
 * różnych stref potrafi przesunąć wynik o dobę i zamienić „ten tydzień"
 * w „przyszły tydzień".
 */
function isoWeekStartUtcMs(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  // `getUTCDay()` daje 0 dla niedzieli — w ISO niedziela kończy tydzień, więc
  // przesuwamy ją na siódmy dzień, zanim cofniemy się do poniedziałku.
  const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  return date.getTime() - (isoDay - 1) * 86400000;
}

/**
 * „ten tydzień" / „przyszły tydzień" / „tydzień od 24.08".
 *
 * Etykieta liczy się w strefie aplikacji, a nie odbiorcy: podsumowanie dotyczy
 * gospodarstwa, więc nie ma jednego „teraz" per adresat.
 */
export function describeWeek(
  weekStart?: string | null,
  now: Date = new Date(),
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(weekStart ?? '');
  if (!match) return 'ten tydzień';

  const targetWeekMs = isoWeekStartUtcMs(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  );

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const partValue = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const currentWeekMs = isoWeekStartUtcMs(
    partValue('year'),
    partValue('month'),
    partValue('day'),
  );

  const diffWeeks = Math.round((targetWeekMs - currentWeekMs) / (7 * 86400000));

  if (diffWeeks === 0) return 'ten tydzień';
  if (diffWeeks === 1) return 'przyszły tydzień';

  const target = new Date(targetWeekMs);
  const day = String(target.getUTCDate()).padStart(2, '0');
  const month = String(target.getUTCMonth() + 1).padStart(2, '0');
  return `tydzień od ${day}.${month}`;
}

/**
 * Jedno zdanie o całej paczce zmian w planie.
 *
 * Reguła jest hierarchiczna, bo zdarzenia nie są równorzędne: wyczyszczenie
 * tygodnia unieważnia wszystko, co przed nim, a zapis puli opisuje tydzień
 * lepiej niż lista pojedynczych kratek. Dopiero gdy w paczce nie ma żadnego
 * zdarzenia „całotygodniowego", schodzimy do slotów — i tam liczymy UNIKALNE
 * sloty, nie zdarzenia, bo podmiana przepisu to `REMOVE_SLOT` + `UPSERT_SLOT`
 * na tej samej kratce i użytkownik widzi w tym jedną zmianę, nie dwie.
 */
export function buildPlanSummary(
  actorDisplayName: string | null | undefined,
  events: PlanChangeEvent[],
  now: Date = new Date(),
): PushCopy {
  const actor = extractFirstName(actorDisplayName);
  const week = describeWeek(
    events.find((event) => event.weekStart)?.weekStart,
    now,
  );
  const title = 'Plan posiłków';

  const actions = new Set(events.map((e) => (e.action ?? '').toUpperCase()));

  if (actions.has('CLEAR_PLAN')) {
    return { title, body: `${actor} usunął/ęła plan na ${week}.` };
  }
  if (actions.has('SAVE_PLAN')) {
    return { title, body: `${actor} ustawił/a plan na ${week}.` };
  }

  const slotEvents = events.filter((e) => e.dayOfWeek && e.mealType);
  const slotKeys = new Set(
    slotEvents.map((e) => `${e.dayOfWeek}|${e.mealType}`),
  );

  if (slotKeys.size === 0) {
    return { title, body: `${actor} zaktualizował/a plan na ${week}.` };
  }

  if (slotKeys.size === 1) {
    const meal = mapMealType(slotEvents[0].mealType).toLowerCase();
    const day = mapDayOfWeek(slotEvents[0].dayOfWeek).toLowerCase();
    const onlyRemovals = slotEvents.every(
      (e) => (e.action ?? '').toUpperCase() === 'REMOVE_SLOT',
    );
    if (onlyRemovals) {
      return {
        title,
        body: `${actor} usunął/ęła ${meal} z planu na ${day}.`,
      };
    }
    return { title, body: `${actor} zmienił/a ${meal} na ${day}.` };
  }

  const count = slotKeys.size;
  const noun = polishPlural(count, 'zmianę', 'zmiany', 'zmian');
  return {
    title,
    body: `${actor} wprowadził/a ${count} ${noun} w planie na ${week}.`,
  };
}

/**
 * Jedno zdanie o paczce zmian na liście zakupów.
 *
 * `null` znaczy „nie ma o czym powiadamiać" — tak wygląda paczka złożona z
 * samych odznaczeń (ktoś odklikał coś przez pomyłkę i cofnął), która po
 * zsumowaniu nie niesie żadnej informacji.
 */
export function buildShoppingSummary(
  actorDisplayName: string | null | undefined,
  events: ShoppingChangeEvent[],
): PushCopy | null {
  const actor = extractFirstName(actorDisplayName);
  const title = 'Lista zakupów';

  const actions = events.map((e) => (e.action ?? '').toUpperCase());

  if (actions.includes('ARCHIVE_LIST')) {
    return { title, body: `${actor} zamknął/ęła listę zakupów.` };
  }

  const checkedCount = events.filter(
    (e) => (e.action ?? '').toUpperCase() === 'SET_ITEM_CHECKED' && e.isChecked,
  ).length;
  const uncheckedCount = events.filter(
    (e) =>
      (e.action ?? '').toUpperCase() === 'SET_ITEM_CHECKED' && !e.isChecked,
  ).length;

  if (checkedCount > 0) {
    const noun = polishPlural(checkedCount, 'produkt', 'produkty', 'produktów');
    return {
      title,
      body: `${actor} odhaczył/a ${checkedCount} ${noun} na liście zakupów.`,
    };
  }

  if (uncheckedCount > 0) {
    // Same odznaczenia to zwykle korekta pomyłki — nie ma czym zawracać głowy.
    return null;
  }

  const otherActions = actions.filter(
    (action) => action && action !== 'SET_ITEM_CHECKED',
  );
  if (otherActions.length === 0) {
    return null;
  }

  return { title, body: `${actor} zaktualizował/a listę zakupów.` };
}

/** Powiadomienie o nowym domowniku. */
export function buildHouseholdJoinedCopy(
  joinedDisplayName: string | null | undefined,
  householdName?: string | null,
): PushCopy {
  const actor = extractFirstName(joinedDisplayName);
  const house = householdName?.trim();
  return {
    title: 'Gospodarstwo',
    body: house
      ? `${actor} dołączył/a do gospodarstwa „${house}".`
      : `${actor} dołączył/a do Twojego gospodarstwa.`,
  };
}

/**
 * Powiadomienie o zaproszeniu czekającym w skrzynce.
 *
 * Treść mówi wprost, że zaproszenie „czeka", a nie że coś się właśnie stało:
 * jego wartością jest to, że da się do niego wrócić, a nie moment przyjścia.
 */
export function buildHouseholdInvitationCopy(
  invitedByDisplayName: string | null | undefined,
  householdName?: string | null,
): PushCopy {
  const actor = extractFirstName(invitedByDisplayName);
  const house = householdName?.trim();
  return {
    title: 'Zaproszenie do gospodarstwa',
    body: house
      ? `${actor} zaprasza Cię do gospodarstwa „${house}". Zaproszenie czeka w Ustawieniach.`
      : `${actor} zaprasza Cię do swojego gospodarstwa. Zaproszenie czeka w Ustawieniach.`,
  };
}

/** Powiadomienie o odejściu domownika. */
export function buildHouseholdLeftCopy(
  leftDisplayName: string | null | undefined,
  householdName?: string | null,
): PushCopy {
  const actor = extractFirstName(leftDisplayName);
  const house = householdName?.trim();
  return {
    title: 'Gospodarstwo',
    body: house
      ? `${actor} opuścił/a gospodarstwo „${house}".`
      : `${actor} opuścił/a Twoje gospodarstwo.`,
  };
}
