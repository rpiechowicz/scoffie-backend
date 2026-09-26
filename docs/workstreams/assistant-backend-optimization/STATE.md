# Stan workstreamu

**Ostatnia aktualizacja:** 26.09.2026 (po Etapie 0)  
**Branch startowy:** `claude/admin-crm-planning-b0hmgo`

## Status

| Etap | Status | Raport |
|---|---|---|
| 0. Baseline | **DONE** — harness i lokalny baseline gotowe; płatny live benchmark świadomie odłożony na finał | `reports/00-baseline.md` |
| 1. Poprawność, stan, koszty | **READY** | `reports/01-correctness-state-costs.md` |
| 2. Server-side planner | WAITING | `reports/02-server-side-planner.md` |
| 3. Odchudzenie agenta | WAITING | `reports/03-agent-thinning.md` |
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

- Rezydencja danych / docelowa ścieżka dostawcy dla danych wrażliwych.
- Ostateczne tolerancje planera (kcal, makro, różnorodność).
- Czy obecny model danych pozwala poprawnie modelować porcje dla różnych
  domowników — do audytu w Etapie 2A.
- Kandydaci do benchmarku modeli w Etapie 6.

## Ostatni raport

`reports/00-baseline.md` (26.09.2026) — Etap 0 **DONE**:
- harness scenariuszy wyrównany z produkcją (`8c61a00`), 40/40 scenariuszy
  przechodzi na sucho ($0) w trybie `search` / `strict`;
- lokalna sonda zapytań DB (`scripts/agent-db-probe.ts`, `22aa63c`);
- stare wyniki opisane jako tryb digest (`benchmark/README.md`);
- **płatny przebieg świadomie odłożony** decyzją Rafała do końca workstreamu.

Anchor do końcowego porównania: commit `22aa63c`. Na finale uruchomić identyczny
benchmark na tym commicie i na finalnym HEAD, tego samego dnia i na tej samej
konfiguracji modelu, aby ograniczyć wpływ driftu dostawcy. Etap 1 jest READY.
