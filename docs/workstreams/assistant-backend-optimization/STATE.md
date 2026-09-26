# Stan workstreamu

**Ostatnia aktualizacja:** 26.09.2026 (po Etapie 2)  
**Branch startowy:** `claude/admin-crm-planning-b0hmgo`

## Status

| Etap | Status | Raport |
|---|---|---|
| 0. Baseline | **DONE** — harness i lokalny baseline gotowe; płatny live benchmark świadomie odłożony na finał | `reports/00-baseline.md` |
| 1. Poprawność, stan, koszty | **DONE** — po review + addendum (klucz idempotencji księgi) | `reports/01-correctness-state-costs.md` |
| 2. Server-side planner | **DONE** — czeka na review; decyzja o porcjach per osoba (raport 02, §9) | `reports/02-server-side-planner.md` |
| 3. Odchudzenie agenta | **READY** (start dopiero po akceptacji Etapu 2) | `reports/03-agent-thinning.md` |
| 4. Katalog / DB / API | WAITING | `reports/04-catalog-db-api-scale.md` |
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
- Porcje dla domowników o różnych celach (audyt 2A: model danych zna tylko RÓWNY
  udział — para 1600/2600 przy wspólnych daniach ma ~23 % odchylenia): A zostaje /
  B osobne dania przy rozbieżności / C porcje per osoba (migracja cross-repo).
  Raport 02, §9.1.
- Dieta w walidatorze zapisu `applyWeekPlan` (planer ją egzekwuje, walidator nie).
- Tolerancje planera przyjęte roboczo: kcal ±10 %, białko ±20 %, tłuszcz/węgle ±25 %,
  powtórki 0 poza wymuszonymi — do potwierdzenia po benchmarku.
- Kandydaci do benchmarku modeli w Etapie 6.

## Ostatni raport

`reports/02-server-side-planner.md` (26.09.2026) — Etap 2 **DONE**:
- audyt 2A (testy charakteryzujące): `plannedServings` = porcje ŁĄCZNE, równy udział
  na osobę; model danych wystarcza do poprawnego planera, nie wyraża nierównych porcji
  tego samego dania (decyzja, bez migracji);
- czysty silnik `src/meal-planner/` (dzień, tydzień, slot; filtry twarde przed
  scoringiem; kandydaci → zachłannie → lokalna poprawa; UNSAT/PARTIAL z powodami;
  `evaluatePlan` — metryki dla dowolnego planu, także modelu, pod Etap 6);
- narzędzia `build_meal_plan` i `replace_plan_item` przez istniejące propozycje;
- testy: unit 3345/3345, e2e planera 7/7, regresja 173/173; `pnpm planner:eval`:
  solo 1,6 % odchylenia kcal, 0 złamań, 12 zapytań DB na plan, 5100 przepisów w 358 ms.

Poprzednie: `reports/01-correctness-state-costs.md`, `reports/00-baseline.md` — anchor
do końcowego porównania: commit `22aa63c` (ten sam benchmark na anchorze i finalnym HEAD,
tego samego dnia, na tej samej konfiguracji modelu).

**Etap 2 zakończony. Wykonawca czeka na review — Etapu 3 nie rozpoczynać.**
