/**
 * Dni kalendarzowe panelu w strefie `Europe/Warsaw`.
 *
 * Serwer stoi w UTC, a „dzień” na wykresie ma być polskim dniem: tura
 * z 23:30 czasu polskiego należy do TEGO dnia, nie do następnego (tak
 * policzyłby ją `createdAt::date` w UTC przez pół roku). Klucz dnia to napis
 * `YYYY-MM-DD`; chwilę początku dnia daje `warsawDayStart`.
 *
 * Bez biblioteki stref: przesunięcie bierzemy z `Intl` dla konkretnej chwili,
 * więc zmiana czasu (ostatnia niedziela marca i października, zawsze
 * o 2:00/3:00) wypada poprawnie — północ w Polsce nigdy nie leży w dziurze
 * ani w zakładce zmiany czasu.
 */
export const PANEL_TIME_ZONE = 'Europe/Warsaw';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: PANEL_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function wallClock(instant: Date): WallClock {
  const values: Record<string, number> = {};
  for (const part of PARTS.formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** Przesunięcie strefy panelu względem UTC (ms) w chwili `instant`. */
function offsetMs(instant: Date): number {
  const wall = wallClock(instant);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  // Sekundy przestępne i milisekundy nie mają tu znaczenia — ucinamy je po
  // obu stronach, żeby różnica była czystym przesunięciem strefy.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** Data kalendarzowa (`YYYY-MM-DD`) chwili `instant` w Polsce. */
export function warsawDateKey(instant: Date): string {
  const wall = wallClock(instant);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** Chwila północy dnia `key` w Polsce (np. `2026-09-24` → `2026-09-23T22:00Z`). */
export function warsawDayStart(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  const first = utcMidnight - offsetMs(new Date(utcMidnight));
  // Druga iteracja łapie dzień, w którym przesunięcie o północy jest inne niż
  // o północy UTC (zmiana czasu tej nocy).
  const second = utcMidnight - offsetMs(new Date(first));
  return new Date(second);
}

/** Klucz dnia przesunięty o `days` dni kalendarzowych. */
export function addDays(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * Poniedziałek tygodnia, do którego należy dzień `key` — w tej samej postaci,
 * w jakiej leży `WeeklyPlan.weekStart` (data poniedziałku jako północ UTC,
 * `parseWeekStart`).
 */
export function mondayOf(key: string): Date {
  const date = new Date(`${key}T00:00:00.000Z`);
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return new Date(`${addDays(key, -sinceMonday)}T00:00:00.000Z`);
}
