# Raport etapu 03 — Odchudzenie agenta / mniej rund modelu

**Data:** 2026-09-26  
**Status:** DONE — wszystko sprawdzone bez modelu (unit, e2e na żywej bazie, harness na sucho,
metryki lokalne). Liczby o zachowaniu MODELU (rundy, tokeny, koszt) są policzone z kodu
(CALCULATED), nie zmierzone: płatny benchmark świadomie nie był uruchamiany (§12).  
**Branch:** `claude/admin-crm-planning-b0hmgo`  
**Zakres z TASKS.md:** Etap 3 — odchudzenie asystenta i liczby rund

Konfiguracja produkcji, od której liczę rundy: jedna faza na `AI_MODEL` (`AI_MODEL_TOOLS`
nieustawione — `docs/plans/scoffie-ai-agent/cennik-i-limity-2026-09.md`), `AI_CARDS_MODE=strict`
(tryb propozycji), `AI_CATALOG_MODE=search`. Tryb z przekazaniem (`start_planning`) opisuję osobno.
Model i effort — bez zmian (3.9).

## 1. Flow przed / po dla typowych intencji

„Runda" = jedno wywołanie API modelu. Przed = to, co kazały prompt i opisy narzędzi przed
Etapem 3 (zasada 2: „Zanim cokolwiek zaproponujesz, sprawdź gospodarstwo przez
get_household_context", „Najpierw sprawdzasz stan…", „jedno find_recipes, potem offer_options").
Wszystkie liczby rund — **CALCULATED** ze ścieżek w kodzie i promptu.

| Intencja | Przed: narzędzia (rundy) | Po: narzędzia (rundy) | Co zniknęło |
|---|---|---|---|
| 1. „Co zjeść dziś na kolację?" | `get_household_context` → `find_recipes` → `offer_options` (2–3; +1, gdy model nie napisał zdania przed kartą) | `suggest_meals` (**1**) | odczyt domowników (są w prompcie), wyszukiwanie sterowane przez model, runda na wybór 3 dań, runda „oto propozycje" |
| 2. „Daj mi 3 szybkie kolacje." | jw. z `find_recipes(tags:[quick], max_prep)` (2–3, +1) | `suggest_meals(prefer_tags:[quick], max_prep_minutes)` (**1**) | jw.; „szybkie" pilnuje serwer (zawężenie, §4) |
| 3. „Ułóż mi dzisiaj jedzenie." | (`get_household_context` →) `build_meal_plan` (1–2, +1 bez zdania) | `build_meal_plan` (**1**; bez zdania modelu przy statusie OK — zdanie serwera) | odczyt domowników; runda po karcie przy OK |
| 4. „Ułóż mi cały tydzień." | jw. (1–2, +1) | `build_meal_plan` z 7 dniami (**1**) | jw.; `propose_week_plan` (ręczne 21 pozycji) zdjęte z modelu |
| 5. „Zmień środową kolację na wegetariańską." | (`get_household_context` →) `replace_plan_item` (1–2, +1) | `replace_plan_item` (**1**) | jw. |
| 6. „Wybieram drugą." (po karcie OPTIONS) | `propose_swap` / `revise_proposal` z referencją z dopisku karty (1, +1 bez zdania) | bez zmian (**1**); dopisek karty `suggest_meals` = ten sam co `offer_options` (test 7) | runda po karcie (zdanie serwera) |
| 7. „Mam dużo kurczaka, wykorzystaj go." | `find_recipes(include_ingredients:[kurczak])` → `offer_options` (2, +1) | `suggest_meals(include_ingredients:[kurczak])` (**1**) | wyszukiwanie sterowane przez model |

Tryb z przekazaniem (`AI_MODEL_TOOLS`, nie na prod): `start_planning` → planista. Wynik
`start_planning` niósł kandydatów na każdą porę (**7 750 znaków; 30 zapytań DB** w sondzie Etapu 0, 26 w turze — MEASURED),
których planista po Etapie 2 nie potrzebuje (dania dobiera serwer). Po: **277 znaków, 0 zapytań**.
Kolejna runda planisty zostaje (to jest cena podziału modeli — decyzja Etapu 6).

## 2. Lista narzędzi przed / po

**Przed (26 narzędzi modelu + `start_planning` w trybie przekazania):** `get_household_context`,
`get_week_plan`, `get_week_balance`, `get_recipe_details`, `find_recipes`, `search_ingredients`,
`ask_clarifying_question`, `propose_day_plan`, `offer_options`, `propose_swap`,
`propose_remove_meal`, `propose_household_split`, `show_macro_gap`, `show_shopping_list`,
`mark_meal_eaten`, `check_shopping_items`, `check_plan_conflicts`, `propose_week_plan`,
`build_meal_plan`, `replace_plan_item`, `revise_proposal`, `apply_week_plan`, `create_recipe`,
`update_recipe`, `remember_note`, `delete_recipe`.

**Po (24):** jw. bez `get_household_context`, `propose_week_plan`, `delete_recipe`, z nowym
`suggest_meals`. Faza rozmowy (tryb przekazania): 14 → 14 (−`get_household_context`,
+`suggest_meals`).

Przegląd (3.5) — decyzja i uzasadnienie po przejrzeniu call-site'ów, testów i trybów:

| Narzędzie | Decyzja | Dlaczego |
|---|---|---|
| `get_household_context` | **REMOVE FROM MODEL** | te same dane (dieta, alergeny, wykluczenia, cele, filtr zgód) są w bloku gospodarstwa promptu (`<domownicy>`); prompt i tak kazał je pobrać drugi raz. Implementacja domenowa (`memberPreferences`, `membersForModel`) zostaje — używają jej prompt, planer, propozycje |
| `propose_week_plan` | **INTERNAL ONLY** | kazało modelowi ręcznie składać do 42 pozycji — tydzień układa `build_meal_plan`, pojedyncze zmiany `replace_plan_item`/`propose_swap`/`revise_proposal`/`propose_remove_meal`. Zostaje w executorze (`INTERNAL_AGENT_TOOLS`) dla stuba e2e (`[[propose:…]]`) i harnessu; `createWeekPlanProposal` używa dalej `build_meal_plan` |
| `delete_recipe` | **REMOVE FROM MODEL** | zapis nieodwracalny bez scenariusza w rozmowie (brak scenariusza w benchmarku); aplikacja ma edytor. `RecipesService.remove` (REST, panel) bez zmian |
| `propose_day_plan` | KEEP (zawężone) | jedyna droga, gdy użytkownik PODAJE konkretne dania na dzień; opis mówi wprost „przepisujesz, nie dobierasz" |
| `apply_week_plan` | KEEP / **DEPRECATE** | jedyny zapis w trybie bezpośrednim (`AI_CARDS_MODE=off/soft` bez `cards.v1`); w `strict` (prod) i tak odmawia. Lista narzędzi musi być identyczna w obu trybach (prefiks cache). Do usunięcia razem z trybem bezpośrednim |
| `find_recipes` | KEEP (lean, §6) | wyszukiwarka do PYTAŃ o dania; wybór i plan przejęły `suggest_meals` / `build_meal_plan` |
| `offer_options` | KEEP | kafelki z KONKRETNYCH dań, które model już ma (historia, wyszukiwanie, dania podane przez użytkownika) |
| `revise_proposal`, `replace_plan_item`, `build_meal_plan`, `propose_swap`, `propose_remove_meal`, `propose_household_split` | KEEP | wysokopoziomowe operacje serwera / karty |
| `create_recipe`, `update_recipe`, `search_ingredients` | KEEP (do weryfikacji live) | są scenariusze benchmarku (`g11-nowy-przepis`, `g11-zmiana-przepisu`) — to deklarowana funkcja; ciężkie w schemacie (listy obiektów) → kandydat na decyzję po live benchmarku |
| `get_week_plan`, `get_week_balance`, `get_recipe_details`, `show_*`, `mark_meal_eaten`, `check_*`, `remember_note`, `ask_clarifying_question` | KEEP | odczyty z jasnym zastosowaniem / karty / zapisy jednego checkboxa |
| `start_planning` | KEEP (lean) | tylko tryb przekazania; bez kandydatów |

## 3. Narzędzia usunięte WYŁĄCZNIE ze schematu modelu

`RETIRED_MODEL_TOOLS` w `src/agent/tools/agent-tools.ts`: `get_household_context`,
`propose_week_plan` (wewnętrzne), `delete_recipe`. Żadne API, serwis ani migracja nie zostały
usunięte. Call-site'y sprawdzone: stub e2e (`[[tool]]` → teraz `get_week_plan`; `[[propose]]` →
wewnętrzny `propose_week_plan`), harness scenariuszy (`has('get_household_context')` — opcjonalne),
etykiety postępu (zostają — stare tury w bazie niosą te nazwy), spec-i i e2e (zaktualizowane).
Nowa bramka: **dostawca wykonuje wyłącznie narzędzia z listy wysłanej modelowi w tej fazie** —
zmyślona albo wycofana nazwa wraca jako błąd narzędzia i nie dociera do executora (dotąd executor
wykonywał każdą znaną nazwę, także narzędzie planisty w fazie rozmowy).

## 4. Nowe operacje wysokiego poziomu

**`suggest_meals`** (warstwa `chat`, kończy turę, wyłącznie pola wymagane) — „co na kolację?",
„3 szybkie obiady", „mam dużo kurczaka". Wejście: tydzień, dzień, pora, `count` (2–4),
`include_ingredients`, `for_user_ids` i te same życzenia co planer (`diet`, `must_have_tags`,
`prefer_tags`, `avoid_ingredients`, `max_prep_minutes`). Serwer:
- `AgentMealPlannerService.suggest` → czysty `suggestForSlot` w `src/meal-planner/meal-plan-engine.ts`:
  te same filtry twarde co planer (alergeny, wykluczenia, dieta KAŻDEGO jedzącego, pora,
  aktywność, życzenia twarde) i ta sama funkcja kosztu dnia (bilans osoby przy reszcie dnia
  z planu, powtórki w tygodniu, preferencje);
- życzenie miękkie („szybko", `prefer_tags`) ZAWĘŻA pulę, gdy zostaje ≥ `count` dań; inaczej
  łagodnieje jawnie (`relaxed`);
- różnorodność: wybór zachłanny z karą za tagi wspólne z już wybranymi (inne białko, inny rodzaj
  dania) — tagi, o które proszono, nie są karane;
- obecne danie slotu wypada z propozycji; składnik z prośby dopasowany tą samą funkcją co
  `find_recipes` (`ingredientMatches`);
- karta OPTIONS z danymi Z BAZY (`recipeSide`), wyróżniki kafelków z danych („Najlepiej pasuje",
  „Najszybsze", „Najwięcej białka"), eyebrow „Kolacja · środa" — **ta sama karta co
  `offer_options`**, więc „wybieram drugą" i przycisk „Wstaw na…" działają bez zmian w iOS.

Wynik dla modelu (gdy tura trwa dalej): `offered`, `status`, `eligible`, `remainingKcalForMeal`
(ile kcal zostaje pytającemu na ten posiłek — z PLANU, nie z odhaczeń), `relaxed`, lista
`{recipe, title, kcal, prepMinutes}` — 359 znaków (MEASURED).

**Zdanie serwera na koniec tury** (`AgentToolResult.turnText`, `turnTextFor`): karta, po której
model nic nie napisał, kończy turę zdaniem serwera („Trzy propozycje na kolację w środę — wybierz
jedną.", „Plan na sobotę gotowy — zatwierdzisz go jednym kliknięciem."). `null` = model ma coś do
wyjaśnienia (plan PARTIAL, zamiennik nie-OK) i dostaje rundę jak dotąd. Tekst modelu ma pierwszeństwo.

**Jedna karta na turę** (`TurnMemo.claimCard`): druga karta w tej samej turze — także równolegle
w jednej rundzie — dostaje `AI_ONE_CARD_PER_TURN`; odmowa narzędzia zwalnia kartę. Dotąd druga
propozycja osierocała pierwszą (wiadomość niesie jedną kartę), a dwie karty bez skutków: wygrywała
ostatnia.

## 5. Rundy, które udało się usunąć (CALCULATED)

- „co na kolację" / „3 szybkie" / „mam kurczaka": **2–3 (+1) → 1** — `find_recipes` + wybór
  modelem + `offer_options` zastąpione jedną operacją; odczyt domowników zniknął z promptu.
- plan dnia/tygodnia, podmiana jednego dania: **1–2 (+1) → 1** — koniec z „najpierw sprawdź stan
  przez get_household_context".
- każda karta bez zdania modelu: **+1 → 0** (zdanie serwera), poza świadomymi wyjątkami (PARTIAL).
- tryb przekazania: runda planisty zostaje, ale bez ~7,7 tys. znaków kandydatów w historii
  każdej kolejnej rundy.

## 6. Zmiany promptu (3.8)

Instrukcje **10 052 → 9 137 znaków (−9 %)**, blok trybu propozycji **2 146 → 1 984** (MEASURED).
- Nowy akapit PODZIAŁ PRACY: model rozumie prośbę, wybiera JEDNĄ operację serwera, przekazuje
  życzenia, mówi jednym zdaniem, co wyszło; serwer szuka, pilnuje alergenów i diet, planuje,
  dobiera porcje, liczy, buduje karty.
- Usunięte: „Zanim cokolwiek zaproponujesz, sprawdź gospodarstwo przez get_household_context",
  „Najpierw sprawdzasz stan (kontekst gospodarstwa, plan, bilans)", „jedno find_recipes, potem
  offer_options", „widzisz pięć najcięższych składników", zasada „tydzień jako stan docelowy"
  (przeniesiona do trybu bezpośredniego, jedynego, w którym dotyczy), zasada o
  `excludedIngredients` (nakłada serwer), wszystkie odesłania do `propose_week_plan`.
- Zasada 4: „Nie liczysz kalorii, makr ani porcji i nie zgadujesz wyników planera" (+ planned
  osobno od eaten przez `get_week_balance`).
- JAK PRACUJESZ = mapa intencja → operacja: `suggest_meals`, `build_meal_plan`,
  `replace_plan_item`/`propose_swap`/`revise_proposal`, `find_recipes` tylko do pytań;
  „jedna wiadomość = jedna karta".
- Opisy narzędzi: odesłania do `get_household_context` → „blok DOMOWNICY"; `find_recipes` i
  `offer_options` z jasnym „nie do wyboru na posiłek — od tego suggest_meals".

## 7. Rozmiar payloadów i kontekstu (MEASURED, `scripts/agent-thinning-metrics.ts`, katalog dev ≈500)

| Metryka | Przed | Po | Zmiana |
|---|---:|---:|---:|
| narzędzia widoczne dla modelu | 26 | 24 | −2 |
| schemat narzędzi (znaki JSON) | 35 170 | 34 718 | −1,3 % (`suggest_meals` dokłada ~2,3 tys.) |
| pola nieobowiązkowe (limit API 24) | 24 | 20 | zapas 4 |
| instrukcje (znaki) | 10 052 | 9 137 | −9 % |
| `find_recipes`, 8 trafień „szybka kolacja" (znaki wyniku) | 3 460 | 1 692 | **−51 %** |
| wybór 3 kolacji — wyniki narzędzi w turze (znaki) | 4 087 (`get_household_context` 614 + `find_recipes` 3 460 + `offer_options` 13) | 359 (`suggest_meals`) | **−91 %** |
| `start_planning` (znaki / zapytania DB) | 7 750 / 30 | 277 / 0 | −96 % / −30 |
| `build_meal_plan` (znaki wyniku) | 726 | 726 | 0 |

Pliki: `benchmark/agent-thinning-before.json`, `benchmark/agent-thinning-after.json`.

## 8. Baza: zapytania i ponowne użycie kontekstu tury (3.7)

`TurnMemo` (`src/agent/turn-memo.ts`, klucze `TURN_KEYS`) — tylko proces i tylko tura, bez Redisa.
Pamięta domowników z celami (`memberPreferences`), filtr zgód (`membersForModel`) i wiersz domu
(`name`, `enabledMealTypes`); planu tygodnia NIE (zapis w trybie bezpośrednim zmienia go w turze).
Używają jej prompt, executor (wszystkie odczyty domowników), adapter planera (`build`, `replace`,
`suggest`) i serwis propozycji (cel pytającego, imiona, pory). Zapisy dalej sprawdzają członkostwo
we własnej transakcji. Błąd ładowania nie zostaje w pamięci.

| Przepływ w jednej turze (prompt + narzędzia) | Przed: zapytania / odczyty domowników | Po |
|---|---:|---:|
| wybór 3 kolacji (przed: household + find + offer; po: suggest), zimny katalog | 46 / 2 | 36 / **1** |
| plan dnia: household + `build_meal_plan` → po: `build_meal_plan` | 45 / 4 (41 / 3 bez household) | 31 / **1** |
| `find_recipes` w turze (bez promptu) | — | 8 (poza turą 11 — jak w baseline) |
| `start_planning` (bez promptu) | 26 | 0 |

(MEASURED lokalnie; `prompt.build` = 16 zapytań w sondzie `agent-db-probe` wobec 15 w baseline
Etapu 0 — +1 to relacja `PlanItemPortion` z Etapu 2.2 w odczycie planu.) Test 10 (e2e) przypina:
tura „co na kolację" czyta domowników **raz**.

## 9. Testy

| Test / komenda | Wynik |
|---|---|
| `pnpm test` | **188/188 suit, 3401/3401** (przed Etapem 3: 186/3377; −3 przypadki `it.each` po krótszej liście narzędzi, +27 nowych) |
| — `src/meal-planner/suggest-for-slot.spec.ts` (nowy) | 8: 3 różne dania (1), alergia+dieta (2), „szybkie" + jawne łagodzenie (3), różnorodność białka, pula składnika, dopasowanie do dnia (ciężki obiad → lżejsza kolacja), UNSAT, determinizm |
| — `src/agent/agent-thinning.spec.ts` (nowy) | 13: `TurnMemo` (raz na klucz, także równolegle; błąd nie zostaje; jedna karta — 10, 12), `turnTextFor`, `suggest_meals` w warstwie chat/kończy turę/same pola wymagane, wycofane narzędzia poza listami i poza runnerem/trasą/dostawcami (11), prompt bez wycofanych nazw i bez „liczenia" |
| — `anthropic-agent.provider.spec.ts` (+6) | karta ze zdaniem serwera = 1 wywołanie (4), tekst modelu ma pierwszeństwo, karta bez zdania → model dostaje głos, dwie karty z odmową drugiej → tura nie kończy się przed przetworzeniem (12), dwie udane karty → oba zdania, narzędzie spoza listy fazy nie trafia do executora |
| `e2e.sh test/agent-thinning` (nowy, żywa baza) | **7/7**: „co na kolację" = tylko `suggest_meals`, karta OPTIONS z 3 różnymi daniami na kolację, domownicy czytani RAZ (1, 10); alergia+dieta z profilu (2); „szybkie" ≤ 25 min (3); `build_meal_plan` sam, bez `propose_week_plan`/`find_recipes` (5); „wybieram drugą" — model widzi opcje karty `suggest_meals` w kolejności kafelków (7); chudy `find_recipes` (9); dwie karty w jednej turze równolegle → jedna odmówiona, odmowa zwalnia kartę, zdanie serwera (12) |
| e2e regresja: `agent*` (agent, accounting, card-state, catalog-boundary, tools, thinning), `meal-planner`, `per-user-portions`, `apply-week-plan`, `authz-audit`, `data-export`, `account-deletion` | **12/12 suit, 188/188** — w tym Etap 1 (księga, stan kart, propozycje: 8) i `replace_plan_item` zmienia wyłącznie wskazany slot (`meal-planner.e2e` „8.–9.", 6) |
| `admin-assistant.e2e` | 13/15 — 2 błędy ŚRODOWISKOWE: kurs USD/PLN z lokalnej tabeli `FxRate` (3,8404) zamiast stałej referencyjnej (3,7224), niezwiązane z Etapem 3 |
| `pnpm agent:scenarios --dry` | **40/40** scenariuszy ma sprawny harness (listy `expectedTools` uzupełnione o `suggest_meals`/`build_meal_plan`/`replace_plan_item`, `WRITING_TOOLS` o narzędzia propozycji, pamięć tury jak w runnerze) |
| `pnpm typecheck`, `pnpm lint:check`, `pnpm build`, `pnpm openapi:check` | 0 błędów; lint: 42 ostrzeżenia sprzed etapu, żadne w zmienionych plikach; OpenAPI aktualne (osobny commit `fc9c06b` naprawia MOJE przeoczenie z Etapu 2.2 — eksport porcji bez regeneracji dokumentu) |

## 10. Ryzyka

- **Zachowanie modelu niezmierzone.** Rundy są policzone z kodu i promptu; czy model faktycznie
  sięga po `suggest_meals` zamiast `find_recipes` + `offer_options` — pokaże live benchmark (§12).
- Model pisze zdanie PRZED wynikiem `suggest_meals`/`build_meal_plan` — nie wie, czy wyszło
  PARTIAL (to było już po Etapie 2). Przy PARTIAL bez tekstu modelu tura i tak trwa dalej.
- Zawężenie „szybko" może ukryć danie lepsze kalorycznie — świadomie: użytkownik prosił o szybkie.
- `AI_ONE_CARD_PER_TURN` zmienia zachowanie prośby „ułóż środę i pokaż 3 kolacje na czwartek" —
  druga karta idzie do następnej wiadomości (dotąd jedna z nich i tak ginęła).
- Stare tury w bazie mają w `progress` nazwy wycofanych narzędzi — etykiety zostały, iOS je rysuje.
- `TurnMemo` trzyma migawkę domowników na czas tury: zmiana profilu w trakcie tury (sekundy)
  wejdzie od następnej — tak samo jak blok gospodarstwa w prompcie.

## 11. Świadomie pozostawione

- `apply_week_plan` i cały tryb bezpośredni (DEPRECATE — razem z `AI_CARDS_MODE=off/soft`).
- `create_recipe`/`update_recipe`/`search_ingredients` w schemacie (scenariusze benchmarku) —
  decyzja po live benchmarku.
- Warstwy modeli (`build_meal_plan`/`replace_plan_item` u planisty w trybie przekazania) — to
  routing modeli, Etap 6.
- `find_recipes` bez własnego „lookup szczegółów" — jest `get_recipe_details`.
- `recipeSide` = jedno `findById` na kafelek (3 zapytania na kartę); do zbiorczego odczytu w Etapie 4.
- `AgentCatalogService.snapshot` sprawdza odcisk katalogu (2 agregaty) w każdym wywołaniu
  wyszukiwania/planera — kandydat do pamięci tury w Etapie 4.
- Effort i model bez zmian (3.9).

## 12. Do sprawdzenia w końcowym live benchmarku

1. Odsetek tur „co na kolację"/„3 szybkie"/„mam kurczaka" kończących się **jednym** wywołaniem
   i jedynym narzędziem `suggest_meals` (`g2-*`); czy model nie wraca do `find_recipes` + `offer_options`.
2. `stopReason = tool_ended_turn` z tekstem serwera vs modelu — jak często model milczy przed kartą.
3. Czy model nie woła już `get_week_plan`/odczytów „na zapas" przed `build_meal_plan` (rundy ≤ 1).
4. Wejścia `suggest_meals` (czy `prefer_tags`/`max_prep_minutes` trafnie z „szybko", `include_ingredients`
   z „mam kurczaka") i jakość wyboru z karty.
5. `AI_ONE_CARD_PER_TURN` w praktyce (ile razy, czy model dobrze tłumaczy).
6. Tokeny wejścia: schemat −452 znaki, instrukcje −915 znaków, wyniki narzędzi −51…−96 %.
7. Scenariusze przepisów (`g11-*`) — czy `create_recipe`/`update_recipe` zostają w schemacie.
8. Tryb przekazania (jeśli zostanie włączony): koszt rundy planisty bez kandydatów.
