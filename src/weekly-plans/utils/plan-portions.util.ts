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

/**
 * Jak zapis traktuje alokację, którą pozycja JUŻ ma
 * (`docs/adr/plan-portions-write-safety.md`, `plan-portions-safe-editing.md`):
 * - `strict` — zapis bez zgodnego tokenu (WS bez `expectedRevision`, narzędzia
 *   AI): brak pola albo `[]` nie może alokacji ani usunąć, ani zmienić, a jej
 *   zastąpienie albo usunięcie pozycji wymaga tokenu (`REVISION_REQUIRED`);
 * - `verified` — zgodny `expectedRevision` albo `guard` propozycji, który pod
 *   zamkiem porównał odcisk tygodnia: jawne `portions` zastępują alokację;
 * - `no-allocation-changes` — zapis propozycji z `force` (odcisk pominięty):
 *   istniejącej alokacji nie wolno zmienić ani usunąć;
 * - `authoritative` — cofnięcie propozycji; stan docelowy chroniony odciskiem
 *   sprawdzonym w tej samej transakcji.
 */
export type PortionsWritePolicy =
  | 'strict'
  | 'verified'
  | 'no-allocation-changes'
  | 'authoritative';

/**
 * - `WRITE` — zapis jak dotąd;
 * - `KEEP` — zapis bez intencji co do porcji, który niczego w pozycji nie
 *   zmienia: pozycja zostaje nietknięta (nic nie jest przenoszone ani
 *   przeliczane);
 * - `CONFLICT` — odmowa `PLAN_PORTIONS_CONFLICT`;
 * - `REVISION_REQUIRED` — zapis zastąpiłby alokację bez tokenu
 *   (`PLAN_REVISION_REQUIRED`).
 */
export type PortionsWriteDecision =
  | 'WRITE'
  | 'KEEP'
  | 'CONFLICT'
  | 'REVISION_REQUIRED';

export const PORTIONS_CONFLICT_MESSAGE =
  'To danie ma porcje ustawione osobno dla każdej osoby, a ten zapis by je skasował. Odśwież plan i spróbuj ponownie.';

export const REVISION_REQUIRED_MESSAGE =
  'Zmiana porcji ustawionych osobno dla każdej osoby wymaga aktualnej wersji planu. Odśwież plan i spróbuj ponownie.';

export const REVISION_CONFLICT_MESSAGE =
  'Plan zmienił się od ostatniego odczytu. Odśwież plan i spróbuj ponownie.';

/**
 * Decyzja dla ISTNIEJĄCEJ pozycji (`current`, odczytanej pod zamkiem tygodnia
 * w transakcji zapisu) i zapisu, który w nią trafia (`requested`).
 * `participantIds` obu stron w postaci znormalizowanej (pusta = „Wspólne”).
 * `[]` w `requested.portions` znaczy to samo co brak pola.
 */
export function portionsWriteDecision(
  current: {
    participantIds: readonly string[];
    plannedServings: number;
    portions: readonly PortionView[];
  },
  requested: {
    participantIds: readonly string[];
    plannedServings?: number | null;
    portions: readonly PortionView[];
  },
  policy: PortionsWritePolicy = 'strict',
): PortionsWriteDecision {
  if (current.portions.length === 0 || policy === 'authoritative') {
    return 'WRITE';
  }
  if (requested.portions.length > 0) {
    if (samePortions(current.portions, requested.portions)) return 'WRITE';
    if (policy === 'verified') return 'WRITE';
    return policy === 'no-allocation-changes'
      ? 'CONFLICT'
      : 'REVISION_REQUIRED';
  }
  const sameAudience =
    new Set(current.participantIds).size ===
      new Set(requested.participantIds).size &&
    requested.participantIds.every((id) => current.participantIds.includes(id));
  const sameServings =
    requested.plannedServings === undefined ||
    requested.plannedServings === null ||
    requested.plannedServings === current.plannedServings;
  return sameAudience && sameServings ? 'KEEP' : 'CONFLICT';
}

/**
 * Usunięcie pozycji Z alokacją, której nie ma w stanie docelowym
 * `applyWeekPlan`. `null` = wolno usunąć.
 */
export function portionsRemovalDecision(
  policy: PortionsWritePolicy,
): 'CONFLICT' | 'REVISION_REQUIRED' | null {
  if (policy === 'verified' || policy === 'authoritative') return null;
  return policy === 'no-allocation-changes' ? 'CONFLICT' : 'REVISION_REQUIRED';
}

/**
 * Jawna intencja zapisu wobec porcji per osoba (workstream
 * `per-user-portions-write-safety`):
 * - `PRESERVE` — zachowaj bieżącą alokację; przy zmianie audytorium serwer
 *   przelicza ją sam (`remapPortions`); `plannedServings` = ceil(Σ);
 * - `REPLACE` — podane `portions` stają się alokacją (zastąpienie istniejącej
 *   wymaga zweryfikowanego zapisu — tokenu);
 * - `RESET` — świadomy powrót do równego podziału (usunięcie istniejącej
 *   alokacji wymaga zweryfikowanego zapisu — tokenu).
 * Brak pola = `LEGACY`: niepuste `portions` = `REPLACE`, pominięte — pozycja
 * bez alokacji jak dotąd, z alokacją: identyczny zapis zostawia ją nietkniętą,
 * każda inna zmiana = `PLAN_PORTIONS_CONFLICT` (nigdy cichy `RESET`).
 */
export const PORTION_POLICIES = ['PRESERVE', 'REPLACE', 'RESET'] as const;
export type PortionPolicy = (typeof PORTION_POLICIES)[number];
export type PortionIntent = PortionPolicy | 'LEGACY';

/** Porcja osoby, która dołącza do audytorium pozycji z alokacją. */
export const JOINED_PORTION_SERVINGS = 1;

export function portionIntentOf(
  policy: PortionPolicy | undefined,
  portions: readonly PortionView[],
): PortionIntent {
  if (policy) return policy;
  return portions.length > 0 ? 'REPLACE' : 'LEGACY';
}

/**
 * Alokacja dla NOWEGO audytorium z bieżącej: osoby, które zostają, zachowują
 * swoją porcję; nowe dostają `JOINED_PORTION_SERVINGS`; usunięte znikają.
 * `audience` = konkretne osoby (dla „Wspólne” — wszyscy domownicy).
 */
export function remapPortions(
  current: readonly PortionView[],
  audience: Iterable<string>,
): PortionView[] {
  const byUser = new Map(current.map((p) => [p.userId, p.servings]));
  return [...new Set(audience)]
    .sort((a, b) => a.localeCompare(b))
    .map((userId) => ({
      userId,
      servings: byUser.get(userId) ?? JOINED_PORTION_SERVINGS,
    }));
}

/**
 * Wynik planowania porcji dla ISTNIEJĄCEJ pozycji: decyzja i alokacja, która
 * ma zostać zapisana (`[]` = bez alokacji). `INVALID` = `PLAN_PORTIONS_INVALID`
 * z `problem`. Ta sama funkcja liczy zapis, podgląd i `dryRun`.
 */
export type PortionsPlan = {
  decision: PortionsWriteDecision | 'INVALID';
  portions: PortionView[];
  problem?: string;
};

export const PRESERVE_SERVINGS_PROBLEM =
  'Przy porcjach per osoba łączna liczba porcji wynika z ich sumy — zmień porcje osób albo użyj RESET.';

export function planPortionsForExisting(
  current: {
    participantIds: readonly string[];
    plannedServings: number;
    portions: readonly PortionView[];
  },
  requested: {
    participantIds: readonly string[];
    plannedServings?: number | null;
    portions: readonly PortionView[];
    intent: PortionIntent;
    /** Osoby jedzące po zapisie (dla „Wspólne” — wszyscy domownicy). */
    audience: readonly string[];
  },
  policy: PortionsWritePolicy,
): PortionsPlan {
  const allocated = current.portions.length > 0;
  switch (requested.intent) {
    case 'LEGACY':
      return {
        decision: portionsWriteDecision(
          current,
          { ...requested, portions: [] },
          policy,
        ),
        portions: [],
      };
    case 'REPLACE':
      return {
        decision: portionsWriteDecision(current, requested, policy),
        portions: [...requested.portions],
      };
    case 'RESET':
      return {
        decision: allocated ? resetDecision(policy) : 'WRITE',
        portions: [],
      };
    case 'PRESERVE': {
      if (!allocated) return { decision: 'WRITE', portions: [] };
      const portions = remapPortions(current.portions, requested.audience);
      const problem = portionsProblem(portions, new Set(requested.audience));
      if (problem) return { decision: 'INVALID', portions, problem };
      if (
        requested.plannedServings != null &&
        requested.plannedServings !== derivedPlannedServings(portions)
      ) {
        return {
          decision: 'INVALID',
          portions,
          problem: PRESERVE_SERVINGS_PROBLEM,
        };
      }
      const changed = !samePortions(current.portions, portions);
      if (changed && policy === 'no-allocation-changes') {
        return { decision: 'CONFLICT', portions };
      }
      return { decision: 'WRITE', portions };
    }
  }
}

/** `RESET` pozycji Z alokacją — usunięcie alokacji, jak usunięcie pozycji. */
function resetDecision(policy: PortionsWritePolicy): PortionsWriteDecision {
  return portionsRemovalDecision(policy) ?? 'WRITE';
}
