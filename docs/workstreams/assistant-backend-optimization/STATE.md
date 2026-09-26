# Stan workstreamu

**Ostatnia aktualizacja:** 26.09.2026 (po Etapie 4)  
**Branch startowy:** `claude/admin-crm-planning-b0hmgo`

## Status

| Etap | Status | Raport |
|---|---|---|
| 0. Baseline | **DONE** — harness i lokalny baseline gotowe; płatny live benchmark świadomie odłożony na finał | `reports/00-baseline.md` |
| 1. Poprawność, stan, koszty | **DONE** — po review + addendum (klucz idempotencji księgi) | `reports/01-correctness-state-costs.md` |
| 2. Server-side planner | **DONE** — po poprawce semantyki celu kcal (raport 02, Addendum A1) | `reports/02-server-side-planner.md` |
| 2.2 Porcje per osoba | **DONE (backend)** — zaakceptowany. iOS compile verification: **DEFERRED / przed rolloutem** (gałąź `claude/per-user-portions` bez zmian i bez merge'a; nie blokuje kolejnych etapów) | `reports/02-2-per-user-portions.md` |
| 3. Odchudzenie agenta | **DONE** — po review (Addendum A1: autorytatywne zdanie serwera, porcje per osoba przez wybór z karty); `suggest_meals`, jedna karta na turę, pamięć tury, 3 narzędzia zdjęte ze schematu modelu; zachowanie modelu do potwierdzenia w końcowym live benchmarku | `reports/03-agent-thinning.md` |
| 4. Katalog / DB / API | **DONE (backend)** — log zmian katalogu z triggerów, snapshot + delta z tombstone'ami, granice cache'u, single-flight (popularność, zakupy), szkic 1 s, `getTurn` 1 zapytanie, indeks `AgentMessage(turnId)`. iOS (`claude/catalog-sync`, bez merge'a): kompilacja Xcode i `catalog-sync-check.sh` **DEFERRED / przed rolloutem** | `reports/04-catalog-db-api-scale.md` |
| 5. Trwałe tury | **READY** (czeka na akceptację Rafała) | `reports/05-durable-turns.md` |
| 6. Modele / routing | WAITING | `reports/06-model-evaluation.md` |

## Aktualne polecenie dla wykonawcy

Nie rozpoczynaj żadnego etapu automatycznie tylko dlatego, że pliki pojawiły się
w repo. Gdy Rafał poleci rozpoczęcie prac, zacznij od pierwszego zatwierdzonego
etapu w tej tabeli.

Przed startem etapu:
1. przeczytaj `README.md`,
2. przeczytaj odpowiednią sekcję `TASKS.md`,
3. sprawdź aktualny kod — plan jest hipotezą, kod jest źródłem prawdy,
4. wypisz w raporcie każdą świadomą zmianę zakresu.

Po zakończeniu:
1. uruchom adekwatne testy,
2. zapisz raport wg `REPORT_TEMPLATE.md`,
3. zmień status etapu na DONE / PARTIAL / BLOCKED,
4. oznacz kolejny jako READY tylko jeśli logicznie może się rozpocząć,
5. zatrzymaj się i poczekaj na review.

## Decyzje już przyjęte

- Architektura **server-first**.
- LLM nie ma być kalkulatorem kalorii ani planerem struktury tygodnia.
- Human-in-the-loop dla zapisu propozycji pozostaje.
- Najpierw poprawność i pomiar, potem optymalizacja.
- Nie dokładamy ciężkiej infrastruktury bez potrzeby potwierdzonej pomiarem.
- Dobór modelu następuje po przeniesieniu logiki domenowej na backend.

## Decyzje otwarte

- Rezydencja danych / docelowa ścieżka dostawcy dla danych wrażliwych — OSOBNY tor,
  nie część wyboru modelu (raport 01, §10).
- `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (domyślnie 0 = łagodne zamknięcie nie działa;
  propozycja 12) i smoke schematów narzędzi przed deployem (raport 01, §9).
- Backlog (świadomie odłożone): limit `/auth/refresh` per rodzina tokenów (dziś hasz
  tokenu + bezpiecznik IP); atomowy budżet instalacji przy wielu równoczesnych startach
  / wielu instancjach (dziś nieatomowy odczyt + sufit w trakcie tury, raport 01 A2).
- Dieta w walidatorze zapisu `applyWeekPlan` (planer ją egzekwuje, walidator nie).
- Tolerancje planera przyjęte roboczo: kcal ±10 % PEŁNEGO celu dnia (`FULL_DAY`) albo
  celu zakresu (`PARTIAL`), białko ±20 %, tłuszcz/węgle ±25 %, powtórki 0 poza
  wymuszonymi — do potwierdzenia po benchmarku.
- Kandydaci do benchmarku modeli w Etapie 6.
- `connection_limit` w `DATABASE_URL` prod — po deployu odczyt linii `pula Prisma:` z logu
  i `SHOW max_connections`, wartość po odjęciu innych usług (raport 04, §9). Limitu nie zgadujemy.
- Kompresja WS (`perMessageDeflate` z progiem) i `statement_timeout` — po pomiarze (raport 04, §8).

## Ostatni raport

`reports/04-catalog-db-api-scale.md` (26.09.2026) — Etap 4 **DONE (backend)**:
- katalog na telefon: trwały log `CatalogChange` (triggery na `Recipe`/`RecipeIngredient`,
  bez przepisów domów i ulubionych), `catalog:snapshot` + `catalog:changes` (upserty,
  tombstone'y, `RESET_REQUIRED`), `recipes:householdState`; stary `recipes:findAll` bez zmian;
- 10k (MEASURED): pełne pobranie 605 → 60 zapytań, 2,8 → 1,0 s, 4 000 → 10 000 widocznych;
  reconnect 17,7 MB → 179 B; zmiana jednego przepisu = 1,9 kB;
- hot paths (10k): `offer_options` 15 → 3, `suggest_meals` 21 → 11, `find_recipes` 9 → 7,
  popularność ×10 → 1, lista zakupów 20 nieświeżych odczytów 20 → 1 przebudowa (447 → 110
  zapytań), `getTurn` RUNNING 3 → 1; szkic ~23 → ~9 zapisów/8 s (CALCULATED);
- indeks `AgentMessage(turnId)` (seq scan 11,5 ms → 0,14 ms); `Invitation.householdId`
  i `Recipe.authorId` świadomie bez indeksu; pula logowana przy starcie, bez zmiany wartości;
- testy: unit 3450/3450, e2e nowe + regresja 68/68, typecheck/lint/openapi OK; iOS: składnia
  OK, kompilacja DEFERRED.

`reports/03-agent-thinning.md` (26.09.2026) — Etap 3 **DONE**:
- nowa operacja `suggest_meals` (silnik `suggestForSlot`: filtry twarde planera, bilans dnia,
  zawężenie „szybko", różnorodność; ta sama karta OPTIONS co `offer_options`);
- karta kończy turę WYŁĄCZNIE autorytatywnym zdaniem serwera (`turnText`); karta bez niego
  (plan PARTIAL) oddaje wynik modelowi — tekst modelu sprzed wywołania nie wygrywa (Addendum A1);
- porcje per osoba przez suggest → wybór → propozycja → zapis liczy serwer (Addendum A1);
  jedna karta na turę
  (`AI_ONE_CARD_PER_TURN`); dostawca wykonuje tylko narzędzia z listy fazy;
- `TurnMemo`: domownicy, zgody i pory raz na turę (prompt, narzędzia, planer, propozycje);
- ze schematu modelu zdjęte `get_household_context`, `propose_week_plan` (wewnętrzne dla stuba),
  `delete_recipe`; `find_recipes` −51 % znaków, `start_planning` bez kandydatów (7 750 → 277);
- rundy (CALCULATED): „co na kolację"/„3 szybkie"/„mam kurczaka" 2–3 → 1, plan/podmiana
  1–2 → 1, runda „po karcie" +1 → 0; prompt −9 %; narzędzia 26 → 24; pola nieobowiązkowe 24 → 20;
- testy: unit 3401/3401, e2e 7 nowych + regresja 188/188, harness na sucho 40/40.

`reports/02-2-per-user-portions.md` (26.09.2026) — Etap 2.2 **DONE**:
- `PlanItemPortion` (osoba → jednostki 0,05 porcji), migracja addytywna, bez backfillu:
  pozycja bez alokacji liczy się jak dotąd; z alokacją — bilans z porcji osoby, lista
  zakupów z Σ (ułamkowo), `plannedServings` = pochodna `ceil(Σ)` dla starych klientów;
- planer `per_user` (to samo danie, porcja 0,5–1,5 co 0,05) za `AI_PLANNER_PER_USER_PORTIONS`
  (domyślnie `false` do wydania iOS);
- `planner:eval`, odchylenie kcal dnia średnio/max: para 23,0/27,2 → 0,6/2,7 %, rodzina
  13,7/27,7 → 0,3/0,7 %, wege 11,2/19,0 → 0,2/0,5 %, solo 1,6/3,1 → 0,2/0,6 %; 0 złamań,
  12 zapytań; PARTIAL zostaje tylko przez białko (katalog);
- testy: unit 3377/3377, e2e 12 nowych + regresja 242/242; iOS: składnia OK, kompilacja
  i `Scripts/plan-portions-check.sh` czekają na Maca.

`reports/02-server-side-planner.md` (26.09.2026) — Etap 2 **DONE**:
- audyt 2A (testy charakteryzujące): `plannedServings` = porcje ŁĄCZNE, równy udział
  na osobę; model danych wystarcza do poprawnego planera, nie wyraża nierównych porcji
  tego samego dania (decyzja, bez migracji);
- czysty silnik `src/meal-planner/` (dzień, tydzień, slot; filtry twarde przed
  scoringiem; kandydaci → zachłannie → lokalna poprawa; UNSAT/PARTIAL z powodami;
  `evaluatePlan` — metryki dla dowolnego planu, także modelu, pod Etap 6);
- narzędzia `build_meal_plan` i `replace_plan_item` przez istniejące propozycje;
- poprawka po review (Addendum A1): zakres `FULL_DAY` (pory domu = 100 % celu, wagi
  normalizowane) / `PARTIAL` (cel osoby minus to, co ONA je poza planowanymi porami);
  pozycje innych domowników nie zmieniają celu osoby;
- testy: unit 3353/3353, e2e planera i regresja zielone; `pnpm planner:eval` (względem
  PEŁNEGO celu): solo 1,6 %, para 23 % i rodzina 13,7 % (granica równego udziału),
  0 złamań, 12 zapytań DB na plan, 5100 przepisów w 358 ms.

Poprzednie: `reports/01-correctness-state-costs.md`, `reports/00-baseline.md` — anchor
do końcowego porównania: commit `22aa63c` (ten sam benchmark na anchorze i finalnym HEAD,
tego samego dnia, na tej samej konfiguracji modelu).

**Etap 4 zakończony (backend) — czeka na review. Etap 5 READY (nie zaczynać bez akceptacji Rafała).**

### Warunek rolloutu synchronizacji katalogu (Etap 4)

Backend (migracja addytywna) może iść pierwszy — stare buildy dalej używają
`recipes:findAll`. Build iOS z gałęzi `claude/catalog-sync` dopiero po: build Xcode,
`sh Scripts/catalog-sync-check.sh`, próba na urządzeniu (snapshot, reconnect = delta),
TestFlight. Starego `recipes:findAll` nie usuwać w tym samym deployu.

### Warunek rolloutu porcji per osoba (Etap 2.2)

`AI_PLANNER_PER_USER_PORTIONS` **MUSI zostać `false`** na produkcji, dopóki osobno nie
zostaną zrobione: build Xcode gałęzi `claude/per-user-portions`, `sh
Scripts/plan-portions-check.sh`, TestFlight i weryfikacja kompatybilności klienta.
Weryfikacja iOS jest odłożona (DEFERRED) i nie blokuje Etapów 3+.
