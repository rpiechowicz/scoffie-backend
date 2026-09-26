# Raport etapu 05 — Trwałe wykonywanie tur asystenta

**Data:** 2026-09-27  
**Status:** DONE  
**Branch:** `claude/admin-crm-planning-b0hmgo`  
**Zakres z TASKS.md:** Etap 5 (+ polecenie 5.0–5.20)

Oznaczenia: **MEASURED** — zmierzone lokalnie (Docker Postgres 16); **CALCULATED** —
wyliczone z kodu; **ESTIMATE** — szacunek.

## 1. Audyt okien awarii (przed zmianą)

Tor tury przed Etapem 5: `POST /messages` → transakcja SERIALIZABLE (lease rozmowy,
semafor, kwota wiadomości, `AgentMessage` USER + `AgentTurn` RUNNING) → **`void
runner.run()` w pamięci procesu** → prompt + historia → pętla dostawcy (wywołanie →
`onUsage` → księga `AiUsage` w osobnej transakcji → narzędzia → kolejna runda) →
`finishDone`: jedna transakcja (tura DONE + `AgentMessage` ASSISTANT + przypięcie
propozycji + zwrot kwoty przy suficie) → push (fire-and-forget).

„Kto wykonuje", „czy anulowana", „czy do odzyskania" wynikało WYŁĄCZNIE z pamięci
procesu (`running: Map<turnId, AbortController>`) i z `updatedAt` odświeżanego co 15 s.
Po SIGKILL sprzątanie po minucie ciszy domykało turę jako FAILED.

**KNOWN COST** = koszt wywołania zapisany w `AiUsage` (znamy i liczymy).
**UNKNOWN PROVIDER OUTCOME** = dostawca przyjął żądanie, ale odpowiedź/zużycie nie
dotarło do naszej bazy. Anthropic nie daje klucza idempotencji dla `messages.create`,
więc tego nie da się ani powtórzyć „exactly-once", ani odzyskać z naszej strony.

| # | Punkt SIGKILL | Wynik PRZED | Wynik PO (pożądany = osiągnięty) | Co gwarantujemy | Czego fundamentalnie nie da się zagwarantować |
|---|---|---|---|---|---|
| 1 | przed 1. wywołaniem dostawcy | tura RUNNING, po 60 s FAILED `AI_PROVIDER_ERROR`, zwrot wiadomości; użytkownik pyta od nowa | lease wygasa (≤30 s; przy łagodnym zamknięciu od razu) → nowy worker wykonuje próbę 2 → DONE | wykonanie dokończone, jedna odpowiedź, kwota raz | — |
| 2 | w trakcie wywołania dostawcy | jak 1; koszt tego wywołania nieznany (księga 0 → wiadomość wraca) | próba 2 od nowa, NOWE wywołania pod nowymi kluczami | znany koszt obu prób w księdze | **UNKNOWN PROVIDER OUTCOME**: przerwane wywołanie mogło zostać naliczone przez dostawcę, u nas go nie ma |
| 3 | dostawca odpowiedział, zapis `AiUsage` jeszcze nie | jak 2 | jak 2 | — | **UNKNOWN PROVIDER OUTCOME** (granica — patrz §17) |
| 4 | `AiUsage` zapisany, narzędzie jeszcze nie | FAILED po 60 s, koszt zostaje, bez zwrotu | próba 2 (koszt próby 1 zostaje, próba 2 dolicza swój) → DONE | KNOWN COST ani zgubiony, ani zdublowany | powtórzony koszt dostawcy za rundy próby 1 (świadomie: płacimy drugi raz, ale wiemy ile) |
| 5 | narzędzie zapisało efekt, runner dalej nie | efekt zostaje (przepis/notatka/zapis planu), tura FAILED; ponowienie przez użytkownika mogło zrobić **drugi** przepis/notatkę | wiersz dziennika efektu w TEJ SAMEJ transakcji co efekt → próba 2 dostaje zapisany wynik, efekt nie powtarza się | exactly-once efektu w naszej bazie (klucz `turn + narzędzie#n` / `card`) | efekty „z natury" (odhaczenie) mogą zostać ustawione drugi raz na tę samą wartość — bez drugiego efektu (§12) |
| 6 | propozycja powstała, odpowiedź nie | propozycja bez `messageId` = nieosiągalna; tura FAILED | próba 2 domyka turę TĄ propozycją, zdaniem serwera, bez wywołania modelu | jedna propozycja, jedna odpowiedź, poprawne przypięcie | — |
| 7 | odpowiedź asystenta jest, tura RUNNING | niemożliwe — ta sama transakcja | nadal ta sama transakcja + unikat `(turnId, outputKey='final')`; gdyby odpowiedź była — domknięcie na niej (`closeOnExistingAnswer`) | jedna odpowiedź na turę | — |
| 8 | tura DONE, worker jeszcze pracuje (push, metryki) | push może nie wyjść | bez zmian | tura i odpowiedź trwałe | push i broadcast WS: best-effort (może zginąć, nie dubluje się) |
| 9 | w trakcie „Stop" | Stop tylko sygnałem w pamięci; pad między sygnałem a domknięciem = `AI_PROVIDER_ERROR`; Stop na innej instancji domykał turę, a właściciel dalej wydawał pieniądze | `cancelRequestedAt` w bazie; nikt nie przejmie tury z żądaniem; właściciel widzi je przy odnowieniu (≤10 s), przed wywołaniem modelu i przed zapisem narzędzia; bez właściciela — domknięcie od razu | anulowanie przeżywa pad procesu | wywołanie modelu w locie dobiega (koszt znany) |
| 10 | w trakcie zamykania procesu | 8 s łaski, potem FAILED `AI_PROVIDER_ERROR` (i tylko przy `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` > 0) | łaska, potem lease **oddany** → nowa instancja przejmuje od razu; SIGKILL → po wygaśnięciu lease | tura nie przepada z powodu deployu | — |

## 2. Wybrany model worker / job / lease

**Wariant A** z polecenia: kolumny wykonania na istniejącym `AgentTurn` (bez osobnej
tabeli jobów — relacja 1:1 nic by nie dała, a lease rozmowy, semafor domu i telefon i tak
patrzą na `AgentTurn`). Plus mała tabela **dziennika efektów narzędzi**
`AgentTurnEffect` (to nie kolejka — to pamięć o efektach, §12).

Stan zadania wynika z kolumn, bez nowych statusów:

| Logiczny stan | Warunek | Telefon widzi |
|---|---|---|
| READY / RECLAIMABLE | `status=RUNNING`, `execution` jest, `leaseExpiresAt` NULL albo przeszłość, przed `deadlineAt`, bez `cancelRequestedAt`, `attempt < AI_TURN_MAX_ATTEMPTS` | RUNNING |
| CLAIMED / RUNNING | `status=RUNNING`, `leaseExpiresAt > now()` | RUNNING |
| DONE / FAILED | jak dotąd | jak dotąd |

Worker = serwis Nesta `AgentTurnWorker` w procesie API: `kick(turnId)` zaraz po 202
(tura startuje bez opóźnienia, jak przed Etapem 5) i odpytywanie co
`AI_TURN_WORKER_POLL_MS` (3 s) + raz przy starcie. Bez BullMQ, Redis, osobnego
deploymentu. Poprawność przy dwóch instancjach zapewnia baza (claim, fencing, dziennik).

## 3. Schema i migracja

`prisma/migrations/20260927000000_durable_agent_turns` — **addytywna**:

- `AgentTurn`: `execution JSONB` (wejście tury: daty telefonu, tryb propozycji),
  `deadlineAt`, `attempt INT DEFAULT 0`, `leaseOwner`, `leaseToken UUID`,
  `leaseExpiresAt`, `cancelRequestedAt`, `failureDetail` + indeks
  `(status, leaseExpiresAt)`;
- `AgentMessage.outputKey` + unikat `(turnId, outputKey)`;
- `AiUsage.attempt`;
- tabela `AgentTurnEffect (turnId, key, tool, attempt, input, result, card)` z unikatem
  `(turnId, key)`, kaskada z tury.

Istniejące dane: DONE/FAILED bez zmian. **RUNNING z chwili deployu** mają `execution =
NULL` → nieodzyskiwalne (nie ma zapisanych dat telefonu ani trybu) → sprzątanie domyka
je jak dawniej (minuta bez znaku życia → `AI_PROVIDER_ERROR`, `failureDetail =
AI_TURN_LEGACY_ORPHAN`; zwrot wiadomości tylko za turę bez kosztu). W czasie
nakładania się instancji stara instancja prowadzi swoje tury po staremu, a jej
sprzątanie nie zabije nowych tur (nowy runner odświeża `updatedAt` przy każdym
odnowieniu lease, co 10 s). Bez backfillu. Brak dryfu schematu (`prisma migrate diff`
pusty, MEASURED).

## 4. Algorytm claim

Jedno zdanie SQL (`AgentTurnQueue.claim`), autocommit:

```sql
WITH picked AS (
  SELECT id, "leaseOwner" AS "previousOwner" FROM "AgentTurn"
  WHERE status='RUNNING' AND execution IS NOT NULL AND "cancelRequestedAt" IS NULL
    AND "deadlineAt" > now() AND attempt < $max
    AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
    [AND id = $turnId]
  ORDER BY "startedAt" LIMIT $n
  FOR UPDATE SKIP LOCKED)
UPDATE "AgentTurn" a SET "leaseOwner"=$worker, "leaseToken"=gen_random_uuid(),
  "leaseExpiresAt"=now()+$lease, attempt=attempt+1, "updatedAt"=now()
FROM picked WHERE a.id = picked.id RETURNING …
```

Wiersz zablokowany przez innego claimującego jest pomijany (`SKIP LOCKED`); wiersz
przejęty i zatwierdzony przed naszym zablokowaniem nie przechodzi ponownie warunku
`leaseExpiresAt < now()` (Postgres sprawdza go na najnowszej wersji). Terminy liczy
**zegar bazy**. Test: 20 równoległych claimów tej samej tury → dokładnie jeden
właściciel (MEASURED, e2e #2).

EXPLAIN przy 200 000 tur w tabeli i 50 RUNNING (MEASURED, `scoffie_scale`, dane
syntetyczne wycofane): Index Scan `AgentTurn_status_leaseExpiresAt_idx`, przejęto 16,
**0,54 ms**. Odpytywanie bezczynne: jedno zapytanie co 3 s po indeksie.

## 5. Lease + fencing

- `leaseToken` (UUID) jest nowy przy KAŻDYM przejęciu — to fencing token.
- Każde krytyczne domknięcie ma go w warunku: `finishDone`/`finishFailed`
  (`updateMany where {id, status: RUNNING, leaseToken}`), postęp, szkic, odpowiedź,
  zwolnienie lease.
- Każdy efekt narzędzia sprawdza go **w swojej transakcji** (`AgentTurnQueue.fence`:
  `UPDATE … SET leaseToken=leaseToken WHERE id AND leaseToken AND RUNNING` — blokada
  wiersza tury; równoległe przejęcie czeka na commit albo wygrało wcześniej, wtedy
  `LeaseLostError` i efekt się wycofuje).
- Worker po utracie lease: przerywa pętlę (`ABORT_REASON_LEASE_LOST`), nie zapisuje
  szkicu, domknięcia ani zwrotu; koszt jego wywołań zostaje w księdze pod kluczami jego
  próby (to prawdziwe pieniądze). Test e2e #3: A traci lease, B przejmuje, A kończy
  pierwszy → A nie zapisuje nic, jedna odpowiedź od B, obie próby w księdze.

## 6. Heartbeat

Tura pod lease odnawia go co ⅓ ważności (`AI_TURN_LEASE_MS` = 30 s → co 10 s):
`UPDATE … SET leaseExpiresAt = now()+lease WHERE id AND leaseToken AND RUNNING
RETURNING cancelRequestedAt`. Brak wiersza = lease stracony → abort + STOP. Błąd bazy:
próby dalej, ale gdy od ostatniego udanego odnowienia minęła cała ważność — abort (inny
worker mógł już przejąć). `updatedAt` nie jest już jedynym dowodem życia; zostaje tylko
dla tur bez lease (testy jednostkowe, tury sprzed Etapu 5).

## 7. Recovery

- Przy starcie aplikacji worker od razu odpytuje kolejkę (e2e #4: nowa instancja
  przejmuje porzuconą turę sama, bez telefonu; `leaseOwner` = jej id).
- `AgentTurnSweeper` NIE domyka już tur z wygasłym lease przed terminem. Domyka tylko:
  po terminie całej tury (`AI_TIMEOUT`), stare tury bez `execution` bez znaku życia,
  wyczerpane próby, „Stop" bez workera (`turnCloseVerdict`, jedna definicja dla
  sprzątania, `getTurn` i lease rozmowy).
- Lease rozmowy i semafor domu liczą turę do przejęcia jako żywą (blokuje rozmowę
  409, dopóki nie skończy) — nie jest „zombie".
- **Sposób wznowienia (§5.6): kierunek B** — idempotentne efekty narzędzi + bezpieczny
  restart próby. Próba N+1 buduje prompt i historię od nowa z bazy i woła model od
  nowa; efekty z poprzednich prób wracają z dziennika. Kierunek A (checkpoint rund
  dostawcy) odrzucony jako większy: wymagałby zapisu pełnej historii protokołu
  (bloki myślenia z podpisami, `tool_use`) po każdej rundzie i przebudowy
  `AnthropicAgentProvider`, a i tak potrzebowałby idempotencji narzędzi dla rundy w
  locie. Wyjątek — **szybkie domknięcie**: gdy dziennik ma kartę kończącą turę ze
  zdaniem serwera (`turnTextFor`), próba N+1 domyka turę od razu, bez modelu
  (dokładnie to, co dostawca oddałby jako `tool_ended_turn`). e2e #7: 0 wywołań w
  próbie 2.

## 8. Cancel

`cancelTurn`: (1) `cancelRequestedAt = now()` w bazie; (2) sygnał lokalny, jeśli tura
jest w tym procesie; (3) bez żywego lease — domknięcie `AI_CANCELLED` od razu
(`closeTurn(onlyIfUnleased)`); z żywym lease gdzie indziej — tamten worker domknie sam
(odnowienie co 10 s, `onThinking` przed kolejnym wywołaniem modelu, sprawdzenie przed
każdym narzędziem z efektem). Claim pomija tury z żądaniem. e2e #10: Stop → pad
procesu → nowa instancja NIE kontynuuje, sprzątanie domyka `AI_CANCELLED`, 0 odpowiedzi.

## 9. Timeout / deadline

| | Źródło | Skutek |
|---|---|---|
| A. termin całej tury | `deadlineAt` = przyjęcie + `AI_TURN_TIMEOUT_MS`, zapisany raz | po nim `AI_TIMEOUT`, bez kolejnej próby (claim wymaga `deadlineAt > now()`) |
| B. wygaśnięcie lease | `leaseExpiresAt` | tura do przejęcia — **nie** timeout |
| C. timeout dostawcy | zegar runnera = **reszta** do `deadlineAt` | przerwanie wywołania → `AI_TIMEOUT` |
| D. ponowienie po utracie procesu | `attempt` < `AI_TURN_MAX_ATTEMPTS` | kolejna próba z resztą czasu |

Proces padł po 30 s przy limicie 240 s → próba 2 ma ~210 s (e2e #4, #11). e2e #12:
termin minął → `AI_TIMEOUT`, bez przejęcia.

## 10. Polityka prób

`AI_TURN_MAX_ATTEMPTS` (domyślnie 3) = ile razy turę można **przejąć**. Błąd dostawcy
(429/5xx/odmowa) kończy turę w tej samej próbie jak dotąd — nie jest powodem ponowienia
(ponowienia HTTP w SDK Anthropica bez zmian). Po limicie: FAILED, `errorCode =
AI_PROVIDER_ERROR` (kontrakt z telefonem bez zmian — iOS zna ten kod), `failureDetail =
AI_TURN_ATTEMPTS_EXHAUSTED`, znany koszt zostaje, zwrot kwoty wg istniejącej reguły
(tylko za turę bez kosztu). e2e #13 (koszt 0 → zwrot) i #16 (koszt > 0 → bez zwrotu).

## 11. Tożsamość wywołań dostawcy i księga

`usageCallKey(turnId, callIndex, attempt)`:
- próba 1: `turn:<turnId>:<callIndex>` — **stary kształt**, istniejące wiersze i raporty
  bez zmian;
- próba ≥ 2: `turn:<turnId>:a<próba>:<callIndex>` — realne wywołania kolejnej próby mają
  NOWE klucze, więc księga ich nie uzna za powtórkę;
- ponowiony zapis tego samego wywołania (ta sama próba, ten sam indeks) = ten sam klucz
  → exactly-once (`ON CONFLICT DO NOTHING`);
- `AiUsage.attempt` do raportów; liczba wywołań API dalej = liczba wierszy / `apiCalls`.

e2e #4 (MEASURED): próba 1 `turn:X:0` 7000 µ$ (zapisane przed padem), próba 2
`turn:X:a2:0` 7000 µ$ + `turn:X:a2:1` 0 µ$; koszt tury 14 000 µ$; ponowienie zapisu
znanego wywołania nie zmienia ani wierszy, ani kosztu.

**Granica (jawnie):** dostawca odpowiedział → proces ginie PRZED `ledger.record` =
koszt nieznany. Bez klucza idempotencji po stronie dostawcy nie da się tego odzyskać
ani uniknąć; próba 2 zapłaci swoje wywołania drugi raz (znane). Znane i zapisane
zużycie nie jest ani liczone drugi raz, ani gubione.

## 12. Idempotencja efektów narzędzi

Trwała tożsamość wywołania narzędzia = **`card`** (jedna karta na turę) albo
**`<narzędzie>#<n>`** (n-te wywołanie tego narzędzia w turze, nadawane synchronicznie
przed pierwszym `await`). Nie z identyfikatora `tool_use` (każda próba to nowe
wywołanie API z nowymi id) ani z losowego UUID.

| Narzędzie | Klasa | Klucz | Co przy padzie 1 ms po COMMIT, przed wynikiem |
|---|---|---|---|
| `get_*`, `find_recipes`, `search_ingredients`, `show_*`, `check_plan_conflicts`, `start_planning`, `apply_week_plan` z `dry_run` | read | — | nic do powtórzenia |
| `propose_week_plan/day_plan/swap/remove_meal/household_split`, `revise_proposal`, `build_meal_plan`, `replace_plan_item` | card-db | `card` | propozycja i wiersz dziennika w JEDNEJ transakcji (`insertProposal`) → próba 2: szybkie domknięcie albo wynik z dziennika; druga propozycja nie powstaje |
| `ask_clarifying_question`, `offer_options`, `suggest_meals` | card-memory | `card` | brak efektu w bazie; karta zapisana w dzienniku po wykonaniu → próba 2 domyka tą samą kartą |
| `create_recipe`, `update_recipe` | keyed | `…#n` | hak `inTransaction` w `RecipesService.create/update` → przepis + dziennik razem; próba 2 dostaje `{recipeId, alreadyDone}` |
| `remember_note` | keyed | `…#n` | hak `inTransaction` w `AgentMemoryService.remember` (plus istniejący unikat treści) |
| `apply_week_plan` (tryb bez kart) | keyed | `…#n` | kwota planu schodzi w haku `settle` transakcji zapisu (i tylko przy zmianach), razem z dziennikiem → brak drugiego zapisu, drugiej kwoty, drugiego undo (zapis narzędziem nie robi migawki undo) |
| `mark_meal_eaten`, `check_shopping_items` | natural | `…#n` | ustawienie wartości; dziennik po wykonaniu. Pad między commitem a dziennikiem → próba 2 ustawia TĘ SAMĄ wartość jeszcze raz (drugi broadcast, bez drugiego efektu) |

Odmowy narzędzi z kluczem `…#n` też trafiają do dziennika, żeby n-te wywołanie w
próbie 2 dostało tę samą odmowę, a nie wykonało się jako „pierwsze udane". Nieudana
karta nie zajmuje klucza `card`.

Testy „SIDE EFFECT COMMITTED → crash → recovery → brak drugiego efektu" (e2e, prawdziwy
restart): #7 propozycja, #8 notatka, #8b zapis planu z kwotą, #14 `suggest_meals`,
#15 `build_meal_plan`.

## 13. Idempotencja odpowiedzi

Odpowiedź asystenta ma `outputKey = 'final'`; unikat `(turnId, outputKey)`. DONE,
odpowiedź, karta, przypięcie propozycji i zwrot przy suficie — jedna transakcja z
fencingiem. Konflikt na kluczu (odpowiedź już jest) → `closeOnExistingAnswer`: DONE i
przypięcie propozycji bez nowej wiadomości (e2e #9). Jedna tura = jedna odpowiedź
(legalnie nigdy nie było więcej).

## 14. Shutdown

SIGTERM: `draining` → worker nie przejmuje nowych tur (także `kick`); **przyjmowanie
wiadomości trwa** (tura jest trwała — wcześniej 503 `AI_UPSTREAM_PAUSED`, teraz 202 i
wykona ją nowa instancja); biegnące mają `AI_SHUTDOWN_GRACE_MS`; niedokończone —
przerwanie z `ABORT_REASON_SHUTDOWN`, księga, **zwolnienie lease** (bez FAILED) → nowa
instancja przejmuje od razu (e2e #18). Bez `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` > 0
proces dostaje SIGKILL od razu — wtedy przejęcie po wygaśnięciu lease (≤30 s + ≤3 s
odpytywania, ESTIMATE). Wartość zmiennej zostaje osobną decyzją produkcyjną (§ decyzje).

## 15. Metryki

`/ops/metrics` → `agent.jobs` (styl istniejących sekcji; te same zdarzenia do Sentry
`scoffie.agent.job.*`):

| Polecenie | Pole | Rodzaj |
|---|---|---|
| agent_turn_jobs_ready | `jobs.ready` | gauge z bazy (sprzątanie co minutę) |
| agent_turn_jobs_claimed | `jobs.claimed` | gauge z bazy (żywy lease) |
| agent_turn_jobs_running | `jobs.running` | gauge — tury w biegu w tym procesie |
| agent_turn_jobs_recovered | `jobs.recovered` | licznik — przejęcia z `attempt > 1` |
| agent_turn_job_attempts | `jobs.attempts` | licznik — każde przejęcie |
| agent_turn_lease_lost | `jobs.leaseLost` | licznik |
| agent_turn_jobs_failed | `jobs.failed` | licznik — domknięte przez sprzątanie (próby, stare) |
| agent_turn_jobs_cancelled | `jobs.cancelled` | licznik — „Stop" bez workera |

„Czy ta tura była odzyskana?": `AgentTurn.attempt > 1` (+ `AiUsage.attempt`), log
`turn <id>: przejęta po utracie procesu (próba N/M, poprzedni właściciel …)` — bez
treści użytkownika.

## 16. Testy restartu

| Komenda | Wynik |
|---|---|
| `pnpm test` | **192/192 suites, 3468/3468** (MEASURED) |
| `pnpm typecheck` / `pnpm lint:check` / `pnpm openapi:check` | OK / 0 błędów (42 ostrzeżenia sprzed etapu) / OK (kontrakt bez zmian) |
| `test/durable-turns.e2e-spec.ts` | **17/17** (MEASURED) |
| regresja e2e asystenta (agent, accounting, thinning, tools, card-state, choice-portions, catalog-boundary, meal-planner, per-user-portions, hot-paths, apply-week-plan, account-deletion, data-export) | zielone |
| pełne e2e | patrz §16a |

Mapa testów obowiązkowych (§5.17) → `test/durable-turns.e2e-spec.ts`:
1 → #1; 2 → #2; 3 → #3; 4/5/6 → #4; 7 → #7; 8 → #8 (+ #8b zapis planu); 9 → #9;
10 → #10; 11 → #4; 12 → #12; 13 → #13; 14 → #14; 15 → #15; 16 → #13 + #16;
17 → #17; 18 → #18. Reguły czyste: `src/agent/durable/durable-turns.spec.ts`,
`agent-turn-sweeper.service.spec.ts`, `agent-turns.service.spec.ts`.

**Prawdziwy restart (§5.18):** „proces" = osobna instancja CAŁEJ aplikacji Nest
(`AppModule`: własny runner, worker, mapy w pamięci, pula połączeń) na tej samej bazie.
Pad = `vanishForTests()` + zatrzymany worker: tura przerywa się bez ani jednego zapisu.
Druga instancja nie ma w pamięci nic z pierwszej. Wynik #4: próba 1 zapisała koszt
jednego wywołania i padła; NOWA instancja przy starcie przejęła turę (`attempt = 2`,
`leaseOwner` = jej id), dokończyła DONE z jedną odpowiedzią, bez `errorCode`; księga ma
wszystkie 3 realne wywołania pod rozłącznymi kluczami.

### 16a. Pełne e2e

`pnpm test:e2e` (lokalna baza dev, env jak w CI): **51/54 suites, 608/613 testów**
(MEASURED). Czerwone te same 3 suity co przed etapem (raport 04): `admin-assistant`
(2 testy `profit`), `admin-revenue`, `admin-integrations` — środowisko (lokalne
`FxRate`, klucze), sprawdzone na drzewie bez zmian Etapu 5: te same 2 porażki
`admin-assistant`. `durable-turns.e2e-spec.ts` powtórzony 3× — 17/17 za każdym razem.
Jedyna zmiana w istniejącym e2e: `agent-accounting` › leniwy timeout przesuwa też
`deadlineAt` (termin tury jest teraz trwały, nie `startedAt` + bieżący env).

## 17. Znane granice exactly-once

1. **Wywołania dostawcy** — at-least-once: próba N+1 woła model od nowa (znany,
   zapisany koszt). Wywołanie przerwane padem = UNKNOWN PROVIDER OUTCOME (brak klucza
   idempotencji u dostawcy).
2. **Efekty „z natury"** (`mark_meal_eaten`, `check_shopping_items`): pad między
   commitem a dziennikiem → ta sama wartość ustawiona drugi raz; gdyby w tej przerwie
   domownik zmienił ją ręcznie, próba 2 ustawi ją z powrotem.
3. **Rozbieżność modelu między próbami**: n-te wywołanie narzędzia w próbie 2 dostaje
   wynik n-tego z próby 1, nawet gdy model podał inne wejście (flaga `alreadyDone`) —
   to cena gwarancji „bez drugiego efektu". Model może też w próbie 2 zdecydować o
   innej karcie, jeśli próba 1 nie zdążyła żadnej zapisać.
4. **Push i broadcast WS**: best-effort, poza transakcją — mogą zginąć albo (dla
   broadcastu przy efekcie „z natury") pójść drugi raz.
5. **Zegar**: lease i claim liczy zegar bazy; werdykt sprzątania (Stop/wyczerpane próby)
   — zegar procesu. Rozjazd zegarów może najwyżej wcześniej domknąć turę, która i tak
   miała zostać domknięta; fencing blokuje wtedy zapis starego właściciela.
6. **Konfiguracja asystenta** w próbie N+1 to env z chwili wykonania (model, sufity),
   nie z chwili przyjęcia; tryb propozycji i daty są z przyjęcia (`execution`).
7. **Kontekst odpowiedzi** (`usedContext`) przy szybkim domknięciu z dziennika jest
   pusty (bez budowy promptu).

## 18. Rollback

- **Kod:** stary kod nie czyta nowych kolumn. Tury przyjęte przez nowy kod i
  niedokończone: stary sprzątacz domknie je po minucie ciszy (`AI_PROVIDER_ERROR`) —
  zachowanie sprzed Etapu 5. `outputKey` stary kod zostawia NULL (unikat nie przeszkadza).
  Wiersze `AgentTurnEffect` zostają (kasowane z turą). Nic do ręcznej naprawy.
- **Baza (opcjonalnie, dopiero po cofnięciu kodu):** `DROP TABLE "AgentTurnEffect";
  DROP INDEX "AgentMessage_turnId_outputKey_key", "AgentTurn_status_leaseExpiresAt_idx";
  ALTER TABLE "AgentMessage" DROP COLUMN "outputKey"; ALTER TABLE "AiUsage" DROP COLUMN
  "attempt"; ALTER TABLE "AgentTurn" DROP COLUMN "execution", … "failureDetail";`.
- Nowe zmienne są opcjonalne (`AI_TURN_LEASE_MS`, `AI_TURN_MAX_ATTEMPTS`,
  `AI_TURN_WORKER`, `AI_TURN_WORKER_POLL_MS`, `AI_TURN_WORKER_CONCURRENCY`) — nic do
  ustawienia przed deployem.

## 19. Świadomie niewdrożone

- Redis, BullMQ, Kafka, SQS, osobna usługa, druga instancja, adapter Socket.IO,
  koordynacja cronów (poza zakresem — §5.20).
- Checkpointy rund dostawcy (kierunek A) — patrz §7.
- Backoff między próbami (`nextAttemptAt`) — niepotrzebny: przerwą jest wygaśnięcie
  lease, a pętlę zatrzymuje limit prób.
- Worker jako osobny proces — jedna instancja, `AI_TURN_WORKER=off` pozwala kiedyś
  rozdzielić API i worker bez zmian w kodzie.
- Pomiar pamięci/kosztu CPU odpytywania na prod — jedno zapytanie po indeksie co 3 s
  (ESTIMATE: pomijalne).
- Zmiana modelu, effortu, płatny benchmark, iOS, synchronizacja katalogu, GitHub
  Actions — nietknięte.

## Decyzje potrzebne od Rafała

1. `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (dziś 0): z wartością ≥ `AI_SHUTDOWN_GRACE_MS`
   + 2 s (np. 12) tura w trakcie deployu przechodzi na nową instancję od razu; bez niej
   — po ≤30 s (wygaśnięcie lease). Zmiana na prod tylko po Twoim „tak".
2. Czy `AI_TURN_MAX_ATTEMPTS = 3` i `AI_TURN_LEASE_MS = 30 s` zostają (bez zmian w env =
   te wartości).

## Commity

- `db0e55b` — feat(asystent): trwałe wykonywanie tur — lease, fencing i dziennik efektów
- commit dokumentacji (ten raport, STATE, TASKS, CLAUDE.md) — następny po `db0e55b`
