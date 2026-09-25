import { Prisma } from '@prisma/client';

/**
 * JEDEN kalendarz panelu w strefie `Europe/Warsaw` (serwer stoi w UTC).
 *
 * Rafał czyta panel w Warszawie, więc „dziś" to doba polska, a nie doba
 * serwera — rejestracja z 0:30 czasu polskiego (22:30 UTC dnia poprzedniego)
 * ma wpaść do dzisiejszego słupka. Wcześniej były trzy kopie tej arytmetyki
 * (pulpit, asystent, subskrypcje) z trzema zestawami testów; poprawka zmiany
 * czasu w jednej nie trafiała do pozostałych.
 *
 * Bez biblioteki stref: przesunięcie bierzemy z `Intl` dla konkretnej chwili,
 * więc zmiana czasu (ostatnia niedziela marca i października, zawsze
 * o 2:00/3:00) wypada poprawnie — północ w Polsce nigdy nie leży w dziurze
 * ani w zakładce zmiany czasu. Czyste funkcje bez bazy i bez zegara, żeby
 * zmianę czasu dało się sprawdzić testem, a nie czekaniem na październik.
 *
 * Trzy postacie dnia, bo tak ich używają ekrany: `CivilDate` (miesiąc 1–12),
 * klucz `YYYY-MM-DD` i zegar ścienny (`WallClock`, miesiąc 0–11 jak w `Date`).
 * Wszystkie idą przez ten sam `warsawWallClock` / `fromWarsawWallClock`.
 */
export const PANEL_TIME_ZONE = 'Europe/Warsaw';

const DAY_MS = 24 * 60 * 60 * 1000;

// ——— rdzeń: zegar ścienny ———

// `h23`, bo część wersji ICU oddaje północ jako „24" przy `hour12: false`.
const WALL_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: PANEL_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

export type WallClock = {
  year: number;
  /** 0–11, jak w `Date`. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
};

/** Zegar ścienny Warszawy dla chwili `date`. */
export function warsawWallClock(date: Date): WallClock {
  const parts: Record<string, number> = {};
  for (const part of WALL_CLOCK.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month - 1,
    day: parts.day,
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
    ms: date.getUTCMilliseconds(),
  };
}

/** Przesunięcie strefy (czas lokalny − UTC, w ms) w chwili `instant`. */
function warsawOffsetMs(instant: number): number {
  const wall = warsawWallClock(new Date(instant));
  return (
    Date.UTC(
      wall.year,
      wall.month,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
      wall.ms,
    ) - instant
  );
}

/**
 * Chwila, w której zegar w Warszawie pokazuje podaną datę i godzinę.
 * Miesiąc (0–11) spoza zakresu przechodzi na sąsiedni rok (jak w `Date.UTC`).
 * Dwa przybliżenia przesunięcia, bo zmiana czasu potrafi leżeć między
 * zgadnięciem a wynikiem (przesunięcie zależy od chwili, której szukamy).
 */
export function fromWarsawWallClock(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const guess = Date.UTC(year, month, day, hour, minute, second, ms);
  const first = guess - warsawOffsetMs(guess);
  return new Date(guess - warsawOffsetMs(first));
}

// ——— dni kalendarzowe (`CivilDate`) i doby panelu ———

/** Data kalendarzowa (miesiąc 1–12). */
export type CivilDate = { year: number; month: number; day: number };

/** Jedna doba panelu: klucz `YYYY-MM-DD` i jej granice w UTC `[start, end)`. */
export type PanelDay = { key: string; start: Date; end: Date };

/** Dzień kalendarzowy w Warszawie, w którym wypada `instant`. */
export function warsawDate(instant: Date): CivilDate {
  const wall = warsawWallClock(instant);
  return { year: wall.year, month: wall.month + 1, day: wall.day };
}

/** Północ w Warszawie danego dnia jako chwila UTC. */
export function warsawMidnight(date: CivilDate): Date {
  return fromWarsawWallClock(date.year, date.month - 1, date.day);
}

export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

const pad = (value: number): string => String(value).padStart(2, '0');

export function civilKey(date: CivilDate): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

function parseKey(key: string): CivilDate {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
}

/** Początek dzisiejszej (warszawskiej) doby. */
export function warsawTodayStart(now: Date): Date {
  return warsawMidnight(warsawDate(now));
}

/**
 * Ostatnie `count` dób do dziś włącznie, od najstarszej. Granice liczone
 * z kalendarza, nie jako „minus 24 h": doba zmiany czasu ma 23 albo 25 godzin.
 */
export function warsawDays(now: Date, count: number): PanelDay[] {
  const today = warsawDate(now);
  return Array.from({ length: count }, (_, index) => {
    const date = addCivilDays(today, index - (count - 1));
    return {
      key: civilKey(date),
      start: warsawMidnight(date),
      end: warsawMidnight(addCivilDays(date, 1)),
    };
  });
}

/** Doby od pierwszego dnia bieżącego miesiąca (Warszawa) do dziś włącznie. */
export function warsawMonthDays(now: Date): PanelDay[] {
  return warsawDays(now, warsawDate(now).day);
}

// ——— klucze dnia `YYYY-MM-DD` ———

/** Data kalendarzowa (`YYYY-MM-DD`) chwili `instant` w Polsce. */
export function warsawDateKey(instant: Date): string {
  return civilKey(warsawDate(instant));
}

/** Chwila północy dnia `key` w Polsce (np. `2026-09-24` → `2026-09-23T22:00Z`). */
export function warsawDayStart(key: string): Date {
  return warsawMidnight(parseKey(key));
}

/** Klucz dnia przesunięty o `days` dni kalendarzowych. */
export function addDays(key: string, days: number): string {
  return civilKey(addCivilDays(parseKey(key), days));
}

// ——— tydzień planu ———

/**
 * Poniedziałek tygodnia, do którego należy dzień `key` — w tej samej postaci,
 * w jakiej leży `WeeklyPlan.weekStart` (data poniedziałku jako północ UTC,
 * `parseWeekStart`).
 */
export function mondayOf(key: string): Date {
  const date = parseKey(key);
  const weekday = new Date(
    Date.UTC(date.year, date.month - 1, date.day),
  ).getUTCDay();
  const monday = addCivilDays(date, weekday === 0 ? -6 : 1 - weekday);
  return new Date(Date.UTC(monday.year, monday.month - 1, monday.day));
}

/**
 * Poniedziałek bieżącego tygodnia w reprezentacji `WeeklyPlan.weekStart`.
 *
 * Tydzień wyznacza data WARSZAWSKA, a nie UTC jak w `currentWeekStart`
 * (tam to świadomie szeroki filtr do sprzątania). Klucz tygodnia to data
 * kalendarzowa telefonu, a telefony naszych użytkowników żyją w tej strefie —
 * w poniedziałek o 0:30 panel ma już liczyć nowy tydzień.
 */
export function warsawWeekStart(now: Date): Date {
  return mondayOf(warsawDateKey(now));
}

// ——— miesiące ———

/** Północ pierwszego dnia miesiąca (0–11) w Warszawie. */
export function warsawMonthStart(year: number, month: number): Date {
  return fromWarsawWallClock(year, month, 1);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * „Ten sam dzień miesiąc temu" na zegarze Warszawy; 31 marca → 28/29 lutego.
 */
export function oneMonthEarlier(now: Date): Date {
  const wall = warsawWallClock(now);
  const target = new Date(Date.UTC(wall.year, wall.month - 1, 1));
  const year = target.getUTCFullYear();
  const month = target.getUTCMonth();
  return fromWarsawWallClock(
    year,
    month,
    Math.min(wall.day, daysInMonth(year, month)),
    wall.hour,
    wall.minute,
    wall.second,
    wall.ms,
  );
}

// ——— chwile i SQL ———

export function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Chwila jako `timestamp` w UTC — do porównań w surowym SQL z kolumnami
 * Prismy (`timestamp(3)` bez strefy, trzymają UTC). Napis ISO rzutowany w
 * bazie, a nie `Date` jako parametr: wynik nie zależy od tego, jak sterownik
 * typuje parametr ani od strefy sesji Postgresa.
 */
export function sqlInstant(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Klucz `YYYY-MM-DD` doby warszawskiej dla kolumny z chwilą w UTC. */
export function sqlWarsawDay(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`to_char((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${PANEL_TIME_ZONE}, 'YYYY-MM-DD')`;
}
