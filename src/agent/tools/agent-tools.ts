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
    'Indeks przepisu z katalogu (np. R07) albo identyfikator przepisu gospodarstwa zwrócony przez create_recipe.',
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
      'czegoś, co już tam jest, i żeby wiedzieć, co zniknie po zastosowaniu nowego tygodnia.',
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
          description: 'Czego dotyczy wybór, np. „Kolacja · wtorek".',
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
          description: 'Kroki po kolei; najwyżej 40.',
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
          description: 'Pełna lista, nie różnica; najwyżej 60 pozycji.',
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
          description: 'Kroki po kolei; najwyżej 40.',
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
    input_schema: object({ text: { type: 'string' } }, ['text']),
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

export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.name);
