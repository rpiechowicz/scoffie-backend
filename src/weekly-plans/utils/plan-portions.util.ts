import { PLANNED_SERVINGS_MAX } from './planned-servings.util';

/**
 * Porcje per osoba (workstream, Etap 2.2) — jedna definicja jednostek
 * i reguł dla zapisu planu, bilansu, listy zakupów, planera i drutu.
 *
 * Porcja osoby jest liczona w JEDNOSTKACH: 1 jednostka = 1/20 porcji (0,05).
 * Liczba całkowita w Postgresie, Prismie, JSON-ie i Swifcie — bez binarnego
 * Float w bazie i bez `Decimal` (Prisma oddaje go jako obiekt, Swift i tak
 * dekoduje liczby JSON jako `Double`). 0,05 porcji to ~25 kcal przy typowym
 * daniu, czyli poniżej sensownej precyzji planu. Na drut idzie `servings`
 * w porcjach (wielokrotność 0,05), bo tym językiem mówi reszta kontraktu.
 *
 * Semantyka (raport 02.2):
 * - pozycja BEZ alokacji — jak zawsze: `plannedServings / liczba jedzących`;
 * - pozycja Z alokacją — alokacja jest źródłem prawdy: osoba je SWOJĄ porcję,
 *   gotujemy Σ porcji, a `plannedServings` jest POCHODNĄ `ceil(Σ)` dla starych
 *   klientów (nikt nowy go wtedy nie czyta).
 */
export const PORTION_UNITS_PER_SERVING = 20;
export const PORTION_STEP = 1 / PORTION_UNITS_PER_SERVING;
/** Widełki porcji JEDNEJ osoby przy zapisie (poza planerem, np. ręcznie). */
export const PORTION_WRITE_MIN = 0.1;
export const PORTION_WRITE_MAX = 6;

export type PortionView = { userId: string; servings: number };
export type PortionRow = { userId: string; units: number };

/** Porcja w jednostkach; `null` = nie wielokrotność 0,05 albo poza widełkami. */
export function servingsToUnits(servings: number): number | null {
  if (!Number.isFinite(servings)) return null;
  const units = Math.round(servings * PORTION_UNITS_PER_SERVING);
  if (Math.abs(units - servings * PORTION_UNITS_PER_SERVING) > 1e-6) {
    return null;
  }
  if (
    units < PORTION_WRITE_MIN * PORTION_UNITS_PER_SERVING - 1e-9 ||
    units > PORTION_WRITE_MAX * PORTION_UNITS_PER_SERVING + 1e-9
  ) {
    return null;
  }
  return units;
}

/** Jednostki → porcje (dokładnie, bez śmieci zmiennoprzecinkowych). */
export function unitsToServings(units: number): number {
  return Math.round((units / PORTION_UNITS_PER_SERVING) * 100) / 100;
}

/**
 * Wiersze `PlanItemPortion` → widok. `null`/brak = pozycja bez alokacji
 * (także wiersz dociągnięty bez tej relacji, np. w atrapie Prismy).
 */
export function toPortionViews(
  rows: readonly PortionRow[] | null | undefined,
): PortionView[] {
  return [...(rows ?? [])]
    .sort((a, b) => a.userId.localeCompare(b.userId))
    .map((row) => ({
      userId: row.userId,
      servings: unitsToServings(row.units),
    }));
}

/** Łącznie gotowane porcje pozycji z alokacją. */
export function portionsTotal(portions: readonly PortionView[]): number {
  const units = portions.reduce(
    (sum, portion) =>
      sum + Math.round(portion.servings * PORTION_UNITS_PER_SERVING),
    0,
  );
  return units / PORTION_UNITS_PER_SERVING;
}

/**
 * `plannedServings` pozycji z alokacją: `ceil(Σ)` w klamrze 1..12. Pochodna
 * dla klientów, które alokacji nie znają (dekodują `plannedServings: Int`).
 */
export function derivedPlannedServings(
  portions: readonly PortionView[],
): number {
  return Math.min(
    PLANNED_SERVINGS_MAX,
    Math.max(1, Math.ceil(portionsTotal(portions) - 1e-9)),
  );
}

/**
 * Ile porcji gotujemy łącznie — lista zakupów. Z alokacją dokładnie Σ
 * porcji osób (0,8 + 1,3 = 2,1, nie 2 ani 3); bez niej `plannedServings`.
 */
export function cookedServings(item: {
  plannedServings: number;
  portions?: readonly PortionView[] | null;
}): number {
  return item.portions && item.portions.length > 0
    ? portionsTotal(item.portions)
    : Math.max(1, item.plannedServings);
}

/**
 * Powód, dla którego alokacja jest zła; `null` = poprawna. Zbiór osób
 * alokacji MUSI być audytorium pozycji (imienni uczestnicy albo — przy
 * „Wspólnym" — wszyscy domownicy), każda porcja wielokrotnością 0,05
 * w widełkach, a suma w klamrze `plannedServings`.
 */
export function portionsProblem(
  portions: readonly { userId: string; servings: number }[],
  audience: ReadonlySet<string>,
): string | null {
  const ids = portions.map((portion) => portion.userId);
  if (new Set(ids).size !== ids.length) {
    return 'Każda osoba może mieć najwyżej jedną porcję.';
  }
  if (ids.length !== audience.size || ids.some((id) => !audience.has(id))) {
    return 'Porcje muszą mieć dokładnie te osoby, które jedzą danie.';
  }
  for (const portion of portions) {
    if (servingsToUnits(portion.servings) === null) {
      return `Porcja osoby to wielokrotność ${PORTION_STEP} w widełkach ${PORTION_WRITE_MIN}–${PORTION_WRITE_MAX}.`;
    }
  }
  if (portionsTotal(portions) > PLANNED_SERVINGS_MAX + 1e-9) {
    return `Łącznie najwyżej ${PLANNED_SERVINGS_MAX} porcji.`;
  }
  return null;
}

/** Wiersze do zapisu (`PlanItemPortion`) z poprawnej alokacji. */
export function toPortionRows(portions: readonly PortionView[]): PortionRow[] {
  return portions.map((portion) => ({
    userId: portion.userId,
    units: servingsToUnits(portion.servings) ?? 0,
  }));
}

/** Czy dwie alokacje są identyczne (kolejność bez znaczenia). */
export function samePortions(
  a: readonly PortionView[],
  b: readonly PortionView[],
): boolean {
  if (a.length !== b.length) return false;
  const left = new Map(a.map((portion) => [portion.userId, portion.servings]));
  return b.every(
    (portion) =>
      left.has(portion.userId) &&
      Math.abs((left.get(portion.userId) ?? 0) - portion.servings) < 1e-9,
  );
}
