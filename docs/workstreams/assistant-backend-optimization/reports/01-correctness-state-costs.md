# Raport etapu 01 — Poprawność stanu, kosztów i granic danych

**Data:** 2026-09-26  
**Status:** DONE (zakres z TASKS.md); dwie rzeczy czekają na decyzję poza kodem — §9  
**Branch:** `claude/admin-crm-planning-b0hmgo` (HEAD kodu: `e3c30fc`, raport w commicie po nim)  
**Zakres z TASKS.md:** Etap 1 — poprawność stanu, kosztów i granic danych. Bez płatnych
benchmarków i bez scenariuszy na żywym modelu; bez serwerowego planera (Etap 2).

## 1. Co zostało zrobione

Fakty (każdy punkt ma test; komendy w §4):

1. **Granica katalogu** (`dbf0100` test → `8ce83dd` fix): indeks, digest i odcisk
   katalogu asystenta biorą wyłącznie `isCatalog: true`. Prywatny przepis konta
   katalogowego idzie ścieżką przepisów gospodarstwa (własny id zamiast `R…`).
2. **Księga kosztu per wywołanie** (`40e6b2c`): wiersz `AiUsage` na KAŻDE wywołanie
   dostawcy, zapisany zaraz po nim (`onUsage` → `AgentUsageLedger.record`), klucz
   idempotencji `(turnId, callIndex)`. Jedna transakcja: wiersz, przyrost tokenów
   i kosztu tury (bez względu na status), liczniki sufitów domu i instalacji,
   a gdy koszt dojedzie do tury już zwróconej — cofnięcie zwrotu (+1 wiadomość).
   Błąd zapisu = ponowienie przy domknięciu. `finishDone`/`finishFailed` nie piszą
   już kosztu. Dostawca bez `onUsage` → jeden zbiorczy wiersz zastępczy.
3. **Zwrot tylko za darmową turę na każdej ścieżce** (runner, leniwy timeout,
   „Stop" spoza procesu, lease przy nowej wiadomości, sprzątanie): wspólne
   `refundIfFree` z warunkiem `quotaRefunded: false, costMicroUsd: 0` w samym
   `updateMany`, w transakcji z licznikiem.
4. **Znak życia i recovery**: runner odświeża `updatedAt` co 15 s; RUNNING bez znaku
   życia od 60 s = osierocona (`AI_PROVIDER_ERROR`), po czasie tury + margines =
   `AI_TIMEOUT`. Jedna definicja (`agent-turn-liveness.ts`) dla lease, semafora,
   leniwego timeoutu i nowego `AgentTurnSweeper` (przy starcie procesu + co minutę).
   Runner przerywa turę, którą domknął ktoś inny (przestaje wydawać pieniądze).
5. **Łagodne zamknięcie**: `beforeApplicationShutdown` → nowe tury 503
   `AI_UPSTREAM_PAUSED` (`retryAfterSeconds:5`), biegnące mają `AI_SHUTDOWN_GRACE_MS`
   (8 s), reszta przerwana jako `AI_PROVIDER_ERROR` bez bezpiecznika, zwrot tylko
   za darmową.
6. **Budżet przy współbieżności**: sufity domu (doba, miesiąc) z rezerwacją
   `AI_TURN_COST_RESERVE_USD` × inne żywe tury domu, w transakcji SERIALIZABLE po
   semaforze; instalacja — to samo przed transakcją (nieatomowo, §7); w trakcie tury
   werdykt księgi kończy pętlę ostatnim słowem (`stopReason: budget_ceiling`).
7. **Eksport danych**: `turns` = `COUNT(DISTINCT turnId)` (+ wiersze bez tury).
8. **Karty w historii** (`30a15cc` test → `d357eca` fix): do wiadomości asystenta
   z kartą dopisek — OPTIONS „1) R012 Tytuł; 2) …" w kolejności kafelków, najnowsza
   propozycja PLAN_WEEK/PLAN_DAY z id, statusem **z bazy** i pozycjami
   „MON DINNER R045 Tytuł (dla: …)", starsze jedną linią. Prompt składany przed
   historią (indeks tury, domownicy ze zgodą).
9. **`revise_proposal`** — poprawka JEDNEGO slotu propozycji PENDING z tej rozmowy;
   serwer bierze `action.slots`, podmienia cały slot na jedno danie (uczestnicy:
   suma, pusta = cały dom), liczy nową propozycję zwykłą ścieżką (walidacja,
   karta, odcisk). Referencja do pozycji = (numer propozycji, dzień, pora) —
   niezależna od kolejności tekstu modelu.
10. **`/auth/refresh`** (`95e7303` test → `e3c30fc` fix): limit per sesja (hasz
    przedstawionego refresh tokenu, 10/min) + luźny bezpiecznik IP tylko dla tej
    trasy (600/min); logowanie bez zmian.

Nie zrobione w tym etapie: żaden pomiar na żywym modelu (poza zakresem), smoke
schematów narzędzi przez API (§8).

## 2. Zmiany w kodzie

| Plik / moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `src/agent/search/agent-catalog.service.ts`, `catalog-digest.ts` (`8ce83dd`) | `isCatalog: true` w indeksie/digeście/odcisku | prywatny przepis konta katalogowego był kandydatem dla każdego domu |
| `src/agent/agent-usage-ledger.service.ts` (nowy) | `record`, `refundIfFree`, `closeTurn` | koszt zapisany w chwili wydania; jedna reguła zwrotu i domknięcia z zewnątrz |
| `src/agent/providers/agent-provider.ts` | `AgentProviderCall`, `AgentUsageVerdict`, `onUsage` | kontrakt meldowania wywołań i werdyktu budżetu |
| `src/agent/providers/anthropic-agent.provider.ts` | `onUsage` po każdym `accumulate` (pętla + ostatnie słowo, także przed odmową), `budget_ceiling` | koszt przeżywa błąd kolejnej rundy; sufit w trakcie tury |
| `src/agent/providers/stub-agent.provider.ts` | meldowanie wywołań; markery `[[options:…]]`, `[[revise:…]]`, kilka `[[propose:…]]` | e2e bez modelu dla nowych ścieżek |
| `src/agent/agent-turn.runner.ts` | `TurnLedger` (ponowienia, zapis zastępczy), znak życia, `beforeApplicationShutdown`, `isRunning`/`isDraining`, domknięcia bez kosztu, historia z kartami | punkty A–D, G |
| `src/agent/agent-turn-liveness.ts` (nowy) | definicja tury żywej/osieroconej, warunki Prisma | jedna definicja dla czterech ścieżek |
| `src/agent/agent-turn-sweeper.service.ts` (nowy) | sprzątanie przy starcie + co minutę | recovery po restarcie bez czekania na odpytanie |
| `src/agent/agent-turns.service.ts` | draining 503, budżet instalacji z rezerwacją, sufity domu z rezerwacją w tx, stale close po znaku życia, domknięcia przez księgę | punkty B, C, E |
| `src/agent/history-cards.ts` (nowy), `agent-prompt.service.ts` (`visibleUserIds`) | dopiski kart w historii | punkt G |
| `src/agent/tools/agent-tools.ts`, `agent-tool-executor.ts`, `proposals/agent-proposals.service.ts`, `agent-progress.ts`, `agent-system-prompt.ts` | `revise_proposal` (schemat, tier `planner`, `TURN_ENDING_TOOLS`, `refuseOutOfMode`, serwis, etykiety, linie instrukcji) | punkt G |
| `src/data-export/user-export.ts` | tury jako `COUNT(DISTINCT turnId)` | wiersz to teraz wywołanie, nie tura |
| `src/common/throttle/refresh-token-tracker.ts` (nowy), `throttle-env.ts`, `auth.controller.ts`, `config/runtime-settings.ts` | tracker per sesja, 2 nowe limity (też w panelu) | punkt H |
| `src/config/agent-env.ts` (`1bcd282` + fix) | `turnCostReserveUsd`, `shutdownGraceMs` (+ walidacja) | nowe env |
| `scripts/agent-usage-report.ts` | etykiety: wiersz = wywołanie (od 26.09) | raport mieszałby epoki |
| `CLAUDE.md`, `.env.example` | kolejność odmów, księga, życie tury, refresh, nowe env | dokumentacja kontraktu |

**Migracja** `20260926120000_ksiega_per_wywolanie` (`1bcd282`):
- `ALTER TABLE "AiUsage" ADD COLUMN "callIndex" INTEGER` (nullable, bez domyślnej —
  natychmiastowe w Postgresie), `CREATE UNIQUE INDEX (turnId, callIndex)` — stare
  wiersze mają `NULL`, a NULL-e nie kolidują w indeksie unikalnym;
  `CREATE INDEX "AgentTurn"(status, updatedAt)`.
- Wpływ na dane: żaden (brak backfillu). Indeksy tworzone bez `CONCURRENTLY` —
  krótka blokada zapisu na czas budowy; tabele mają rząd tysięcy wierszy (ESTIMATE),
  więc to milisekundy.
- Rollback: `DROP INDEX` ×2 + `DROP COLUMN "callIndex"`; kod sprzed etapu ignoruje
  kolumnę, więc możliwy też forward-fix bez cofania migracji.
- Zastosowana na lokalnej bazie dev (`prisma migrate deploy`, 26.09). Na prod
  wejdzie przez safe-migrate przy starcie po merge'u do `main`.

## 3. Kontrakty i kompatybilność

- **REST / WebSocket / OpenAPI:** `pnpm openapi:check` — „OpenAPI aktualne" (kształty
  bez zmian). Nowe zachowania w istniejących kodach: 503 `AI_UPSTREAM_PAUSED`
  z `retryAfterSeconds:5` przy zamykaniu procesu; 503 `AI_BUDGET_PAUSED` może teraz
  wynikać z rezerwacji (inny `message`, ten sam kod i `details`); tury osierocone
  kończą się `AI_PROVIDER_ERROR` po minucie zamiast `AI_TIMEOUT` po ~4 min.
  `/auth/refresh`: te same odpowiedzi (201/401/429), inny klucz limitu.
- **iOS:** bez zmian wymaganych — wszystkie kody istniały i są mapowane
  (`UserFacingErrorMapper`). Karta po `revise_proposal` to zwykła `PLAN_WEEK`/`PLAN_DAY`.
- **Kontrakt z modelem:** nowe narzędzie `revise_proposal` (4 pola wymagane, bez
  `strict`; budżet pól nieobowiązkowych dalej **24/24**), dwie linie instrukcji,
  dopiski `[Karta …]`/`[Propozycja …]` w historii. Prefiks cache zmieni się raz przy
  deployu (lista narzędzi + instrukcje).
- **Zmienne środowiskowe** (wszystkie mają domyślne — merge nie wymaga ustawiania):
  `AI_TURN_COST_RESERVE_USD` (0.25), `AI_SHUTDOWN_GRACE_MS` (8000),
  `THROTTLE_AUTH_REFRESH_LIMIT` (10), `THROTTLE_AUTH_REFRESH_IP_LIMIT` (600).
  Do rozważenia na Railwayu: `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (§9).
- **Księga `AiUsage`:** od tego etapu wiersz = wywołanie (`apiCalls = 1`, `callIndex`),
  `stopReason` = powód zakończenia TEGO wywołania z API (`tool_use`, `end_turn`,
  `budget_ceiling` przy ostatnim słowie…), `latencyMs` = czas wywołania. Stare wiersze
  (faza tury) zostają. Panel liczy sumy i `COUNT(DISTINCT turnId)` — sprawdzone
  w kodzie (`admin-profit`, `admin-reports`, `admin-users`, `admin-dashboard`).
- **Kompatybilność wsteczna:** kod sprzed etapu działa na zmigrowanej bazie
  (kolumna nullable). Tury RUNNING z procesu sprzed deployu zamknie sprzątanie.

## 4. Testy

Lokalna baza dev (Docker `scoffie-db`), env e2e jak w CI.

| Test / komenda | Wynik |
|---|---|
| `pnpm typecheck` | 0 błędów |
| `pnpm lint:check` | 0 błędów, 42 ostrzeżenia — wszystkie w plikach nieruszanych w etapie |
| `pnpm build` | OK |
| `pnpm test` | **181/181 suit, 3309/3309 testów** |
| `pnpm openapi:check` | „OpenAPI aktualne. REST: 37 operacji, WS: 48+8 zdarzeń" |
| e2e `agent-accounting` (timeout/Stop/restart/równoległe starty) | **5/5** (przed etapem 3 czerwone: timeout gubił koszt i oddawał wiadomość, restart → 409, równoległe starty przechodziły przez sufit) |
| e2e `agent-catalog-boundary` | **4/4** |
| e2e `agent-card-state` (nowy: wybór z kafelków, podmiana jednej pozycji) | **2/2** |
| e2e `throttling` (NAT-like burst, pętla jednej sesji, bezpiecznik IP) | **6/6** (przed fixem 2 czerwone) |
| e2e `agent`, `agent-tools`, `data-export` | **104/104** |
| e2e `auth-session-audit`, `auth-refresh-after-grace`, `auth-session-lifecycle` | razem z throttling 67/67 |
| **pełne `pnpm test:e2e:ci`** | **543/548, 44/47 suit.** 5 porażek w `admin-assistant` (profit ×2), `admin-integrations`, `admin-revenue` ×2 — **te same 5 pada na commicie sprzed etapu `1c265a3`** (sprawdzone w osobnym worktree). Przyczyna środowiskowa: kursy NBP zsynchronizowane do bazy dev przez lokalny kontener API (test oczekuje kursu z cennika) i `MAIL_TRANSPORT=resend` w env dev. CI ma czystą bazę. |

Obowiązkowe testy z TASKS.md → gdzie:
- rozmowa wieloturowa z wyborem pozycji — `agent-card-state.e2e` #1 + runner spec „historia z kartami";
- podmiana jednej pozycji bez zmiany reszty — `agent-card-state.e2e` #2 (intencja, zapis, stara wersja 409) + `agent-proposals.revise.spec.ts`;
- prywatny przepis poza publicznym indeksem — `agent-catalog-boundary.e2e`;
- anulowanie/timeout/restart nie gubi i nie dubluje usage — `agent-accounting.e2e` + `agent-usage-ledger.service.spec.ts` (duplikat = `count 0`, nic się nie dolicza);
- dwa równoległe starty nie przekraczają budżetu — `agent-accounting.e2e` #5 + `agent-turns.service.spec.ts`;
- NAT-like burst na refresh — `throttling.e2e`.

## 5. Pomiary przed / po

Etap poprawnościowy — bez pomiarów modelu (płatne, poza zakresem). Liczby:

| Metryka | Przed | Po | Źródło |
|---|---:|---:|---|
| Czas odblokowania rozmowy po padzie procesu | `AI_TURN_TIMEOUT_MS` + 5 s = **245 s** | **60 s** (+ ≤ 60 s do przebiegu sprzątania, jeśli nikt nie pisze) | **CALCULATED** z progów w kodzie; e2e „restart" potwierdza 90 s → 202 |
| Koszt wywołań przed timeoutem/restartem/„Stop" spoza procesu w księdze | 0 (gubiony) | 100 % zameldowanych wywołań | **MEASURED** (e2e, stub `[[cost:7000]]` → księga 7000, licznik doby 7000) |
| Przekroczenie sufitu domu przez tury w biegu | nieograniczone rundami (do `AI_MAX_TURN_COST_USD` = $0,80 na turę) | wywołanie przekraczające + najwyżej **1** wywołanie (ostatnie słowo) na turę w biegu | **CALCULATED** z pętli dostawcy |
| Maks. koszt tego jednego wywołania (Sonnet 5) | — | wyjście ≤ 16 000 tok × $10/MTok = **$0,16** + wejście (~$0,05–0,10) | wyjście **CALCULATED** (`MAX_TOKENS`, cennik), wejście **ESTIMATE** |
| Przekroczenie sufitu domu przy starcie | 2 starty tuż pod sufitem przechodziły oba | druga odmowa 503 | **MEASURED** (e2e #5) |
| Zapytania DB na wywołanie modelu (księga) | 0 (raz na turę przy domknięciu ~7) | ~9–13 małych zapytań na wywołanie (odczyt tury, wiersz, przyrost, 2× licznik domu, licznik instalacji, do 3 odczytów sufitów, +2 przy cofnięciu zwrotu) | **CALCULATED** z kodu |
| Znak życia | — | 1 `UPDATE` / 15 s / tura w biegu; sprzątanie 1 zapytanie / min | **CALCULATED** |
| `/auth/refresh` za jednym IP | 20/min na CAŁE IP (razem z logowaniem) | 10/min na sesję, 600/min na IP | konfiguracja; e2e 8 sesji × 1 bez 429 (**MEASURED**) |
| Dopisek karty w historii | 0 tok (karta niewidoczna) | OPTIONS ~20–40 tok; propozycja tygodnia 21 pozycji ~300–450 tok | **ESTIMATE** (~40–60 znaków/pozycja, ~3 znaki/tok) |

## 6. Wydajność bazy / API

- Hot path przyjęcia tury: +1 `count` żywych tur instalacji (tylko przy włączonym
  budżecie globalnym i rezerwacji > 0), w transakcji +2 odczyty liczników (doba,
  miesiąc); liczenie żywych tur domu połączone z semaforem (jedno zapytanie).
- Kandydaci do sprzątania idą po nowym indeksie `AgentTurn(status, updatedAt)`;
  gałąź „po czasie" filtruje RUNNING (kilka wierszy).
- EXPLAIN nie był robiony — tabele małe, zmiana nie dotyczy katalogu.

## 7. Ryzyka i regresje

- **Nowe ryzyka:**
  - Budżet instalacji sprawdzany NIEATOMOWO (świadomie — licznik tur całej
    instalacji w SERIALIZABLE kłóciłby się z każdą turą w każdym domu). K startów
    w tym samym oknie może przejść; ogranicza je werdykt księgi w trakcie tury.
  - Cofnięcie zwrotu (+1 wiadomość) nie sprawdza limitu — pula może chwilowo wyjść
    o 1 ponad limit, gdy zwolnione miejsce zajęła inna tura. Rzadkie (koszt musi
    dojechać po domknięciu z zewnątrz).
  - Więcej małych zapytań na turę (§5). Przy obecnym ruchu pomijalne; do obejrzenia
    w Etapie 4, gdyby DB stała się wąskim gardłem.
  - Model może naśladować dopiski `[…]` w swoich odpowiedziach — instrukcja tego
    zabrania, ale sprawdzi to dopiero benchmark (Etap 6).
- **Znane ryzyka pozostawione:**
  - Łagodne zamknięcie nie działa, dopóki Railway daje 0 s między SIGTERM a SIGKILL
    (domyślne). Wtedy ratuje nas sprzątanie w nowym procesie (≤ 60 s) — koszt jest
    już w księdze, więc nic nie ginie poza odpowiedzią.
  - Limit refresh per hasz tokenu nie jest limitem RODZINY: klient w pętli udanych
    rotacji dostaje nowy klucz co rotację; łapie go dopiero bezpiecznik IP. Pełny
    limit per rodzina wymagałby odczytu z bazy — do decyzji, czy warto (§10).
- **Edge cases sprawdzone testami:** tura bez kosztu po „Stop" oddaje wiadomość;
  tura zniknęła w trakcie (RODO) → wiersz bez tury, liczniki dostają koszt;
  zapis księgi padł raz → ponowiony; padł dwa razy → brak zwrotu (pamięć tury);
  cicha tura z tego procesu nie jest zamykana; propozycja dnia poprawia tylko swój dzień.

## 8. Odstępstwa od planu

- **Smoke schematów narzędzi przez API** (`scripts/agent-tools-smoke.ts`) — nie
  uruchomiony: to wywołanie żywego modelu (poza zakresem etapu). Spec-i limitów
  (`agent-tools.spec.ts`: 24 pola opcjonalne, gramatyka `strict`) są zielone, ale
  CLAUDE.md mówi wprost, że jedynym pewnym sprawdzianem jest smoke. **Do uruchomienia
  przed deployem** (grosze).
- `stopReason` w nowych wierszach `AiUsage` to powód wywołania z API, nie powód tury
  (`tool_ended_turn` / kod błędu tury lądują w wierszu tylko w zapisie zastępczym).
  Powód tury zostaje w `AgentTurn.errorCode` / wyniku. Nic w panelu tego pola nie czyta.
- Sufity domu mają teraz DWIE bramki: szybką przed transakcją (same wydane, jak
  dotąd — zachowuje kolejność „dom przed instalacją") i atomową z rezerwacją w tx.
- `revise_proposal` nie przyjmuje uczestników ani porcji (budżet 24/24): bierze
  osoby z podmienianego slotu; porcje zostają tylko przy podmianie jednej pozycji.
- Znak życia przerywa turę domkniętą z zewnątrz (poza projektem — dopisane, bo inaczej
  runner płaciłby za rundy odpowiedzi, której nikt nie zobaczy).

## 9. Decyzje potrzebne od Rafała

1. **`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` na `scoffie-backend`** — dokumentacja
   Railwaya (Deployment Teardown → Draining time): po starcie nowego deploymentu stary
   dostaje SIGTERM, a SIGKILL po czasie z tej zmiennej, **domyślnie 0**. Proponuję
   **12** (8 s łaski + 2 s domknięcia + zapas). Koszt: stary i nowy proces żyją
   równolegle do 12 s — bezpieczne, bo znak życia działa między procesami. Zapis na prod
   tylko za Twoim „tak".
2. **`scripts/agent-tools-smoke.ts` przed deployem** (§8) — jedno żądanie do API.
3. Czy limit refresh ma iść za RODZINĄ tokenów (odczyt z bazy w guardzie), czy
   wystarcza hasz tokenu + bezpiecznik IP.

## 10. Co proponujesz dalej

- Etap 2 zgodnie z planem (audyt 2A: semantyka porcji/uczestników) — `revise_proposal`
  jest naturalnym punktem wpięcia `replace_plan_item` z 2D.
- **Rezydencja danych w UE — osobny tor**, nie część wyboru modelu: dziś dane domu
  (w tym alergie/diety domowników ze zgodą) idą do API w USA. Do decyzji: regionalny
  endpoint / dostawca z przetwarzaniem w UE, aktualizacja polityki prywatności i DPA —
  niezależnie od tego, który model wygra benchmark w Etapie 6.
- Po wdrożeniu: `pnpm agent:report:usage` na prod po tygodniu — pierwsza mediana
  wywołań na turę liczona z księgi per wywołanie, nie z benchmarku.

## 11. Commity

- `dbf0100` — test(agent): prywatny przepis konta katalogowego poza wspólnym indeksem
- `8ce83dd` — fix(agent): wspólny indeks katalogu tylko z isCatalog=true
- `ee8c740` — test(agent): księgowanie kosztu pod timeoutem, restartem i równoległymi startami
- `1bcd282` — wip(agent): księga per wywołanie — schemat, migracja, env rezerwacji
- `40e6b2c` — feat(agent): księga kosztu per wywołanie, znak życia tur, łagodne zamknięcie i rezerwacja budżetu
- `30a15cc` — test(agent): model nie widzi kart z poprzednich tur (opcje, pozycje propozycji)
- `d357eca` — feat(agent): karty z poprzednich tur w historii modelu i revise_proposal
- `95e7303` — test(auth): odświeżanie tokenu za NAT-em blokuje poprawnych użytkowników
- `e3c30fc` — fix(auth): /auth/refresh limitowane per sesja z luźnym bezpiecznikiem IP
- (następny) — docs: raport Etapu 1, STATE.md, CLAUDE.md
