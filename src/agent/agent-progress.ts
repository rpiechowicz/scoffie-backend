/**
 * Postęp tury — to, co telefon pokazuje przez te trzydzieści sekund.
 *
 * Tura trwa 25–60 s, a klient odpytuje `GET /agent/turns/:id` co sekundę.
 * Kolumna `AgentTurn.progress` istniała od Fazy 0 i przez cały ten czas
 * wracała pusta: kontrakt obiecywał kroki, klient dostawał `[]` i mógł
 * pokazać wyłącznie kręciołek. Tu powstają wpisy, które ten kontrakt wypełniają.
 *
 * Etykieta jest gotowym zdaniem PO POLSKU, a nie kodem do przetłumaczenia na
 * kliencie — tak samo jak komunikaty błędów z serwera. Klient, który chce
 * własnej ikony albo własnego tekstu, ma `tool`; klient, który nie chce nic
 * mapować, ma `label` i działa od pierwszego dnia.
 */
export type AgentProgressStep = {
  /** Nazwa narzędzia (`apply_week_plan`) — dla klienta z własną mapą. */
  tool: string;
  /** Gotowe zdanie do pokazania użytkownikowi. */
  label: string;
  /** Kiedy krok się zaczął (ISO 8601, UTC). */
  at: string;
  /**
   * Czy ten krok ZMIENIA dane gospodarstwa.
   *
   * Klient po tym poznaje, że po turze jest co oglądać — plan tygodnia albo
   * przepis — i może pokazać skrót „otwórz plan" zamiast kazać użytkownikowi
   * czytać w odpowiedzi, co się właśnie stało. Sama nazwa narzędzia nie
   * wystarczy: `apply_week_plan` biegnie w każdej turze najpierw jako próba
   * (`dry_run`), która niczego nie zapisuje.
   */
  writes: boolean;
  /**
   * `PLANNING` = od tego kroku turę prowadzi dokładniejszy model
   * (`start_planning`, patrz `AI_MODEL_TOOLS`). Klient rysuje ten krok jako
   * osobny moment z licznikiem sekund, nie jako kolejną linijkę — projekt v2.
   * Brak pola = zwykły krok.
   */
  phase?: 'PLANNING';
};

/**
 * Etykiety mówią, co asystent ROBI DLA UŻYTKOWNIKA, a nie jak nazywa się
 * narzędzie. „Czytam plan tygodnia" jest zrozumiałe; „get_week_plan" nie jest.
 *
 * Każde narzędzie ma KILKA sformułowań i to nie jest ozdoba. Ten sam wiersz
 * pod każdym pytaniem czyta się po trzecim razie jak komunikat maszyny —
 * a asystent, który za każdym razem mówi identycznie, przestaje brzmieć jak
 * ktoś, kto akurat coś robi. Wybór jest deterministyczny (patrz `pickLabel`),
 * więc odpytanie tej samej tury dwa razy nigdy nie podmieni tekstu pod ręką.
 */
const LABELS: Record<string, readonly string[]> = {
  get_household_context: [
    'Sprawdzam, kto je i jakie ma cele',
    'Zaglądam do profili domowników',
    'Przypominam sobie, kto czego nie je',
  ],
  get_week_plan: [
    'Czytam plan tygodnia',
    'Sprawdzam, co już stoi w planie',
    'Patrzę, który dzień jest jeszcze pusty',
  ],
  get_week_balance: [
    'Liczę bilans dnia',
    'Sprawdzam, jak wychodzą kalorie',
    'Podliczam tydzień',
  ],
  get_recipe_details: [
    'Czytam przepis',
    'Sprawdzam skład i kroki',
    'Zaglądam do przepisu',
  ],
  search_recipes_by_ingredient: [
    'Szukam dań z tym składnikiem',
    'Przeglądam składy przepisów',
  ],
  search_ingredients: [
    'Szukam składników',
    'Przeglądam listę produktów',
    'Sprawdzam, co wchodzi w skład',
  ],
  ask_clarifying_question: ['Formułuję pytanie', 'Wolę dopytać, niż zgadywać'],
  propose_week_plan: [
    'Układam propozycję planu',
    'Dobieram dania na cały tydzień',
    'Składam tydzień tak, żeby nic się nie powtarzało',
  ],
  propose_day_plan: ['Układam ten dzień', 'Dobieram posiłki na jeden dzień'],
  propose_swap: ['Szukam czegoś w zamian', 'Dobieram danie na podmianę'],
  propose_remove_meal: [
    'Wyjmuję to z planu',
    'Sprawdzam, co zostanie po usunięciu',
  ],
  propose_household_split: [
    'Rozdzielam porcje',
    'Dopasowuję wielkość porcji do każdego',
  ],
  offer_options: ['Wybieram kilka propozycji', 'Zbieram dania do wyboru'],
  show_macro_gap: ['Sprawdzam, czego brakuje', 'Porównuję plan z celami'],
  show_shopping_list: [
    'Składam listę zakupów',
    'Sprawdzam, czego trzeba dokupić',
  ],
  remember_note: ['Zapamiętuję to sobie', 'Notuję na przyszłość'],
  // Jedno sformułowanie, celowo: to jest MOMENT, nie kolejny krok, i ma
  // wyglądać tak samo w każdej turze.
  start_planning: ['Biorę się za plan'],
  apply_week_plan: ['Zapisuję plan tygodnia', 'Wpisuję dania do planu'],
  create_recipe: ['Dodaję przepis', 'Zapisuję nowy przepis'],
  update_recipe: ['Poprawiam przepis'],
  delete_recipe: ['Wycofuję przepis'],
};

const DRY_RUN_LABELS: readonly string[] = [
  'Sprawdzam, czy plan się spina',
  'Upewniam się, że nic nie koliduje',
  'Sprawdzam alergeny i limity',
];

/** Narzędzie spoza listy (nowe, jeszcze bez etykiety) nie może zostawić pustki. */
export const PROGRESS_FALLBACK = 'Pracuję nad tym';

/** Narzędzia, które zapisują — `apply_week_plan` tylko bez `dry_run`. */
const WRITING_TOOLS = new Set([
  'apply_week_plan',
  'create_recipe',
  'update_recipe',
  'delete_recipe',
]);

/**
 * Wybór sformułowania — losowy w odbiorze, deterministyczny w działaniu.
 *
 * `Math.random()` byłby tu błędem: postęp zapisujemy w bazie i klient odpytuje
 * go co sekundę, ale runner tworzy krok tylko raz — za to TESTY i ewentualne
 * ponowne przeliczenie muszą dawać ten sam wynik. Ziarno to tura plus nazwa
 * narzędzia, więc dwie tury dostają inne zdania, a jedna tura zawsze to samo.
 */
function pickLabel(options: readonly string[], seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return options[Math.abs(hash) % options.length];
}

/**
 * Krok postępu dla wywołania narzędzia.
 *
 * `apply_week_plan` ma dwie twarze i użytkownik musi je rozróżniać: próba
 * (`dry_run`) niczego nie zmienia, a zapis zmienia jego tydzień. Pokazanie
 * „Zapisuję plan" przy suchym przebiegu byłoby po prostu nieprawdą.
 */
export function progressStep(
  tool: string,
  input: Record<string, unknown> = {},
  now: Date = new Date(),
  /** Ziarno wyboru sformułowania — w turze podajemy jej identyfikator. */
  seed = '',
): AgentProgressStep {
  const dryRun = tool === 'apply_week_plan' && input.dry_run === true;
  const options = dryRun ? DRY_RUN_LABELS : LABELS[tool];
  const label = options
    ? pickLabel(options, `${seed}:${tool}`)
    : PROGRESS_FALLBACK;
  return {
    tool,
    label,
    at: now.toISOString(),
    writes: WRITING_TOOLS.has(tool) && !dryRun,
    ...(tool === 'start_planning' ? { phase: 'PLANNING' as const } : {}),
  };
}

/**
 * Dokłada krok, chyba że powtarza poprzedni.
 *
 * Model potrafi wywołać `search_ingredients` osiem razy pod rząd — osiem
 * identycznych wierszy to nie jest postęp, tylko szum. Zwraca `true`, gdy
 * lista się zmieniła i warto ją zapisać.
 */
export function appendProgress(
  steps: AgentProgressStep[],
  step: AgentProgressStep,
): boolean {
  const last = steps[steps.length - 1];
  if (last && last.tool === step.tool && last.label === step.label) {
    return false;
  }
  steps.push(step);
  return true;
}
