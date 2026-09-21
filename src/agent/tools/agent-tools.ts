/**
 * Narzędzia, które asystent może wywołać — kontrakt dla modelu.
 *
 * To jest ta część promptu, która decyduje o zachowaniu bardziej niż
 * jakakolwiek instrukcja: model wybiera narzędzie po nazwie i opisie, a pola
 * wypełnia po schemacie. Dlatego opisy mówią, KIEDY sięgnąć po narzędzie i
 * czego NIE robić, a nie tylko co ono robi.
 *
 * Każde narzędzie odpowiada operacji, która już istnieje w domenie i ma własną
 * walidację — schemat jest pierwszą bramką, nie jedyną. `strict: true` z
 * `additionalProperties: false` gwarantuje, że wejście zgadza się ze
 * schematem, więc halucynowane pole zatrzymuje się przed naszym kodem.
 *
 * Identyfikatory przepisów z katalogu model podaje jako KRÓTKI INDEKS z digestu
 * (`R01`), nigdy jako UUID — patrz `src/agent/catalog-digest.ts`. UUID kosztuje
 * 20–25 tokenów i model i tak by go przekręcił.
 */
export type AgentToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  /** Wejście MUSI zgadzać się ze schematem — halucynowane pole to błąd, nie dane. */
  /**
   * Wymuszenie schematu gramatyką po stronie API.
   *
   * Nie dla wszystkich: gramatyki WSZYSTKICH narzędzi ze `strict` kompilują
   * się razem i API odmawia, gdy wyjdzie za duża („compiled grammar is too
   * large"). Trzymamy je więc na narzędziach o płaskim wejściu, gdzie są
   * tanie, a zdejmujemy z tych z zagnieżdżonymi listami obiektów — tam
   * kosztują najwięcej, a nasza walidacja i tak sprawdza to samo i oddaje
   * modelowi błąd jako dane.
   */
  strict?: boolean;
};

const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): AgentToolDefinition['input_schema'] => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const WEEK_START = {
  type: 'string',
  description:
    'Poniedziałek tygodnia w formacie YYYY-MM-DD. Zawsze bierz go z kontekstu rozmowy, nie licz sam.',
};

const RECIPE_REF = {
  type: 'string',
  description:
    'Indeks przepisu DOKŁADNIE w formie z katalogu w prompcie (np. R07 albo R007 — tyle cyfr, ile w nagłówku katalogu) ' +
    'albo identyfikator przepisu gospodarstwa zwrócony przez create_recipe.',
};

const DAY = {
  type: 'string',
  enum: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
};

const MEAL = {
  type: 'string',
  enum: [
    'BREAKFAST',
    'SECOND_BREAKFAST',
    'LUNCH',
    'AFTERNOON_SNACK',
    'DINNER',
    'SNACK',
  ],
};

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: 'get_household_context',
    description:
      'Kto mieszka w gospodarstwie: dieta, alergeny, cel kaloryczny i cele makro każdej osoby. ' +
      'Wywołaj to ZANIM zaproponujesz cokolwiek do jedzenia — bez tego nie wiesz, czego ktoś nie je. ' +
      'Gdy makra mają źródło UNAVAILABLE, trzymaj się samych kalorii i nie zgaduj gramów.',
    input_schema: object({}),
    strict: true,
  },
  {
    name: 'get_week_plan',
    description:
      'Co już stoi w planie danego tygodnia. Wywołaj przed zmianą planu, żeby nie zaproponować ' +
      'czegoś, co już tam jest, i żeby wiedzieć, co zniknie po zastosowaniu nowego tygodnia. ' +
      'Pole recipe każdej pozycji to gotowa referencja do innych narzędzi: indeks katalogu (R07) ' +
      'albo identyfikator przepisu tego domu. Brak participants znaczy „posiłek dla całego domu"; ' +
      'othersCount mówi, ILU jedzących nie ma na liście, i tych osób nie da się wskazać po imieniu. ' +
      'Składów tu nie ma — masz je w katalogu.',
    input_schema: object({ week_start: WEEK_START }, ['week_start']),
    strict: true,
  },
  {
    name: 'get_week_balance',
    description:
      'Bilans dnia po dniu dla jednej osoby: ile kalorii i makr przypada na nią z zaplanowanych ' +
      'posiłków (planned) i ile z tego odhaczyła jako zjedzone (eaten). Porównaj to z celami ' +
      'z get_household_context, zanim powiesz, że plan jest dobry.',
    input_schema: object(
      {
        week_start: WEEK_START,
        member_user_id: {
          type: 'string',
          description: 'Czyj bilans; pominięte = osoby, z którą rozmawiasz.',
        },
      },
      ['week_start'],
    ),
    strict: true,
  },
  {
    name: 'get_recipe_details',
    description:
      'Pełny przepis: WSZYSTKIE składniki z gramaturą i kroki przygotowania. ' +
      'Katalog w prompcie pokazuje tylko pięć najcięższych składników i zero kroków, ' +
      'więc na pytania „jak to ugotować", „ile tam czego" i „czy jest w tym X" ' +
      'odpowiadasz WYŁĄCZNIE po wywołaniu tego narzędzia. Nie zgaduj z nazwy dania ' +
      'ani z tych pięciu składników — „dorsz z masłem" wygląda stamtąd na danie bez nabiału. ' +
      'Kroki przepisz swoimi słowami tylko wtedy, gdy użytkownik o nie prosi.',
    input_schema: object({ recipe: RECIPE_REF }, ['recipe']),
    // BEZ `strict` — to i cztery kolejne narzędzia z 18.09 weszły ze `strict`
    // bez smoke-testu na żywym API i produkcja oddawała AI_PROVIDER_ERROR na
    // KAŻDEJ turze (gramatyka wszystkich narzędzi ze `strict` kompiluje się
    // razem; patrz limit w agent-tools.spec.ts). Walidacja DTO w executorze
    // sprawdza to samo. Wracać do `strict` tylko po zielonym
    // `pnpm exec tsx scripts/agent-tools-smoke.ts`.
  },
  {
    name: 'search_recipes_by_ingredient',
    description:
      'Znajdź dania, w których naprawdę JEST dany składnik — po całym składzie, ' +
      'nie po nazwie dania. Używaj, gdy pytanie wychodzi od produktu („co zrobić ' +
      'z bakłażanem", „mam pół kurczaka", „coś z soczewicą"): katalog w prompcie ' +
      'niesie tylko pięć najcięższych składników każdego dania, więc sam go nie ' +
      'przejrzysz pod tym kątem i przegapisz połowę trafień. ' +
      'Odmiana nie przeszkadza („jajka" znajdzie „jajko"). ' +
      'Wynik niesie gotowe referencje do propose_* — używaj ich dosłownie.',
    input_schema: object(
      {
        ingredient: {
          type: 'string',
          description: 'Nazwa składnika albo jej fragment, po polsku.',
        },
      },
      ['ingredient'],
    ),
  },
  {
    name: 'search_ingredients',
    description:
      'Znajdź składnik po nazwie i pobierz jego identyfikator, alergeny i dozwolone jednostki. ' +
      'MUSISZ tego użyć przed create_recipe albo update_recipe — identyfikatorów składników nie ' +
      'wolno wymyślać. Odmiana nie przeszkadza („jajka" znajdzie „jajko"). ' +
      'Ustaw only_with_nutrition, gdy budujesz przepis: składnik bez wartości odżywczych zostanie ' +
      'odrzucony przy zapisie.',
    input_schema: object(
      {
        query: { type: 'string', description: 'Nazwa albo jej fragment.' },
        only_with_nutrition: {
          type: 'boolean',
          description: 'Tylko składniki, którymi da się zbudować przepis.',
        },
      },
      ['query'],
    ),
    strict: true,
  },
  {
    name: 'ask_clarifying_question',
    description:
      'Zadaj JEDNO pytanie, gdy brakuje ci informacji, bez której plan byłby zgadywaniem ' +
      '(dla ilu osób, na który tydzień, co z alergią, której nie ma w profilu). ' +
      'Podaj 2–4 gotowe odpowiedzi — użytkownik wybiera jedną dotknięciem, więc pytaj o rzeczy ' +
      'rozstrzygalne jednym słowem. NIE używaj tego zamiast sprawdzenia narzędziem: jeśli ' +
      'odpowiedź jest w get_household_context albo w get_week_plan, po prostu ją sprawdź. ' +
      'Po tym narzędziu KOŃCZYSZ turę — nie proponujesz planu w tej samej odpowiedzi.',
    input_schema: object(
      {
        question: {
          type: 'string',
          description: 'Jedno zdanie, konkretne pytanie.',
        },
        hint: {
          type: 'string',
          description:
            'Jedno zdanie, dlaczego pytasz. Pomiń, gdy to oczywiste.',
        },
        options: {
          type: 'array',
          description:
            'Gotowe odpowiedzi, od najbardziej prawdopodobnej. 2–4 pozycje, ' +
            'każda krótka jak przycisk („Dla czterech osób").',
          items: { type: 'string' },
        },
      },
      ['question', 'options'],
    ),
    strict: true,
  },
  {
    name: 'propose_day_plan',
    description:
      'Pokaż PROPOZYCJĘ jednego dnia. Tak jak propose_week_plan, ale lista slots opisuje stan ' +
      'docelowy WYŁĄCZNIE tego dnia — reszta tygodnia zostaje nietknięta. Używaj, gdy rozmowa ' +
      'dotyczy jednego dnia („co na jutro?"): karta dnia pokazuje posiłek po posiłku i sumę ' +
      'wobec celu, czego karta tygodnia nie robi. TY NIE ZAPISUJESZ — zapisze użytkownik.',
    input_schema: object(
      {
        week_start: WEEK_START,
        day_of_week: DAY,
        note: {
          type: 'string',
          description:
            'Jedno zdanie, dlaczego akurat tak. Bez liczb i bez nazw dań — te są w karcie.',
        },
        slots: {
          type: 'array',
          description: 'Posiłki tego dnia; najwyżej 6 pozycji.',
          items: object(
            {
              meal_type: MEAL,
              recipe: RECIPE_REF,
              participant_user_ids: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Kto to je. Pomiń albo zostaw puste, gdy danie jest dla całego domu.',
              },
              planned_servings: {
                type: 'integer',
                description:
                  'Porcje ŁĄCZNE, 1–12. Pomiń, żeby policzyły się z audytorium.',
              },
            },
            ['meal_type', 'recipe'],
          ),
        },
      },
      ['week_start', 'day_of_week', 'slots'],
    ),
  },
  {
    name: 'offer_options',
    description:
      'Pokaż 2–4 DANIA DO WYBORU jako kafelki ze zdjęciem, kaloriami i czasem. ' +
      'Używaj, gdy pytanie brzmi „co na kolację?" i sensownych odpowiedzi jest kilka — ' +
      'wybór obrazkami jest szybszy niż lista w tekście. Dotknięcie kafelka wysyła zwykłą ' +
      'wiadomość „Wybieram: …", więc po tym narzędziu KOŃCZYSZ turę i czekasz na wybór. ' +
      'Nie używaj do pokazania planu — od tego są propose_week_plan i propose_day_plan.',
    input_schema: object(
      {
        title: {
          type: 'string',
          description: 'Nagłówek karty, np. „Trzy szybkie kolacje".',
        },
        slot_label: {
          type: 'string',
          description:
            'Pora i DZIEŃ, którego dotyczy wybór — zawsze oba, np. „Kolacja · wtorek". ' +
            'Dzień nazwą tygodnia, także dla „dziś" i „jutro": aplikacja składa z niego ' +
            'przycisk „Wstaw na wtorek".',
        },
        options: {
          type: 'array',
          description: '2–4 pozycje z katalogu.',
          items: object(
            {
              recipe: RECIPE_REF,
              tag: {
                type: 'string',
                description:
                  'Jedno słowo, czym to danie się wyróżnia: „Najszybsze", „Najwięcej białka".',
              },
            },
            ['recipe'],
          ),
        },
      },
      ['title', 'slot_label', 'options'],
    ),
  },
  {
    name: 'propose_swap',
    description:
      'Zaproponuj PODMIANĘ jednego dania w planie. Karta pokaże, co znika i co wchodzi, ' +
      'razem z różnicą w czasie i kaloriach — to jest odpowiedź na „co się zmieni". ' +
      'Podmiana wymienia CAŁY slot (dzień + posiłek) na jedno danie. ' +
      'TY NIE ZAPISUJESZ — zapisze użytkownik jednym kliknięciem.',
    input_schema: object(
      {
        week_start: WEEK_START,
        day_of_week: DAY,
        meal_type: MEAL,
        recipe: RECIPE_REF,
        reason: {
          type: 'string',
          description:
            'Czego chciał użytkownik („żeby było szybciej"). Trafia w tytuł, gdy różnice są drobne.',
        },
        participant_user_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Dla KOGO jest ta podmiana. Podane = tylko te osoby dostają nowe danie, ' +
            'a reszta domu zostaje przy dotychczasowym. Pominięte = podmiana dla wszystkich, ' +
            'czyli stare danie znika z planu.',
        },
      },
      ['week_start', 'day_of_week', 'meal_type', 'recipe'],
    ),
    strict: true,
  },
  {
    name: 'propose_remove_meal',
    description:
      'Zaproponuj USUNIĘCIE jednego dania z planu — gdy użytkownik mówi, że ' +
      'czegoś nie będzie („w czwartek jemy u teściów", „zdejmij tę kolację"). ' +
      'NIE rób tego przez apply_week_plan: tamto przyjmuje stan docelowy CAŁEGO ' +
      'tygodnia i każda pozycja, której nie wypiszesz, zniknie razem z tą jedną. ' +
      'Podaj participant_user_ids, gdy danie ma zniknąć TYLKO komuś — reszta domu ' +
      'zostaje wtedy przy swoim. TY NIE ZAPISUJESZ — usunie użytkownik jednym kliknięciem.',
    input_schema: object(
      {
        week_start: WEEK_START,
        day_of_week: DAY,
        meal_type: MEAL,
        reason: {
          type: 'string',
          description:
            'Dlaczego to znika, kilka słów („nie ma nas w domu"). Trafia w tytuł karty.',
        },
        participant_user_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'KOMU danie znika. Puste = całemu domowi, czyli pozycja wypada z planu.',
        },
      },
      [
        'week_start',
        'day_of_week',
        'meal_type',
        'reason',
        'participant_user_ids',
      ],
    ),
  },
  {
    name: 'propose_household_split',
    description:
      'Zaproponuj JEDNO danie dla kilku osób naraz i powiedz, jak podać je każdej z nich. ' +
      'Używaj, gdy w domu są różne cele albo ograniczenia, a gotuje się jedno („co ugotować, ' +
      'żeby każdy zjadł swoje"). Cele i alergeny karta bierze z profili — ty dokładasz sam ' +
      'sposób podania (wielkość porcji, co odłożyć osobno, czego nie dosypywać). ' +
      'TY NIE ZAPISUJESZ — zapisze użytkownik.',
    input_schema: object(
      {
        week_start: WEEK_START,
        day_of_week: DAY,
        meal_type: MEAL,
        recipe: RECIPE_REF,
        portions: {
          type: 'array',
          description: 'Po jednej pozycji na osobę, która to je.',
          items: object(
            {
              user_id: {
                type: 'string',
                description: 'Identyfikator domownika z get_household_context.',
              },
              note: {
                type: 'string',
                description:
                  'Jak podać tej osobie: „Duża porcja + kasza 100 g", „Śmietana osobno".',
              },
            },
            ['user_id'],
          ),
        },
      },
      ['week_start', 'day_of_week', 'meal_type', 'recipe', 'portions'],
    ),
  },
  {
    name: 'show_macro_gap',
    description:
      'Pokaż, ile brakuje do celu makro w tym tygodniu, i zaproponuj 1–3 zmiany, które to ' +
      'domkną. LICZBY LICZY SERWER z bilansu tygodnia i celów z profilu — ty podajesz wyłącznie ' +
      'pomysły na zmianę wraz z szacunkiem, ile każda dodaje. Karta niczego nie zapisuje: ' +
      'przycisk „zastosuj" wyśle wiadomość, po której ułożysz normalną propozycję.',
    input_schema: object(
      {
        week_start: WEEK_START,
        macro: {
          type: 'string',
          description: 'O co chodzi.',
          enum: ['PROTEIN', 'FAT', 'CARBS', 'KCAL'],
        },
        member_user_id: {
          type: 'string',
          description: 'Czyj bilans; pominięte = osoby, z którą rozmawiasz.',
        },
        boosters: {
          type: 'array',
          description: '1–3 zmiany, każda jednym zdaniem.',
          items: object(
            {
              text: {
                type: 'string',
                description:
                  'Zmiana po ludzku: „Twarożek zamiast musli (śr.)".',
              },
              amount: {
                type: 'integer',
                description: 'Ile ta zmiana dodaje — w gramach albo kaloriach.',
              },
            },
            ['text', 'amount'],
          ),
        },
      },
      ['week_start', 'macro', 'boosters'],
    ),
  },
  {
    name: 'show_shopping_list',
    description:
      'Pokaż, co trzeba kupić na dany tydzień — po działach sklepu, z ilościami. ' +
      'Listę liczy serwer z zaplanowanych posiłków, więc TY NIE WYPISUJESZ produktów ' +
      'ani ilości w odpowiedzi; napisz jedno zdanie, a resztę pokaże karta. ' +
      'Aplikacja nie wie, co użytkownik ma w domu — nie mów, czego mu „nie brakuje".',
    input_schema: object({ week_start: WEEK_START }, ['week_start']),
    strict: true,
  },
  {
    name: 'mark_meal_eaten',
    description:
      'Odhacz zaplanowany posiłek jako ZJEDZONY przez osobę, z którą rozmawiasz ' +
      '(albo cofnij odhaczenie). Używaj, gdy pada to wprost: „zjadłem obiad", ' +
      '„kolacji nie jadłem". To zmienia WYŁĄCZNIE bilans tej osoby — plan zostaje ' +
      'nietknięty, innym domownikom nic nie ubywa. Danie bierze się z planu, więc ' +
      'nie podajesz przepisu; pusty slot kończy się błędem, nie odhaczeniem. ' +
      'Nie odhaczaj niczego „przy okazji" — tylko wtedy, gdy użytkownik o tym mówi.',
    input_schema: object(
      {
        week_start: WEEK_START,
        day_of_week: DAY,
        meal_type: MEAL,
        eaten: {
          type: 'boolean',
          description: 'true = zjedzone, false = zdejmij odhaczenie.',
        },
      },
      ['week_start', 'day_of_week', 'meal_type', 'eaten'],
    ),
  },
  {
    name: 'check_shopping_items',
    description:
      'Odhacz produkty na liście zakupów tego tygodnia (albo cofnij odhaczenie), ' +
      'gdy użytkownik mówi, że je ma: „kupiłem mleko i jajka". Podajesz NAZWY ' +
      'produktów po polsku — dopasowanie do listy robi serwer i oddaje, czego nie ' +
      'znalazł. Nie wymyślaj nazw spoza tego, co powiedział użytkownik, i nie ' +
      'odhaczaj „całej listy" na podstawie domysłu, że skoro był w sklepie, to ma wszystko.',
    input_schema: object(
      {
        week_start: WEEK_START,
        products: {
          type: 'array',
          description: 'Nazwy produktów, tak jak powiedział je użytkownik.',
          items: { type: 'string' },
        },
        checked: {
          type: 'boolean',
          description: 'true = kupione, false = zdejmij odhaczenie.',
        },
      },
      ['week_start', 'products', 'checked'],
    ),
  },
  {
    name: 'check_plan_conflicts',
    description:
      'Sprawdź, czy ZAPISANY plan tygodnia łamie czyjeś alergeny albo wykluczenia. ' +
      'Wywołuj ZAWSZE, gdy ktoś pyta, czy danie albo plan jest bezpieczny dla ' +
      'konkretnej osoby („czy środowy obiad jest ok dla Zosi?", „co mogę dać Ani?"). ' +
      'NIE odpowiadaj na takie pytania z pamięci ani ze składników — pełny skład ' +
      'przepisów zna wyłącznie serwer, a to narzędzie pyta tę samą bramkę, ' +
      'która pilnuje zapisu planu.',
    input_schema: object({ week_start: WEEK_START }, ['week_start']),
    strict: true,
  },
  {
    name: 'propose_week_plan',
    description:
      'Pokaż użytkownikowi PROPOZYCJĘ tygodnia. Lista slots to stan docelowy: czego na niej nie ma, ' +
      'tego w planie nie będzie. TY NIE ZAPISUJESZ PLANU — zapisze go użytkownik jednym kliknięciem ' +
      'w karcie, którą to narzędzie dla niego przygotuje. ' +
      'Narzędzie samo sprawdza plan po stronie serwera i zwraca naruszenia (nieznany przepis, danie ' +
      'nie do tego posiłku, ALERGEN domownika, obcy domownik) — popraw je i zawołaj ponownie. ' +
      'W odpowiedzi NIE przepisuj planu dzień po dniu: użytkownik widzi go w karcie.',
    input_schema: object(
      {
        week_start: WEEK_START,
        note: {
          type: 'string',
          description:
            'Jedno zdanie, dlaczego akurat tak. Bez liczb i bez nazw dań — te są w karcie.',
        },
        removals: {
          type: 'array',
          description:
            'Dla każdego dania z OBECNEGO planu, którego nie ma w slots: jedno-dwa słowa dlaczego ' +
            '(„powtórka", „ponad cel", „bez ryb"). Karta pokaże to obok przekreślonego dania. Pomiń, gdy nic nie znika.',
          items: object(
            {
              day_of_week: DAY,
              meal_type: MEAL,
              reason: { type: 'string', description: 'Najwyżej 3 słowa.' },
            },
            ['day_of_week', 'meal_type', 'reason'],
          ),
        },
        slots: {
          type: 'array',
          description: 'Najwyżej 42 pozycje na tydzień.',
          items: object(
            {
              day_of_week: DAY,
              meal_type: MEAL,
              recipe: RECIPE_REF,
              participant_user_ids: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Kto to je. Pomiń albo zostaw puste, gdy danie jest dla całego domu.',
              },
              planned_servings: {
                type: 'integer',
                description:
                  'Porcje ŁĄCZNE, 1–12. Pomiń, żeby policzyły się z audytorium — tak jest prawie zawsze dobrze.',
              },
            },
            ['day_of_week', 'meal_type', 'recipe'],
          ),
        },
      },
      ['week_start', 'slots'],
    ),
  },
  {
    name: 'apply_week_plan',
    description:
      'Zapisz CAŁY tydzień naraz. Lista slots to stan docelowy: czego na niej nie ma, tego nie ' +
      'będzie w planie. ZAWSZE wywołaj najpierw z dry_run=true — dostaniesz listę naruszeń ' +
      '(nieznany przepis, danie nie do tego posiłku, ALERGEN domownika, obcy domownik) ' +
      'i poprawisz wszystko naraz. ' +
      'Przy jakimkolwiek naruszeniu nic się nie zapisuje, więc ponowny zapis bez poprawki nic nie da.',
    input_schema: object(
      {
        week_start: WEEK_START,
        dry_run: {
          type: 'boolean',
          description: 'true = sprawdź i policz, nie zapisuj.',
        },
        slots: {
          type: 'array',
          description: 'Najwyżej 42 pozycje na tydzień.',
          items: object(
            {
              day_of_week: DAY,
              meal_type: MEAL,
              recipe: RECIPE_REF,
              participant_user_ids: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Kto to je. Pomiń albo zostaw puste, gdy danie jest dla całego domu.',
              },
              planned_servings: {
                type: 'integer',
                description:
                  'Porcje ŁĄCZNE, 1–12. Pomiń, żeby policzyły się z audytorium — tak jest prawie zawsze dobrze.',
              },
            },
            ['day_of_week', 'meal_type', 'recipe'],
          ),
        },
      },
      ['week_start', 'slots', 'dry_run'],
    ),
  },
  {
    name: 'create_recipe',
    description:
      'Utwórz nowy przepis gospodarstwa. Sięgaj po to dopiero, gdy w katalogu naprawdę nie ma nic ' +
      'odpowiedniego — katalog jest sprawdzony, twój przepis nie. Wartości odżywcze liczy serwer ' +
      'ze składników, więc ich nie podawaj. Identyfikatory składników bierz z search_ingredients.',
    input_schema: object(
      {
        title: { type: 'string' },
        meal_type: MEAL,
        prep_time_minutes: {
          type: 'integer',
          description: 'Ile minut zajmuje przygotowanie; co najmniej 1.',
        },
        servings: {
          type: 'integer',
          description: 'Na ile porcji jest ten przepis; 1–20.',
        },
        ingredients: {
          type: 'array',
          // Granica idzie w OPISIE, nie w `minItems` — słów kluczowych JSON
          // Schema to API nie przyjmuje (patrz `agent-tools.spec.ts`).
          // Pilnuje jej walidacja DTO: `@ArrayMinSize(1)`, bo przepis bez
          // składników ma zerowe makra i PUSTĄ listę alergenów, czyli wygląda
          // na danie bezpieczne dla każdego.
          description: 'Co najmniej jeden składnik, najwyżej 60.',
          items: object(
            {
              ingredient_id: {
                type: 'string',
                description: 'Wyłącznie z search_ingredients.',
              },
              amount: { type: 'number', description: 'Większa od zera.' },
              unit: {
                type: 'string',
                description:
                  'Jedna z allowed_units zwróconych przez search_ingredients dla tego składnika.',
              },
            },
            ['ingredient_id', 'amount', 'unit'],
          ),
        },
        steps: {
          type: 'array',
          description: 'Kroki po kolei; co najmniej jeden, najwyżej 40.',
          items: object({ text: { type: 'string' } }, ['text']),
        },
      },
      ['title', 'meal_type', 'prep_time_minutes', 'servings', 'ingredients'],
    ),
  },
  {
    name: 'update_recipe',
    description:
      'Popraw przepis gospodarstwa. Podaj tylko to, co ma się zmienić. Uwaga: przysłane składniki ' +
      'albo kroki ZASTĘPUJĄ poprzednie w całości, więc wysyłaj pełną listę, nie różnicę. ' +
      'Przepisów z katalogu nie da się zmienić — zrób własną kopię przez create_recipe.',
    input_schema: object(
      {
        recipe_id: {
          type: 'string',
          description:
            'Identyfikator przepisu gospodarstwa (nie indeks katalogu).',
        },
        title: { type: 'string' },
        prep_time_minutes: { type: 'integer' },
        servings: {
          type: 'integer',
          description: 'Na ile porcji jest ten przepis; 1–20.',
        },
        ingredients: {
          type: 'array',
          // Granica w OPISIE, nie w `minItems` (patrz `create_recipe`).
          // Pusta lista skasowałaby wszystkie składniki razem z makrami
          // i alergenami; odrzuca ją walidacja DTO (`@ArrayMinSize(1)`).
          // „Nie ruszaj składników" to POMINIĘCIE pola, nie `[]`.
          description:
            'Pełna lista, nie różnica; co najmniej jedna pozycja, najwyżej 60. ' +
            'Nie zmieniasz składników? Pomiń to pole — pustej listy nie wolno przysłać.',
          items: object(
            {
              ingredient_id: { type: 'string' },
              amount: { type: 'number', description: 'Większa od zera.' },
              unit: { type: 'string' },
            },
            ['ingredient_id', 'amount', 'unit'],
          ),
        },
        steps: {
          type: 'array',
          description:
            'Kroki po kolei; co najmniej jeden, najwyżej 40. Nie zmieniasz kroków? Pomiń to pole.',
          items: object({ text: { type: 'string' } }, ['text']),
        },
      },
      ['recipe_id'],
    ),
  },
  {
    name: 'remember_note',
    description:
      'Zapamiętaj JEDNO trwałe zdanie o tym gospodarstwie, żeby wiedzieć to także w następnych ' +
      'rozmowach. Używaj OSZCZĘDNIE i tylko dla rzeczy, które będą prawdziwe za miesiąc: stałe ' +
      'zwyczaje („w środy jedzą u teściów"), trwałe niechęci („Kuba nie je ryb"), sprzęt („mają ' +
      'Thermomixa"). NIE zapamiętuj: jednorazowych próśb, treści dzisiejszego planu, liczb, które ' +
      'i tak policzą narzędzia, ani niczego o wadze, zdrowiu i celach — to jest w preferencjach ' +
      'domownika i nie ma prawa trafić do wspólnej pamięci domu. Jedno zdanie, po polsku, bez ' +
      'imion, których użytkownik sam nie użył.',
    input_schema: object(
      {
        text: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['PREFERENCE', 'CONSTRAINT', 'HABIT'],
          description:
            'PREFERENCE = co lubią / wolą; CONSTRAINT = czego nie jedzą albo nie mogą; ' +
            'HABIT = stałe zwyczaje i rytm tygodnia.',
        },
        about_user_id: {
          type: 'string',
          description:
            'Jeżeli notatka jest o KONKRETNYM domowniku — jego user_id z get_household_context. ' +
            'Pomiń, gdy zdanie dotyczy całego domu. Notatka o osobie, której nie ma na tej ' +
            'liście, nie zostanie zapisana; notatka bez tego pola nie trafi do kolejnych rozmów, ' +
            'jeśli ktokolwiek w domu nie zgodził się na asystenta.',
        },
      },
      ['text', 'kind'],
    ),
    strict: true,
  },
  {
    name: 'delete_recipe',
    description:
      'Wycofaj przepis gospodarstwa z użycia. Nie zadziała, gdy przepis stoi w jakimkolwiek planie — ' +
      'najpierw usuń go z planu przez apply_week_plan.',
    input_schema: object({ recipe_id: { type: 'string' } }, ['recipe_id']),
    strict: true,
  },
] as const;

/**
 * Przekazanie tury mocniejszemu modelowi (`AI_MODEL_TOOLS`).
 *
 * Tańszy model dostaje TYLKO narzędzia do czytania i to jedno. Nie ma jak
 * ułożyć planu sam — `propose_*`/`apply_*` pojawiają się dopiero po wywołaniu
 * `start_planning`, kiedy pałeczkę przejmuje `AI_MODEL`. Dzięki temu podział
 * pracy jest wymuszony przez listę narzędzi, a nie przez prośbę w prompcie.
 * `reason` idzie do postępu tury jako „biorę się za plan" — użytkownik widzi,
 * że zaczyna się droższa część i że to normalne.
 */
export const START_PLANNING_TOOL: AgentToolDefinition = {
  name: 'start_planning',
  description:
    'Przekazanie pałeczki dokładniejszemu modelowi, który ułoży albo zmieni plan. ' +
    'Wywołaj, gdy pytanie wymaga UŁOŻENIA lub ZMIANY planu (tydzień, dzień, podmiana ' +
    'dania, porcje dla domu, nowy albo poprawiony przepis). Dopiero po tym wywołaniu ' +
    'dostaniesz narzędzia propose_* i apply_*. NIE wywołuj przy pytaniach o to, co jest ' +
    'w planie, o składniki, bilans czy listę zakupów — na nie odpowiadasz sam. ' +
    'Wołaj OD RAZU, bez pobierania planu i domowników: planista sprawdzi sam, ' +
    'co mu potrzebne, a to, co pobierzesz wcześniej, i tak przeczyta drugi raz.',
  input_schema: object({
    reason: {
      type: 'string',
      description: 'Jedno krótkie zdanie po polsku: co zamierzasz ułożyć.',
    },
  }),
  strict: true,
};

/**
 * Warstwa narzędzia = odpowiedź na pytanie „jaki model ma to robić".
 *
 * `chat` — czytanie i przepisywanie tego, co policzył serwer: tani model
 * fazy CHAT (patrz `agent-route.ts`). `planner` — dobór dań pod alergeny,
 * cele i makra albo zapis do bazy: mocny model fazy PLANNER.
 *
 * To JEST polityka routingu i jedyne miejsce, gdzie się ją zmienia:
 * `TRIAGE_TOOLS` i `PLANNING_TOOL_NAMES` są z niej wyprowadzone, więc
 * przeniesienie narzędzia między modelami to jedna linia widoczna w git.
 * Test w `agent-tools.spec.ts` pilnuje, żeby każde narzędzie miało wpis —
 * nowe narzędzie bez decyzji nie przejdzie CI.
 */
export type AgentToolTier = 'chat' | 'planner';

export const AGENT_TOOL_TIERS: Readonly<Record<string, AgentToolTier>> = {
  // Czytanie i pytania: dane są już policzone przez serwer.
  get_household_context: 'chat',
  get_week_plan: 'chat',
  get_week_balance: 'chat',
  show_shopping_list: 'chat',
  // Czytanie przepisu i szukanie po składniku zostaje w rozmowie CELOWO:
  // to są odpowiedzi na pytania („jak to ugotować", „co zrobić z bakłażanem"),
  // a nie układanie planu. Gdyby wymagały `start_planning`, najczęstsze
  // pytanie o przepis kosztowałoby drugi, droższy model za nic. Planista ma
  // je też — lista `AGENT_TOOLS` jest dla niego pełna.
  get_recipe_details: 'chat',
  search_recipes_by_ingredient: 'chat',
  // Karty, które niczego nie zapisują.
  ask_clarifying_question: 'chat',
  offer_options: 'chat',
  show_macro_gap: 'chat',
  remember_note: 'chat',
  // Bezpieczeństwo liczy serwer, model cytuje — patrz komentarz przy narzędziu.
  check_plan_conflicts: 'chat',
  // ZAPISY, a mimo to w warstwie rozmowy — i to jest decyzja, nie przeoczenie.
  // Podział warstw idzie za tym, jakiej INTELIGENCJI wymaga zadanie, a nie za
  // tym, czy coś dotyka bazy: odhaczenie „zjadłem obiad" nie dobiera dania,
  // nie sprawdza alergenów i nie rusza planu — zmienia bilans jednej osoby
  // albo jeden checkbox na liście zakupów. Oba są odwracalne tym samym
  // zdaniem („jednak nie jadłem"). Przepuszczenie ich przez `start_planning`
  // znaczyłoby, że najkrótsza wiadomość w całej aplikacji uruchamia droższy
  // model i drugą rundę narzędzi.
  mark_meal_eaten: 'chat',
  check_shopping_items: 'chat',
  // Układanie i zapisywanie: dobór pod ograniczenia całego domu.
  propose_week_plan: 'planner',
  propose_day_plan: 'planner',
  propose_swap: 'planner',
  propose_remove_meal: 'planner',
  propose_household_split: 'planner',
  apply_week_plan: 'planner',
  create_recipe: 'planner',
  update_recipe: 'planner',
  // NIE `chat`, mimo że samo w sobie tylko czyta. To narzędzie ma dokładnie
  // jedno zastosowanie — zdobyć `ingredient_id` do `create_recipe` /
  // `update_recipe` — a oba są u planisty. W warstwie rozmowy było więc
  // ślepą uliczką: tani model mógł wyszukać składnik i nie mieć co z nim
  // zrobić, płacąc rundę za nic.
  search_ingredients: 'planner',
  // Kasowanie przepisu jest jednym identyfikatorem, ale to ZAPIS — zostaje
  // u planisty do czasu, aż raport pokaże, ile takich tur naprawdę jest.
  delete_recipe: 'planner',
};

/** Narzędzia, których tańszy model NIE dostaje przed `start_planning`. */
export const PLANNING_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.entries(AGENT_TOOL_TIERS)
    .filter(([, tier]) => tier === 'planner')
    .map(([name]) => name),
);

/** Lista narzędzi PRZED przekazaniem: czytanie + `start_planning`. */
export const TRIAGE_TOOLS: readonly AgentToolDefinition[] = [
  ...AGENT_TOOLS.filter((tool) => !PLANNING_TOOL_NAMES.has(tool.name)),
  START_PLANNING_TOOL,
];

export const AGENT_TOOL_NAMES = [...AGENT_TOOLS, START_PLANNING_TOOL].map(
  (tool) => tool.name,
);
