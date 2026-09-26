# Stan workstreamu

**Ostatnia aktualizacja:** 26.09.2026 (po Etapie 1)  
**Branch startowy:** `claude/admin-crm-planning-b0hmgo`

## Status

| Etap | Status | Raport |
|---|---|---|
| 0. Baseline | **DONE** — harness i lokalny baseline gotowe; płatny live benchmark świadomie odłożony na finał | `reports/00-baseline.md` |
| 1. Poprawność, stan, koszty | **DONE** — po review + addendum (klucz idempotencji księgi) | `reports/01-correctness-state-costs.md` |
| 2. Server-side planner | **READY** | `reports/02-server-side-planner.md` |
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

- Rezydencja danych / docelowa ścieżka dostawcy dla danych wrażliwych — OSOBNY tor,
  nie część wyboru modelu (raport 01, §10).
- `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (domyślnie 0 = łagodne zamknięcie nie działa;
  propozycja 12) i smoke schematów narzędzi przed deployem (raport 01, §9).
- Backlog (świadomie odłożone): limit `/auth/refresh` per rodzina tokenów (dziś hasz
  tokenu + bezpiecznik IP); atomowy budżet instalacji przy wielu równoczesnych startach
  / wielu instancjach (dziś nieatomowy odczyt + sufit w trakcie tury, raport 01 A2).
- Ostateczne tolerancje planera (kcal, makro, różnorodność).
- Czy obecny model danych pozwala poprawnie modelować porcje dla różnych
  domowników — do audytu w Etapie 2A.
- Kandydaci do benchmarku modeli w Etapie 6.

## Ostatni raport

`reports/01-correctness-state-costs.md` (26.09.2026) — Etap 1 **DONE**:
- granica katalogu (`isCatalog: true`), księga `AiUsage` per wywołanie z idempotencją
  `(turnId, callIndex)`, zwrot wiadomości tylko za darmową turę na każdej ścieżce;
- znak życia tur (15 s / 60 s), sprzątanie osieroconych przy starcie i co minutę,
  łagodne zamknięcie (503 + `AI_SHUTDOWN_GRACE_MS`);
- sufity domu z rezerwacją za tury w biegu (atomowo w tx), instalacji — nieatomowo,
  `budget_ceiling` w trakcie tury;
- karty z poprzednich tur w historii modelu + `revise_proposal` (poprawka jednego slotu);
- `/auth/refresh` per sesja + bezpiecznik IP;
- migracje `20260926120000_ksiega_per_wywolanie` i (addendum)
  `20260926140000_ksiega_klucz_wywolania` — trwały `AiUsage.callKey` NOT NULL UNIQUE,
  idempotencja także po usunięciu tury; testy: unit 3309/3309, e2e 543/548 przed
  addendum (5 porażek środowiskowych, identycznych na `1c265a3`), po addendum
  e2e agent/accounting/księga 153/155 (2 z tych samych środowiskowych).

Poprzedni: `reports/00-baseline.md` — anchor do końcowego porównania: commit `22aa63c`.
Na finale uruchomić identyczny benchmark na tym commicie i na finalnym HEAD, tego samego
dnia i na tej samej konfiguracji modelu.

**Etap 1 zamknięty. Etap 2 READY — wykonawca czeka na polecenie startu.**
