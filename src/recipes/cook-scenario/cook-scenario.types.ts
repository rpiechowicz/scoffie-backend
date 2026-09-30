/**
 * Kształt scenariusza trybu Gotuj — KONTRAKT z telefonem (iOS, później
 * Android). Źródło decyzji: scoffie-ios `docs/workstreams/gotuj/README.md`
 * (§5 zasady pisania, §6 model danych, §13 zatwierdzony design).
 *
 * Zasady, które kształt wymusza:
 * - składnik wchodzi do kroku z ILOŚCIĄ tam, gdzie trafia do dania, i tylko
 *   tam; później może być przywołany bez ilości (`mentions`). Suma ilości
 *   danego składnika = ilość w przepisie (walidator `checkScenarioAgainstRecipe`);
 * - ilości są dla `basePortions` porcji — telefon skaluje je sam;
 * - timer ma własne `id` (a nie numer kroku), bo w przyszłości jedna oś może
 *   łączyć kilka przepisów, a krok „w międzyczasie” wskazuje timer, pod
 *   którym się mieści (`during`).
 *
 * Nowe pole = nowy `schemaVersion` tylko wtedy, gdy stary klient nie umie go
 * pominąć. Klient NIEZNANE pola i wartości słowników pomija.
 */

export const COOK_SCENARIO_SCHEMA_VERSION = 1;

/**
 * Zasady pisania (§5), według których powstał scenariusz wzorcowy.
 * `.2` (30.09, po pilocie E3b): liczba z jednostką przepisana dosłownie
 * z kroków przepisu, gdy nie jest ilością składnika; jeden czas z przepisu =
 * jeden timer.
 * `.3` (30.09, decyzje Rafała po pilocie): timer od 4 min, najwyżej dwa
 * odliczania naraz, kroki „w międzyczasie” mieszczą się po ludzku (±2 min),
 * tryb piekarnika zawsze podany, praktyczne wskazówki dozwolone.
 */
export const COOK_SCENARIO_RULES_VERSION = '2026-09-30.3';

export const COOK_STEP_PHASES = ['PREP', 'COOK', 'FINISH', 'SERVE'] as const;
export type CookStepPhase = (typeof COOK_STEP_PHASES)[number];

/**
 * Jaką część składnika zużywa krok. `ALL` = całość w jednym kroku,
 * `HALF`/`REST`/`PART` = porcja dzielona między kroki (telefon pisze
 * „połowa”, „reszta”; `PART` bez słowa, sama ilość).
 */
export const COOK_INGREDIENT_PARTS = ['ALL', 'HALF', 'REST', 'PART'] as const;
export type CookIngredientPart = (typeof COOK_INGREDIENT_PARTS)[number];

export const COOK_NOTE_KINDS = ['CUE', 'WARNING', 'TIP'] as const;
export type CookNoteKind = (typeof COOK_NOTE_KINDS)[number];

/** `NOW` = odliczanie od stuknięcia; `EVENT` = czeka na zdarzenie („gdy woda zawrze”). */
export const COOK_TIMER_TRIGGERS = ['NOW', 'EVENT'] as const;
export type CookTimerTrigger = (typeof COOK_TIMER_TRIGGERS)[number];

/** Limity tekstów — design ekranu kroku, wyspy i ekranu blokady (§5.2, §13). */
export const COOK_LIMITS = {
  title: 60,
  body: 320,
  stage: 24,
  note: 140,
  tip: 140,
  tipsMax: 3,
  nextTimeTip: 180,
  timerLabel: 14,
  timerStartLabel: 40,
  timerAlertTitle: 40,
  timerAlertBody: 120,
  scaleNote: 120,
  stepsMin: 1,
  stepsMax: 30,
  timerSecondsMax: 12 * 60 * 60,
} as const;

export interface CookStepIngredient {
  /** `Ingredient.id` składnika przepisu (`RecipeIngredient.ingredientId`). */
  ingredientId: string;
  /** Ilość w jednostce przepisu, dla `basePortions`. */
  amount: number;
  /** Jednostka — ta sama co w `RecipeIngredient.unit`. */
  unit: string;
  part: CookIngredientPart;
}

export interface CookStepNote {
  kind: CookNoteKind;
  text: string;
}

export interface CookTimer {
  id: string;
  /** Nazwa w kapsule, Dynamic Island i alercie („Kotlety”). */
  label: string;
  /** Po tylu sekundach dzwoni alarm. */
  minSeconds: number;
  /** Górna granica zakresu („10–12 min”); alarm proponuje „+2 min” do niej. */
  maxSeconds: number;
  trigger: CookTimerTrigger;
  /** Etykieta startu, mówi KIEDY stuknąć („Woda wrze — odliczaj 20 min”). */
  startLabel: string;
  alert: { title: string; body: string };
}

export interface CookStep {
  /** Stabilne w obrębie scenariusza („s1”…). */
  id: string;
  phase: CookStepPhase;
  /** Etykieta nad tytułem („SMAŻENIE”, „W MIĘDZYCZASIE”); `null` = z fazy. */
  stage: string | null;
  /** Co robisz teraz — jedno zdanie w trybie rozkazującym. */
  title: string;
  /** Jak — prostym językem; liczby porcjowe tylko przez tokeny `{count:…}`. */
  body: string;
  ingredients: CookStepIngredient[];
  /** Przywołania bez ilości (`Ingredient.id`) — „z talerzy z panierką”. */
  mentions: string[];
  note: CookStepNote | null;
  timer: CookTimer | null;
  /** `id` timera z WCZEŚNIEJSZEGO kroku, pod którym ten krok się mieści. */
  during: string | null;
  /** Nota skali pokazywana dopiero od `fromPortions` porcji. */
  scaleNote: { fromPortions: number; text: string } | null;
}

export interface CookScenarioContent {
  schemaVersion: typeof COOK_SCENARIO_SCHEMA_VERSION;
  /** Porcje, dla których są ilości (= `Recipe.servings` przy pisaniu). */
  basePortions: number;
  /** Sztuka dania do odmiany („kotlet”, „kotlety”, „kotletów”) — opcjonalna. */
  portionUnit: { id: string; forms: [string, string, string] } | null;
  totalMinutes: number;
  /** Rady kucharza na powitaniu (§13.1), najwyżej 3. */
  tips: string[];
  /** Rada „na następny raz” na zakończeniu (§13.3, D27). */
  nextTimeTip: string | null;
  steps: CookStep[];
}

/** Odpowiedź `recipes:cookScenario`. `scenario: null` = brak trybu Gotuj. */
export interface CookScenarioResponse {
  recipeId: string;
  scenario: {
    version: number;
    rulesVersion: string;
    content: CookScenarioContent;
  } | null;
}
