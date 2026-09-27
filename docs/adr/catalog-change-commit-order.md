# ADR: kolejność rewizji `CatalogChange` = kolejność commitów

Status: **PRZYJĘTE** (27.09.2026) — workstream N2-1, gałąź `fix/catalog-change-commit-order`
Kontekst: synchronizacja katalogu przyrostowo (Etap 4A, `src/recipes/catalog-sync.service.ts`), przed wydaniem iOS catalog-sync.

## 1. Problem

Log `CatalogChange` wypełniają triggery `AFTER … FOR EACH ROW` na `Recipe` i `RecipeIngredient`
(`20260926200000_catalog_sync_log`). Rewizja to `BIGSERIAL` — numer nadaje `nextval` **w chwili DML**,
a wiersz staje się widoczny **w chwili COMMIT**. Czytelnik (`head()` w `CatalogSyncService` i
`versionKey()` w `AgentCatalogService`) bierze `MAX(revision)` z wierszy widocznych.

Transakcja, która dostała niższy numer, a commituje później, ląduje PONIŻEJ kursora, który klient już
zapisał — delta `revision > C` nigdy jej nie zwróci (tylko pełny snapshot ją naprawi). Tego samego
`MAX(revision)` używa klucz cache katalogu asystenta (przestarzały do 10 min).

## 2. Minimalny reproducer (zmierzony na `develop`, FAIL 3/3)

`test/catalog-change-commit-order.e2e-spec.ts` › „0. RACE”. Zatrzaski (obietnice), bez sleepów:

```
T1: BEGIN;  UPDATE "Recipe" SET title=… WHERE id=A;   -- trigger: INSERT CatalogChange → nextval = 5266 (niewidoczne)
T2:         UPDATE "Recipe" SET title=… WHERE id=B;   -- autocommit: nextval = 5267, COMMIT
klient:     head = MAX(revision) = 5267 → delta (5265, 5267] = {B}; zapisuje C = 5267
T1: COMMIT;                                            -- 5266 widoczne, ale 5266 <= C
klient:     delta (5267, …] = {}                       -- zmiana A zgubiona
```
Log: `A=[5264(utworzenie),5266] B=[5265(utworzenie),5267]; kursor C=5267`.

## 3. Niezmiennik

> Jeżeli klient otrzyma kursor C, żadna transakcja katalogowa, która później stanie się widoczna,
> nie może mieć rewizji <= C.

Równoważnie: w każdym snapshocie zbiór widocznych rewizji jest **domknięty w dół** z dokładnością do
dziur po transakcjach wycofanych (jeśli r widoczna, to każda zatwierdzona r' < r też).

## 4. Porównanie rozwiązań

Sonda `benchmark/catalog-change-commit-order/lock-probe.ts` na świeżych kopiach bazy (warianty
`benchmark/catalog-change-commit-order/variants/*.sql`), 3 powtórzenia każdego scenariusza:
S1 = wyścig z §2; S2 = cykl z polecenia (T1 blokuje A, T2 blokuje B, T1 chce B); S3 = wzorzec panelu
admina (`SELECT … FOR UPDATE` na wierszu przed zmianą — `AdminCatalogService.updateRecipe`).

| Klasa | Wariant | S1 wyścig | S2 cykl | S3 panel | Zmiana API | Blokuje zapisujących |
|---|---|---|---|---|---|---|
| — | dziś (`develop`) | **ZGUBIONA 3/3** | OK | OK | — | nie |
| A | zamek doradczy w triggerze wierszowym (w chwili DML) | OK | **DEADLOCK 3/3** | **DEADLOCK 3/3** | nie | cała transakcja |
| A' | zamek w `BEFORE STATEMENT` | (analiza) | (analiza: jak S3 — wiersz zablokowany wcześniej `SELECT … FOR UPDATE`) | **DEADLOCK** | nie | cała transakcja, także przepisy domów |
| A'' | `LOCK TABLE "CatalogChange"` | (analiza) | cykl jak A | cykl jak A | nie | cała transakcja |
| B | transakcyjny licznik — wiersz singleton pod `FOR UPDATE` | OK | **DEADLOCK 3/3** | **DEADLOCK 3/3** | nie | cała transakcja |
| C | kursor po horyzoncie `xid` (`pg_snapshot_xmin`) | (analiza: poprawny) | brak nowych blokad | brak nowych blokad | **tak** (format kursora) | nie |
| C' | overlap / cofnięcie kursora / znacznik czasu | **niepoprawne** | — | — | tak | nie |
| **D** | **trigger ODROCZONY do COMMIT (constraint trigger) + zamek doradczy dopiero w fazie commitu** | **OK 3/3** | **OK 3/3** | **OK 3/3** | **nie** | **tylko faza commitu transakcji katalogowej** |

### A — globalna serializacja w chwili DML (advisory xact lock / wiersz singleton / LOCK TABLE)

- Zamek zdobywany w triggerze wierszowym — PO blokadzie wiersza, którą właśnie zmieniamy, i po
  wszystkim, co transakcja zrobiła wcześniej. Kolejność rewizji = kolejność commitów (zamek trzymany
  do końca transakcji, widoczność przed zwolnieniem) — S1 OK.
- **Cykl z polecenia jest realny, nie hipotetyczny**: T1 (wiersz A + zamek G) chce wiersz B; T2 trzyma B
  i czeka na G → 40P01 w 3/3 (S2). To samo dla panelu admina: `SELECT … FOR UPDATE` bierze wiersz BEZ
  triggera, zamek G dopiero przy UPDATE (S3, 3/3). Deadlock jest wykrywany (1 s), ale odrzuca zwykłą
  edycję z panelu albo import — w normalnym ruchu.
- `BEFORE STATEMENT`: zamek przed wierszami TEJ instrukcji, ale nie przed blokadami wcześniejszych
  instrukcji tej samej transakcji (`FOR UPDATE` w panelu) → ten sam cykl; do tego trigger instrukcji
  nie zna wierszy, więc serializowałby też zapisy przepisów domów (użytkownicy).
- Latencja: zapisujący katalog czekają przez CAŁĄ transakcję poprzednika (import 500 przepisów).
- **Odrzucone**: łamie wymaganie „bez deadlocku” w typowym przepływie (zmierzone).

### B — transakcyjny licznik `CatalogRevision` (singleton pod blokadą wiersza)

- Semantycznie = A (blokada wiersza zamiast zamka doradczego): rollback cofa numer (brak dziur), ale
  blokada zdobywana w chwili DML → te same cykle (S2/S3: DEADLOCK 3/3). Dodatkowo „gorący” wiersz
  (martwe krotki przy każdym zapisie) i migracja istniejących numerów.
- Licznik zdobywany w fazie commitu = wariant D z blokadą wiersza zamiast zamka — bez zalet wobec D
  (dziury po rollbackach nie szkodzą niezmiennikowi), z kosztem martwych krotek.
- **Odrzucone.**

### C — zmiana protokołu kursora (bez serializacji zapisujących)

- **Horyzont `xid`** (poprawny): kolumna `xid8 DEFAULT pg_current_xact_id()`; czytelnik w JEDNYM
  snapshocie bierze H = `pg_snapshot_xmin(pg_current_snapshot())` — każda transakcja z xid < H jest
  zakończona, więc wiersze z `xid ∈ [kursor, H)` są kompletne; kolejny kursor = H. Brak nowych blokad
  → brak nowych deadlocków.
- **Żywotność (zmierzone)**: H stoi na najstarszej transakcji PISZĄCEJ w CAŁEJ bazie — także
  niezwiązanej. Pomiar: otwarta transakcja z xid 161960 (zwykła tabela tymczasowa) trzymała
  `xmin=161960`, choć 161961 i 161962 zatwierdziły; H ruszył dopiero po jej końcu (161964). Zawieszona
  sesja „idle in transaction” wstrzymałaby synchronizację katalogu dla wszystkich klientów bez limitu.
- Koszt zmiany: nowy format kursora (wersjonowanie, RESET dla starych), nowa kolumna + indeks, zmiana
  obu konsumentów (`head`, `versionKey` — klucz cache nie może być samym H, bo zmienia się przy każdej
  transakcji w bazie).
- **Overlap / cofnięcie kursora o N / „5 s zapasu” / znacznik czasu**: niepoprawne — transakcja może
  trzymać niższy numer (albo wcześniejszy `changedAt`) dowolnie długo (import, zawieszona sesja);
  każdy skończony zapas da się przekroczyć. Wykrywanie dziur: dziura po ROLLBACK i dziura po
  transakcji w toku są nierozróżnialne dla czytelnika → albo zgubienie, albo wieczne czekanie.
- WAL/LSN: pozycja commitu nie jest dostępna w wierszu w chwili zapisu (tylko przez replikację
  logiczną — osobna infrastruktura, której nie mamy).
- **Odrzucone**: C poprawne, ale ryzyko żywotności zależne od całej bazy + zmiana API; C' niepoprawne.

### D — trigger odroczony do COMMIT + zamek doradczy w fazie commitu (WYBRANE)

- Triggery stają się `CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED FOR EACH ROW` z tymi
  samymi funkcjami (ta sama reguła „co logować”), a funkcje przed `INSERT INTO "CatalogChange"` biorą
  `pg_advisory_xact_lock(0x63617473 /* 'cats' */, 1)`.
- Zdarzenia wierszowe są kolejkowane w trakcie transakcji (jak dziś), ale FUNKCJE wykonują się dopiero
  w fazie commitu — po całej logice transakcji. Numer rewizji powstaje więc pod zamkiem, a zamek
  trzymany jest do końca commitu.

## 5. Wybrane rozwiązanie

**D.** Najmniejsza zmiana (jedna migracja: 2 funkcje + 2 triggery), BEZ zmiany API i formatu kursora,
BEZ zmiany kodu czytelnika, pokrywa wszystkie ścieżki zapisu (trigger, nie serwis), a zamek trzymany jest
tylko przez fazę commitu transakcji katalogowej. Wynik sondy: S1/S2/S3 OK 3/3.

### Dowód niezmiennika

1. Każdy numer rewizji nadaje `nextval` wewnątrz funkcji triggera, PO zdobyciu zamka G (zamek
   reentrant w obrębie transakcji). Sekwencji `CatalogChange_revision_seq` nie używa nic innego.
2. Transakcja zdobywa G w fazie commitu i trzyma do jego końca. Postgres oznacza transakcję jako
   zatwierdzoną w ProcArray (widoczność) PRZED zwolnieniem blokad transakcji (`CommitTransaction`:
   `RecordTransactionCommit` → `ProcArrayEndTransaction` → zwolnienie blokad).
3. Przedziały trzymania G przez różne transakcje są rozłączne. Jeśli r' < r i należą do różnych
   transakcji T', T, to T' nadała r' wcześniej, więc T' trzymała G wcześniej, więc T' zakończyła się
   (commit = widoczna albo abort = nigdy) ZANIM T zdobyła G, a więc zanim T nadała r i zanim T stała się
   widoczna.
4. Snapshot S, który widzi T, został zrobiony po końcu T, a więc po końcu T' → jeśli T' zatwierdzona,
   S widzi T'. Czyli zbiór widocznych rewizji jest domknięty w dół (dziury tylko po abortach).
5. `head()` = `MAX(revision)` w snapshocie S1 = H. Każda później widoczna transakcja K ma rewizje > H:
   gdyby miała r <= H, to z (4) byłaby widoczna już w S1 — sprzeczność. **Niezmiennik §3 zachodzi.**
   Stronicowanie delty (`until` ustalone na pierwszej stronie, kolejne strony w nowszych snapshotach)
   i snapshot + delta pozostają poprawne z tego samego powodu (nic <= H nie pojawi się później).

## 6. Deadlock analysis (D)

Deadlock wymaga cyklu w grafie oczekiwań. Nowa krawędź to wyłącznie „czeka na G”.
- Kto czeka na G: transakcja w fazie commitu (funkcja triggera) — może trzymać dowolne blokady wierszy.
- Kto trzyma G: transakcja w fazie commitu, która zdobyła G i dokańcza zdarzenia odroczone. Co robi,
  trzymając G: (a) funkcja `Recipe`: tylko porównanie `OLD/NEW` (bez odczytu tabel) i `INSERT` do
  `CatalogChange`; (b) funkcja `RecipeIngredient`: `SELECT "isCatalog","isActive" FROM "Recipe"`
  (odczyt MVCC — nie bierze blokad wierszy) i `INSERT` do `CatalogChange`. `INSERT` do `CatalogChange`:
  brak FK, klucz z sekwencji (brak konfliktu unikatu), indeks nieunikalny → nie czeka na blokady
  wierszy innych transakcji.
- Posiadacz G **nigdy nie czeka na blokadę WIERSZA** → cykl „wiersz ↔ G” z polecenia jest niemożliwy
  (sonda: S2/S3 OK 3/3; test `8.` w e2e odtwarza wzorzec celowo).
- Jedyna możliwa blokada posiadacza G to blokada TABELI: `RowExclusive` na `CatalogChange`
  (INSERT) i `AccessShare` na `Recipe` (SELECT). Konflikt z nimi mają tylko: `Share`/`ShareRowExclusive`/
  `Exclusive`/`AccessExclusive` na `CatalogChange` oraz `AccessExclusive` na `Recipe` — czyli DDL,
  `LOCK TABLE`, `TRUNCATE`, `CREATE INDEX` (niewspółbieżny) na tych tabelach.
- **Dokładny warunek cyklu z D**: istnieje transakcja X, która (1) zmieniła wiersze katalogu (ma
  zdarzenia odroczone → będzie czekać na G przy commicie) ORAZ (2) trzyma jedną z powyższych blokad
  tabeli, gdy inna transakcja trzyma G. W repozytorium nie ma takiej ścieżki (DDL tylko w migracjach,
  żadna nie zmienia wierszy katalogu w tej samej transakcji co DDL na tych tabelach). Gdyby ktoś to
  zrobił ręcznie, Postgres wykryje cykl (`deadlock_timeout` 1 s) i wycofa CAŁĄ jedną transakcję — bez
  cichej utraty zmiany (wycofane są też jej wiersze logu). Reguła operacyjna w §11.
- `SET CONSTRAINTS ALL IMMEDIATE` wykonałby funkcje w środku transakcji → wraca ryzyko jak w A. W kodzie
  nieużywane (sprawdzone: brak `SET CONSTRAINTS`, brak innych obiektów `DEFERRABLE` w bazie).
- `PREPARE TRANSACTION` (2PC): zdarzenia odroczone odpalają się przy PREPARE, G trzymany do
  `COMMIT PREPARED` — 2PC w projekcie nieużywane (`max_prepared_transactions` domyślnie 0).

## 7. Rollback semantics

- ROLLBACK całej transakcji: zdarzenia odroczone nie wykonują się, G nigdy nie zdobyty, żadnego wiersza
  logu, żaden numer nie zużyty.
- ROLLBACK TO SAVEPOINT: zdarzenia z wycofanej podtransakcji są usuwane z kolejki (tak działa kolejka
  triggerów odroczonych) → brak wpisu dla wycofanych zmian.
- Abort PO nadaniu numerów (np. błąd serializacji w samym commicie): numery zużyte (dziura), wiersze
  niewidoczne na zawsze — dziura nie łamie niezmiennika (brak transakcji, która kiedyś stanie się
  widoczna z tym numerem).

## 8. Wiele zmian w jednej transakcji

Wszystkie zdarzenia transakcji wykonują się w fazie commitu pod JEDNYM zdobyciem G → rewizje jednej
transakcji tworzą ciągły blok (brak przeplotu z innymi). Kolejne zmiany tego samego przepisu = kilka
wierszy logu (jak dziś); czytelnik i tak deduplikuje (`SELECT DISTINCT "recipeId"`). Funkcje czytają
stan w chwili commitu — np. składnik przepisu, który w tej samej transakcji przestał być katalogowy albo
został usunięty, jest oceniany według stanu końcowego (lepsza semantyka niż dziś; delta i tak podaje
stan bieżący przepisu, a nie `kind`).

## 9. Bulk import

`recipes:import:json` pisze przepis po przepisie (każdy nested write = osobna transakcja) → G trzymany
kilka ms na przepis; panel może się przeplatać. `createMany`/`updateMany` w jednej transakcji: wszystkie
zdarzenia w fazie commitu pod jednym G — czas trzymania G rośnie liniowo z liczbą wierszy (pomiar: raport
§Performance). Kolejka zdarzeń odroczonych trzymana w pamięci backendu (jak dziś dla `AFTER ROW` do
końca instrukcji — teraz do końca transakcji).

## 10. Bezpośredni SQL / skrypty

Pokrycie bez zmian: trigger jest na tabelach, więc Prisma, panel, import, loader tagów, skrypty zdjęć i
ręczny SQL przechodzą tę samą drogę. `TRUNCATE` (tylko sonda skali, baza `*_scale`) omija triggery jak
dziś i zmienia epokę.

## 11. Performance

Czytelnik bez zmian. Zapisujący katalog: dodatkowy koszt = zdobycie G w commicie (bez rywalizacji ~µs)
+ oczekiwanie na commit poprzednika (tylko przy równoległych zapisach KATALOGU). Przepisy domów: funkcja
kończy się przed zamkiem (bez zmian kosztu). Zmierzone liczby: raport workstreamu.
Reguła operacyjna: nie łączyć w jednej transakcji DDL/`LOCK TABLE`/`TRUNCATE` na `Recipe`,
`RecipeIngredient`, `CatalogChange` ze zmianami wierszy katalogu.

## 12. Migration

Jedna migracja addytywna w sensie danych: `DROP TRIGGER` ×2, `CREATE OR REPLACE FUNCTION` ×2 (+ zamek),
`CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` ×2. Bez zmian tabel i danych. DDL bierze
`AccessExclusive` na `Recipe`/`RecipeIngredient` na czas migracji (ułamek sekundy; czeka na trwające
transakcje).

## 13. Backward compatibility

API `catalog:snapshot` / `catalog:changes` / `recipes:findAll`, format kursora `<epoka>.<numer>`,
tombstone'y, `RESET_REQUIRED`, `minRevision` — bez zmian. Istniejące kursory pozostają ważne (numeracja
ciągła). Stary kod aplikacji działa z nową migracją (nie czyta triggerów).

## 14. Rollout

Deploy backendu (migracja przy starcie). Brak zależności od klienta. Zalecane PRZED wydaniem iOS
catalog-sync.

## 15. Rollback

Migracja odwrotna (SQL w raporcie): przywrócić funkcje bez zamka i zwykłe triggery `AFTER … FOR EACH
ROW`. Dane logu nie wymagają zmian. Rollback samego kodu aplikacji niepotrzebny (kod się nie zmienia).

## 16. Observability

- W funkcji: czas oczekiwania na G; powyżej 100 ms `RAISE LOG` (log serwera Postgres: tylko liczba ms,
  bez danych przepisu).
- W `/ops/metrics`: `catalogSync.head` (bieżąca rewizja) i `catalogSync.deadlocks` (licznik
  `pg_stat_database.deadlocks` bieżącej bazy) — niskokardynalne, bez identyfikatorów.

## 17. Test matrix

E2E `test/catalog-change-commit-order.e2e-spec.ts`: (0) wyścig z §2; rollback T1; rollback T2;
10 równoległych zapisujących; Recipe + RecipeIngredient w jednej transakcji; usunięcie/tombstone;
bulk `createMany`/`updateMany`; wiele zmian w transakcji (ciągły blok); delta między commitami;
„pruning” (`minRevision`) nie łamie gwarancji; znacznik snapshotu + późniejsza delta; RESET dla
starego kursora; SAVEPOINT; celowy konflikt kolejności blokad (wzorzec z §6) bez 40P01; wykrycie
cyklu przy naruszeniu reguły operacyjnej (DDL + DML katalogu). Istniejące `catalog-sync.e2e` bez zmian.

## 18. Konsekwencje

+ Poprawność bez zmiany protokołu. + Zapis przepisów domów bez zmian. − Zapisy katalogu serializowane w
fazie commitu (koszt zmierzony w raporcie). − Reguła operacyjna dla DDL (§11). − Funkcje czytają stan
przepisu w chwili commitu, nie w chwili DML (świadoma zmiana, §8).
