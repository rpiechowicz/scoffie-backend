# Stan workstreamu

**Ostatnia aktualizacja:** 26.09.2026 (po Etapie 3)  
**Branch startowy:** `claude/admin-crm-planning-b0hmgo`

## Status

| Etap | Status | Raport |
|---|---|---|
| 0. Baseline | **DONE** — harness i lokalny baseline gotowe; płatny live benchmark świadomie odłożony na finał | `reports/00-baseline.md` |
| 1. Poprawność, stan, koszty | **DONE** — po review + addendum (klucz idempotencji księgi) | `reports/01-correctness-state-costs.md` |
| 2. Server-side planner | **DONE** — po poprawce semantyki celu kcal (raport 02, Addendum A1) | `reports/02-server-side-planner.md` |
| 2.2 Porcje per osoba | **DONE (backend)** — zaakceptowany. iOS compile verification: **DEFERRED / przed rolloutem** (gałąź `claude/per-user-portions` bez zmian i bez merge'a; nie blokuje kolejnych etapów) | `reports/02-2-per-user-portions.md` |
| 3. Odchudzenie agenta | **DONE** — `suggest_meals`, zdanie serwera na koniec tury, jedna karta na turę, pamięć tury, 3 narzędzia zdjęte ze schematu modelu; zachowanie modelu do potwierdzenia w końcowym live benchmarku | `reports/03-agent-thinning.md` |
| 4. Katalog / DB / API | **READY** (czeka na akceptację Rafała) | `reports/04-catalog-db-api-scale.md` |
| 5. Trwałe tury | WAITING | `reports/05-durable-turns.md` |
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
- Porcje per osoba (wariant C) — osobna decyzja architektoniczna po Etapie 2
  (kierunek: C). Dziś `plannedServings` dzieli się RÓWNO; para 1600/2600 przy
  wspólnych daniach ma ~23 % odchylenia dnia (granica modelu, raport 02 §9.1, A1).
- Dieta w walidatorze zapisu `applyWeekPlan` (planer ją egzekwuje, walidator nie).
- Tolerancje planera przyjęte roboczo: kcal ±10 % PEŁNEGO celu dnia (`FULL_DAY`) albo
  celu zakresu (`PARTIAL`), białko ±20 %, tłuszcz/węgle ±25 %, powtórki 0 poza
  wymuszonymi — do potwierdzenia po benchmarku.
- Kandydaci do benchmarku modeli w Etapie 6.

## Ostatni raport

`reports/03-agent-thinning.md` (26.09.2026) — Etap 3 **DONE**:
- nowa operacja `suggest_meals` (silnik `suggestForSlot`: filtry twarde planera, bilans dnia,
  zawężenie „szybko", różnorodność; ta sama karta OPTIONS co `offer_options`);
- karta kończy turę także bez tekstu modelu (`turnText` serwera); jedna karta na turę
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

**Etap 3 zakończony — czeka na review. Etap 4 READY (nie zaczynać bez akceptacji Rafała).**

### Warunek rolloutu porcji per osoba (Etap 2.2)

`AI_PLANNER_PER_USER_PORTIONS` **MUSI zostać `false`** na produkcji, dopóki osobno nie
zostaną zrobione: build Xcode gałęzi `claude/per-user-portions`, `sh
Scripts/plan-portions-check.sh`, TestFlight i weryfikacja kompatybilności klienta.
Weryfikacja iOS jest odłożona (DEFERRED) i nie blokuje Etapów 3+.
