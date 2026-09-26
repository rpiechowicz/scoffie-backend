# Raport etapu 02.2 — Porcje per osoba

**Data:** 2026-09-26  
**Status:** IN_PROGRESS (projekt zapisany przed zmianą schematu)  
**Branch:** backend `claude/admin-crm-planning-b0hmgo`; iOS — osobna gałąź (§7)  
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
