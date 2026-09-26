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
  /**
   * Krok PRZEJŚCIOWY: mówi, co dzieje się TERAZ, ale nie jest etapem, który
   * warto pamiętać po turze. Dziś jedyny taki to `think` — model czyta wyniki
   * narzędzi i decyduje, co dalej (albo już pisze odpowiedź). Klient pokazuje
   * go w wierszu na żywo, a pomija w zwiniętym podsumowaniu „Myślałem 42 s"
   * — bez tego lista kroków po turze byłaby przeplatana tym samym zdaniem
   * co drugi wiersz. Brak pola = zwykły krok.
   */
  transient?: true;
};

/**
 * Nie narzędzie, tylko CISZA między narzędziami.
 *
 * Wywołanie modelu po wynikach narzędzi trwa 10–30 s — najdłużej na końcu
 * tury, gdy model pisze odpowiedź. Przez ten czas ostatnim krokiem było
 * „Zapisuję plan tygodnia", czyli zdanie o czymś, co skończyło się pół
 * minuty temu; wskaźnik na telefonie wyglądał wtedy na zawieszony. Ten krok
 * mówi prawdę o tym odcinku, a serwer NIE WIE z góry, czy po nim przyjdzie
 * kolejne narzędzie, czy ostatnie słowo — stąd sformułowania, które pasują
 * do obu.
 */
export const THINK_STEP_TOOL = 'think';

/**
 * Trzy kroki PRZED pierwszym narzędziem i MIĘDZY nimi, których nie widać
 * w żadnym wywołaniu narzędzia — a które zajmują większość ciszy tury.
 *
 * `read`: tura ruszyła, historia i prompt się składają, żądanie idzie do
 * API. `reason`: model myśli (bloki `thinking` w strumieniu) — przy modelach
 * z rozumowaniem to 10–40 s bez jednej litery odpowiedzi i bez narzędzia.
 * `write`: pierwszy fragment tekstu — od tej chwili szkic rośnie na
 * telefonie. Bez tych trzech telefon przez pierwsze pół minuty pokazywał
 * „Zastanawiam się…" i nic więcej, a użytkownik brał to za zawieszenie.
 *
 * Wszystkie są przejściowe jak `think`: mówią, co dzieje się TERAZ, ale po
 * turze nie są etapem, który warto pamiętać — `settledProgress` zdejmuje je
 * z zapisu przy domknięciu.
 */
export const READ_STEP_TOOL = 'read';
export const REASON_STEP_TOOL = 'reason';
export const WRITE_STEP_TOOL = 'write';

/** Kroki, które mówią o TERAŹNIEJSZOŚCI, nie o etapie — patrz `transient`. */
const TRANSIENT_TOOLS: ReadonlySet<string> = new Set([
  THINK_STEP_TOOL,
  READ_STEP_TOOL,
  REASON_STEP_TOOL,
  WRITE_STEP_TOOL,
]);

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
  find_recipes: [
    'Szukam pasujących dań',
    'Przeglądam katalog przepisów',
    'Dobieram dania do Waszych ograniczeń',
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
  mark_meal_eaten: ['Odhaczam posiłek', 'Zaznaczam, że to zjedzone'],
  check_shopping_items: ['Odhaczam zakupy', 'Zaznaczam kupione produkty'],
  // Jedno sformułowanie, celowo: to jest MOMENT, nie kolejny krok, i ma
  // wyglądać tak samo w każdej turze.
  start_planning: ['Biorę się za plan'],
  apply_week_plan: ['Zapisuję plan tygodnia', 'Wpisuję dania do planu'],
  create_recipe: ['Dodaję przepis', 'Zapisuję nowy przepis'],
  update_recipe: ['Poprawiam przepis'],
  delete_recipe: ['Wycofuję przepis'],
  [THINK_STEP_TOOL]: [
    'Zbieram to w całość',
    'Analizuję, co wyszło',
    'Myślę, co z tym zrobić',
  ],
  // Start tury. Nie „czytam pytanie": to opis mechaniki (i brzmiało jak
  // automat, który głośno sylabizuje), a nie tego, co asystent robi dla
  // użytkownika. Tu ma paść zdanie człowieka, który bierze się do roboty.
  [READ_STEP_TOOL]: [
    'Już się tym zajmuję',
    'Zabieram się do tego',
    'Chwila, już patrzę',
  ],
  [REASON_STEP_TOOL]: [
    'Zastanawiam się nad podejściem',
    'Myślę nad tym',
    'Rozważam, co zrobić',
    'Układam plan działania',
  ],
  [WRITE_STEP_TOOL]: [
    'Piszę odpowiedź',
    'Układam odpowiedź',
    'Formułuję odpowiedź',
  ],
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
  // Nie zmieniają PLANU, ale zmieniają dane gospodarstwa, które użytkownik
  // ogląda na osobnych ekranach — po takiej turze skrót „otwórz plan" albo
  // „otwórz listę" prowadzi do czegoś, co naprawdę wygląda inaczej.
  'mark_meal_eaten',
  'check_shopping_items',
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
    ...(TRANSIENT_TOOLS.has(tool) ? { transient: true as const } : {}),
  };
}

/**
 * Postęp do ZAPISU przy domknięciu tury: bez kroków przejściowych.
 *
 * Na żywo „Już się tym zajmuję" i „Piszę odpowiedź" są sygnałem życia; po turze
 * byłyby szumem w podsumowaniu „Myślałem 42 s" i w każdym kliencie, który
 * nie zna flagi `transient`. Zostaje to, co asystent zrobił: narzędzia,
 * przekazanie planiście, zapis.
 */
export function settledProgress(
  steps: readonly AgentProgressStep[],
): AgentProgressStep[] {
  return steps.filter((step) => step.transient !== true);
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
