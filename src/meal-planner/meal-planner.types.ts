import { DayOfWeek, DietPreferenceValue, MealType } from '@prisma/client';

/**
 * Serwerowy planer posiłków — kontrakt wejścia i wyjścia (workstream, Etap 2).
 *
 * Silnik jest CZYSTY: nie zna bazy, modelu ani tożsamości pytającego. Dostaje
 * gotową pulę przepisów, profile jedzących i to, co już stoi w tygodniu,
 * a oddaje szkic planu (`PlanDraft`) z diagnostyką. Ładowanie danych, filtr
 * zgód i zapis przez propozycję robi adapter asystenta
 * (`src/agent/planner/agent-meal-planner.service.ts`).
 *
 * Semantyka porcji — patrz audyt 2A (`portion-semantics.audit.spec.ts`):
 * `plannedServings` to porcje ŁĄCZNE, dzielone RÓWNO między jedzących.
 */

export type PlannerNutrition = {
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
};

/** Przepis w kształcie, którego potrzebuje planer. */
export type PlannerRecipe = {
  id: string;
  title: string;
  /** Pory, do których przepis się nadaje (pusta lista w bazie = jego `mealType`). */
  slots: MealType[];
  /** Na ile porcji napisany jest przepis (1..8). */
  servings: number;
  prepTimeMinutes: number;
  /** Makra NA PORCJĘ; `null` = przepis bez makr (planer go nie użyje). */
  perServing: PlannerNutrition | null;
  allergens: string[];
  dietTags: string[];
  /** Wszystkie składniki — do wykluczeń domowników. */
  ingredientIds: string[];
  /** Nazwy składników znormalizowane (ASCII, małe litery) — do „bez X" z prośby. */
  ingredientNames: string[];
  /** Składniki bez przypraw — do premii za wspólne zakupy. */
  sharedIngredientIds: string[];
  /** Tagi wyszukiwarki (`soup`, `poultry`, `quick`…). */
  tags: string[];
  /** Aktywny i widoczny dla tego domu. Nieaktywny nie wejdzie nigdy. */
  active: boolean;
};

/** Profil osoby: twarde ograniczenia i cele. */
export type PlannerEater = {
  userId: string;
  allergens: string[];
  excludedIngredientIds: string[];
  diet: DietPreferenceValue;
  /** Dzienny cel kcal. */
  kcalTarget: number;
  /** Dzienne cele makro w gramach; `null` = nie da się ich policzyć. */
  macros: { proteinG: number; fatG: number; carbsG: number } | null;
};

/** Pozycja planu — ten sam kształt, co slot `applyWeekPlan`. */
export type PlannedItem = {
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
  /** Puste = cały dom. */
  participantIds: string[];
  /** Porcje ŁĄCZNE. */
  plannedServings: number;
};

/**
 * Twarde wymagania PROŚBY — poza profilami jedzących. Nie do poluzowania
 * przez scoring: przepis, który ich nie spełnia, nie jest kandydatem.
 */
export type PlanningConstraints = {
  /** Dieta dla tej prośby („wegetariańska kolacja"); `null` = bez dodatkowej. */
  diet: DietPreferenceValue | null;
  /** Tagi, które danie MUSI mieć (wszystkie). */
  requiredTags: string[];
  /** Fragmenty nazw składników, których danie NIE może mieć (znormalizowane). */
  avoidIngredients: string[];
  /** Przepisy wykluczone (np. danie, które właśnie podmieniamy). */
  excludeRecipeIds: string[];
};

/** Miękkie preferencje — wpływają na ranking, nigdy na dopuszczalność. */
export type PlanningPreferences = {
  /** Tagi mile widziane (co najmniej jeden). */
  preferredTags: string[];
  /** Podpowiedź czasu gotowania; przekroczenie kosztuje, nie wyklucza. */
  maxPrepMinutes: number | null;
  favoriteRecipeIds: string[];
  /** Przepisy z niedawnych tygodni — powtórka kosztuje. */
  recentRecipeIds: string[];
  /** Ile razy przepis stał w planach wszystkich domów. */
  popularity: Record<string, number>;
};

export type PlanningRequest = {
  /** Dni do zaplanowania (kolejność bez znaczenia). */
  days: DayOfWeek[];
  /** Pory do zaplanowania każdego z tych dni. */
  mealTypes: MealType[];
  /** Wszyscy domownicy (profile) — twarde ograniczenia i cele. */
  members: PlannerEater[];
  /** Dla kogo planujemy; puste = cały dom. */
  participantIds: string[];
  /** Co już stoi w tygodniu i zostaje (liczy się do bilansu i powtórek). */
  fixed: PlannedItem[];
  constraints: PlanningConstraints;
  preferences: PlanningPreferences;
  /**
   * Cel kcal NA OSOBĘ dla konkretnego slotu (`DAY|MEAL`) — np. „podobnie
   * kalorycznie" przy podmianie. Dokłada się do celu dnia, nie zastępuje go.
   */
  slotKcalTargets?: Record<string, number>;
  /**
   * `auto` = porcji tyle, ilu jedzących (udział 1); `tune` = planer może
   * dobrać porcje w widełkach `PORTION_SHARE_MIN..MAX`.
   */
  portionMode?: 'auto' | 'tune';
  /** Ziarno rozstrzygania remisów — ten sam seed i dane = ten sam plan. */
  seed?: string;
};

export type PlanStatus = 'OK' | 'PARTIAL' | 'UNSAT';

export type PlanIssueCode =
  /** Po filtrach twardych nie został żaden przepis dla tej pory. */
  | 'NO_CANDIDATES'
  /** Dzień osoby poza tolerancją kcal. */
  | 'KCAL_OUT_OF_TOLERANCE'
  /** Białko dnia osoby poza tolerancją. */
  | 'PROTEIN_OUT_OF_TOLERANCE'
  /** Tłuszcz albo węglowodany poza tolerancją (informacyjnie). */
  | 'MACRO_OUT_OF_TOLERANCE'
  /** Za mało różnych dań na tę porę — powtórka była nieunikniona. */
  | 'REPEAT_FORCED'
  /** Danie dłuższe niż podpowiedź czasu. */
  | 'PREP_TIME_EXCEEDED'
  /** Danie bez żadnego z mile widzianych tagów. */
  | 'PREFERENCE_UNMET';

export type PlanIssue = {
  code: PlanIssueCode;
  /** `error` — czegoś nie da się zrobić; `warning` — cel nie trafiony; `info`. */
  severity: 'error' | 'warning' | 'info';
  dayOfWeek?: DayOfWeek;
  mealType?: MealType;
  userId?: string;
  planned?: number;
  target?: number;
  message: string;
};

export type HardFilterReason =
  | 'INACTIVE'
  | 'MEAL_TYPE'
  | 'NO_NUTRITION'
  | 'ALLERGEN'
  | 'EXCLUDED_INGREDIENT'
  | 'DIET'
  | 'REQUEST_DIET'
  | 'REQUIRED_TAG'
  | 'AVOIDED_INGREDIENT'
  | 'EXCLUDED_RECIPE';

export type CandidateStats = {
  mealType: MealType;
  /** Przepisy w puli. */
  total: number;
  /** Po filtrach twardych. */
  eligible: number;
  /** Ile odpadło i dlaczego (pierwszy powód na przepis). */
  removed: Partial<Record<HardFilterReason, number>>;
};

export type EaterDayDiagnostics = {
  userId: string;
  kcal: number;
  kcalTarget: number;
  /** Odchylenie względne, znak: + ponad cel. */
  kcalDeviation: number;
  protein: number;
  proteinTarget: number | null;
  fat: number;
  fatTarget: number | null;
  carbs: number;
  carbsTarget: number | null;
};

export type DayDiagnostics = {
  dayOfWeek: DayOfWeek;
  /** Jaką część dziennego celu pokrywają planowane pory (np. 0,8). */
  coverage: number;
  eaters: EaterDayDiagnostics[];
};

export type PlanMetrics = {
  /** Średnie |odchylenie kcal| po osobo-dniach, w procentach. */
  kcalDeviationPct: number;
  maxKcalDeviationPct: number;
  /** Średnie |odchylenie| makro w %; `null` = brak celów makro. */
  proteinDeviationPct: number | null;
  fatDeviationPct: number | null;
  carbsDeviationPct: number | null;
  /** Złamane twarde ograniczenia — dla planu z planera ZAWSZE 0. */
  hardViolations: number;
  /** Ile razy przepis wystąpił ponad pierwszy raz w tygodniu. */
  repeats: number;
  /** Niespełnione miękkie preferencje (czas, tagi). */
  softUnmet: number;
  /** Wartość funkcji celu (mniej = lepiej) — do porównań wariantów. */
  objective: number;
  slotsRequested: number;
  slotsFilled: number;
  /** Kandydaci po filtrach twardych, suma po porach. */
  candidatesConsidered: number;
  durationMs: number;
};

export type PlanDiagnostics = {
  issues: PlanIssue[];
  days: DayDiagnostics[];
  candidates: CandidateStats[];
  metrics: PlanMetrics;
};

export type PlanDraft = {
  status: PlanStatus;
  /** NOWE pozycje (bez `fixed`). */
  items: PlannedItem[];
  diagnostics: PlanDiagnostics;
};
