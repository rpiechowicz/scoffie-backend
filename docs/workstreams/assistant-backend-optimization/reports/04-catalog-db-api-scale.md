# Raport etapu 04 — Katalog / DB / API pod tysiące przepisów

**Data:** 2026-09-26  
**Status:** DONE (backend). iOS: kod napisany, **kompilacja Xcode DEFERRED / przed rolloutem**  
**Branch:** backend `claude/admin-crm-planning-b0hmgo`; iOS `claude/catalog-sync` (od `origin/develop` 4a1288c, bez merge'a)  
**Zakres z TASKS.md:** Etap 4 (4A–4D) + 4.0 audyt/baseline + 4E probe skali

Oznaczenia: **MEASURED** — zmierzone lokalnie (Docker Postgres 16, jeden proces Node,
świat syntetyczny 300 domów × 4 tygodnie); **CALCULATED** — wyliczone z kodu/pomiaru;
**ESTIMATE** — szacunek. Liczby zapytań są przenośne na prod, czasy — nie.

## 1. Co zostało zrobione

- **4.0 audyt + baseline.** Skrypt `pnpm catalog:scale-probe` zmierzył stary kod
  (commit `00f5a50`) na 5 000 i 10 000 przepisów: pełny katalog przez `recipes:findAll`,
  ścieżki asystenta na turę, popularność, listę zakupów pod współbieżnością, `getTurn`.
  Surowe wyniki: `benchmark/catalog-scale-probe-before.json`.
- **4A synchronizacja katalogu.** Trwały, monotoniczny log `CatalogChange` wypełniany
  TRIGGERAMI Postgresa, rewizja-token `<epoka>.<n>`, snapshot (keyset po `id`,
  znacznik ustalony na 1. stronie) i delta (upserty + tombstone'y, stronami, `until`
  ustalone na 1. stronie), `RESET_REQUIRED` + `snapshotRequired`. Przepisy domów
  i ulubione poza strumieniem — osobne `recipes:householdState`. iOS: koniec sufitu
  40 × 100, lokalna rewizja, snapshot/delta, rewizja zapisywana dopiero po całym
  przebiegu, reconnect = delta.
- **4B cache i zapytania.** Ulubione i przepisy domu nie czyszczą publicznego cache'u;
  odcisk wersji katalogu = jedno zapytanie o głowę logu, raz na turę (`TurnMemo`),
  zamiast `count + max(updatedAt)` × 2 przy każdym wyszukaniu; popularność single-flight;
  strony dań dla kart wsadowo (`cardSides`), z zachowaniem kolejności.
- **4C zakupy / polling / szkic.** Single-flight odczytu nieświeżej listy zakupów,
  szkic tury co ~1 s (pierwszy fragment od razu, domknięcie czeka na ostatni zapis),
  `getTurn` jednym zapytaniem dla tury RUNNING.
- **4D Postgres/Prisma.** Indeks `AgentMessage(turnId)` uzasadniony EXPLAIN-em;
  `Invitation.householdId` i `Recipe.authorId` zbadane i świadomie BEZ indeksu; pula
  i timeouty jawnie opisane i logowane przy starcie, bez zgadywania limitu Railwaya,
  bez zwiększania puli; retry SERIALIZABLE i kolejność blokad bez zmian.
- **4E** — `pnpm catalog:scale-probe` + `benchmark/catalog-scale-probe-after.json`.
- Sprzątanie po Etapie 3: w `reports/03-agent-thinning.md` ryzyko rozwiązane
  w Addendum A1 oznaczone jako rozwiązane.

## 2. Zmiany w kodzie

| Plik / moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `prisma/migrations/20260926200000_catalog_sync_log/` | `CatalogChange`, `CatalogSyncState`, 2 funkcje + 2 triggery, indeks `AgentMessage_turnId_idx` | trwała rewizja katalogu, której nie ominie żadna ścieżka zapisu; seq scan wiadomości tury |
| `prisma/schema.prisma` | modele `CatalogChange`, `CatalogSyncState`, `@@index([turnId])` | jw. |
| `src/recipes/catalog-sync.service.ts` (nowy) | `snapshot`, `changes`, `currentRevision`, parsowanie/format tokenu, powody resetu | kontrakt snapshot/delta |
| `src/recipes/recipes.gateway.ts` | `catalog:snapshot`, `catalog:changes`, `recipes:householdState` (koperty z dekoratorami) | nowe zdarzenia WS |
| `src/recipes/recipes.service.ts` | `recipeListSelect`/`toListItem` wspólne ze snapshotem; `householdState`; `cardSides` (1 bramka + 1 `findMany`, kolejność wejścia); unieważnianie per dom; `setFavorite` bez unieważniania | jeden kształt pozycji w starym i nowym syncu; brak N+1 w kartach; granice cache'u |
| `src/recipes/recipes-cache.service.ts` | `invalidateRecipesList(householdId?)` | zmiana przepisu domu czyści tylko wpisy tego domu |
| `src/agent/search/agent-catalog.service.ts` | `snapshot(memo)` przez `TurnMemo` (`catalog:snapshot`), odcisk = głowa logu, popularność single-flight | odcisk raz na turę; burst popularności = 1 zapytanie |
| `src/agent/agent-prompt.service.ts`, `planner/agent-meal-planner.service.ts` | przekazują `memo` | jw. |
| `src/agent/tools/agent-tool-executor.ts` | `recipeSides(ids)` przez `cardSides`; `searchContext` z `memo` | `offer_options`/`suggest_meals` bez `findById` per danie |
| `src/weekly-plans/services/shopping-list.service.ts` | `snapshotReads` — single-flight odczytu nieświeżej listy (tylko poza transakcją); `markShoppingListStale` zdejmuje wpis | 20 odczytów → 1 przebudowa |
| `src/agent/agent-turn.runner.ts` | `DraftPublisher` (1 s, leading edge, łańcuch zapisów, `settle()`) | szkic: ~23 → ~9 zapisów na 8 s strumienia |
| `src/agent/agent-turns.service.ts` | `loadPolledTurn` — tura + członkostwo jednym `findFirst`; `expireIfStale` doczytuje dom leniwie | polling RUNNING 3 → 1 zapytanie |
| `src/prisma/database-config.ts` (nowy), `prisma.service.ts`, `transaction-runner.util.ts` | odczyt i log puli (`connection_limit`/`pool_timeout`/`connect_timeout` z `DATABASE_URL`); opcjonalne `DB_SERIALIZABLE_TIMEOUT_MS`/`DB_SERIALIZABLE_MAX_WAIT_MS` | jawna konfiguracja bez zgadywania |
| `scripts/scale/scale-world.ts`, `scripts/catalog-scale-probe.ts`, `package.json` | deterministyczny świat skali (tylko baza `*_scale`) i probe | 4E |
| `openapi/*` | regeneracja (51 zdarzeń WS) | kontrakt |
| testy | patrz §4 | |

**Migracja `20260926200000_catalog_sync_log`**
- Wpływ na dane: ADDYTYWNA — nowe tabele, funkcje, triggery, indeks. Istniejące wiersze
  bez zmian; log startuje pusty (rewizja 0) — pierwszy klient dostaje snapshot.
- Koszt przy deployu: `CREATE INDEX` na `AgentMessage` (bez `CONCURRENTLY`, bo Prisma
  migruje w transakcji) — krótka blokada zapisu tabeli; przy dzisiejszym rozmiarze
  prod ułamek sekundy (ESTIMATE, niezmierzone).
- Koszt w biegu: każdy zapis przepisu KATALOGU / jego składnika = +1 wiersz logu
  (INSERT ~60 B). Import 500 przepisów ≈ 5 tys. wierszy (CALCULATED ze świata 10k:
  ~85 tys. wierszy / 10 tys. przepisów). Zapis bez zmiany treści (sam `updatedAt`)
  nie przesuwa rewizji.
- Rollback: `DROP TRIGGER "Recipe_catalog_change" ON "Recipe"; DROP TRIGGER
  "RecipeIngredient_catalog_change" ON "RecipeIngredient"; DROP FUNCTION
  catalog_change_from_recipe(); DROP FUNCTION catalog_change_from_recipe_ingredient();
  DROP TABLE "CatalogChange", "CatalogSyncState";` — indeks `AgentMessage_turnId_idx`
  może zostać. Kod po rollbacku: nowe zdarzenia oddają `SERVICE_UNAVAILABLE`, iOS
  (nowy build) spada do starego `recipes:findAll` bez sufitu.
- Forward-fix / wymuszenie snapshotu u wszystkich: `UPDATE "CatalogSyncState" SET
  "epoch" = gen_random_uuid() WHERE id = 1;` (każda stara rewizja = `UNKNOWN_REVISION`).

## 3. Kontrakty i kompatybilność

### Model synchronizacji (przed / po)

| | Przed | Po |
|---|---|---|
| Pierwsze uruchomienie | `recipes:findAll` po 100, max 40 stron (sufit 4000) | `catalog:snapshot` po 500 do końca |
| Każde połączenie/reconnect | pełne pobranie od nowa | `catalog:changes` od zapisanej rewizji |
| Zmiana jednego przepisu | cały katalog | 1 upsert (~1,9 kB) |
| Wycofanie / usunięcie | niewidoczne do pełnego pobrania | tombstone |
| Przepisy domu, ulubione | w tej samej liście | `recipes:householdState` (osobno) |

### WS (nowe zdarzenia; stare bez zmian)

- `catalog:snapshot {revision?, cursor?, limit?}` → `{mode:'SNAPSHOT', revision, items[], nextCursor}`
  lub `RESET_REQUIRED`. Pierwsza strona bez `revision`; kolejne odsyłają `revision`
  i `nextCursor` z poprzedniej. `limit` 1..500 (domyślnie 200). Tożsamość nie jest
  potrzebna (katalog publiczny), ale socket musi być uwierzytelniony (strict).
- `catalog:changes {sinceRevision, untilRevision?, cursor?, limit?}` →
  `{mode:'DELTA', fromRevision, revision, upserts[], tombstones[], nextCursor}` lub
  `{mode:'RESET_REQUIRED', snapshotRequired:true, revision, reason}`;
  `reason ∈ UNKNOWN_REVISION | REVISION_PRUNED | FUTURE_REVISION`. Klient zapisuje
  `revision` DOPIERO po ostatniej stronie (`nextCursor: null`).
- `recipes:householdState {householdId}` → `{householdId, recipes[] (prywatne, aktywne,
  z isFavorite), favoriteRecipeIds[]}`; bramka członkostwa.
- Pozycja snapshotu/delty = pozycja `recipes:findAll` (wspólne `recipeListSelect` +
  `toListItem`) — iOS dekoduje ją tym samym DTO.

**Spójność.** Snapshot czyta stan bieżący stronami przy ustalonym znaczniku R. Zmiana
w trakcie snapshotu może (ale nie musi) trafić na późniejszą stronę; zawsze trafi do
delty od R (upsert idempotentny, tombstone usuwa także nieznane id) — snapshot(R) +
delta(R→H) = stan H (test 15). Delta to `SELECT DISTINCT recipeId` z (since, until]
+ stan bieżący wierszy: przepis zmieniony 11 razy = 1 pozycja.

- REST / OpenAPI: bez zmian REST; `openapi/SOCKET-EVENTS.md` + `openapi.json`
  zregenerowane (51 zdarzeń klient→serwer), `pnpm openapi:check` zielone.
- iOS: patrz §3.1.
- Zmienne środowiskowe (nowe, opcjonalne, puste = zachowanie bez zmian):
  `DB_SERIALIZABLE_TIMEOUT_MS`, `DB_SERIALIZABLE_MAX_WAIT_MS`. Nic do ustawienia przed deployem.
- Kompatybilność wsteczna: `recipes:findAll` i jego cache bez zmian kształtu — stare
  buildy działają (dalej z własnym sufitem 4000). Starego sync NIE usuwamy w tym
  deployu. Nowy iOS na starym backendzie: `catalog:snapshot` bez acka → pełna lista
  starą drogą bez sufitu (koszt: timeout acka, patrz §7).

### 3.1 iOS — stan

Commit `120b7c7` na `claude/catalog-sync` (wypchnięty, NIE zmergowany):
- `CatalogSyncApplier.swift` (czysty Foundation): `CatalogSyncState` (ids, items,
  revision; `applySnapshot`, `applyDelta`, `invalidateRevision`), `CatalogSyncBuffer`
  (strony zbierane do bufora, stan zmieniany dopiero po ostatniej).
- `RecipeCatalogStore.swift`: cache v13 (katalog + rewizja + przepisy domu + ulubione);
  `reload` = delta (albo snapshot przy braku rewizji / RESET) + stan domu; błąd stanu
  domu nie chowa zsynchronizowanego katalogu; `loadNextPageIfNeeded` — no-op (sufit
  40 × 100 usunięty, nie zamieniony na inny); reconnect = delta; serduszko w toku nie
  cofa się przy przebudowie listy; stary backend → `legacyFullReload` bez sufitu.
- Kolejność: katalog w kolejności `id` (snapshot) — widoki i tak sortują same
  (`RecipesView.swift:171` ranking polecanych), więc kolejność serwera nie jest
  kontraktem.
- `Scripts/catalog-sync-check.sh` + `Scripts/CatalogSync/main.swift` — 13 sprawdzeń
  logiki (5100 bez sufitu, upsert/tombstone, idempotencja, przerwany sync, RESET).
- Sprawdzone na Windows: składnia (tree-sitter, 7 plików, 0 problemów).
- **DEFERRED / przed rolloutem:** build Xcode, `sh Scripts/catalog-sync-check.sh`,
  test na urządzeniu (pierwszy snapshot ~17,5 MB, reconnect = delta), TestFlight.

## 4. Testy

| Test / komenda | Wynik |
|---|---|
| `pnpm test` | **191/191 suites, 3450/3450** (MEASURED 26.09) |
| `pnpm typecheck` | OK |
| `pnpm lint:check` | 0 błędów (42 ostrzeżenia — wszystkie sprzed etapu) |
| `pnpm openapi:check` | OK — 37 REST, 51 WS |
| e2e (`test:e2e:ci`): `catalog-sync`, `hot-paths`, `catalog-visibility`, `agent` | **4/4 suites, 68/68** (po commicie `7816540`) |
| e2e pełne (przed commitem, ten sam kod backendu) | 50/53 suites; 3 czerwone to `admin-assistant`, `admin-revenue`, `admin-integrations` — środowisko (lokalna baza dev ma 8261 wierszy `FxRate`, lokalne klucze), niezwiązane z etapem |
| `python swift_check.py` (tree-sitter) na plikach iOS | 7 plików, 0 problemów |
| `sh Scripts/catalog-sync-check.sh` | **DEFERRED** (wymaga `xcrun swiftc`) |

`test/catalog-sync.e2e-spec.ts` (5 100 przepisów katalogu w bazie), numeracja wg polecenia:

| # | Scenariusz | Test |
|---|---|---|
| 1, 2, 13 | snapshot > 5 100 bez sufitu 4000, bez braków i duplikatów | ✔ |
| 3, 4, 5, 11 | brak zmian → pusta delta (1 zapytanie); zmiana jednego → tylko on | ✔ |
| 6 | wycofanie i twarde usunięcie → tombstone | ✔ |
| 7 | nowy przepis → upsert | ✔ |
| 8 | składnik, tag diety, makra przesuwają rewizję | ✔ |
| 9, 10 | ulubione i przepis GOSPODARSTWA nie przesuwają rewizji | ✔ |
| 12 | nieznana / przyszła / wyczyszczona rewizja → `RESET_REQUIRED` | ✔ |
| 14 | delta stronami (25 zmian po 10) bez braków i duplikatów, `until` stałe | ✔ |
| 15 | zmiana w trakcie snapshotu: znacznik stały, następna delta ją dowozi | ✔ |
| 16 | ta sama delta dwa razy = ten sam stan | ✔ (+ scenariusz w `catalog-sync-check.sh`, DEFERRED) |

Pozostałe nowe: `test/hot-paths.e2e-spec.ts` (20 nieświeżych odczytów → ≤ 1 przebudowa;
`getTurn` RUNNING = 1 zapytanie, 404 po wyjściu z domu; karta 3 dań = jeden odczyt),
`src/recipes/catalog-cache-boundaries.spec.ts`, `src/agent/draft-publisher.spec.ts`,
`src/prisma/database-config.spec.ts`; zaktualizowane spec-i gatewaya, serwisu przepisów,
`AgentCatalogService`, `AgentTurnsService`, inwentarz WS (51).

## 5. Pomiary przed / po

Komendy (baza `scoffie_scale` w lokalnym Dockerze; skrypt odmawia na bazie bez sufiksu `_scale`):

```bash
docker compose exec -T db psql -U scoffie -c "CREATE DATABASE scoffie_scale"   # raz
export SCALE_DATABASE_URL='postgresql://scoffie:scoffie@localhost:5432/scoffie_scale?schema=public' \
  JWT_SECRET=ci-secret REFRESH_TOKEN_PEPPER=ci-pepper OPS_TOKEN=ci-ops-token APNS_ENABLED=false \
  COOKIDOO_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
# przed: na 00f5a50;  po: na 7816540 (drzewo robocze nad 00f5a50 w chwili pomiaru — pole `commit` w JSON)
pnpm catalog:scale-probe --sizes 5000,10000 --out benchmark/catalog-scale-probe-before.json
pnpm catalog:scale-probe --sizes 5000,10000 --out benchmark/catalog-scale-probe-after.json
```

Surowe dane: `benchmark/catalog-scale-probe-before.json`, `benchmark/catalog-scale-probe-after.json`.

### Katalog na telefon (MEASURED)

| Metryka | 5k przed | 5k po | 10k przed | 10k po |
|---|---:|---:|---:|---:|
| pełne pobranie: strony | 51 | 10 | 101 | 20 |
| pełne pobranie: zapytania | 305 | 30 | 605 | 60 |
| pełne pobranie: bajty JSON | 8,84 MB | 8,75 MB | 17,70 MB | 17,51 MB |
| pełne pobranie: gzip stron JSON (ESTIMATE transferu z kompresją; `gzipSync` na stronach) | — | 1,50 MB | — | 3,01 MB |
| pełne pobranie: czas | 931 ms | 511 ms | 2 821 ms | 1 045 ms |
| przepisów widocznych na iOS | 4 000 (sufit) | 5 000 | 4 000 (sufit) | 10 000 |
| reconnect bez zmian | pełne pobranie | 1 zapytanie, 179 B | pełne pobranie (17,7 MB) | 1 zapytanie, 179 B |
| zmiana 1 przepisu | pełne pobranie | 4 zapytania, 1 861 B | pełne pobranie | 4 zapytania, 1 861 B |
| wycofanie 1 przepisu | niewidoczne | 4 zapytania, 217 B (tombstone) | niewidoczne | 4 zapytania, 217 B |

### Gorące ścieżki — zapytania DB na operację, 10k (MEASURED; 5k identycznie ±1–2)

| Ścieżka | Przed | Po | Skąd różnica |
|---|---:|---:|---|
| `offer_options` (3 dania) | 15 | **3** | `cardSides`: 1 bramka + 1 `findMany` zamiast `findById` × 3 |
| `suggest_meals` | 21 | **11** | jw. + odcisk raz na turę |
| `find_recipes` (ciepły) | 9 | **7** | odcisk: 1 zapytanie o głowę logu zamiast 2 agregatów; `TurnMemo` |
| `build_meal_plan` (dzień) | 29 | 27 | odcisk; reszta to planer (świadomie, §8) |
| prompt (ciepły) | 15 | 14 | odcisk przez `TurnMemo` |
| indeks katalogu (zimny) | 5 | 4 | odcisk |
| popularność, 10 równoczesnych | 10 (5k) / 15 (10k) | **1** | single-flight |
| lista zakupów: 20 nieświeżych odczytów | 20 przebudów, 447 zapytań, 463 ms | **1 przebudowa, 110 zapytań, 44 ms** | single-flight (5k: 424 → 82) |
| `getTurn` RUNNING / DONE | 3 / 4 | **1 / 2** | tura + członkostwo jednym `findFirst` |
| szkic tury: zapisy na 8 s strumienia | ~23 (co 350 ms) | ~9 (co 1 s) | CALCULATED, `draft-publisher.spec.ts` |

Odcisk wersji katalogu (EXPLAIN, 10k): przed — `count` + `max(updatedAt)` na `Recipe`
i `RecipeIngredient` = 1,8 ms + 14,3 ms seq scanów PRZY KAŻDYM wyszukaniu; po —
`MAX(revision)` z logu = index-only backward scan 0,058 ms, raz na turę.

## 6. Wydajność bazy / API

### Indeksy (EXPLAIN ANALYZE na `scoffie_scale`: 200 tys. `AgentMessage`, 50 tys. `Invitation`, 10 tys. przepisów, ~85 tys. `CatalogChange`)

| Kandydat | Zapytanie | Przed | Decyzja |
|---|---|---|---|
| `AgentMessage(turnId)` | wiadomości tury (`getTurn` DONE, anulowanie, poprawka pytania) | Parallel Seq Scan 11,456 ms, rośnie z historią WSZYSTKICH rozmów | **DODANY** → Bitmap Index Scan 0,135 ms |
| `Invitation(householdId)` | `revokeOpenInvitationsOf` (wyrzucenie domownika) | Seq Scan 4,0 ms przy 50 tys. | **NIE** — rzadka ścieżka administracyjna; koszt indeksu przy każdym zaproszeniu większy niż zysk |
| `Recipe(authorId)` | przepisy autora | Seq Scan 1,07 ms przy 10 tys. | **NIE** — nie jest na hot path |
| `CatalogChange` | delta `DISTINCT recipeId` w zakresie rewizji | PK range 0,058 ms | PK wystarcza; `(recipeId, revision)` pod przyszłe czyszczenie logu |
| snapshot | strona po `id` z filtrem `isCatalog AND isActive` | PK index scan + filtr 0,44 ms | częściowy indeks niepotrzebny przy tej selektywności |

### Pula i timeouty

- Stan: produkcyjny `DATABASE_URL` (referencja do usługi Postgres) nie ma parametrów
  puli → Prisma bierze `connection_limit = 2 × CPU + 1`, `pool_timeout` 10 s,
  `connect_timeout` 5 s; transakcje interaktywne `timeout` 5 s / `maxWait` 2 s.
- Zmiana: przy starcie log `pula Prisma: connection_limit=…, pool_timeout=…, connect_timeout=…`
  (bez hosta i hasła) — pierwszy deploy pokaże REALNĄ wartość. Uwaga: `os.cpus()`
  w kontenerze może raportować rdzenie hosta, więc domyślna pula bywa większa, niż
  się wydaje. Limitu `max_connections` bazy prod nie znamy z repo — nie wpisaliśmy
  żadnej liczby; puli nie zwiększaliśmy.
- Zalecenie (decyzja §9): po deployu odczytać linię logu i `SHOW max_connections`
  (przez tymczasowy proxy albo `railway ssh`), odjąć połączenia innych usług
  (`catalog-sync`, `db-backup`, panel, sesje ręczne, zapas na migracje), i dopiero
  wtedy ustawić `connection_limit=<N>` w zmiennej `DATABASE_URL` serwisu backendu.
- `DB_SERIALIZABLE_TIMEOUT_MS` / `DB_SERIALIZABLE_MAX_WAIT_MS` — gałka, gdyby legalne
  transakcje planu łapały timeout 5 s; domyślnie puste (zachowanie Prismy).
- `statement_timeout` NIE ustawiony — patrz §8.
- `runSerializable` (retry P2034) i kolejność blokad — bez zmian (`week-lock-order`,
  `agent` e2e zielone).

### Transfer

Snapshot 10k = 17,5 MB JSON (≈ 3,0 MB po gzip stron, ESTIMATE transferu z kompresją) — płacony RAZ na instalację
(i po RESET); każdy następny start to delta rzędu setek bajtów. Przed: 17,7 MB przy
KAŻDYM połączeniu.

## 7. Ryzyka i regresje

- **Pierwszy snapshot po aktualizacji** — każdy telefon z nowym buildem raz ściąga
  cały katalog (dziś ~500 przepisów ≈ 0,9 MB, CALCULATED z 17,5 MB / 10k). Przy 10k
  ≈ 17,5 MB bez kompresji WS.
- **Nowy iOS na starym backendzie** — ack `catalog:snapshot` nie przychodzi; klient
  po timeoucie acka (z retry, ESTIMATE do ~54 s) spada do `recipes:findAll`. Kolejność
  wdrożenia: backend PRZED iOS eliminuje to całkowicie.
- **Zmiana samej tabeli `Ingredient`** (np. nazwa składnika w słowniku) nie jest
  w logu — trigger jest na `Recipe` i `RecipeIngredient`. Loader tagów przelicza
  kolumny przepisu (`Recipe` UPDATE → trigger), więc tagi/alergeny przechodzą; zmiana
  nazwy w słowniku dojedzie do telefonu dopiero po zmianie przepisu albo po podbiciu
  epoki (§2, forward-fix). Indeks asystenta ma dodatkowo sufit 10 min.
- **Log rośnie bez czyszczenia** (~60 B/wiersz; import całego katalogu 500 przepisów
  ≈ 5 tys. wierszy). Mechanizm czyszczenia jest przygotowany (`minRevision` →
  `REVISION_PRUNED` → snapshot), ale bez zadania — na lata to megabajty (ESTIMATE).
- **Single-flight zakupów** działa w obrębie procesu (jedna instancja — dziś prawda);
  przy drugiej instancji każda przebuduje raz (Etap 5).
- **Szkic co 1 s** — telefon widzi tekst modelu w większych porcjach; pierwszy
  fragment idzie od razu, końcówka zawsze dojeżdża przed domknięciem tury.
- `setFavorite` nie czyści już cache'u listy — bezpieczne, bo `isFavorite` dokłada się
  po odczycie z cache'u, a widoki filtrowane po ulubionych cache'u nie używają
  (sprawdzone w kodzie `findAll`).

## 8. Odstępstwa od planu

- **Kompresja transportu (4A)** — NIE włączona. Socket.IO aplikacji ma dziś
  `perMessageDeflate` wyłączone (domyślne engine.io). Włączenie to kontekst zlib per
  socket (pamięć przy każdym połączeniu) dla zysku płaconego raz na instalację;
  wymaga też potwierdzenia po stronie klienta iOS (Mac). Propozycja: `perMessageDeflate:
  { threshold: 16384 }` jako osobna decyzja po pomiarze pamięci.
- **Wspólny słownik facetów (4A)** — bez nowego artefaktu: snapshot niesie te same
  surowe pola co `findAll` (tagi diet, alergeny, pory), facety liczą reguły
  `recipe-facets.util.ts` z parytetem do iOS (bez zmian w tym etapie).
- **`statement_timeout` (4D)** — NIE ustawiony: najdłuższe legalne operacje (import
  katalogu, eksport `catalog-sync`, przeliczenie tagów) nie zostały zmierzone na prod;
  zgadnięta wartość mogłaby je ubić. Do ustawienia rolą w bazie po pomiarze.
- **`build_meal_plan` 27 zapytań** — to planer (plan tygodnia, porcje, bilans osób),
  nie N+1; poza zakresem.
- **Indeksy `Invitation.householdId`, `Recipe.authorId`** — zbadane, odrzucone (§6).
- **LRU cache'u (4B)** — bez zmian; poprawiono klucz i unieważnianie (granice), co
  było warunkiem z TASKS.
- **Czyszczenie logu** — bez zadania cyklicznego (§7).

## 9. Decyzje potrzebne od Rafała

1. **`connection_limit`** — po deployu: linia `pula Prisma:` z logu + `SHOW max_connections`
   → wartość w `DATABASE_URL` (zapis na prod tylko po Twoim „tak”).
2. **Kompresja WS** (`perMessageDeflate` z progiem) — tak/nie, po pomiarze pamięci.
3. **Kolejność rolloutu**: backend (migracja addytywna) → build iOS `claude/catalog-sync`
   po Xcode + `catalog-sync-check.sh` → TestFlight. Stary `recipes:findAll` usuwamy
   dopiero, gdy stare buildy wymrą (osobny deploy).

## 10. Co proponujesz dalej

- Etap 5 (trwałe tury) zgodnie z planem — nie zaczęty.
- Przed rolloutem iOS: build Xcode + `sh Scripts/catalog-sync-check.sh` na Macu.
- Po deployu backendu: odczyt puli z logu (decyzja 1).

## 11. Commity

- `7816540` (backend) — feat(katalog): synchronizacja rewizją, granice cache'u i gorące ścieżki pod 10 tys. przepisów
- `120b7c7` (iOS, `claude/catalog-sync`) — feat(przepisy): synchronizacja katalogu rewizją — snapshot + delta bez sufitu 4000
- commit dokumentacji (ten raport, STATE, TASKS, CLAUDE.md) — następny po `7816540`
