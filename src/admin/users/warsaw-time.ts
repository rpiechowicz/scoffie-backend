import { Prisma } from '@prisma/client';

/**
 * Doba panelu: `Europe/Warsaw`, choć serwer stoi w UTC.
 *
 * Rafał czyta pulpit w Warszawie, więc „dziś" to doba polska, a nie doba
 * serwera — rejestracja z 0:30 czasu polskiego (22:30 UTC dnia poprzedniego)
 * ma wpaść do dzisiejszego słupka. Czyste funkcje bez bazy i bez zegara, żeby
 * zmianę czasu (ostatnia niedziela marca i października) dało się sprawdzić
 * testem, a nie czekaniem na październik.
 */
export const PANEL_TIME_ZONE = 'Europe/Warsaw';

/** Data kalendarzowa (miesiąc 1–12). */
export type CivilDate = { year: number; month: number; day: number };

/** Jedna doba panelu: klucz `YYYY-MM-DD` i jej granice w UTC `[start, end)`. */
export type PanelDay = { key: string; start: Date; end: Date };

const DAY_MS = 24 * 60 * 60 * 1000;

// `h23`, bo część wersji ICU oddaje północ jako „24" przy `hour12: false`.
const ZONED = new Intl.DateTimeFormat('en-US', {
  timeZone: PANEL_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function zonedParts(instant: Date) {
  const values: Record<string, number> = {};
  for (const part of ZONED.formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour % 24,
    minute: values.minute,
    second: values.second,
  };
}

/** Przesunięcie strefy w chwili `instant` (czas lokalny − UTC, w ms). */
function offsetMs(instant: Date): number {
  const p = zonedParts(instant);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Dzień kalendarzowy w Warszawie, w którym wypada `instant`. */
export function warsawDate(instant: Date): CivilDate {
  const p = zonedParts(instant);
  return { year: p.year, month: p.month, day: p.day };
}

/** Północ w Warszawie danego dnia jako chwila UTC. */
export function warsawMidnight(date: CivilDate): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  // Dwa kroki, bo przesunięcie zależy od chwili, której właśnie szukamy.
  // Północ nigdy nie wypada w dziurze zmiany czasu (ta jest o 2:00/3:00).
  const first = guess - offsetMs(new Date(guess));
  const second = guess - offsetMs(new Date(first));
  return new Date(second);
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

export function civilKey(date: CivilDate): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** Początek dzisiejszej doby w Warszawie. */
export function warsawDayStart(now: Date): Date {
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

/**
 * Poniedziałek bieżącego tygodnia w reprezentacji `WeeklyPlan.weekStart`:
 * data kalendarzowa zapisana jako północ UTC (`parseWeekStart`).
 *
 * Tydzień wyznacza data WARSZAWSKA, a nie UTC jak w `currentWeekStart`
 * (tam to świadomie szeroki filtr do sprzątania). Klucz tygodnia to data
 * kalendarzowa telefonu, a telefony naszych użytkowników żyją w tej strefie —
 * w poniedziałek o 0:30 pulpit ma już liczyć nowy tydzień.
 */
export function warsawWeekStart(now: Date): Date {
  const today = warsawDate(now);
  const weekday = new Date(
    Date.UTC(today.year, today.month - 1, today.day),
  ).getUTCDay();
  const monday = addCivilDays(today, weekday === 0 ? -6 : 1 - weekday);
  return new Date(Date.UTC(monday.year, monday.month - 1, monday.day));
}

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
