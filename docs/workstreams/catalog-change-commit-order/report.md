# N2-1 — CatalogChange: commit-safe incremental sync — raport

Data: 2026-09-27
Gałąź: `fix/catalog-change-commit-order` (przygotowana z `develop` z #205/#206/#207; bez merge'a, bez rebase)
ADR: `docs/adr/catalog-change-commit-order.md`
Live Anthropic API: 0 wywołań, $0.00. Railway, iOS, flagi, GitHub Actions — nietknięte.

## Problem

Log `CatalogChange` wypełniają triggery wierszowe na `Recipe` i `RecipeIngredient`. Rewizja to
`BIGSERIAL`: numer nadaje `nextval` w chwili DML, wiersz staje się widoczny w chwili COMMIT. Czytelnik
(`CatalogSyncService.head()` → delta `revision > kursor`, oraz klucz cache `AgentCatalogService.versionKey()`)
bierze `MAX(revision)` z wierszy widocznych. Transakcja z niższym numerem zatwierdzona po transakcji z
wyższym ląduje poniżej kursora, który klient już zapisał — delta nigdy jej nie dowiezie (tylko pełny
snapshot). Na prod dziś: tylko klucz cache asystenta (≤10 min); dla iOS catalog-sync — utrata bez limitu.

## Reproducer (FAIL przed)

`test/catalog-change-commit-order.e2e-spec.ts` › „0. RACE”, zatrzaski zamiast sleepów, commit `dd5c504`.
Na `develop`: **FAIL 3/3**. Dokładna kolejność (numery z logu przebiegu):

```
T1: BEGIN; UPDATE "Recipe" SET title=… WHERE id=A   → trigger: INSERT "CatalogChange" nextval=5266 (niewidoczne)
T2: UPDATE "Recipe" SET title=… WHERE id=B (autocommit) → nextval=5267, COMMIT
klient: head=MAX(revision)=5267 → delta (5265,5267]={B} → kursor C=5267
T1: COMMIT                                           → 5266 widoczne, 5266 <= C
klient: delta (5267,…]={}                            → zmiana A ZGUBIONA
```

## Wybrane rozwiązanie i dlaczego

**D: triggery odroczone do COMMIT + zamek doradczy w fazie commitu** (migracja
`20260927090000_catalog_change_commit_order`, commit `f3d887c`):

- `CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED FOR EACH ROW` na `Recipe` i `RecipeIngredient`
  z tymi samymi regułami „co logować”;
- przed `INSERT INTO "CatalogChange"` funkcje wołają `catalog_change_revision_lock()` =
  `pg_advisory_xact_lock(0x63617473 'cats', 1)` (+ pomiar czekania, `RAISE LOG` >100 ms).

Porównanie (sonda `benchmark/catalog-change-commit-order/lock-probe.ts`, świeże kopie bazy, 3 powtórzenia;
wynik `lock-probe-results.tsv`):

| Klasa                                 | S1 wyścig          | S2 cykl z polecenia | S3 wzorzec panelu (`FOR UPDATE`) | Zmiana API |
| ------------------------------------- | ------------------ | ------------------- | -------------------------------- | ---------- |
| dziś                                  | **ZGUBIONA 3/3**   | OK                  | OK                               | —          |
| A: zamek w triggerze wierszowym       | OK                 | **DEADLOCK 3/3**    | **DEADLOCK 3/3**                 | nie        |
| B: licznik‑singleton pod `FOR UPDATE` | OK                 | **DEADLOCK 3/3**    | **DEADLOCK 3/3**                 | nie        |
| C: kursor po horyzoncie `xid`         | poprawny (analiza) | brak blokad         | brak blokad                      | **tak**    |
| **D**                                 | **OK 3/3**         | **OK 3/3**          | **OK 3/3**                       | **nie**    |

A/B odrzucone — deadlock w zwykłym przepływie panelu admina (zmierzone). C odrzucone — poprawne, ale
**zmierzono**, że horyzont `pg_snapshot_xmin` stoi, gdy DOWOLNA niezwiązana transakcja pisząca jest otwarta
(xid 161960 trzymał `xmin` mimo zatwierdzenia 161961/161962) → zawieszona sesja wstrzymałaby synchronizację
wszystkim; do tego zmiana formatu kursora i obu konsumentów. Overlap / cofnięcie kursora / znacznik czasu —
niepoprawne (każdy skończony zapas da się przekroczyć; dziura po ROLLBACK nieodróżnialna od transakcji w toku).

## Invariant proof

Niezmiennik: _jeżeli klient otrzyma kursor C, żadna transakcja katalogowa, która później stanie się widoczna,
nie może mieć rewizji <= C._

1. Każdy numer powstaje w funkcji triggera PO zdobyciu zamka G; sekwencji nie używa nic innego.
2. Funkcje odroczone wykonują się w fazie commitu; G trzymany do końca transakcji. Postgres najpierw oznacza
   transakcję jako zatwierdzoną w ProcArray (widoczność), potem zwalnia jej blokady.
3. Przedziały trzymania G są rozłączne ⇒ jeśli r' < r (różne transakcje T', T), to T' zakończyła się
   (widoczna albo wycofana) zanim T zdobyła G, czyli zanim T nadała r i zanim stała się widoczna.
4. Snapshot, który widzi T, widzi więc każdą zatwierdzoną T' z niższym numerem — zbiór widocznych rewizji
   jest domknięty w dół (dziury tylko po abortach).
5. `head()` = H = MAX widocznych. Gdyby później widoczna transakcja miała r <= H, z (4) byłaby widoczna już
   przy wyliczaniu H — sprzeczność. Stronicowanie delty (`until` z pierwszej strony) i snapshot + delta:
   nic <= H nie pojawi się później.

Ten sam `MAX(revision)` w kluczu cache asystenta jest teraz poprawny bez zmiany jego kodu.

## Deadlock analysis

- Nowa krawędź oczekiwania: „czeka na G”. Czeka transakcja w fazie commitu (może trzymać blokady wierszy).
- Posiadacz G w fazie commitu robi WYŁĄCZNIE: porównanie `OLD/NEW` (funkcja `Recipe`, bez odczytu tabel),
  `SELECT "isCatalog","isActive" FROM "Recipe"` (funkcja `RecipeIngredient`, odczyt MVCC — bez blokad wierszy)
  i `INSERT` do `CatalogChange` (bez FK, klucz z sekwencji, indeks nieunikalny — bez czekania na wiersze).
  **Posiadacz G nigdy nie czeka na blokadę wiersza** ⇒ cykl „wiersz ↔ G” (cykl z polecenia, wzorzec panelu)
  jest niemożliwy. Test 14 celowo buduje oba wzorce ×3: na D zawsze COMMIT/COMMIT; ten sam test na
  odrzuconym wariancie A pada po ~1 s z `t2: 40P01` (sprawdzone).
- Jedyne blokady posiadacza G to blokady TABEL: `RowExclusive` na `CatalogChange`, `AccessShare` na `Recipe`.
  Cykl z D istnieje **wtedy i tylko wtedy**, gdy transakcja X, która zmieniła wiersze katalogu, trzyma
  ≥`Share` na `CatalogChange` albo `AccessExclusive` na `Recipe` (DDL / `LOCK TABLE` / `TRUNCATE` / zwykłe
  `CREATE INDEX` w tej samej transakcji). W repozytorium brak takiej ścieżki. Przy naruszeniu reguły Postgres
  wykrywa cykl i wycofuje CAŁĄ jedną transakcję (test 15: dokładnie jedno 40P01, druga zatwierdzona i
  dostarczona, wycofana bez wpisu w logu — bez cichej utraty).
- Poza zakresem gwarancji (udokumentowane): `SET CONSTRAINTS … IMMEDIATE` (nieużywane), 2PC (nieużywane).

## Transaction semantics

| Przypadek                                      | Zachowanie                                                                                                       | Test    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------- |
| COMMIT                                         | numery w fazie commitu, pod G, > każdego wcześniej wydanego kursora                                              | 0, 1, 4 |
| ROLLBACK T1 / T2                               | brak wpisu, brak numeru, druga transakcja dostarczona                                                            | 2, 3    |
| SAVEPOINT / ROLLBACK TO                        | zdarzenia wycofanej podtransakcji znikają z kolejki                                                              | 13      |
| kilka przepisów + składnik w jednej transakcji | ciągły blok rewizji (bez przeplotu), całość dostarczona                                                          | 5/8, 4b |
| update + delete                                | tombstone dostarczony po commicie                                                                                | 6       |
| bulk `createMany` 200 + `updateMany`           | wszystkie 200 dostarczone                                                                                        | 7       |
| abort po nadaniu numerów                       | dziura, nigdy widoczna — nie łamie niezmiennika                                                                  | ADR §7  |
| stan odczytywany przez funkcje                 | w chwili commitu (np. składnik przepisu, który w tej samej transakcji przestał być katalogowy) — świadoma zmiana | ADR §8  |

## API compatibility

Bez zmian: `catalog:snapshot`, `catalog:changes`, `recipes:findAll`, format kursora `<epoka>.<numer>`,
tombstone'y, `RESET_REQUIRED` (`UNKNOWN_REVISION`, `REVISION_PRUNED`, `FUTURE_REVISION`), `minRevision`,
kod czytelnika. `openapi:check` OK. Istniejące kursory ważne (numeracja ciągła). Testy 10–12.

## Performance before/after

Benchmark `benchmark/catalog-change-commit-order/write-bench.ts`, świeża kopia bazy (500 przepisów katalogu +
1000 testowych), 3 przebiegi, mediana (ms, o ile nie zaznaczono):

| Pomiar                                                        | Przed                | Po                   | Zmiana      |
| ------------------------------------------------------------- | -------------------- | -------------------- | ----------- |
| `createMany` 1000 przepisów                                   | 195,8                | 199,3                | +2 %        |
| pojedynczy UPDATE p50 / p95                                   | 1,39 / 1,84          | 1,42 / 1,74          | szum        |
| 100 przepisów jedną instrukcją p50                            | 4,40                 | 4,80                 | +9 %        |
| 1000 przepisów jedną instrukcją p50                           | 77,9                 | 80,8                 | +4 %        |
| przepis + 5 składników (jak panel) p50 / p95                  | 3,67 / 4,31          | 3,56 / 4,42          | szum        |
| **10 równoległych zapisujących × 50 UPDATE**: przepustowość   | **3 885 op/s**       | **1 630 op/s**       | **−58 %**   |
| — p50 / p95 / max operacji                                    | 2,21 / 2,89 / 25,1   | 5,37 / 7,45 / 23,8   | +3,2 ms p50 |
| **10 równoległych × transakcje po 20 wierszy**: przepustowość | **52 191 wierszy/s** | **16 397 wierszy/s** | **−69 %**   |
| — p50 / p95 transakcji                                        | 3,38 / 5,22          | 10,99 / 13,68        | +7,6 ms p50 |
| odczyt `head` p50 / p95                                       | 0,39 / 0,50          | 0,37 / 0,50          | bez zmian   |
| odczyt delta (500 rewizji) p50 / p95                          | 0,59 / 0,72          | 0,56 / 0,68          | bez zmian   |
| dziury w logu                                                 | 0                    | 0                    | —           |

Czas czekania na zamek G (zmierzony bezpośrednio, funkcja zapisująca każde oczekiwanie, cały benchmark):
9 500 wywołań; p50 0,002 ms, p95 3,44 ms, p99 5,36 ms, max 10,54 ms; >1 ms: 540, >10 ms: 9 — wszystkie
w fazach 10 równoległych zapisujących KATALOG.

Sonda skali (`catalog:scale-probe --sizes 5000,10000`): kompatybilna; snapshot/delta — identyczne bajty
i liczba zapytań jak w Etapie 4 (±1 zapytanie), czasy w granicach szumu.

**Koszt, wprost:** zapisy KATALOGU są serializowane w fazie commitu. Przy 10 równoległych zapisujących
przepustowość spada o 58–69 %, a pojedyncza operacja czeka średnio +3 do +8 ms. Pojedyncze zapisy, import
(przepis po przepisie), panel i odczyty — bez zmiany. Przepisy gospodarstw nie biorą zamka. Dla Scoffie
(zapisy katalogu = panel admina i import) to koszt pomijalny wobec poprawności.

## Tests

| Komenda                                                                                                                        | Wynik                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `catalog-change-commit-order.e2e` na `develop` (przed)                                                                         | **9 FAIL / 6 PASS** (padają 0, 1, 4, 4b, 5/8, 6, 7, 10, 15; przechodzą rollback/savepoint/protokół/snapshot/brak zamka = brak cyklu) |
| to samo po poprawce                                                                                                            | **16/16**, ×3 bez flaków                                                                                                             |
| test 14 (konflikt blokad) na wariancie A                                                                                       | FAIL `t2: 40P01` (~1 s) — test łapie deadlock                                                                                        |
| istniejące e2e katalogu (catalog-sync, admin-catalog, catalog-export, catalog-visibility, agent-catalog-boundary, recipe-edit) | 51/51                                                                                                                                |
| czysta instalacja 75 migracji + bootstrap                                                                                      | OK, 5 263 wpisy logu, 0 dziur                                                                                                        |
| upgrade `develop` → nowa migracja (baza z danymi)                                                                              | OK                                                                                                                                   |
| procedura awaryjna `rollback.sql` na kopii (referencja DDL migracji korygującej)                                               | triggery wracają do `AFTER … FOR EACH ROW`, reproducer znów FAIL (zgodnie z oczekiwaniem), catalog-sync 10/10                        |
| `prisma migrate diff` (dryf)                                                                                                   | pusta migracja                                                                                                                       |
| `pnpm test`                                                                                                                    | **200/200 suit, 3 554/3 554**                                                                                                        |
| `pnpm test:e2e:ci` (pełne, świeża baza z czystej instalacji)                                                                   | **57/57 suit, 643/643**                                                                                                              |
| typecheck / lint:check / openapi:check / build                                                                                 | OK / 0 błędów (42 ostrzeżenia jak na develop) / OK / OK                                                                              |
| `catalog:scale-probe --sizes 5000,10000`                                                                                       | OK                                                                                                                                   |

## Migration

`prisma/migrations/20260927090000_catalog_change_commit_order/migration.sql`: nowa funkcja
`catalog_change_revision_lock()`, `CREATE OR REPLACE` dwóch funkcji logu (+ wywołanie zamka), `DROP TRIGGER` ×2,
`CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` ×2. Bez zmian tabel i danych. Znacznik
`20260927090000` sortuje się po `20260927000000_durable_agent_turns`. DDL bierze na chwilę `AccessExclusive`
na `Recipe`/`RecipeIngredient` (czeka na trwające transakcje).

## Rollout

Zwykły deploy backendu (migracja przy starcie). Bez zależności od klienta. Zalecane **przed** wydaniem iOS
catalog-sync. Po deployu: `/ops/metrics` → `catalogSync.head` rośnie przy edycji z panelu; w logu Postgresa brak
`catalog_change: czekanie na zamek` powyżej 100 ms. `catalogSync.databaseDeadlocks` to licznik CAŁEJ bazy — jego
wzrost po deployu jest sygnałem do analizy logu Postgresa, ale nie dowodzi, że deadlock wyszedł z `CatalogChange`.

## Rollback

Migracje produkcyjne są **forward-only**. Standardowy rollback po deployu = NOWA migracja korygująca z późniejszym
znacznikiem czasu (przywraca funkcje bez zamka i zwykłe triggery, usuwa `catalog_change_revision_lock()`), wdrożona
zwykłym deployem — Prisma i obiekty bazy zostają zgodne. Wdrożonej `migration.sql` się nie edytuje (suma kontrolna).

`docs/workstreams/catalog-change-commit-order/rollback.sql` (sprawdzony na kopii) to procedura AWARYJNA /
referencyjna: gotowy DDL do migracji korygującej. Ręczne uruchomienie zostawia rozjazd (Prisma: migracja
zastosowana, baza: stare triggery), więc tylko w awarii, a potem i tak wchodzi migracja korygująca. `_prisma_migrations`
nie edytujemy ręcznie. Dane logu bez zmian; rollback kodu aplikacji niepotrzebny (kod czytelnika się nie zmienił;
`/ops/metrics` działa w obu stanach). Po wycofaniu wraca wyścig N2-1.

## Known limitations

1. Zapisy katalogu serializowane w fazie commitu (−58…−69 % przepustowości przy 10 równoległych zapisujących).
2. Reguła operacyjna: nie łączyć DDL / `LOCK TABLE` / `TRUNCATE` na `Recipe`, `RecipeIngredient`,
   `CatalogChange` ze zmianami wierszy katalogu w jednej transakcji — inaczej możliwy (wykrywany) deadlock.
3. `SET CONSTRAINTS … IMMEDIATE` i 2PC łamią założenia analizy (nieużywane w projekcie).
4. Funkcje oceniają stan przepisu w chwili commitu, nie w chwili DML (świadoma zmiana; delta i tak podaje
   stan bieżący).
5. Kolejka zdarzeń odroczonych w pamięci backendu do końca transakcji (bulk w jednej transakcji rośnie
   liniowo — 1 000 wierszy bez zmiany czasu).
6. `TRUNCATE` omija triggery (jak dziś; używa go tylko sonda skali na bazie `*_scale`, zmieniając epokę).

## OPEN DECISIONS

1. Kiedy deploy (przed wydaniem iOS catalog-sync — zalecane jak najwcześniej; prod dziś korzysta z logu tylko
   przez cache asystenta).
2. Czy dodać alert na wzrost `catalogSync.databaseDeadlocks` (panel „Alerty”) — dziś tylko metryka; licznik całej bazy.
3. ~~Czy dopisać regułę z Known limitations #2 do `CLAUDE.md`~~ — dopisana w review patchu (Addendum).
4. Test `it.failing` N2-1 z gałęzi nightly (`test/catalog-sync-concurrency.e2e-spec.ts`) nie trafia do `develop`
   — zastępuje go suita z tej gałęzi (do usunięcia z nightly przy porządkach).

## SHA

| Commit       | Opis                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `dd5c504`    | test: reproducer N2-1 (FAIL na develop)                                                                           |
| `52a8892`    | docs(adr): ADR + sonda porównawcza wariantów (dowody)                                                             |
| `f3d887c`    | fix(catalog): migracja (trigger odroczony + zamek), testy 16 scenariuszy, `/ops/metrics`, rollback SQL, benchmark |
| (ten commit) | docs: raport                                                                                                      |

## Status

**READY FOR REVIEW**

Nie zmergowane do `develop` ani `main`, nie wdrożone.

## Addendum (review patch, 2026-09-27)

Zakres: tylko 3 punkty review. Architektura triggerów, zamek i protokół catalog-sync — bez zmian;
wdrożona `migration.sql` nietknięta (suma kontrolna Prismy).

1. **Rollback = forward-only.** ADR §15, sekcja Rollback wyżej i nagłówek `rollback.sql`: migracje
   produkcyjne są forward-only; zwykłe wycofanie = nowa migracja korygująca z późniejszym znacznikiem;
   `rollback.sql` = procedura awaryjna / referencja DDL, nie standardowy rollback; bez ręcznej edycji
   `_prisma_migrations` (usunięte zdanie „wiersz może zostać”).
2. **`catalogSync.deadlocks` → `catalogSync.databaseDeadlocks`** (`src/observability/ops.controller.ts`, test 16,
   ADR §16, Rollout, OPEN DECISIONS #2). Komentarz: licznik CAŁEJ bazy; wzrost po deployu = sygnał do analizy,
   nie dowód, że deadlock wyszedł z `CatalogChange`. Bez nowych metryk.
3. **Strażnicy założeń.** Reguła w `CLAUDE.md` („Kolejność rewizji `CatalogChange`”: DEFERRABLE INITIALLY
   DEFERRED, brak `SET CONSTRAINTS … IMMEDIATE`, brak DDL/`LOCK TABLE`/`TRUNCATE` na tabelach katalogu w
   transakcji z DML katalogu, bez 2PC); test **17** w `test/catalog-change-commit-order.e2e-spec.ts` czyta
   `pg_trigger` i wymaga `tgdeferrable = tginitdeferred = true` dla `Recipe_catalog_change` i
   `RecipeIngredient_catalog_change`. Sprawdzony mutacją: na kopii bazy po `rollback.sql` test 17 FAIL
   (`tginitdeferred: false` ×2).

| Komenda                                                                              | Wynik                                              |
| ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `catalog-change-commit-order.e2e` + `catalog-sync.e2e`                               | **27/27** (17 + 10)                                |
| test 17 na bazie po `rollback.sql` (mutacja)                                         | FAIL zgodnie z oczekiwaniem                        |
| `pnpm test`                                                                          | **200/200 suit, 3 554/3 554**                      |
| `pnpm test:e2e:ci` (świeża baza: 75 migracji + bootstrap, 5 263 wpisy logu, 0 dziur) | **57/57 suit, 644/644**                            |
| typecheck / lint:check / openapi:check                                               | OK / 0 błędów (42 ostrzeżenia jak na develop) / OK |

Uwaga (poza zakresem, niezmienione): jeden wcześniejszy pełny bieg e2e dał 1 FAIL w
`admin-flags-announcements.e2e` › „tworzenie, lista, duplikat 409, audyt” (odczytany wiersz audytu
`FAILED / duplikat flagi` zamiast `SUCCESS`); kolejny bieg na świeżej bazie — 644/644. Test czyta
`adminAuditLog.findFirst({ where: { action, targetId } })` BEZ `orderBy`, a pasują dwa wiersze (sukces i
odrzucony duplikat); plan to Seq Scan, więc wynik zależy od fizycznego położenia wierszy. Który mechanizm
przestawił wiersze (np. ponowne użycie wolnego miejsca po autovacuum, różne połączenia puli) — nie
udowodnione. Gałąź nie dotyka `src/admin` ani tego testu; poprawka (`orderBy` albo filtr po `result`) —
osobny PR.

SHA review patcha: podany w odpowiedzi (commit zawierający ten Addendum, nad `df82951`).

## Addendum 2 (CI PR #208, 2026-09-27)

CI PR #208: `build-and-test` FAIL — testy 4/9 i 4b timeout 60 s. Przyczyna (odtworzona lokalnie): oba trzymają
10 transakcji otwartych naraz, a czytelnik potrzebuje połączenia z tej samej puli; domyślna pula Prismy to
2 × CPU + 1 — na runnerze CI (4 CPU) `connection_limit=domyślne(9)` (log CI), lokalnie (24 CPU) 49. Dziesiąta
transakcja czekała na połączenie, test na nią. Lokalnie z `connection_limit=9`: te same 2 FAIL.

Poprawka tylko w teście: transakcje `hold()` na osobnym `PrismaClient` z jawnym `connection_limit=12`
(odłączany w `afterAll`). Runtime, migracja, triggery i zamek — bez zmian.

| Komenda (z `connection_limit=9`, jak CI)               | Wynik                                         |
| ------------------------------------------------------ | --------------------------------------------- |
| `catalog-change-commit-order.e2e` + `catalog-sync.e2e` | 27/27                                         |
| `pnpm test:e2e:ci` (świeża baza: migracje + bootstrap) | 57/57 suit, 644/644                           |
| typecheck / lint:check                                 | OK / 0 błędów (42 ostrzeżenia jak na develop) |

## Addendum 3 (aktualizacja względem `develop`, 2026-09-27)

`origin/develop` poszedł do przodu o 9 commitów (`31044a4` → `b77941c`: #210, #213, #214 — asystent: oceny
odpowiedzi, zgłoszenia per wiadomość, karty dnia). Gałąź zaktualizowana MERGE'em `origin/develop` (`08156f4`,
bez rebase i force-push — historia PR bez zmian). Konfliktów tekstowych: 0.

Konflikt logiczny z N2-1: brak.

- `develop` nie dotyka katalogu, `CatalogChange`, triggerów ani `ops.controller`. Zmienia agenta, panel
  asystenta, `CLAUDE.md` (scalone automatycznie) i dodaje 3 migracje.
- Te migracje (`20260927120000_agent_message_feedback`, `…130000_agent_report_per_message`,
  `…180000_agent_message_feedback_note`) dotyczą wyłącznie tabel agenta.
- Kolejność migracji: `20260927090000_catalog_change_commit_order` jest WCZEŚNIEJSZA niż migracje z `develop`.
  Sprawdzone oba przebiegi:
  - świeża baza: wszystkie po kolei;
  - baza z migracjami `develop` już zastosowanymi, jak na środowisku, które dostanie `develop` przed #208:
    `prisma migrate deploy` dokłada `…090000` bez błędu.
- `prisma migrate diff` (migracje → schema): brak różnic.

| Komenda (z `connection_limit=9`, jak CI)               | Wynik                                                   |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `catalog-change-commit-order.e2e`                      | 17/17                                                   |
| `catalog-sync.e2e`                                     | 10/10                                                   |
| `pnpm test` (unit)                                     | 202 suity, 3575/3575                                    |
| `pnpm test:e2e:ci` (świeża baza: migracje + bootstrap) | 57/57 suit, 644/644                                     |
| typecheck / lint:check / openapi:check / build         | OK / 0 błędów (42 ostrzeżenia jak na develop) / OK / OK |

Architektura N2-1 bez zmian. Nie zmergowane.
