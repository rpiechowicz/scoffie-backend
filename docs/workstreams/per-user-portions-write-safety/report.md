# Per-user portions — write safety — raport

Data: 2026-09-27.

Gałąź: `fix/per-user-portions-write-safety` z HEAD #212 (`f316f90`).

- Decyzja właściciela: kontynuacja #212, nazewnictwo z #212 (`revision` / `expectedRevision` /
  `PLAN_REVISION_CONFLICT` zamiast `version` / `expectedVersion` / `PLAN_ITEM_CONFLICT`).
- Łańcuch #209 → #212 zaktualizowany o bieżący `develop` (`b77941c`) merge'ami bez force-push: #209 `aa08fcd`,
  #212 `f316f90`.
- PR zależny: baza `feature/plan-portions-safe-editing`.
- Bez merge'a i deployu. Zero live Anthropic API (stub). Railway, flagi (w tym `AI_PLANNER_PER_USER_PORTIONS`),
  GitHub Actions, iOS — nietknięte.

Kolejność integracji:

1. #209 → `develop`;
2. #212 → baza `develop`;
3. ten PR → baza `develop`;
4. deploy backendu (bez nowej migracji — kolumny `revision` wnosi #212);
5. iOS według „iOS contract delta”;
6. dopiero potem decyzja o fladze.

## 1. Mapa ścieżek zapisu

Pełna tabela: `README.md` (ETAP 0, commit `daa6270`) — domena/WS, asystent (11 ścieżek), skład domu, skrypty,
panel. Po tym workstreamie:

| Ścieżka                                                    | Przed (baza #212)                               | Po                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `upsertWeekSlot` legacy                                    | KEEP/CONFLICT (#209)                            | bez zmian                                                               |
| `upsertWeekSlot` z intencją                                | brak intencji                                   | `portionPolicy` PRESERVE / REPLACE / RESET                              |
| zmiana audytorium z alokacją                               | klient musiał podać pełne porcje                | `PRESERVE` — serwer przelicza                                           |
| zamiana dania z alokacją                                   | tylko jawne porcje + tokeny                     | `PRESERVE` (KEEP, para tokenów źródła/celu), `RESET`, `REPLACE`         |
| `applyWeekPlan`                                            | KEEP/CONFLICT/REVISION_REQUIRED                 | + `portionPolicy` per slot; dryRun = podgląd = zapis                    |
| propozycja tygodnia/dnia (model) zamienia danie z alokacją | **alokacja przepadała** (G1)                    | nowe danie przejmuje porcje osób                                        |
| propozycja tygodnia/dnia (model) pomija pozycję z alokacją | **propozycja powstawała, zapis kasował** (G1b)  | odmowa `PLAN_PORTIONS_CONFLICT` (usunięcie tylko `propose_remove_meal`) |
| `propose_swap` / `revise_proposal` / planer (flaga off)    | **alokacja przepadała** (G2, G3)                | przejęcie porcji (KEEP)                                                 |
| nietknięta pozycja z imienną listą wszystkich domowników   | **przepisana** („Wspólne”, nowe stemple — G4)   | nietknięta bit w bit                                                    |
| `scripts/backfill-plan-item-servings.ts`                   | nadpisywał `plannedServings` pozycji z alokacją | pomija je                                                               |

## 2. Reproducery (ETAP 1) — FAIL przed / PASS po

Suita: `test/per-user-portions-write-safety.e2e-spec.ts`.

- Zapisy telefonu A idą przez gateway WS; broadcast łapie szpieg serwera.
- Przeplot „pod zamkiem”: transakcja B trzyma `lockWeekForWrite`, oczekiwanie A potwierdzone w `pg_stat_activity`
  — bez `sleep`.

| Test                                                 | `develop` `b77941c`                                  | baza #212 `f316f90`                    | ta gałąź                                                           |
| ---------------------------------------------------- | ---------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| Race 1 — stary upsert bez `portions`, B pod zamkiem  | **FAIL**: A `OK`, alokacja B skasowana, 2 broadcasty | PASS                                   | PASS: `PLAN_PORTIONS_CONFLICT`, alokacja nietknięta, 0 broadcastów |
| Race 1b — B commit PRZED A (audytorium / stepper)    | **FAIL**: `OK`, alokacja skasowana                   | PASS                                   | PASS                                                               |
| Race 2 — `replaceRecipeId` bez wiedzy o alokacji     | **FAIL**: nowe danie bez porcji                      | PASS                                   | PASS: konflikt, źródło zostaje                                     |
| Race 3 — `applyWeekPlan`, slot bez porcji            | **FAIL**: `applied=true`, porcje skasowane           | PASS                                   | PASS: `applied=false`; bez zmiany — bit w bit                      |
| Race 4 — asystent zmienia INNĄ pozycję               | **FAIL**: alokacja nietkniętej pozycji skasowana     | PASS                                   | PASS (bit w bit)                                                   |
| G1 — propozycja tygodnia zamienia danie z alokacją   | —                                                    | **FAIL** (`{}`)                        | PASS (porcje przejęte)                                             |
| G1b — propozycja tygodnia pomija pozycję z alokacją  | —                                                    | **FAIL** (propozycja powstaje)         | PASS (odmowa)                                                      |
| G2 — `propose_swap`, flaga off                       | —                                                    | **FAIL** (`{}`)                        | PASS                                                               |
| G3 — `revise_proposal`                               | —                                                    | **FAIL** (`{}`)                        | PASS                                                               |
| G4 — imienna lista wszystkich, zmiana innego posiłku | —                                                    | **FAIL** (uczestnicy 2→0, rewizja 1→2) | PASS                                                               |

## 3. Model wersji (ETAP 2) — z #212, bez zmian nazw

- `WeeklyPlan.revision` (monotoniczny licznik tygodnia) i stemple `PlanItem.revision`, `PlanItemPortion.revision`.
  Integer, nie timestamp — deterministyczna równość, brak ABA (odtworzona pozycja ma nowy, wyższy stempel).
- Tokeny:
  - `expectedRevision` — pozycja; przy zamianie: źródło, w parze z `expectedTargetRevision` celu albo `null`;
  - `applyWeekPlan.expectedRevision` — tydzień, wyłącznie z pełnego, spójnego odczytu;
  - `setPortion.expectedRevision` — porcja jednej osoby.
- Konflikt: `PLAN_REVISION_CONFLICT` 409 (nic nie zapisane).
- Brak tokenu przy zastąpieniu/usunięciu alokacji: `PLAN_REVISION_REQUIRED` 428.
- Bez cichego ponowienia operacji użytkownika. Ponowienie tego samego payloadu: `NOOP`, gdy stan już jest żądanym;
  inaczej konflikt.
- Co podbija rewizję: każda zmiana pozycji, audytorium, porcji, `plannedServings`, przepisu (zamiana), usunięcie.
- **„Zjedzone” NIE należy do wersji.** Znacznik jest per osoba (`PlanItemConsumption`) i nie zmienia tego, co
  i ile się gotuje. Gdyby podbijał rewizję, odhaczenie posiłku przez jedną osobę unieważniałoby tokeny edycji porcji
  drugiej — fałszywe konflikty przy najczęstszej operacji w aplikacji.

## 4. Bariera legacy (ETAP 3)

Z #209, sprawdzona ponownie (Race 1–3). Klient bez nowych pól, na pozycji z alokacją:

- zapis identyczny → pozycja nietknięta;
- każda zmiana (audytorium, stepper, zamiana bez porcji, slot `applyWeekPlan` ze zmianą) → 409
  `PLAN_PORTIONS_CONFLICT` / naruszenie. Nigdy `deleteMany portions`.

Decyzja zapada w TEJ SAMEJ transakcji, po `lockWeekForWrite`, na stanie odczytanym pod zamkiem (Race 1: A czekał
na zamek i zobaczył alokację B). Pozycja bez alokacji — jak dotąd (test 3 + 22).

## 5. Semantyka `portions` w DTO (ETAP 4)

`portionPolicy?: 'PRESERVE' | 'REPLACE' | 'RESET'`:

- w `upsertWeekSlot.data`;
- w każdym slocie `applyWeekPlan.data.slots[]`.

| Intencja           | `portions`                              | Pozycja BEZ alokacji | Pozycja Z alokacją                                                                                                                                  |
| ------------------ | --------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| brak pola (legacy) | niepuste = REPLACE, puste/brak = LEGACY | jak dotąd            | identyczny → KEEP; zmiana → `PLAN_PORTIONS_CONFLICT`                                                                                                |
| `PRESERVE`         | zabronione                              | jak dotąd            | zachowaj; audytorium przeliczone na serwerze (§7); `plannedServings` = ceil(Σ); zmiana audytorium/alokacji wymaga tokenu, prawdziwy NOOP nie wymaga |
| `REPLACE`          | wymagane                                | nowa alokacja        | zastąpienie tylko z tokenem (inaczej 428)                                                                                                           |
| `RESET`            | zabronione                              | jak dotąd            | równy podział tylko z tokenem (inaczej 428); `plannedServings` zachowane (regula ręcznej liczby)                                                    |

Błędy:

- sprzeczny kształt (REPLACE bez porcji, PRESERVE/RESET z porcjami) → `VALIDATION_ERROR` przed transakcją;
- PRESERVE z `plannedServings` innym niż ceil(Σ) albo z sumą > 12 → `PLAN_PORTIONS_INVALID`.

Jedna funkcja (`planPortionsForExisting`) liczy decyzję i docelową alokację dla zapisu, `dryRun` i podglądu
propozycji.

## 6. `setPortion` (ETAP 5)

Z #212: `weeklyPlans:setPortion { planItemId, userId, servings, expectedRevision }`.

- Wykonanie: zamek → członkostwo → pozycja tego tygodnia tego domu → token porcji TEJ osoby → walidacja
  audytorium i sumy → zapis jednego `PlanItemPortion` → `plannedServings = ceil(Σ)` → rewizja → lista zakupów
  „stale” → broadcast → pełna pozycja w acku.
- Semantyka tokenu (decyzja udokumentowana w ADR #212):
  - token jest per osoba — zmiany RÓŻNYCH osób nie kolidują (test 9+10: obie zostają, bez CAS całej mapy);
  - zmiany TEJ SAMEJ osoby: dokładnie jedna wchodzi, druga `PLAN_REVISION_CONFLICT`. Nie ma
    niedeterministycznego cichego nadpisania.

## 7. Zmiana audytorium (ETAP 6)

`PRESERVE` przy nowym `participantIds` (serwer, `remapPortions`, pod zamkiem):

- zostający — swoja porcja;
- nowi — 1,00;
- usunięci — alokacja znika;
- `plannedServings = ceil(Σ)`.

Test 11+12: „Wspólne” w domu trojga dodaje Olę z 1,00 (Σ 3,2 → `plannedServings` 4), zawężenie do [Asia, Ola]
usuwa Rafała (2). iOS nie rekonstruuje mapy.

## 8. Zamiana przepisu (ETAP 7)

`upsertWeekSlot` + `replaceRecipeId`:

- `PRESERVE` (= KEEP): porcje osób ze źródła przechodzą na nowe danie, przeliczone na jego audytorium. Tokeny
  wymagane parą: `expectedRevision` źródła i `expectedTargetRevision` celu (`null`, jeśli celu nie było).
- `RESET`: równy podział; wymaga tokenu źródła.
- `REPLACE`: jawne porcje nowego dania (jak w #212).
- Brak polityki (legacy), źródło z alokacją, bez porcji → `PLAN_PORTIONS_CONFLICT`.
- Cel już w slocie z alokacją: przeniesione porcje zastępują alokację celu — tylko ze zgodnym
  `expectedTargetRevision`.
- **PLANNER — nie wprowadzony do kontraktu WS (OPEN DECISION 2):**
  - planer żyje w module asystenta (`AgentMealPlannerService` zależy od `WeeklyPlansService` — odwrotna zależność
    to cykl modułów);
  - działa wyłącznie przy `AI_PLANNER_PER_USER_PORTIONS=true`;
  - zamiany przez asystenta już używają planera (`portionsForChoice` → jawne porcje = REPLACE w propozycji);
  - ręczna zamiana w iOS ma KEEP i RESET.

## 9. `applyWeekPlan` (ETAP 8)

- Stan docelowy z `portionPolicy` per slot, ta sama decyzja co `upsertWeekSlot`.
- Konflikty jako naruszenia: `PLAN_PORTIONS_CONFLICT`, `PLAN_REVISION_REQUIRED`, `PLAN_REVISION_CONFLICT`
  (tydzień, `index: -1`), `PLAN_PORTIONS_INVALID`; `applied: false`.
- Zero częściowego zapisu: odmowa rzucana w transakcji SERIALIZABLE, wycofanie całości.
- Test 15+16:
  - dryRun i zapis dają te same naruszenia dla tego samego stanu (4 przypadki: legacy zmiana audytorium, RESET bez
    tokenu, PRESERVE ze sprzecznym `plannedServings`, usunięcie bez tokenu);
  - PRESERVE per slot przelicza alokację.
- Żądany zbiór osób równy zapisanemu nie zmienia reprezentacji audytorium (`settleParticipants`). Jawne `[]`
  przy zapisanej liście nadal jest zmianą — „Wspólne” obejmuje przyszłych domowników, lista nie.

## 10. Asystent (ETAP 9)

`prepareProposalSlots` (`src/agent/proposals/proposal-portions.ts`) — deterministycznie, na migawce tygodnia, bez
udziału modelu. Stosowane w propozycji tygodnia, dnia (więc też revise i planer), swap i podziale domu:

- pozycja z alokacją powtórzona bez porcji → `PRESERVE` (nigdy równy podział);
- nowe danie w tym samym dniu i posiłku, w którym znika pozycja z alokacją → przejmuje porcje osób (KEEP);
- stan ułożony przez model (`propose_week_plan` / `propose_day_plan`), w którym pozycja z alokacją znika bez
  następcy → odmowa `PLAN_PORTIONS_CONFLICT`, z komunikatem dla modelu (`propose_swap` /
  `propose_remove_meal`);
- migawki tygodnia powtarzane przez swap/remove/split zostają bit w bit (G4, test 18).

Model niczego nie liczy ani nie kopiuje; `toSlots` bez zmian. Cofnięcie przywraca dokładnie (test 19: po zamianie
dania z przejęciem porcji „Cofnij” przywraca pierwotne danie z alokacją 0,9/1,3). Apply propozycji: `verified`
(guard z odciskiem), `force`: `no-allocation-changes` — bez zmian z #209/#212.

Bezpośrednie narzędzie `apply_week_plan` (tryb bez kart, `strict`, bez tokenu):

- nie zmienia ani nie usuwa alokacji — konflikt, jak dotąd;
- zmiana na #209 test 14: PROPOZYCJA zmieniająca audytorium pozycji z alokacją już nie odmawia, tylko przelicza
  alokację (PRESERVE) — karta pokazuje wynik, zapis przez guard.

## 11. Dowód współbieżności

- Każda ścieżka zapisu pozycji/porcji bierze `lockWeekForWrite` (albo `lockWeeksForWriteFrom`) jako PIERWSZĄ
  blokadę. Decyzja o porcjach i tokenach zapada po zamku, na stanie odczytanym w tej samej transakcji:
  - READ COMMITTED: kolejne zapytania widzą stan po zatwierdzeniu poprzednika;
  - SERIALIZABLE (`applyWeekPlan`): P2034 → ponowienie od nowa.
    Dwa zapisy tego samego tygodnia są więc szeregowane, a drugi liczy na stanie po pierwszym.
- Race 1 dowodzi tego dla najgorszego przypadku: A czyta przed B, B zatwierdza w trakcie oczekiwania A → A widzi
  alokację B → konflikt, zero zapisu i broadcastu.
- `setPortion` różnych osób: oba pod zamkiem, drugi widzi porcję pierwszego i zapisuje tylko swoją (test 9+10);
  suma > 12 wykrywana pod zamkiem (#212 test 4).
- Odczyt tygodnia to jedna migawka (REPEATABLE READ, #212) — token opisuje dokładnie zwrócony stan.
- Ograniczenie: gwarancja dotyczy ścieżek przez `WeeklyPlansService`, `plan-roster.util`, `setPortion`. Ręczny SQL
  i skrypty administracyjne (`import-recipes-from-json` z `CLEAR_EXISTING`, `reset-accounts`) są poza nią.

## 12. Testy

| Zestaw                                                                              | Wynik                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/per-user-portions-write-safety.e2e-spec.ts` (Race 1–4, G1–G4, macierz 1–22)   | 23/23 PASS                                                                                                                                                                                                                                      |
| — ta sama suita (Race 1–4) na `develop` `b77941c`                                   | 6/6 FAIL (reproducery)                                                                                                                                                                                                                          |
| — mutacja: `prepareProposalSlots` wyłączony                                         | G1, G1b, G2, G3 FAIL (wykrywa)                                                                                                                                                                                                                  |
| — mutacja: PRESERVE bez przeliczenia audytorium                                     | 4, 7+8, 11+12, 15+16, 20+21 FAIL (wykrywa)                                                                                                                                                                                                      |
| `src/weekly-plans/utils/plan-portions.util.spec.ts` (intencja, remap)               | 25/25                                                                                                                                                                                                                                           |
| `src/agent/proposals/proposal-portions.spec.ts`                                     | 5/5                                                                                                                                                                                                                                             |
| portions/plan/proposal/planner/zakupy/bilans/lock e2e                               | 180/180 (per-user-portions, plan-portions-safe-editing, plan-portions-write-safety, apply-week-plan, meal-planner, proposal-consistency, agent-choice-portions, agent-card-state, agent-tools, weekly-balance, shopping-units, week-lock-order) |
| `pnpm test` (unit)                                                                  | 203 suity, 3621/3621                                                                                                                                                                                                                            |
| `pnpm test:e2e:ci` (świeża baza: migracje + bootstrap, `connection_limit=9` jak CI) | 59 suit, 700/700 PASS (198 s)                                                                                                                                                                                                                   |
| typecheck / lint:check / build / openapi:check                                      | OK / 0 błędów (42 ostrzeżenia jak na develop) / OK / OK                                                                                                                                                                                         |

Mapowanie listy ETAP 11:

| #     | Wymaganie                          | Test            |
| ----- | ---------------------------------- | --------------- |
| 1     | stale upsert conflict              | Race 1          |
| 2     | sequential stale                   | Race 1b         |
| 3     | legacy bez alokacji                | 3 + 22          |
| 4     | PRESERVE                           | 4               |
| 5     | RESET                              | 5               |
| 6     | REPLACE                            | 6               |
| 7–8   | token zgodny / niezgodny           | 7 + 8           |
| 9–10  | `setPortion` ta sama / różne osoby | 9 + 10          |
| 11–12 | audytorium                         | 11 + 12         |
| 13–14 | zamiana KEEP/RESET                 | 13 + 14         |
| 15    | apply nie gubi                     | Race 3, 15 + 16 |
| 16    | dryRun = apply                     | 15 + 16         |
| 17    | AI zmienia inną pozycję            | Race 4, G4      |
| 18    | revise nietkniętej                 | 18              |
| 19    | undo                               | 19              |
| 20    | zakupy                             | 20 + 21         |
| 21    | bilans                             | 20 + 21         |
| 22    | stary payload bez alokacji         | 3 + 22          |

- Test 20: lista liczy Σ porcji osób — 2,2 → 3,2 po dodaniu osoby, każdy produkt rośnie w tej proporcji. Nie liczy
  zaokrąglonego `plannedServings`; to reguła Etapu 2.2.
- Test 21: bilans dodanej osoby = 1,00 porcji.

## 13. OpenAPI (ETAP 10)

Generator (`typescript-json-schema`) czytał tylko typy, więc `PlanPortionDto.servings` był gołym `number`. Teraz:

- JSDoc `@minimum 0.1 @maximum 6 @multipleOf 0.05` na `PlanPortionDto.servings`, `SetPortionDto.servings` i
  `PortionView.servings` — wejście i odpowiedzi;
- plus `multipleOf` w `@ApiProperty`;
- `portionPolicy` (enum) w `UpsertWeekSlotDto` i `ApplyWeekSlotDto`.

`openapi:check` PASS. Uwaga dla generatorów klientów: `multipleOf: 0.05` na liczbach zmiennoprzecinkowych wymaga
tolerancji (np. Ajv `multipleOfPrecision`). Serwer liczy w jednostkach 1/20 z tolerancją 1e-6.

## 14. Migracja, rollout, rollback

- **Migracja:** brak nowej. Kolumny `revision` wnosi #212 (`20260927120000_plan_revisions`, addytywna, DEFAULT 0).
  Nazwa dzieli prefiks czasu z `20260927120000_agent_message_feedback` z `develop` — kolejność leksykalna
  deterministyczna, świeża baza OK, `prisma migrate diff` bez różnic.
- **Rollout:** patrz kolejność integracji.
  - Stary iOS po wdrożeniu: bez zmian dla pozycji bez alokacji. Dla pozycji z alokacją dostaje konflikty zamiast
    cichej utraty (już od #209).
  - Asystent: propozycje zachowują i przenoszą porcje.
- **Rollback:**
  - Kod ten PR → #212: zapis bez `portionPolicy` działa jak na #212. Nowy iOS wysyłający `portionPolicy` dostałby od
    starszego backendu `VALIDATION_ERROR` (DTO odrzuca nieznane pola). Rollback backendu tylko przed wydaniem iOS
    albo razem z blokadą edycji po stronie iOS (wykrywanie funkcji — delta §16).
  - Baza: nic do cofania.

## 15. Znane ograniczenia

- `removeWeekSlot` / `clearWeekPlan` usuwają pozycję (z alokacją) bez tokenu — jawne usunięcie całego posiłku,
  także przez starego klienta (OPEN DECISION 1).
- Pełny zapis pozycji przestemplowuje wszystkie jej porcje — równoległy `setPortion` ze starszego odczytu dostaje
  konflikt (bezpiecznie, zgrubnie).
- Przejęcie porcji w propozycjach działa w obrębie tego samego dnia i posiłku. Podział domu przejmuje porcje
  tylko dla osób, które miały porcję w znikającym daniu. Przeniesienie dania na inny dzień to usunięcie + nowa
  pozycja — dla modelu odmowa, dla ścieżek serwerowych (swap, planer) nowe danie bez przejęcia.
- `apply_week_plan` (narzędzie bez kart) nie może zmienić pozycji z alokacją ani jej usunąć — tylko propozycje.
- `multipleOf` z liczbami zmiennoprzecinkowymi (§13).
- iOS nieskompilowany i niezmieniany; kontrakt poniżej jest dla osobnego patcha.

## 16. iOS contract delta (na bazie `ios-contract.md` z #212)

**Nowe pole** `portionPolicy` w `weeklyPlans:upsertWeekSlot.data` i w każdym slocie
`weeklyPlans:applyWeekPlan.data.slots[]`:

```json
{
  "householdId": "…",
  "weekStart": "2026-10-05",
  "data": {
    "dayOfWeek": "TUE",
    "mealType": "DINNER",
    "recipeId": "7d4e…",
    "participantIds": ["a1…", "c3…"],
    "portionPolicy": "PRESERVE",
    "expectedRevision": 11
  }
}
```

Mapowanie operacji iOS:

| Operacja w UI                         | Wywołanie                                                                                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zmiana porcji jednej osoby (stepper)  | `setPortion` (bez zmian z #212)                                                                                                                                         |
| zmiana „kto je” na pozycji z alokacją | `upsertWeekSlot` + `participantIds` + `portionPolicy: PRESERVE` + wymagany `expectedRevision` pozycji — BEZ `portions` i BEZ `plannedServings`; nowa osoba dostaje 1,00 |
| zamiana dania, zachowanie porcji      | `upsertWeekSlot` + `replaceRecipeId` + `portionPolicy: PRESERVE` + wymagana para tokenów źródła/celu                                                                    |
| zamiana dania, równy podział          | `portionPolicy: RESET` + `expectedRevision` (źródło) + `expectedTargetRevision`                                                                                         |
| „wróć do równego podziału”            | `portionPolicy: RESET` + `expectedRevision`                                                                                                                             |
| ustaw całą mapę                       | `portionPolicy: REPLACE` + `portions` + `expectedRevision`                                                                                                              |

Nowe odpowiedzi błędów (reszta jak w `ios-contract.md` §6):

| Kod                                             | Kiedy                                                                                               | Co robi klient                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `VALIDATION_ERROR` 400, `details: ["portions"]` | REPLACE bez porcji; PRESERVE/RESET z porcjami                                                       | błąd klienta                                                     |
| `PLAN_PORTIONS_INVALID` 400                     | PRESERVE z `plannedServings` ≠ ceil(Σ); suma po dodaniu osoby > 12                                  | nie wysyłaj `plannedServings` z PRESERVE; przy sumie — komunikat |
| `PLAN_REVISION_REQUIRED` 428                    | RESET/REPLACE lub zmiana audytorium/alokacji PRESERVE bez tokenu; zamiana PRESERVE bez pary tokenów | dołóż tokeny ze świeżego odczytu                                 |

Pozostałe punkty kontraktu:

- **Ack:** pełna pozycja z nowymi `revision` (pozycja i porcje), jak w #212; `changeKind` `NOOP` przy PRESERVE bez
  zmiany.
- **Wykrywanie funkcji:** `plan.revision` w `getByWeek` jest od #212. Ten PR nie dodaje pola odczytu, więc iOS
  nie ma dziś sygnału w odczycie — wykrywa obsługę `portionPolicy` ostrożnie: pierwszy `VALIDATION_ERROR`
  z `details` zawierającym `portionPolicy` = stary backend → blokada edycji. OPEN DECISION 4: jawna flaga funkcji
  w `/me/flags`.
- **Klient legacy** (bez `portionPolicy`): bez zmian — pozycje bez alokacji jak dotąd, z alokacją KEEP/konflikt,
  nigdy cichy reset.
- **Asystent:** karty propozycji pokazują porcje przejęte przez nowe danie. iOS nie musi nic robić poza
  dekodowaniem `portions` w kartach (już jest).

## 17. OPEN DECISIONS

1. Token (albo polityka) dla `removeWeekSlot` / `clearWeekPlan` — dziś jawne usunięcie bez kontroli wersji.
2. Polityka `PLANNER` dla ręcznej zamiany w WS (wymaga wyniesienia logiki porcji planera z modułu asystenta).
3. Przejęcie porcji przy przeniesieniu dania na inny dzień w propozycjach serwerowych.
4. Flaga funkcji dla nowych pól kontraktu (`/me/flags`) zamiast wykrywania po błędzie.
5. Minimalna wersja iOS przed włączeniem `AI_PLANNER_PER_USER_PORTIONS` (stare buildy dostają konflikty przy
   edycji pozycji z alokacją).
6. Metryka konfliktów `PLAN_PORTIONS_*` / `PLAN_REVISION_*` w `/ops/metrics`.

## 18. Odpowiedzi

1. **Czy stary klient może jeszcze skasować nową alokację?**
   - Nie zwykłym zapisem: upsert, zamiana, stepper i `applyWeekPlan` bez nowych pól kończą się KEEP albo
     konfliktem (Race 1–3, na `develop` wszystkie FAIL).
   - Może jedynie usunąć CAŁY posiłek jawnym `removeWeekSlot` / `clearWeekPlan` — alokacja znika razem z nim
     (świadome usunięcie, OPEN DECISION 1).
2. **Czy dwa telefony mogą utracić cudzą zmianę porcji?**
   - Nie. Porcje różnych osób (`setPortion`) — obie zostają. Ta sama osoba — jedna wchodzi, druga dostaje
     konflikt.
   - Pełne zapisy z nieaktualnym tokenem → konflikt. Bez tokenu → nie mogą zastąpić ani zresetować alokacji (428).
     PRESERVE czyta aktualne porcje pod zamkiem, ale zmiana audytorium/alokacji wymaga tokenu; zamiana dania wymaga pary tokenów. Sam odczyt pod zamkiem nie chroni intencji starego klienta.
   - Wyjątki to jawne operacje: usunięcie osoby z audytorium (znika JEJ porcja) i usunięcie posiłku.
3. **Czy AI może zgubić porcje nietkniętej pozycji?**
   - Nie. KEEP albo PRESERVE, identyczne sloty z migawki są no-opem, lista wszystkich domowników nie jest
     przepisywana (G4, Race 4, test 18). Propozycja modelu, która pomija pozycję z alokacją, jest odrzucana (G1b).
   - Zmieniana pozycja przejmuje porcje (G1–G3). Planer z flagą: jawne porcje.
   - Model niczego nie liczy.
4. **Czy można bezpiecznie włączyć `AI_PLANNER_PER_USER_PORTIONS=true` po aktualizacji iOS?**
   - Zapis po stronie backendu tak — po wdrożeniu #209 + #212 + tego PR alokacje są chronione na wszystkich
     ścieżkach.
   - Warunki:
     - iOS z tym kontraktem wydany i sprawdzony na macOS;
     - świadoma decyzja o starszych buildach: z flagą powstaje więcej pozycji z alokacją, a stare buildy przy
       ich edycji dostają konflikty zamiast zapisu (bez utraty danych, ale z błędem w UI) — minimalna wersja
       (OPEN DECISION 5).
   - Flagi nie ruszałem.
5. **Co jeszcze blokuje rollout?**
   - merge #209 → #212 → ten PR (wszystkie niezmergowane) i deploy backendu;
   - patch iOS według §16 plus `ios-contract.md` z #212, kompilacja i testy na macOS (z Windows niewykonalne),
     review App Store;
   - OPEN DECISIONS 1, 4, 5 przed włączeniem flagi.
   - Gałąź iOS `feature/catalog-sync-per-user-portions` (edycja zablokowana, niekompilowana) trzeba przepiąć na ten
     kontrakt.

## SHA

| Commit       | Opis                               |
| ------------ | ---------------------------------- |
| `daa6270`    | mapa ścieżek zapisu (ETAP 0)       |
| `2120a90`    | wyścigi 1–4 i luki G1–G4 (FAIL)    |
| `3793369`    | util intencji i remap              |
| `86c652a`    | `portionPolicy` w upsert/apply     |
| `63b8155`    | porcje w propozycjach liczy serwer |
| `ce93408`    | backfill pomija alokacje           |
| `8a92eb7`    | OpenAPI                            |
| `b07265d`    | macierz 1–22                       |
| (ten commit) | raport                             |

## Werdykt

**READY FOR REVIEW** — PR zależny od #212 (a ten od #209). Nie merge'owane, nie wdrożone. Flaga bez zmian.

## Addendum — ostatni review przed integracją (2026-09-27)

Znaleziono lukę w `PRESERVE`: odczyt bieżącej alokacji pod zamkiem nie chronił
przed przysłaniem starej listy uczestników. Telefon B dodawał osobę, a telefon A
mógł usunąć ją wraz z porcją, wysyłając stary zestaw bez rewizji.

- Dowód przed poprawką: test utila wymagający `REVISION_REQUIRED` dla zmiany
  audytorium FAIL (otrzymywał `WRITE`; 24 pozostałe testy PASS).
- Minimalna poprawka: zmiana audytorium lub alokacji przez `PRESERVE` w trybie
  `strict` wymaga rewizji. Prawdziwy NOOP bez tokenu pozostaje dozwolony.
  Zamiana dania `PRESERVE` wymaga pary tokenów źródła i celu.
- Regresja PostgreSQL: B dodaje trzecią osobę, A wysyła stary stan bez tokenu
  albo ze starym tokenem; odmowa i stan pozycji bez zmian. Obejmuje także
  `applyWeekPlan`, jego `dryRun` i zapis. Istniejące testy poprawnych zmian
  przekazują teraz tokeny wymagane kontraktem.
- Zaktualizowano powyższą instrukcję dla klienta: tokeny nie są już tylko zaleceniem.

Zmierzona regresja lokalna: util 25/25, dedykowane e2e 24/24, pełne unit
3621/3621 (203 suites), pełne e2e 701/701 (59 suites). Typecheck, OpenAPI
i build PASS; lint 0 błędów / 42 ostrzeżenia. Testy na osobnej lokalnej bazie
PostgreSQL po migracjach i bootstrapie; bez live AI. Log e2e zawiera ostrzeżenia
o niedostępnym lokalnym Cookidoo, ale żadnego failing testu. Lokalny Node 24
jest poza deklarowanym zakresem projektu; przed merge wymagane także CI Node 22.

Ryzyko kompatybilności: klient używający nowego `PRESERVE` do zmiany uczestników
lub zamiany dania musi przekazać tokeny ze świeżego odczytu. Legacy bez nowych
pól pozostaje objęte istniejącymi testami. Bez zmian migracji, flag i algorytmu
catalog sync. Commit poprawki identyfikuje historia tego addendum.

## Addendum — krok porcji 0,5 (2026-09-27, decyzja właściciela)

„0,8 porcji to nie jest coś, co ktoś nakłada na talerz” — porcja osoby ma krok **0,5** (0,5 / 1 / 1,5 / … / 6):

- walidacja zapisu (`servingsToUnits`, `portionsProblem`, `SetPortionDto`, `PlanPortionDto`): wielokrotność 0,5,
  widełki 0,5–6; jednostka w bazie bez zmian (1/20 porcji), krok = 10 jednostek;
- planer (`portionFor`): 0,5 / 1 / 1,5 zamiast kroku 0,05;
- migracja `20260928090000_portions_half_step`: istniejące porcje spoza kroku zaokrąglone do najbliższego 0,5
  (połówki w górę, minimum 0,5), `plannedServings = ceil(Σ)` przeliczone, rewizje tygodnia/pozycji/porcji podbite
  (stare tokeny nie przejdą); pozycje już w kroku nietknięte (sprawdzone na bazie testowej);
- OpenAPI: `minimum 0.5`, `multipleOf 0.5` (wejście i odpowiedzi) — §13 wyżej opisuje stan sprzed tej zmiany.

Koszt (zmierzony w teście planera 8): grubszy krok nie zawsze domyka dzień osoby w ±10 % (w scenariuszu testowym
14 %). Gwarancja po zmianie: porcje per osoba nie gorsze od równego podziału tego samego slotu i odchylenie ≤ 20 %.
