# Bezpieczna edycja porcji per osoba — raport

Data: 2026-09-27
Gałąź: `feature/plan-portions-safe-editing` z HEAD `fix/plan-portions-write-safety` @ `2a4899b` (PR #209, OPEN,
niezmergowany — ten PR jest ZALEŻNY, baza = `fix/plan-portions-write-safety`, bez cherry-picków). Koniec: commit
tego raportu (SHA w opisie PR). Bez merge'a i deployu. Live Anthropic API: 0 wywołań (stub). Railway, flagi
produkcyjne, GitHub Actions, iOS, N2-1 / catalog sync — nietknięte. Edycja porcji w aplikacji NIE jest odblokowana.
ADR: `docs/adr/plan-portions-safe-editing.md`. Kontrakt klienta: `ios-contract.md` (obok).

## Kolejność integracji

1. #209 (`fix/plan-portions-write-safety` → `develop`) — najpierw; ten PR go nie zawiera w diffie, tylko na nim stoi.
2. Ten PR: po merge'u #209 zmienić bazę na `develop` (diff zostanie ten sam: 19 commitów od `2a4899b`), CI, merge.
3. Deploy backendu (migracja addytywna wchodzi przy starcie przez `prisma-migrate-deploy-safe`).
4. iOS z tokenami i `setPortion` — dopiero wtedy odblokowanie edycji (warunki: `ios-contract.md` §9).

## Problem — FAIL przed / PASS po

`test/plan-portions-safe-editing.e2e-spec.ts`, regresje A–C (commit `9e9d5ff`, kod z `2a4899b`). Tokeny w teście
wysyłane tylko wtedy, gdy odczyt je daje — na starym kodzie test idzie dzisiejszą ścieżką i pokazuje utratę, a nie
odrzucenie nieznanego pola.

| Test                                      | Kolejność                                                                                            | Przed (`2a4899b`)                                                      | Po                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A. dwa pełne zapisy z tego samego odczytu | alokacja 0,8/1,25 → A i B czytają → A: Rafał 1,5 → B (stary odczyt): Asia 1,0 + Rafał 1,25           | `A: OK → B: OK → {rafal 1.25, asia 1}` — zmiana A cofnięta — **FAIL**  | `A: OK → B: PLAN_REVISION_CONFLICT → {asia 0.8, rafal 1.5}` — **PASS**                                         |
| B. nieaktualny pełny stan                 | A czyta tydzień → B dodaje środę i zmienia audytorium wtorku → A: `applyWeekPlan` ze swojego odczytu | `applied=true`; środa usunięta, wtorek z powrotem „Wspólne” — **FAIL** | `applied=false`, `[PLAN_REVISION_CONFLICT]`; środa i audytorium B zostają, poniedziałek nie wchodzi — **PASS** |
| C. porcje dwóch osób                      | A: porcja Rafała, B: porcja Asi — z tego samego odczytu                                              | brak operacji (`setPortion is not a function`) — **FAIL**              | obie `OK` → `{asia 1, rafal 1.5}` — **PASS**                                                                   |

## Rozwiązanie (skrót ADR)

- Jeden monotoniczny licznik `WeeklyPlan.revision` (+1 w każdej transakcji zmieniającej treść tygodnia) i stemple
  `PlanItem.revision` / `PlanItemPortion.revision` = wartość licznika z chwili ostatniej zmiany. Stemple nie wracają
  (usunięcie + odtworzenie = nowy, wyższy stempel), więc nie ma ABA.
- `weeklyPlans:setPortion` — porcja JEDNEJ osoby z tokenem jej porcji; porcje innych osób nietknięte.
- Opcjonalne `expectedRevision` w `upsertWeekSlot` (pozycja; przy zamianie — źródło, w parze z
  `expectedTargetRevision` celu) i `applyWeekPlan` (tydzień — wyłącznie z pełnej, spójnej migawki odczytu).
- Polityki zapisu: `strict` (bez tokenu) / `verified` (zgodny token albo guard propozycji) /
  `no-allocation-changes` (propozycja z `force`) / `authoritative` (undo). `verified`/`authoritative` z haków
  wymagają `guard`; z drutu `verified` powstaje wyłącznie ze zgodnego tokenu — polityka nie jest polem DTO
  (próba = `VALIDATION_ERROR`, test 12).
- Sprawdzenie tokenu i zapis w tej samej transakcji, po `lockWeekForWrite` (który oddaje rewizję odczytaną pod
  zamkiem).

## Gwarancje (sprawdzone testami)

1. Pełny zapis pozycji ze starego tokenu nie cofa zmiany wykonanej po odczycie — także równolegle (test 1, A).
2. Pełny stan tygodnia ze starego tokenu nie usuwa pozycji dodanej po odczycie ani nie cofa zmienionej; nic nie
   wchodzi (B, 9) — także przy równoległych zapisach (1). Warunek: token i wysyłany stan pochodzą z tego samego
   pełnego odczytu — serwer nie rozpozna starej treści pod nowym tokenem, dlatego acki pozycji tokenu tygodnia
   nie niosą (R1; obowiązek klienta w `ios-contract.md` §1.1).
3. Zmiany porcji RÓŻNYCH osób z tego samego odczytu zostają obie (C, 2); tej samej osoby — druga dostaje konflikt (3).
4. Suma ≤ 12 liczona pod zamkiem — równoległe zmiany, które razem ją przekraczają, nie wchodzą obie (4).
5. Zmiana uczestników / zamiana / usunięcie dania unieważnia tokeny starego odczytu (5, 6, 7); zmiana uczestników
   i zamiana wymagają jawnych porcji — bez niejawnego resetu (5, 6).
6. Ponowienie po utraconej odpowiedzi: gdy stan już jest żądanym — sukces `NOOP` bez nowej rewizji; gdy ktoś
   zmienił go później — konflikt, nowsza zmiana zostaje (8).
7. Zastąpienie albo usunięcie alokacji wymaga tokenu (albo guarda propozycji) — bez niego 428 / naruszenie
   `PLAN_REVISION_REQUIRED` (12, poprzednia suita 3/4b/16b).
8. Każda odmowa: cała transakcja wycofana (także przejęcie propozycji w `guard` — nieaktualny token odmawia PRZED
   guardem, test 10), brak broadcastu (gateway spec), brak kwoty planów (poprzednia suita 11–13, 16).
9. Brak wycieku: cudza pozycja = `PLAN_ITEM_NOT_FOUND` bez `details`, nie-członek = `NOT_HOUSEHOLD_MEMBER`;
   `details` konfliktu niesie tylko id i stempel pozycji własnego domu (13).
10. Zmiana składu domu unieważnia tokeny tygodni od bieżącego (11); wiersze sprzed migracji mają ważny token 0 (14).
11. Token w odczycie = token w odpowiedzi zapisu (15).
12. Ochrona z #209 bez zmian: zapis bez `portions` nie kasuje alokacji (KEEP/CONFLICT), preview liczy KEEP,
    `force` nie zmienia ani nie usuwa alokacji — cała poprzednia suita PASS.
13. Odczyt tygodnia to jedna migawka: `plan.revision`, pozycje i porcje z tego samego stanu bazy, także gdy zapis
    zatwierdza się w trakcie odczytu (R1c). Ack pozycji jest spójny, bo czyta go transakcja zapisu pod zamkiem.
14. Zamiana dania z tokenami chroni źródło I cel. Cel zmieniony, powstały po odczycie, usunięty albo odtworzony
    = konflikt przed zapisem: źródło zostaje, cel i lista zakupów bez zmian (R2, R2b).
15. Pełny zapis zmieniający pozycję (także samo audytorium) unieważnia tokeny wszystkich jej porcji. `setPortion`
    — tylko swojej osoby, a prawdziwy NOOP — żadnych (R3, R3b).

## Mapa zapisujących — po zmianie

| Zapisujący                         | Rewizja                                                                | Token                                                                | Pozycja Z alokacją                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `upsertWeekSlot`                   | +1 tydzień, stempel pozycji i WSZYSTKICH jej porcji                    | opcjonalny, pozycja; zamiana: para źródło + cel (`null` = brak celu) | jawne inne porcje: tylko z tokenem; bez porcji: KEEP/CONFLICT (#209)             |
| `upsertWeekSlot` bez różnicy       | brak (nic nie zapisane)                                                | —                                                                    | —                                                                                |
| `applyWeekPlan` (WS, narzędzia AI) | +1 gdy zmiana; zmieniona pozycja = stempel jej i WSZYSTKICH jej porcji | opcjonalny, tydzień (z pełnego odczytu)                              | bez tokenu: zastąpienie/usunięcie = `PLAN_REVISION_REQUIRED`                     |
| apply propozycji                   | +1 gdy zmiana                                                          | — (guard z odciskiem)                                                | bez `force`: `verified`; `force`: `no-allocation-changes`; undo: `authoritative` |
| `setPortion`                       | +1, stempel pozycji i TEJ porcji                                       | wymagany, porcja osoby                                               | — (pozycja BEZ alokacji: `reason:NOT_ALLOCATED`)                                 |
| `removeWeekSlot`, `clearWeekPlan`  | +1 gdy coś usunięto                                                    | brak (jawne usunięcie)                                               | usuwa                                                                            |
| zmiana składu domu                 | +1 każdy tydzień od poniedziałku, stempel wszystkich pozycji i porcji  | —                                                                    | przeliczenie jak dotąd                                                           |
| `setMealEaten`                     | brak                                                                   | —                                                                    | —                                                                                |

## Zmiany kontraktu (addytywne)

- Odczyt: `WeeklyPlanDto.revision`, `PlanItemDto.revision`, `PlanItemPortionDto.revision`.
- Odczyt tygodnia w jednej migawce (REPEATABLE READ) — `plan.revision` opisuje dokładnie zwrócone `items`.
- Acki `upsertWeekSlot` i `setPortion`: tokeny pozycji i jej porcji, BEZ rewizji tygodnia (`planRevision` z pierwszej
  wersji usunięte po review); `setPortion` także `changeKind` (`DETAILS_CHANGED`/`NOOP`).
- Wejście: `UpsertWeekSlotDto.expectedRevision?`, `UpsertWeekSlotDto.expectedTargetRevision?` (liczba albo `null`,
  tylko przy zamianie, w parze ze źródłem), `ApplyWeekPlanDto.expectedRevision?`, nowe `SetPortionDto`.
- Zdarzenie WS `weeklyPlans:setPortion` (52 handlery). Broadcast tylko po zmianie, akcja `UPSERT_SLOT`, bez pusha.
- Kody: `PLAN_REVISION_CONFLICT` (409), `PLAN_REVISION_REQUIRED` (428); `PLAN_PORTIONS_CONFLICT` dostaje
  `details` `reason:NOT_ALLOCATED` / `reason:NOT_IN_AUDIENCE` dla `setPortion`.
- `PlanViolation.dayOfWeek/mealType/recipeId` opcjonalne — brak tylko przy naruszeniu całego tygodnia
  (`index: -1`, `PLAN_REVISION_CONFLICT`).
- `openapi/openapi.json` i `openapi/SOCKET-EVENTS.md` wygenerowane (`pnpm openapi`, `openapi:check` PASS).

Zmiana zachowania dla klientów bez tokenu (świadoma, ADR decyzja 3): zapis, który ZASTĘPUJE jawnie inną alokacją
albo USUWA pozycję z alokacją, dostaje `PLAN_REVISION_REQUIRED` (wcześniej przechodził — „API GAP” z #209).
Dotyczy wyłącznie pozycji, które mają alokację. Do sprawdzenia przed wdrożeniem: czy gałąź iOS
`feature/catalog-sync-per-user-portions` (niekompilowana) wysyła jawne `portions` na istniejącą alokację — jeśli
tak, potrzebuje tokenu (`ios-contract.md` §3–4).

## Migracja, rollout, rollback

- Migracja `20260927120000_plan_revisions`: `ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0` na trzech tabelach.
  Addytywna, bez backfillu, bez przepisywania tabel (Postgres 11+: stała domyślna bez rewrite). `prisma migrate diff`
  (migracje → schema): „No difference detected.”
- Rollout: patrz „Kolejność integracji”. Stary iOS działa bez zmian (nie wysyła tokenów ani `portions`).
- Rollback kodu: stary kod ignoruje kolumny. UWAGA: po wydaniu iOS wysyłającego `expectedRevision` powrót backendu
  do wersji bez tego pola kończy zapisy nowego iOS `VALIDATION_ERROR` (DTO odrzuca nieznane pola) — rollback
  backendu tylko przed wydaniem takiego iOS albo razem z blokadą edycji po stronie iOS (wykrywanie funkcji §8).
- Rollback bazy: nowa migracja korygująca `DROP COLUMN` — nigdy ręczna edycja `_prisma_migrations`.

## Macierz testów i wyniki

Środowisko: Windows, Postgres 17 w Dockerze (`scoffie-db`), Node 24 (CI: 22).

| Zestaw                                                                                       | Wynik                                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/plan-portions-safe-editing.e2e-spec.ts` (A–C + 1–15 + review R1–R3b)                   | 26/26 PASS                                                                                                                                                |
| — mutacja: bez sprawdzania tokenów w `setPortion` i `applyWeekPlan`                          | 11/18 FAIL (testy wykrywają; pierwsza wersja)                                                                                                             |
| — mutacja: bez podbicia rewizji przy odejściu z domu                                         | test 11 FAIL (wykrywa)                                                                                                                                    |
| — mutacja: bez sprawdzenia tokenu celu zamiany                                               | R2, R2b FAIL (wykrywają)                                                                                                                                  |
| `test/plan-portions-write-safety.e2e-spec.ts` + `test/per-user-portions.e2e-spec.ts`         | 35/35 PASS (przepisane na kontrakt tokenów: 3, 4b, 13, 16b, per-user 10; 4b — token celu)                                                                 |
| `test/week-lock-order.e2e-spec.ts`                                                           | 4/4 PASS — szpieg `$transaction` nie liczy już migawkowego odczytu `plan` (REPEATABLE READ) jako próby zapisu (`f6d2212`); kolejność blokad bez zmian     |
| `pnpm test` (unit)                                                                           | 200 suit, 3588/3588 PASS                                                                                                                                  |
| `pnpm test:e2e:ci` na świeżej bazie (`prisma:migrate:deploy`, `connection_limit=9` jak w CI) | 58 suit, 677/677 PASS (204 s); pierwszy bieg po poprawkach: 676/677 — `week-lock-order` liczył odczyt migawkowy jako próbę zapisu, naprawione w `f6d2212` |
| `pnpm typecheck`, `pnpm lint:check`, `pnpm build`, `pnpm openapi:check`                      | PASS                                                                                                                                                      |
| `prisma migrate diff --from-migrations … --to-schema-datamodel …`                            | brak różnic                                                                                                                                               |

Pokrycie macierzy z ADR (numery testów w suicie):
1 pełne zapisy tej samej wersji (sekwencyjnie A, równolegle 1 — upsert i apply) · 2 dwie osoby (C, 2 równolegle) ·
3 ta sama osoba (3, sekwencyjnie i równolegle) · 4 suma w domu trojga (4) · 5 uczestnicy (5) · 6 zamiana i
usunięcie (6) · 7 odtworzenie (7) · 8 ponowienia (8) · 9 pełny plan (B, 9) · 10 apply/force/undo (10 in-process +
poprzednia suita 11–16 przez HTTP propozycji) · 11 zmiana składu (11) · 12 legacy i odmowa bez tokenu (12) ·
13 autoryzacja (13) · 14 migracja (14) · 15 token odczyt = odpowiedź (15).

Przeploty równoległe: osobna transakcja trzyma zamek tygodnia, zapisy ruszają i czekają na nim (potwierdzone w
`pg_stat_activity`, `wait_event_type = 'Lock'`), potem zamek puszcza — bez `sleep`. Kolejność wygranej jest
niedeterministyczna, asercje od niej nie zależą (sprawdzają „dokładnie jeden” i stan zwycięzcy).

## Ograniczenia (świadome)

- `applyWeekPlan` BEZ tokenu nadal usuwa pozycje BEZ alokacji spoza stanu docelowego (kontrakt legacy).
- `removeWeekSlot` / `clearWeekPlan` bez tokenu — jawne usunięcie.
- Pełny zapis pozycji przestemplowuje WSZYSTKIE jej porcje — równoległy `setPortion` ze starszego odczytu dostaje
  konflikt, nawet jeśli dotyczy osoby, której wartość się nie zmieniła (zgrubnie, bezpiecznie).
- Zmiana składu domu unieważnia tokeny wszystkich pozycji tygodni od bieżącego.
- Ponowienie zamiany dania (`replaceRecipeId`) i `applyWeekPlan` po sukcesie = konflikt (bezpieczny, ale nie
  idempotentny) — klient odświeża.
- Serwer nie odróżni starej treści od aktualnej, jeśli klient poda do niej nowy, poprawny token tygodnia —
  ochrona pełnego apply zależy od obowiązku klienta (`ios-contract.md` §1.1). API nie podsuwa już takiego
  tokenu w ackach pozycji.
- Odczyt tygodnia to teraz krótka transakcja REPEATABLE READ (BEGIN/COMMIT wokół tych samych zapytań).
- `upsertWeekSlot` `NOOP` nadal rozgłasza `weekChanged` (zachowanie sprzed zmian, poza zakresem).
- `setMealEaten` nie podbija rewizji.
- Narzędzia AI (bez tokenu) nie zastąpią ani nie usuną alokacji — dostają naruszenie; zmiany alokacji przez
  asystenta idą ścieżką propozycji.
- iOS nieskompilowany i niezmieniany; edycja porcji zablokowana do spełnienia `ios-contract.md` §9.

## OPEN DECISIONS

1. Opcjonalny token dla `removeWeekSlot` / `clearWeekPlan` (dziś jawne usunięcie bez kontroli wersji).
2. Jawna operacja „resetuj do równego podziału” (dziś tylko przez pełne `portions`).
3. Licznik konfliktów (`PLAN_REVISION_*`) w `/ops/metrics` — dziś widoczne tylko w logu odpowiedzi WS.
4. Idempotentne ponowienie `applyWeekPlan` / zamiany dania (klucz operacji) — dziś konflikt.
5. Czy narzędzia AI mają dostać token tygodnia (np. ze snapshotu), żeby planer mógł zastępować alokacje poza
   propozycjami.
6. Czy `upsertWeekSlot` `NOOP` ma przestać rozgłaszać `weekChanged`.
7. Polityka rollbacku po wydaniu iOS z tokenami (np. tymczasowo pobłażliwe DTO).

## Addendum — review patch (2026-09-27)

Trzy uwagi z review. Reproducery w `test/plan-portions-safe-editing.e2e-spec.ts` („review patch — regresje”),
commit `624cd58` (FAIL na `a20b704`). Poprawki:

- `accabfb` — token tygodnia i migawka;
- `ed63d49` — cel zamiany;
- `842f051` — stemple porcji w apply;
- `5c13239` — OpenAPI;
- `f6d2212` — szpieg transakcji w `week-lock-order`;
- commit tego addendum — dokumenty.

Wcześniejsze sprzeczne deklaracje (ack z `planRevision`, „cel zamiany `strict`”, stemple porcji tylko przy zmianie
wartości) poprawione w tym raporcie, ADR i `ios-contract.md`.

### FAIL przed / PASS po

| Test                                                                          | Przed (`a20b704`)                                                                                                                       | Po                                                                                                                                                               |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 — ack pozycji a token starego snapshotu                                    | ack niesie `planRevision=3`; klient wg kontraktu podmienia token snapshotu (1) → pełny apply `applied`, środa B **USUNIĘTA** — **FAIL** | ack bez `planRevision`; apply ze starej kopii → `PLAN_REVISION_CONFLICT`, środa zostaje; pełny odczyt obejmuje B i daje nowy token → apply przechodzi — **PASS** |
| R1b — odpowiedzi w odwrotnej kolejności                                       | PASS (własność stempli)                                                                                                                 | PASS — wyższy stempel wygrywa, starszy token i starszy snapshot = konflikt                                                                                       |
| R1c — spójność odczytu                                                        | zapis zatwierdzony w trakcie odczytu → `revision=1` + środa z rewizji 2 — **FAIL**                                                      | `revision=1`, bez środy (jedna migawka); kolejny odczyt: `revision=2` ze środą — **PASS**                                                                        |
| R2 — cel zamiany zmieniony po odczycie                                        | sam token źródła → `OK`: Y nadpisany (`[rafal]` → `[]`), X usunięty; token celu nieznany (`VALIDATION_ERROR`) — **FAIL**                | sam token źródła → `PLAN_REVISION_REQUIRED`; stary token celu → `PLAN_REVISION_CONFLICT`; X jest, Y i lista zakupów identyczne — **PASS**                        |
| R2b — cel z alokacją / powstały po odczycie / odtworzony / brak celu / legacy | **FAIL** (brak tokenu celu w API)                                                                                                       | konflikt / konflikt / konflikt / `REPLACED` / legacy bez zmian — **PASS**                                                                                        |
| R3 (apply) — jawna lista wszystkich → „Wspólne”, te same porcje               | stemple porcji bez zmian → `setPortion` starym tokenem przechodzi — **FAIL**                                                            | stemple porcji nowe → `PLAN_REVISION_CONFLICT`, dane bez zmian — **PASS**                                                                                        |
| R3 (upsert) — to samo przez `upsertWeekSlot`                                  | PASS (upsert już przestemplowywał)                                                                                                      | PASS — zachowanie ujednolicone                                                                                                                                   |
| R3b — „Wspólne” → lista wszystkich; niezależność `setPortion`                 | PASS                                                                                                                                    | PASS — prawdziwy NOOP (normalizacja), bez nowej rewizji; `setPortion` Asi nie unieważnia tokenu Rafała                                                           |

### Root causes

1. Rewizja tygodnia jechała w ackach pojedynczej pozycji, a `ios-contract.md` kazał nią nadpisywać token lokalnej
   kopii tygodnia. Kopia dostawała token nowszy niż jej treść. Niezależnie od tego `getByHouseholdAndWeek` czytał
   tydzień, pozycje i relacje OSOBNYMI zapytaniami w READ COMMITTED (Prisma `include` — sprawdzone w logu
   Postgresa). Zapis zatwierdzony w trakcie dawał mieszankę stanów.
2. Przy zamianie `expectedRevision` dotyczył tylko źródła; cel (przepis już leżący w slocie) był zapisywany
   polityką `strict` bez kontroli wersji.
3. `applyWeekPlan` przepisywał porcje (i ich stemple) tylko przy zmianie wartości (`portionsChanged`), a
   `upsertWeekSlot` przy każdej zmianie pozycji — zmiana samego audytorium zostawiała stare tokeny porcji.

### Kontrakt tokenów po poprawce

- Token tygodnia = kompletny snapshot. Pochodzi wyłącznie z pełnego odczytu (`getByWeek`, `plan` z
  `applyWeekPlan`), czytanego w jednej migawce (interaktywna transakcja REPEATABLE READ). Jednoelementowy
  `$transaction([...])` Prisma wysyła bez BEGIN — to też sprawdzone w logu.
- Ack pozycji aktualizuje tę pozycję i jej tokeny, a tokenu tygodnia nie niesie. Klientowi nie wolno przypisać
  nowej rewizji staremu snapshotowi. Przed pełnym apply musi mieć kompletny stan odpowiadający `expectedRevision`.
- Odwrotna kolejność: stemple są monotoniczne — klient przyjmuje wyższy, starszy snapshot odrzuca w całości.

### Ochrona zamiany

- `expectedRevision` (źródło, znaczenie bez zmian) i nowe `expectedTargetRevision` (cel albo `null` = brak
  celu) idą parami; jedno bez drugiego → 428 `missing:…`.
- Wszystkie warunki sprawdzane pod zamkiem tygodnia, PRZED usunięciem źródła, w tej samej transakcji co zapis.
- Zgodny token celu czyni cel `verified`.
- Zgodność wstecz: zamiana bez tokenów działa jak dotąd; pole jest nowe i opcjonalne.

### Unieważnianie tokenów porcji

- Każda zmiana pozycji przez pełny zapis (`upsertWeekSlot` / `applyWeekPlan`) przestemplowuje wszystkie jej porcje.
- `setPortion` przestemplowuje tylko porcję swojej osoby.
- NOOP nie przestemplowuje niczego. „Wspólne” → lista wszystkich obecnych domowników jest normalizowana do
  tego samego stanu, więc to NOOP. W bazie jawna lista wszystkich może powstać tylko np. po odejściu domownika
  (R3) — jej zamiana na „Wspólne” jest prawdziwą zmianą.

### Co jest testem backendu, a co nie

R1 i R1b modelują przepływ klienta w teście backendowym. To NIE jest test aplikacji iOS. iOS jest niezmieniony
i nieskompilowany; zgodność aplikacji z §1 kontraktu wymaga testów na macOS (`ios-contract.md` §9).

## Werdykt

**READY FOR REVIEW** — jako PR zależny od #209 (najpierw #209, potem zmiana bazy tego PR na `develop`).
Nie merge'owane, nie wdrożone. Odblokowanie edycji porcji w iOS: dopiero po wdrożeniu backendu i spełnieniu
`ios-contract.md` §9 (w tym kompilacja i testy na macOS — z Windows niewykonalne).
