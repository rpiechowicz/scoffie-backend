# Raport etapu 02.2 — Porcje per osoba

**Data:** 2026-09-26  
**Status:** DONE — backend sprawdzony testami (unit + e2e na żywej bazie + `planner:eval`);
iOS napisany, **NIESKOMPILOWANY** (brak Xcode na tej maszynie, §7)  
**Branch:** backend `claude/admin-crm-planning-b0hmgo`; iOS `claude/per-user-portions` (od `develop`, bez merge'a)  
**Zakres:** Etap 2.2 — osobna alokacja porcji per osoba dla wspólnego dania, żeby planer
mógł doprowadzić CAŁY dzień każdej osoby możliwie blisko 100 % jej celu.

## 0. Projekt (zapisany PRZED zmianą `schema.prisma`)

### Audyt — co zależy od porcji

**Backend** (`scoffie-backend`):

| Miejsce | Co robi z porcjami |
|---|---|
| `weekly-plans.service.ts` — `PLAN_ITEM_INCLUDE`, `withPlanItemRelationIds` | kształt `PlanItemDto` na drut (WS `weeklyPlans:*`, odczyt tygodnia) |
| `upsertWeekSlot` (+ `resolvePlannedServings`, `resolveUpdatedPlannedServings`) | ręczny zapis slotu z iOS (stepper porcji, audytorium) |
| `applyWeekPlan` / `previewWeekPlan` / `previewWeekPlanChanges` / `collectPlanViolations` | zapis tygodnia jako stan docelowy (propozycje asystenta) |
| `snapshotWeekAsSlots` | migawka tygodnia → baseline propozycji, `revise_proposal`, planer |
| `weeklyBalance` + `utils/daily-balance.util.ts` | bilans dnia osoby (`servingsPerPerson`, `nutritionPerPerson`, `visibleToMember`) |
| `services/shopping-list.service.ts` | skalowanie składników `plannedServings / recipe.servings` |
| `utils/plan-roster.util.ts` (`onRosterChanged`, `onMemberLeft`) | auto-porcje „Wspólnych" po zmianie składu domu |
| `utils/planned-servings.util.ts` | klamra 1..12 i reguła auto |
| `agent/proposals/*` (`proposal-baseline.ts`, karty, `reviseProposal`, swap) | odcisk planu, intencja propozycji |
| `agent/week-plan-projection.ts`, narzędzia | plan dla modelu |
| `meal-planner/*`, `agent/planner/*` | planer (dobór porcji) |
| `data-export/user-export.ts`, `ws-payload-fixtures.spec-helper.ts`, skrypty | eksport, fikstury WS |

**iOS** (`scoffie-ios`):

| Miejsce | Co robi z porcjami |
|---|---|
| `Models/Plans/SavedMealPlan.swift` (`PlanMeal`) | `plannedServings: Int?`, `effectiveServings`, `servingsPerPerson`, `nutritionPerPerson`, dekoder z cache (`meal_plans.json`, `saved_plan.json`) |
| `Models/Stores/WeeklyPlanStore.swift` | `BackendWeeklyPlanItemDTO`, `WeekPlanSlot`, `upsertWeekSlot(plannedServings:)` |
| `Models/Stores/MealCalendarStore.swift` | odtwarzanie tygodnia, pamięć porcji po `PlanItem.id`, zapis optymistyczny |
| `PlanDayNutrition.make` (Plan, Kalendarz, Asystent) | suma dnia JEDNEJ osoby (już zawężona `visibleTo`) |
| `CalendarView`, `PlanDayTimeline`, `AssistantView`, `SessionStore` (przypomnienia) | kcal posiłku „na osobę" |
| `PlanSlotPickerSheet`, `AddToPlanSheet`, `RecipeDetail` | stepper porcji łącznych |

Brak testów iOS w repo (jeden target aplikacji) i brak `swiftc` na tej maszynie — §7.

### Model danych

- **Nowa tabela `PlanItemPortion(planItemId, userId, units Int)`**, PK `(planItemId, userId)`,
  kaskada z `PlanItem` i `User`. `units` w **1/20 porcji (0,05)**: liczba całkowita
  w Postgresie, Prismie, JSON-ie i Swifcie, bez binarnego Float i bez `Decimal` (Prisma
  oddaje go jako obiekt/tekst, a Swift dekoduje liczby JSON jako `Double` i tak). 0,05 porcji
  to ~25 kcal przy typowym daniu — poniżej sensownej precyzji planu.
- **Semantyka `participantIds` bez zmian** (pusty zbiór = cały dom).
- **Pozycja bez alokacji = dokładnie jak dziś:** `plannedServings / liczba jedzących`.
  Brak backfillu — stare wiersze niczego nie potrzebują.
- **Pozycja z alokacją:** alokacja jest ŹRÓDŁEM PRAWDY. Osoba dostaje SWOJĄ porcję;
  łącznie gotujemy Σ porcji. Zbiór osób w alokacji = audytorium pozycji (imienni
  uczestnicy albo wszyscy domownicy przy „Wspólnym") — walidowane przy zapisie.
- **`plannedServings` zostaje `Int` i przy pozycji z alokacją jest POCHODNĄ:**
  `plannedServings = min(12, ceil(Σ porcji))`, liczone zawsze przez serwer (wartość od
  klienta jest wtedy ignorowana). Nie jest drugim źródłem prawdy — żaden rachunek serwera
  ani nowego iOS go nie czyta przy pozycji z alokacją; istnieje dla STARYCH klientów, które
  dekodują `plannedServings: Int?` (zmiana na ułamek wywróciłaby im dekoder całego tygodnia).
- **Lista zakupów:** gotujemy DOKŁADNIE tyle, ile zjadają osoby — składniki skalowane
  przez `Σ porcji / recipe.servings` (0,8 + 1,3 = 2,1 porcji → ×2,1, nie ×2 ani ×3).
  Model „pełne porcje i resztki" świadomie odrzucony: lista mówiłaby co innego niż plan.

### Kontrakt drutu

- `PlanItemDto.portions: { userId: string; servings: number }[]` — zawsze obecne (pusta
  lista = pozycja bez alokacji), `servings` wielokrotność 0,05.
- Zapis: opcjonalne `portions` w `ApplyWeekSlotDto` (`weeklyPlans:applyWeekPlan`,
  propozycje) i w `UpsertWeekSlotDto` (`weeklyPlans:upsertWeekSlot`). Zapis slotu BEZ
  `portions` (np. stary iOS, stepper łącznej liczby) zapisuje pozycję bez alokacji —
  wraca równy podział. Naruszenie reguł alokacji = nowy kod `PLAN_PORTIONS_INVALID`.

### Planer

- Dla wspólnego dania każda osoba dostaje własną porcję tego SAMEGO przepisu:
  `porcja = clamp(krok 0,05; 0,5–1,5)` z jej pozostałego celu dnia (reszta dnia już
  ustalona w lokalnej poprawie). Zakres i krok to stałe domenowe (`PORTION_MIN/MAX/STEP`).
- Włącznik `AI_PLANNER_PER_USER_PORTIONS` (domyślnie `false`) — rollout po wydaniu iOS,
  który umie czytać alokacje (§8).

### Zmiana składu domu

- Dołączenie: „Wspólne" z alokacją od bieżącego tygodnia dostają porcję 1,0 dla nowej
  osoby (jak reguła auto), `plannedServings` przeliczone.
- Odejście: alokacje odchodzącego znikają, `plannedServings` przeliczone; auto-porcje
  starego mechanizmu nie ruszają pozycji z alokacją.
- Edge case: osoba jedząca pozycję z alokacją, która nie ma w niej wiersza (np. alokacja
  zapisana przed jej dołączeniem, gdyby hook nie zadziałał) → 1,0 porcji (reguła auto).

### Przeszkody

Nie znalazłem przeszkody blokującej migrację. Ryzyka rolloutowe (stary iOS widzi równy
podział `ceil(Σ)` przy pozycjach z alokacją) — §8 i włącznik planera.

---

## 1. Co zostało zrobione

- **Model danych** zgodny z projektem z §0: tabela `PlanItemPortion`, jednostki 1/20 porcji,
  pozycja bez alokacji liczona jak dotąd, `plannedServings` = pochodna `ceil(Σ)`.
- **Zapis/odczyt:** `applyWeekPlan`, `previewWeekPlan`, `upsertWeekSlot`, `snapshotWeekAsSlots`,
  odczyt tygodnia, odcisk propozycji, karty, projekcja planu dla modelu, eksport danych (RODO).
- **Bilans osoby** (`weeklyBalance`) i **lista zakupów** (Σ porcji, ułamkowo) czytają alokację.
- **Planer**: tryb `portionMode: 'per_user'` — to samo danie, osobna porcja każdej osoby
  (0,5–1,5, krok 0,05) domykająca JEJ dzień; za włącznikiem `AI_PLANNER_PER_USER_PORTIONS`.
- **Propozycje asystenta**: `build_meal_plan`, `revise_proposal` i `replace_plan_item` (także
  podmiana w zapisanym planie) niosą porcje; zawężenie slotu (podmiana/usunięcie dania części
  osób) zdejmuje porcje osób, które wychodzą z pozycji (`narrowSlot`).
- **Skład domu**: nowy domownik dostaje 1,0 porcji we „Wspólnym" z alokacją, wychodzący znika
  z alokacji; `plannedServings` przeliczone.
- **iOS** (osobna gałąź): dekodowanie starego i nowego planu, kcal osoby z jej porcji w Planie,
  Kalendarzu, Asystencie i przypomnieniach, porcje w cache'u, kod błędu `PLAN_PORTIONS_INVALID`.
- **Poza projektem z §0 (świadome zmiany zakresu):**
  - stałe planera nazywają się `PLANNER_PORTION_MIN/MAX/STEP` (`meal-plan-scoring.ts`), a osobne
    widełki ZAPISU (0,1–6) — `PORTION_WRITE_MIN/MAX` (`plan-portions.util.ts`): ręczny zapis może
    więcej niż planer;
  - przy „podobnie kalorycznie" (`slotKcalTargets`) w trybie `per_user` cel slotu waży tylko
    w wyborze DANIA (średnia kcal na osobę), a porcję każdej osoby dobiera jej własny bilans dnia
    — wspólna porcja dla 1600 i 2600 kcal rozjechałaby oba dni;
  - eksport danych osoby (`user-export.ts`) dostał `meals.portions` — porcja jest daną osobową.

## 2. Zmiany w kodzie

| Plik / moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `prisma/schema.prisma`, migracja `20260926160000_porcje_per_osoba` | tabela `PlanItemPortion` (PK `planItemId,userId`, `units` INT CHECK 2..120, indeks `userId`, FK kaskadowe) | alokacja per osoba |
| `src/weekly-plans/utils/plan-portions.util.ts` (nowy) | jednostki, `cookedServings`, `derivedPlannedServings`, `portionsProblem`, konwersje | jedna definicja reguł dla zapisu, bilansu, zakupów, planera |
| `src/weekly-plans/dto/*` | `PlanPortionDto`, `portions?` w `ApplyWeekSlotDto`/`UpsertWeekSlotDto`, `PlanItemDto.portions` | kontrakt |
| `src/weekly-plans/weekly-plans.service.ts` | include/zapis/porównanie/podgląd porcji, walidacja `PLAN_PORTIONS_INVALID`, zapis bez `portions` czyści alokację | źródło prawdy + zgodność ze starym klientem |
| `src/weekly-plans/utils/daily-balance.util.ts` | `servingsPerPerson(meal, count, memberId?)` | kcal osoby z jej porcji |
| `src/weekly-plans/services/shopping-list.service.ts` | krotność = `cookedServings / recipe.servings` | Σ porcji, ułamkowo |
| `src/weekly-plans/utils/plan-roster.util.ts`, `households.service.ts` | dopisanie/zdjęcie porcji przy zmianie składu; auto-porcje omijają pozycje z alokacją | alokacja = audytorium |
| `src/meal-planner/*` | `per_user`, `portionFor`, `PLANNER_PORTION_*`, bilans osoby z porcji, koszt miękki porcji | planer dobiera porcje |
| `src/agent/planner/agent-meal-planner.service.ts`, `src/config/agent-env.ts` | włącznik `AI_PLANNER_PER_USER_PORTIONS` | rollout |
| `src/agent/proposals/*`, `cards/*`, `week-plan-projection.ts`, `tools/agent-tool-executor.ts` | porcje w propozycjach, odcisku (tylko gdy są — odcisk legacy bez zmian), kartach (kcal widza), projekcji | propozycje nie gubią alokacji |
| `src/data-export/user-export.ts` | `meals.portions` | RODO art. 15/20 |
| `src/common/app-error-code.ts` | `PLAN_PORTIONS_INVALID` | czytelna odmowa |
| `openapi/*` | regenerowane | kształt `PlanItem` |

**Migracja** `20260926160000_porcje_per_osoba`: czysto ADDYTYWNA (nowa tabela, żadnej zmiany
istniejących kolumn i wierszy). Wpływ na dane: zero — brak backfillu, bo pozycja bez wierszy
alokacji liczy się jak dotąd. Rollback: `DROP TABLE "PlanItemPortion"` (tracimy tylko alokacje;
`plannedServings` = `ceil(Σ)` zostaje w `PlanItem`, więc plan dalej działa jako równy podział).
Forward-fix zamiast rollbacku: `AI_PLANNER_PER_USER_PORTIONS=false` zatrzymuje nowe alokacje.

## 3. Kontrakty i kompatybilność

- **WS/REST:** `PlanItem.portions: {userId, servings}[]` zawsze obecne (puste = bez alokacji).
  Wejście: `portions?` w `weeklyPlans:applyWeekPlan` (sloty) i `weeklyPlans:upsertWeekSlot`;
  `servings` wielokrotność 0,05 w widełkach 0,1–6 (`@IsNumber({maxDecimalPlaces: 2})` + reguła
  kroku), zbiór osób = audytorium pozycji, Σ ≤ 12. Przy `portions` serwer ignoruje
  `plannedServings` od klienta i liczy `ceil(Σ)`. Zapis slotu BEZ `portions` = pozycja bez
  alokacji. OpenAPI zregenerowane, `openapi:check` zielone.
- **Nowy kod błędu:** `PLAN_PORTIONS_INVALID` (naruszenie w `violations[]` przy `applyWeekPlan`,
  wyjątek przy `upsertWeekSlot`); iOS ma kopię w `UserFacingErrorMapper`.
- **Zmienne środowiskowe:** `AI_PLANNER_PER_USER_PORTIONS` (domyślnie `false`).
- **Macierz zgodności:**

| | backend bez 2.2 | backend 2.2, włącznik `false` | backend 2.2, włącznik `true` |
|---|---|---|---|
| **stary iOS** | jak dziś | jak dziś (alokacje nie powstają; ręcznie z telefonu też nie) | pozycje z planera: kcal = równy podział `ceil(Σ)` (np. 1,5 porcji zamiast 0,8/1,3); stepper zapisuje bez `portions` → pozycja wraca do równego podziału; lista zakupów poprawna (liczy serwer) |
| **nowy iOS** | pole nieobecne → równy podział (dekoder toleruje brak) | jak dziś | kcal z porcji osoby, suma dnia per osoba, porcje przeżywają edycję bez zmiany dania/osób |

## 4. Testy

| Test / komenda | Wynik |
|---|---|
| `pnpm test` (cała suita unit) | **186/186 suit, 3377/3377 testów** (MEASURED; bez nowych spec-ów 2.2: 184/3355) |
| — `plan-portions.util.spec.ts` (nowy) | 12 testów: jednostki, walidacja, bilans (test 1, 2), lista zakupów (test 3) |
| — `per-user-portions.spec.ts` (nowy) | 10 testów: stałe (0,5/1,5/0,05), solo (4), para (5), rodzina (6), twarde (7), podmiana slotu (8), determinizm, PARTIAL przy lekkich daniach, stałe pozycje z porcjami |
| — `portion-semantics.audit.spec.ts` | bez zmian logiki: teraz przypina semantykę pozycji BEZ alokacji |
| `e2e.sh test/per-user-portions` (nowy, żywa baza dev) | **12/12**: round-trip `applyWeekPlan` (10), legacy (11), bilans z porcji (2), zła alokacja = naruszenie i nic się nie zapisuje, krok 0,05 na DTO, `upsertWeekSlot`, lista zakupów ułamkowo (3/12), `build_meal_plan` → propozycja → zapis (9), `revise_proposal` zachowuje porcje nietkniętych (8), podmiana w zapisanym planie, włącznik `false` = równy podział, wejście/wyjście domownika |
| e2e regresja: `per-user-portions apply-week-plan meal-planner agent agent-card-state agent-tools shopping* weekly-balance week-lock-order authz-audit cross-household invitation* account-deletion data-export` | **16/16 suit, 242/242 testy** |
| `pnpm typecheck`, `pnpm lint:check` | 0 błędów (42 ostrzeżenia sprzed etapu, żadne w zmienionych plikach) |
| `pnpm openapi:check` | aktualne |
| iOS: `python swift_check.py` (tree-sitter-swift, cały `Scoffie/` + skrypt) | 0 błędów składni; **kompilacja i `sh Scripts/plan-portions-check.sh` (testy 13–17) NIEURUCHOMIONE** — brak macOS |

Mapowanie testów obowiązkowych: 1 → unit `bilans…1.`; 2 → unit + e2e „2."; 3 → unit + e2e
„3./12."; 4 → „4. solo"; 5 → „5. para"; 6 → „6. rodzina"; 7 → „7. porcje nie łamią twardych";
8 → unit „8." + e2e „8." + e2e „w ZAPISANYM planie"; 9 → e2e „9."; 10 → e2e „10."; 11 → e2e
„11."; 12 → e2e „3./12."; 13–17 → `Scripts/PlanPortions/main.swift` (iOS, nieuruchomione).

## 5. Pomiary przed / po

`pnpm planner:eval --runs 3` na lokalnym katalogu dev (≈500 przepisów), ostatni przebieg,
osoby z sylwetką i celem jak w raporcie 02. „Przed" = ten sam kod z włącznikiem `false`
(wyniki identyczne z raportem 02, Addendum A1 — tryb `tune` się nie zmienił). **MEASURED.**

**Odchylenie kcal CAŁEGO dnia osoby (`dayKcalDeviationPct` średnio / max, %):**

| Scenariusz | Operacja | Przed | Po | Status przed → po |
|---|---|---:|---:|---|
| solo 2000 | tydzień | 1,6 / 3,1 | **0,2 / 0,6** | OK → OK |
| solo 2000 | dzień | 1,3 / 1,3 | **0,4 / 0,4** | OK → OK |
| para 1600/2600 | tydzień | 23,0 / 27,2 | **0,6 / 2,7** | PARTIAL → **OK** |
| para 1600/2600 | dzień | 22,5 / 27,9 | **0,1 / 0,2** | PARTIAL → **OK** |
| para 1600/2600 | podmiana śr. kolacji (wege, podobnie kal.) | 21,4 / 31,6 | **0,1 / 0,1** | PARTIAL → **OK** |
| rodzina 4 (orzechy) | tydzień | 13,7 / 27,7 | **0,3 / 0,7** | PARTIAL → PARTIAL (białko) |
| rodzina 4 (orzechy) | dzień | 13,5 / 26,9 | **0,3 / 0,4** | PARTIAL → PARTIAL (białko) |
| rodzina 4 (orzechy) | podmiana śr. kolacji | 16,0 / 33,3 | **0,7 / 0,9** | PARTIAL → PARTIAL |
| wege + bez glutenu | tydzień | 11,2 / 19,0 | **0,2 / 0,5** | PARTIAL → PARTIAL (białko) |
| wege + bez glutenu | dzień | 2,8 / 2,8 | **0,1 / 0,1** | OK → OK |
| wege + bez glutenu | podmiana śr. kolacji | 7,4 / 7,4 | **0,2 / 0,2** | PARTIAL → PARTIAL |

**Pozostałe metryki (tydzień, przed → po):**

| Scenariusz | Białko odch. % | Twarde złamania | Powtórki | Czas ms | Zapytania DB |
|---|---:|---:|---:|---:|---:|
| solo | 3,3 → 2,1 | 0 → 0 | 0 → 0 | 108 → 100 | 12 → 12 |
| para | 20,4 → 4,8 | 0 → 0 | 0 → 0 | 191 → 117 | 12 → 12 |
| rodzina 4 | 23,3 → 18,1 | 0 → 0 | 0 → 0 | 470 → 127 | 12 → 12 |
| wege + bez glutenu | 30,4 → 11,5 | 0 → 0 | 0 → 0 | 37 → 40 | 12 → 12 |

- Wszystkie dni mieszczą się w progu „bardzo dobrze" (≤ 5 %); przed etapem para i rodzina były
  daleko poza „akceptowalnie" (> 10 %).
- PARTIAL po zmianie wynika WYŁĄCZNIE z białka (`PROTEIN_OUT_OF_TOLERANCE`): porcja skaluje całe
  danie, więc nie zmienia PROPORCJI makro — rodzinie z orzechami i wege bez glutenu brakuje w
  katalogu dań o wyższym udziale białka. To sprawa katalogu/Etapu 4, nie porcji.
- W podmianie wege dla scenariusza wege pojawiła się 1 powtórka (na 22 kandydatów bez glutenu
  i mięsa — przy tak małej puli powtórka kosztuje mniej niż kilka % kcal). Przed: 0.
- Czas planowania spadł (para 191 → 117 ms, rodzina 470 → 127 ms): per osoba to jedna porcja na
  przepis zamiast przeglądu kilku wariantów porcji łącznych.
- e2e na katalogu dev (para 1600/2600, zapis przez propozycję, bilans z `weeklyBalance`):
  najgorszy dzień 0,9 % (Asia) i 0,5 % (Rafał). **MEASURED.**

## 6. Wydajność bazy / API

- Odczyt tygodnia: `portions` w tym samym `include` (Prisma robi jedno dodatkowe zapytanie
  `IN (...)` na relację, jak dla uczestników i konsumpcji). Planer: 12 zapytań na plan — bez zmian.
- Zapis: przy zmianie alokacji `deleteMany` + `createMany` wierszy pozycji w tej samej transakcji
  (za zamkiem tygodnia, kolejność blokad bez zmian — `PlanItemPortion` jest dzieckiem `PlanItem`).
- Indeks `PlanItemPortion(userId)` — dla eksportu, kasowania konta i zmiany składu.

## 7. Wpływ na iOS (`scoffie-ios`, gałąź `claude/per-user-portions`)

**Stan: commit `afffa44` na `claude/per-user-portions` (wypchnięty, bez PR-a i merge'a).
Sprawdzone: składnia (tree-sitter, 0 błędów) i przegląd deklaracji przez drugiego agenta
(sygnatury, kolejność argumentów memberwise, Codable, zależności skryptu — bez błędów
kompilacji; trzy uwagi logiczne poprawione przed commitem: cudze danie osobiste pokazuje
średnią porcję swoich jedzących, porcje nie są odsyłane po zmianie składu domu, ponowny zapis
tego samego dania nie gubi porcji w stanie optymistycznym). NIESKOMPILOWANE i nieuruchomione.**
Przed merge'em: build w Xcode + `sh Scripts/plan-portions-check.sh`.

- `PlanMeal.portions: [String: Double]` (dekoder: brak klucza = `[:]`, więc cache sprzed zmiany
  i stary serwer czytają się jako równy podział), `portion(for:)`, `hasPortions`, `==`/`hash`.
- `servingsPerPerson` / `nutritionPerPerson(householdMemberCount:|knownHouseholdMemberCount:,
  memberId:)` — `memberId` domyślnie `nil`; przy alokacji porcja osoby (brak wpisu = 1,0, brak
  osoby = średnia), bez alokacji bez zmian. Porcja osoby liczy się też przed wczytaniem składu
  domu (bez migania).
- `BackendWeeklyPlanItemDTO.portions` + `WeekPlanSlot.portions` → `MealCalendarStore`.
- **Moje kcal z mojej porcji, cudze z cudzej:** `PlanDayNutrition.make(memberId:)` — Plan
  (osoba z soczewki/pigułki), Kalendarz i Asystent (ten, kto trzyma telefon); kcal dania na osi
  Planu (`PlanTimelineDish.kcalPersonId`), Kalendarza, briefing Asystenta i przypomnienia.
- Wspólne zostaje wspólne: jedna pozycja, `participantIds` bez zmian.
- Plakietka „N porcji" nie pokazuje się przy alokacji (`ceil(Σ)` mówiłoby nieprawdę).
- Edycja: porcje przeżywają zapis slotu, gdy nie zmienia się danie, osoby ani liczba porcji,
  a alokacja dalej pasuje do audytorium (telefon odsyła `portions`); stepper porcji łącznych i nowe audytorium wracają do równego
  podziału — tak samo jak na serwerze.
- **Minimalny UX (decyzja produktowa do podjęcia, NIE zrobione):**
  - A (jest): stepper porcji łącznych; ruszenie go zdejmuje alokację.
  - B (rekomendacja): w arkuszu edycji posiłku wiersz na osobę z własnym stepperem 0,5–1,5
    co 0,05 (lub co 0,25 dla prostoty) i kcal obok; telefon wysyła `portions`.
  - C: „Mój talerz" — suwak tylko dla siebie, cudze porcje bez zmian (mniej UI, ale nie da się
    poprawić porcji dziecka).
- Testy 13–17: `Scripts/PlanPortions/main.swift` + `Scripts/plan-portions-check.sh` (wzorem
  `card-contract-check.sh`, bo projekt nie ma targetu testów).

## 8. Rollout i ryzyka

1. **Backend na prod z włącznikiem `false`** (domyślny — nic nie trzeba ustawiać). Migracja
   addytywna; zachowanie dla wszystkich klientów bez zmian (§3).
2. **Build iOS z gałęzi `claude/per-user-portions`**: kompilacja, `plan-portions-check.sh`,
   TestFlight, wydanie.
3. **Włączenie `AI_PLANNER_PER_USER_PORTIONS=true` na Railwayu** — dopiero gdy stary build
   praktycznie zniknie (backend nie ma dziś bramki „minimalna wersja klienta"; `/me/flags`
   z panelu mogłoby nią zostać, ale to osobna zmiana). Zmiana zmiennej na prod = tylko za
   jawnym „tak" Rafała.

Ryzyka:
- stary iOS przy pozycji z alokacją pokazuje równy podział `ceil(Σ)` — kcal zawyżone (0,8+1,3
  → po 1,5 porcji) i jego stepper zdejmuje alokację; stąd kolejność kroków 1–3;
- alokacja zawsze = audytorium: każda ścieżka zmieniająca audytorium (zapis ręczny, propozycje,
  skład domu) jest pokryta testem, ale nowa ścieżka zapisu musi przejść przez `portionsProblem`;
- porcja nie poprawia proporcji makro (białko) — patrz §5.

## 9. Otwarte sprawy (poza zakresem)

- UX edycji porcji per osoba (wariant B/C z §7) — decyzja produktowa.
- Bramka minimalnej wersji klienta przed włączeniem flagi.
- Białko w scenariuszach rodzina/wege — dobór katalogu (Etap 4).
