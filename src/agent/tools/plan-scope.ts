/**
 * Zakres planowania jednej tury — najwyżej TYDZIEŃ.
 *
 * 24.09.2026: „zaplanuj mi cały miesiąc” kończyło się czterema wywołaniami
 * `propose_week_plan` w jednej turze — cztery karty, cztery zapisy planu z puli
 * i kilka minut myślenia modelu. Prompt mówi modelowi, że planuje najwyżej
 * tydzień, ale prompt to prośba; ta bramka jest twarda.
 *
 * Dwie reguły, obie liczone WYŁĄCZNIE z dat telefonu (serwer żyje w UTC,
 * patrz `dto/agent-date.validators.ts`):
 *
 *  1. Budżet tury: suma DNI, których dotykają narzędzia układające plan,
 *     to najwyżej 7. Tydzień (`propose_week_plan`, `apply_week_plan`) to
 *     stan docelowy CAŁEGO tygodnia, więc kosztuje 7 dni; dzień
 *     (`propose_day_plan`) — jeden. Ponowne wywołanie tego samego tygodnia
 *     albo dnia (poprawka po naruszeniach) nic nie dokłada.
 *  2. Horyzont: tydzień planu to bieżący albo następny tydzień u użytkownika,
 *     albo tydzień oglądany w Planie (`weekStart` wiadomości) i ten po nim.
 *     Dzięki temu model nie ucieka z propozycją trzy tygodnie do przodu,
 *     a użytkownik, który sam przewinął Plan dalej, dalej może o niego prosić.
 *
 * Podmiany, usunięcia i podział porcji nie są „planowaniem” — dotyczą jednego
 * dania w istniejącym planie — więc tej bramki nie przechodzą.
 */

export const MAX_PLANNED_DAYS_PER_TURN = 7;

const WEEK_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

/** Narzędzia, które UKŁADAJĄ plan (a nie poprawiają jedno danie). */
export const PLANNING_TOOLS: ReadonlySet<string> = new Set([
  'propose_week_plan',
  'apply_week_plan',
  'propose_day_plan',
]);

/** Stan tury — tworzony raz przez runner, żyje tyle, co tura. */
export type PlanScope = {
  /** `YYYY-MM-DD:DAY` — dni, których dotknęły udane wywołania tej tury. */
  days: Set<string>;
};

export type PlanScopeDates = {
  /** Poniedziałek tygodnia oglądanego w Planie (z telefonu). */
  weekStart: string;
  /** „Dziś” u użytkownika (z telefonu). */
  clientToday: string;
};

export function createPlanScope(): PlanScope {
  return { days: new Set<string>() };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseUtc(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Poniedziałek tygodnia, w którym leży `date` (tydzień od poniedziałku). */
function mondayOf(date: Date): Date {
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(date, -offset);
}

/**
 * Dni, których dotyka wywołanie. `null` = narzędzie nie układa planu albo
 * wejście jest tak złe, że i tak odrzuci je domena — bramka wtedy nie zgaduje.
 */
export function plannedDaysOf(
  name: string,
  input: Record<string, unknown>,
): string[] | null {
  if (!PLANNING_TOOLS.has(name)) return null;
  const weekStart =
    typeof input.week_start === 'string' ? input.week_start.trim() : '';
  if (!parseUtc(weekStart)) return null;

  if (name === 'propose_day_plan') {
    const day =
      typeof input.day_of_week === 'string'
        ? input.day_of_week.trim().toUpperCase()
        : '';
    if (!(WEEK_DAYS as readonly string[]).includes(day)) return null;
    return [`${weekStart}:${day}`];
  }
  return WEEK_DAYS.map((day) => `${weekStart}:${day}`);
}

/** Poniedziałki tygodni, które wolno planować w tej turze. */
export function allowedPlanWeeks(dates: PlanScopeDates): Set<string> {
  const allowed = new Set<string>();
  const today = parseUtc(dates.clientToday);
  if (today) {
    const monday = mondayOf(today);
    allowed.add(isoDay(monday));
    allowed.add(isoDay(addDays(monday, 7)));
  }
  const viewed = parseUtc(dates.weekStart);
  if (viewed) {
    const monday = mondayOf(viewed);
    allowed.add(isoDay(monday));
    allowed.add(isoDay(addDays(monday, 7)));
  }
  return allowed;
}

export type PlanScopeRefusal = { reason: 'range' | 'horizon'; message: string };

/**
 * Czy wywołanie mieści się w zakresie tury. Nie zapisuje niczego — dni
 * dopisuje `recordPlannedDays` dopiero po UDANYM wywołaniu, żeby pomyłka
 * w dacie (poprawiona w następnej rundzie) nie zjadała budżetu.
 */
export function checkPlanScope(
  name: string,
  input: Record<string, unknown>,
  scope: PlanScope,
  dates: PlanScopeDates,
): PlanScopeRefusal | null {
  const days = plannedDaysOf(name, input);
  if (!days) return null;

  const weekStart = (input.week_start as string).trim();
  const allowed = allowedPlanWeeks(dates);
  if (allowed.size > 0 && !allowed.has(weekStart)) {
    return {
      reason: 'horizon',
      message:
        `Tydzień od ${weekStart} jest poza zasięgiem asystenta: planujesz tylko ` +
        `tygodnie od ${[...allowed].sort().join(', ')}. Nie próbuj innej daty — ` +
        'powiedz użytkownikowi jednym zdaniem, że asystent planuje najwyżej ' +
        'bieżący i następny tydzień, i zaproponuj jeden z nich.',
    };
  }

  const union = new Set([...scope.days, ...days]);
  if (union.size > MAX_PLANNED_DAYS_PER_TURN) {
    return {
      reason: 'range',
      message:
        `Jedna prośba to najwyżej ${MAX_PLANNED_DAYS_PER_TURN} dni planu (jeden tydzień), ` +
        `a ta tura ułożyła już ${scope.days.size}. Nie układasz kolejnych dni ani ` +
        'tygodni. Zakończ turę tym, co już jest, i powiedz użytkownikowi jednym ' +
        'zdaniem, że asystent planuje najwyżej tydzień naraz.',
    };
  }
  return null;
}

export function recordPlannedDays(
  name: string,
  input: Record<string, unknown>,
  scope: PlanScope,
): void {
  for (const day of plannedDaysOf(name, input) ?? []) scope.days.add(day);
}
