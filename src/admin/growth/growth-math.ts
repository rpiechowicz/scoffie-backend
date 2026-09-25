import type {
  Cohort,
  FunnelStep,
  FunnelStepKey,
  GrowthPeriod,
} from '../contract';
import { addDays, warsawDayStart } from '../common/warsaw-calendar';

export const GROWTH_PERIODS: readonly GrowthPeriod[] = ['7', '30', '90'];

/** Kolejność kroków lejka — także kolejność kolumn w `FunnelRow`. */
export const FUNNEL_STEPS: readonly FunnelStepKey[] = [
  'registered',
  'onboarded',
  'household',
  'plan',
  'aiConsent',
  'firstTurn',
  'purchase',
];

/** Jedna osoba kohorty: chwila pierwszego wejścia na każdy krok (`null` — nie weszła). */
export type FunnelRow = { registered: Date } & Record<
  Exclude<FunnelStepKey, 'registered'>,
  Date | null
>;

/** Kohorty: ostatnie 12 tygodni rejestracji × tydzień 0..8. */
export const COHORT_WEEKS = 12;
export const COHORT_OFFSETS = 9;

/** DAU/WAU/MAU: 30 dób. */
export const ACTIVE_DAYS = 30;

const round1 = (value: number): number => Math.round(value * 10) / 10;

const percent = (part: number, whole: number): number =>
  whole > 0 ? round1((part / whole) * 100) : 0;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Lejek SEKWENCYJNY: krok liczy osobę, która doszła do niego i do wszystkich
 * wcześniejszych (np. zakup bez zgody na asystenta nie wchodzi do „zakupu”).
 * Tylko tak liczby maleją krok po kroku, a „% od poprzedniego” jest
 * konwersją, a nie porównaniem dwóch niezależnych zbiorów.
 *
 * Czas do kroku liczony od rejestracji; zdarzenie sprzed rejestracji
 * (subskrypcja z poprzedniego konta — wisi na haszu tożsamości) liczy się
 * jako 0, nie jako czas ujemny.
 */
export function funnelSteps(rows: readonly FunnelRow[]): FunnelStep[] {
  let reached = [...rows];
  const start = rows.length;
  let previous = start;
  return FUNNEL_STEPS.map((key) => {
    reached = reached.filter((row) => row[key] !== null);
    const users = reached.length;
    const seconds = reached.map((row) =>
      Math.max(
        0,
        Math.round(
          ((row[key] as Date).getTime() - row.registered.getTime()) / 1000,
        ),
      ),
    );
    const step: FunnelStep = {
      key,
      users,
      pctOfStart:
        key === 'registered' ? (start > 0 ? 100 : 0) : percent(users, start),
      pctOfPrevious:
        key === 'registered' ? (start > 0 ? 100 : 0) : percent(users, previous),
      medianSecondsToStep: median(seconds),
    };
    previous = users;
    return step;
  });
}

/** Wiersz zapytania kohort: rozmiar (`offset = null`) albo aktywni w tygodniu `offset`. */
export type CohortRow = { week: string; offset: number | null; users: number };

/**
 * Macierz kohort. `weekKeys` — poniedziałki (`YYYY-MM-DD`) od najstarszego,
 * `todayKey` — dzisiejsza doba, `activitySinceKey` — doba, od której zbieramy
 * aktywność.
 *
 * Komórka pusta (`null`), gdy tydzień jeszcze nie nastał albo cały leży przed
 * początkiem zbierania — wtedy 0 % znaczyłoby „nie wiemy”, a nie „nikt nie
 * wrócił”. Tydzień 0 liczy się zawsze: dzień rejestracji jest w tabeli także
 * wstecz (backfill z `createdAt`).
 */
export function cohortMatrix(
  weekKeys: readonly string[],
  rows: readonly CohortRow[],
  todayKey: string,
  activitySinceKey: string | null,
): Cohort[] {
  const sizes = new Map<string, number>();
  const active = new Map<string, number>();
  for (const row of rows) {
    if (row.offset === null) sizes.set(row.week, row.users);
    else active.set(`${row.week}:${row.offset}`, row.users);
  }
  return weekKeys.map((week) => {
    const users = sizes.get(week) ?? 0;
    const weeks = Array.from({ length: COHORT_OFFSETS }, (_, offset) => {
      const start = addDays(week, offset * 7);
      if (users === 0 || start > todayKey) return null;
      if (
        offset > 0 &&
        (activitySinceKey === null || addDays(start, 7) <= activitySinceKey)
      ) {
        return null;
      }
      return percent(active.get(`${week}:${offset}`) ?? 0, users);
    });
    return { weekStart: warsawDayStart(week).toISOString(), users, weeks };
  });
}

/** Poniedziałki ostatnich `count` tygodni do bieżącego włącznie, od najstarszego. */
export function cohortWeekKeys(
  currentMondayKey: string,
  count = COHORT_WEEKS,
): string[] {
  return Array.from({ length: count }, (_, index) =>
    addDays(currentMondayKey, (index - (count - 1)) * 7),
  );
}
