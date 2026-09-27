# Porcje per osoba — ochrona przed niejawną utratą alokacji — raport

Data: 2026-09-27
Gałąź: `fix/plan-portions-write-safety` z `origin/develop` @ `31044a4` (start). Koniec: commit tego raportu
(SHA w opisie PR). Bez merge'a i deployu. Live Anthropic API: 0 wywołań (stub + bezpośredni `AgentToolExecutor`).
Railway, flagi (`AI_PLANNER_PER_USER_PORTIONS`, `AI_EFFORT`), GitHub Actions, iOS i N2-1 — nietknięte.
ADR: `docs/adr/plan-portions-write-safety.md`.

## Root cause

Każdy zapis przepisujący pozycję zastępował CAŁĄ alokację:
- `upsertWeekSlot` robił `portions: { deleteMany: {}, create: toPortionRows(portions) }`, więc brak pola albo `[]`
  kasował alokację;
- `replaceRecipeId` usuwał pozycję źródłową z porcjami;
- `applyWeekPlan` uznawał slot bez `portions` za zmianę (`!samePortions`) i kasował.

Klient, który alokacji nie zna (starszy iOS, zapis ze stanu sprzed odświeżenia, narzędzia AI bez pola porcji),
usuwał ją zwykłym zapisem. Zamek tygodnia szeregował zapisy, ale żaden nie pytał, czy pozycja ma alokację.

## Reproducer — FAIL przed / PASS po

`test/plan-portions-write-safety.e2e-spec.ts`. Synchronizacja bez zegarów: transakcja B trzymana na zatrzasku,
oczekiwanie A wykryte przez `pg_stat_activity` (`wait_event_type = 'Lock'`).

| Test | Kolejność operacji | Przed (`bfeaeb6`, kod z `31044a4`) | Po |
|---|---|---|---|
| 1. RACE | A czyta (bez alokacji) → B zapisuje 0,9/1,3 i trzyma zamek → A: upsert bez `portions` (zmiana „kto je”) — **blocked** → B commit → A kontynuuje | A: `OK`; stan `portions=[]`, audytorium zmienione — **FAIL** | A: `PLAN_PORTIONS_CONFLICT`; alokacja 0,9/1,3, `plannedServings=3`, audytorium bez zmian — **PASS** |
| 1b. sekwencyjnie | A czyta → B zapisuje alokację i commituje → A: stepper bez `portions` (`plannedServings: 2`) | A: `OK`; `portions=[]`, `plannedServings=2` — **FAIL** | A: `PLAN_PORTIONS_CONFLICT`; alokacja nietknięta — **PASS** |

## Mapa ścieżek zapisu

| Ścieżka | Przed | Po |
|---|---|---|
| `upsertWeekSlot` bez `portions` / `[]` na pozycji z alokacją | kasuje | zmiana → 409 `PLAN_PORTIONS_CONFLICT`; identyczny zapis → NOOP (nietknięta) |
| `upsertWeekSlot` z `portions` | zastępuje | zastępuje (jawne; bez CAS) |
| `replaceRecipeId`, źródło z alokacją, bez `portions` | usuwa z porcjami | 409 PRZED usunięciem; nic nie zmienione |
| `replaceRecipeId`, źródło z alokacją, z `portions` | zamiana | zamiana (jawna alokacja nowego dania) |
| `replaceRecipeId`, cel już w slocie z alokacją | upsert celu (kasuje) | decyzja na celu: zmiana → 409 (źródło zostaje), bez zmiany → źródło znika, cel nietknięty |
| `applyWeekPlan`, slot bez `portions` na pozycji z alokacją | kasuje | zmiana → `applied:false` + naruszenie (nic nie zapisane); identyczny → pozycja pominięta |
| `applyWeekPlan`, pozycji brak w stanie docelowym | usuwa | usuwa (jawne usunięcie w kontrakcie stanu docelowego) — bez zmian |
| apply propozycji bez `force` | odcisk z porcjami pod zamkiem | jak dotąd + polityka `strict` |
| apply propozycji z `force` | odcisk pominięty → mogła kasować | `no-allocation-changes`: nie zmieni istniejącej alokacji (ani brakiem pola, ani starymi porcjami) |
| undo propozycji | odcisk „po” pod zamkiem | jak dotąd; polityka `authoritative` (przywraca też „bez alokacji”) |
| narzędzia AI (`apply_week_plan`, `propose_*`; `toSlots` bez porcji) | kasowały przez apply | zmiana → naruszenie `PLAN_PORTIONS_CONFLICT` dla modelu; identyczny slot → pozycja nietknięta |
| `removeWeekSlot`, `clearWeekPlan` | usuwają | bez zmian |
| `setMealEaten` | nie dotyka | bez zmian |
| zmiana składu domu (`plan-roster.util`) | 1,00 dochodzącemu / zdjęcie odchodzącego | bez zmian (świadoma semantyka serwera) |

Każdy zapis `PlanItem` / `PlanItemPortion` w `src` bierze `lockWeekForWrite` jako pierwszą blokadę; pomocnicze
funkcje `plan-roster.util` biegną wyłącznie po `lockWeeksForWriteFrom` (sprawdzone `git grep`).

## Semantyka i kod konfliktu

`portionsWriteDecision(current, requested, policy)` (`src/weekly-plans/utils/plan-portions.util.ts`):

- pozycja bez alokacji → **WRITE** (legacy bez zmian);
- polityka `authoritative` → **WRITE**;
- z alokacją, `portions` pominięte albo `[]`:
  - to samo audytorium i `plannedServings` pominięte albo równe → **KEEP**;
  - inaczej → **CONFLICT**;
- z alokacją, `portions` podane:
  - polityka `strict` → **WRITE**;
  - polityka `no-allocation-changes` → WRITE tylko bez zmiany alokacji, inaczej **CONFLICT**.

`[]` znaczy to samo co brak pola. Nie ma jawnej, chronionej operacji „wyczyść alokację” — pozbycie się jej to
usunięcie dania. Nie ma „przenieś porcje” ani „przelicz”.

| Kanał | Odmowa |
|---|---|
| `weeklyPlans:upsertWeekSlot` | `{ ok:false, code:'PLAN_PORTIONS_CONFLICT', status:409, details:['planItemId:<id>'] }`; gateway nie rozgłasza (wyjątek przed broadcastem) |
| `weeklyPlans:applyWeekPlan` / w procesie | `{ applied:false, dryRun, violations:[{ index, dayOfWeek, mealType, recipeId, code:'PLAN_PORTIONS_CONFLICT', message }], changes:{0,0,0}, plan:null }` — bez 409 (kontrakt domenowy); gateway nie rozgłasza przy `applied:false` |
| `POST /agent/proposals/:id/apply` | 409 `AI_PROPOSAL_STALE`, `details:['reason:VIOLATIONS','PLAN_PORTIONS_CONFLICT']`; status `STALE`, `appliedAt` null, kwota i wiadomość APPLIED nie powstają |
| `POST /agent/proposals/:id/undo` | polityka `authoritative`; zmiana po zapisie → istniejące 409 `reason:CHANGED_AFTER_APPLY`, status zostaje `APPLIED` |
| narzędzia AI | wynik `applyWeekPlan` / podglądu z naruszeniem `PLAN_PORTIONS_CONFLICT` — model widzi go jak alergen |

Dane obcego gospodarstwa nie wyciekają: członkostwo jest sprawdzane przed decyzją (także pod zamkiem), a
`details` niesie wyłącznie id pozycji z domu wołającego. Test 7 potwierdza, że obcy dostaje
`NOT_HOUSEHOLD_MEMBER`, a nie konflikt porcji.

## Bezpieczeństwo pod współbieżnością

Decyzja zapada w transakcji zapisu, PO `lockWeekForWrite`, na pozycji odczytanej w tej transakcji. Kontrola
przed transakcją nie jest wiążąca (`dryRun` i podgląd liczą ją doradczo).

- **`upsertWeekSlot` (READ COMMITTED):** kto czekał na zamek, po jego zdobyciu widzi stan zatwierdzony przez
  poprzednika — dokładnie przeplot testu 1.
- **`applyWeekPlan` (SERIALIZABLE):** starsza migawka kończy `UPDATE` zamka błędem serializacji, a
  `runSerializable` liczy decyzję od nowa.

Odmowa w `applyWeekPlan` zapada po `guard` (który przejmuje propozycję), więc rzuca wewnętrzny
`PortionsConflictRefusal`. Wycofuje on całą transakcję — przejęcie statusu, kwotę, wiadomość — i dopiero poza
nią zamienia się w `applied:false`. Nie ma częściowego zapisu (test 8: nowe sloty z tego samego żądania też nie
weszły).

## Zgodność wstecz

| Klient | Zachowanie |
|---|---|
| Pozycje bez alokacji (wszystkie dzisiejsze na prod, flaga planera `false`) | bez zmian (test 5 przechodzi przed i po) |
| Starszy iOS na pozycji z alokacją | identyczny zapis → NOOP (`changeKind:'NOOP'`); zmiana → 409 `PLAN_PORTIONS_CONFLICT` |

Starszy iOS nie ma mapowania dla nowego kodu — pokaże to, co jego `UserFacingErrorMapper` pokazuje dla
nieznanego `code` (w tym workstreamie nie sprawdzane na urządzeniu). Zapis optymistyczny cofnie się, jak przy
każdej odmowie. Wcześniej ten sam zapis „udawał sukces”
i kasował porcje. Nowy kod jest w `openapi.json` (klient Android z generatora). Gałąź iOS
`feature/catalog-sync-per-user-portions` i tak nie przepisuje pozycji z alokacją.

**Zmiana kontraktu (świadoma):** `test/per-user-portions.e2e-spec.ts` › „upsertWeekSlot … zapis bez porcji wraca
do równego podziału” oczekiwał skasowania. Teraz oczekuje `PLAN_PORTIONS_CONFLICT` i nietkniętej alokacji.

## Apply/undo i narzędzia AI

- **Apply bez `force`:** alokacja dodana po propozycji zmienia odcisk, więc 409 `reason:CHANGED` (istniejący
  mechanizm, test 11).
- **Apply z `force`:**
  - propozycja wymienia pozycję z alokacją bez zmian → zapis przechodzi, alokacja zostaje (test 12);
  - zmienia ją → STALE/VIOLATIONS (test 11).

  Przed poprawką `force` kasował alokację: testy 11–12 FAIL na starym kodzie.
- **Undo:** przywraca tydzień z porcjami (test 13). Przed poprawką sam apply tej propozycji kasował porcje
  wymienionej pozycji, więc test 13 był FAIL.
- **Narzędzia AI:** test 14 woła prawdziwy `AgentToolExecutor` bez modelu:
  - `propose_week_plan` i `apply_week_plan` zmieniające imienną pozycję z alokacją dostają
    `PLAN_PORTIONS_CONFLICT` (brak propozycji, plan nietknięty);
  - identyczny slot na wspólnej pozycji przechodzi i jej nie rusza.

  `toSlots` nie kopiuje porcji — nie ma obejścia przez stare dane.

## Testy

**Nowe: `test/plan-portions-write-safety.e2e-spec.ts` (17 testów, żywa baza) — PASS 17/17.** Na kodzie sprzed
poprawki (src z `bfeaeb6`, te same testy): 13 FAIL / 4 PASS — przechodzą wyłącznie 3, 4b, 5, 6, czyli testy
zachowania, które MA zostać bez zmian.

| # | Scenariusz | Przed | Po |
|---|---|---|---|
| 1 | race (przeplot z zamkiem) | FAIL | PASS |
| 1b | sekwencyjnie, stary stan klienta | FAIL | PASS |
| 2 | `portions` pominięte i `[]`: NOOP / konflikt | FAIL | PASS |
| 3 | jawne `portions` zastępują alokację | PASS | PASS |
| 4 | `replaceRecipeId`: alokacja w źródle → odmowa, nic nie zmienione | FAIL | PASS |
| 4b | `replaceRecipeId` z jawnymi porcjami → zamiana | PASS | PASS |
| 4c | `replaceRecipeId`: alokacja w celu (odmowa / cel nietknięty) | FAIL | PASS |
| 5 | legacy (kto je, stepper) + niezależna pozycja obok alokowanej | PASS | PASS |
| 6 | jawne usunięcie, „zjedzone”, czyszczenie tygodnia | PASS | PASS |
| 7 | odmowa bez `emitLive` i bez zmian; obcy → `NOT_HOUSEHOLD_MEMBER` | FAIL | PASS |
| 8 | apply z jednym konfliktem → nic nie zapisane (także `dryRun`) | FAIL | PASS |
| 9 | apply: identyczne wymienienie (także `[]`) zostawia alokację | FAIL | PASS |
| 10 | polityki `authoritative` / `no-allocation-changes` | FAIL | PASS |
| 11 | propozycja: alokacja po utworzeniu (bez force / z force) | FAIL | PASS |
| 12 | propozycja z force bez zmiany pozycji | FAIL | PASS |
| 13 | undo (zwykłe i odmowa po zmianie) | FAIL | PASS |
| 14 | narzędzia AI przez `AgentToolExecutor` | FAIL | PASS |

**Unit:** `portionsWriteDecision` (4 przypadki w `plan-portions.util.spec.ts`). `weekly-plans.service.spec.ts`
padł na starej atrapie Prismy (brak `portions` w `findFirst` źródła zamiany). To nie regresja zachowania, tylko
atrapa niezgodna z nowym `select`; poprawiona (`portions: []`), 76/76.

**Regresja:**

| Komenda | Wynik |
|---|---|
| `pnpm test` | 200/200 suit, 3 558/3 558 |
| `pnpm test:e2e:ci` (świeża baza: 75 migracji + bootstrap, `connection_limit=9` jak na CI) | 57/57 suit, 644/644 — w tym `plan-portions-write-safety`, `per-user-portions`, `apply-week-plan`, `agent`, `proposal-consistency`, `week-lock-order`, `agent-choice-portions`, `agent-card-state`, `meal-planner`, `durable-turns` |
| `pnpm typecheck` | OK |
| `pnpm lint:check` | 0 błędów (42 ostrzeżenia, jak na `develop`) |
| `pnpm openapi:check` | po `pnpm openapi` (nowy kod w dwóch wyliczeniach) — aktualne |
| `pnpm build` | OK |

Tej gałęzi nie dotyczy `catalog-change-commit-order.e2e` (#208, niezmergowany) — stąd 57 plików testów.

## Pozostałe API GAP-y

1. **Utracona zmiana między świadomymi klientami.** Jawne `portions` zastępują alokację bez wersji; dwaj klienci
   zmieniający porcje różnych osób ze starych kopii — wygrywa ostatni. Potrzebne CAS (`expectedVersion` pozycji)
   albo atomowe `setPortion` jednej osoby. Tu nie ma bezpiecznej edycji jednej osoby.
2. **Stary stan docelowy w surowym `weeklyPlans:applyWeekPlan`.** Pozycje spoza stanu docelowego są usuwane
   (kontrakt); klient ze starą kopią może usunąć danie, którego nie znał — dotyczy każdego dania, nie tylko
   porcji. Propozycje mają odcisk; WS — nie.
3. Brak operacji „wyczyść alokację” poza usunięciem dania; brak przeniesienia/przeliczenia porcji przy zmianie
   audytorium i zamianie dania (świadomie — bez kontraktu).
4. OpenAPI `PlanPortionDto` nadal bez min/max/multipleOf (bez zmian w tym patchu).

## Warunki odblokowania edycji porcji (iOS)

1. Wersja pozycji w payloadach i `expectedVersion` na każdym zapisie pozycji (`upsertWeekSlot`, `applyWeekPlan`,
   apply propozycji); e2e z dwoma równoległymi zapisami: 409 dla spóźnionego, brak utraconej zmiany.
2. `setPortion` (albo równoważne) — e2e „A zmienia Rafała, B zmienia Asię → obie zmiany zostają”.
3. Semantyka zmiany audytorium i zamiany dania z alokacją zdefiniowana po stronie serwera (dziś: odmowa).
4. Po stronie iOS: obsługa `PLAN_PORTIONS_CONFLICT` (komunikat + odświeżenie tygodnia) i nowego 409 wersji.

## Rollout i ryzyka

- Zwykły deploy backendu. Bez migracji bazy, bez zmian flag. Na prod alokacji dziś nie ma (flaga planera
  `false`), więc zachowanie widoczne tylko po ich powstaniu.
- **Ryzyko:** klient, który dotąd „poprawiał” pozycję z alokacją zapisem bez porcji, dostanie odmowę zamiast
  cichego skasowania. To zamierzone.
- **Ryzyko:** propozycje AI, które zmieniają audytorium pozycji z alokacją, będą odrzucane jako naruszenie —
  model musi zostawić audytorium albo zaproponować inne danie. Dopóki flaga planera jest `false`, alokacje nie
  powstają.
- **Rollback:** revert commita poprawki (`c0514f9`) i jego testów. Bez stanu w bazie do cofania.

## SHA

| Commit | Opis |
|---|---|
| `31044a4` | start (`origin/develop`) |
| `bfeaeb6` | test: reproducer (FAIL) |
| `344cf54` | docs(adr): kontrakt |
| `c0514f9` | fix: `portionsWriteDecision` w upsert/replace/apply, polityki propozycji, test starego kontraktu zmieniony |
| `403213f` | test: 15 scenariuszy + unit decyzji |
| `3cbd5e2` | chore(openapi): kod `PLAN_PORTIONS_CONFLICT` |
| `49f70b5` | test: atrapa Prismy z `portions` |
| `0b8d2fc` | docs: CLAUDE.md |
| (ten commit) | docs: raport |

## Status

**READY FOR REVIEW.** Patch chroni przed NIEJAWNĄ utratą alokacji (zapis bez intencji co do porcji). Nie
rozwiązuje utraconej zmiany między klientami, którzy porcje jawnie przesyłają (CAS — poza zakresem). Nie
zmergowane, nie wdrożone.
