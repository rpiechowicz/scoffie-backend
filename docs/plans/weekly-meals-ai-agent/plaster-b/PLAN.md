# Plaster B — semantyka planu i przepisów przed Fazą 0

## Kontekst

Plaster A (28.08) naprawił liczby, które użytkownik widzi. Plaster B naprawia zasady, które odziedziczy `applyProposal` asystenta i walidator: martwa „pula tygodnia”, która potrafi skasować posiłki w wyłączonych slotach; podmiana przepisu jako REMOVE+UPSERT z oknem pustego slotu; duchy uczestników po odejściu domownika; auto-porcje nieprzeliczane po zmianie składu domu; rozjechana kopia normalizatora w `RecipesService` (przyprawa uniwersalna: 4 g vs 2,5 g) i makro „jakie klient wpisał”; alergeny bez białej listy i iOS kasujący nieznane wartości.

Decyzje Rafała (28.08): posiłki **solo** odchodzącej osoby są **usuwane** z bieżącego i przyszłych tygodni; nowe alergeny (seler, gorczyca, sezam) wchodzą **później** z tagami składników.

Ustalone w specyfikacjach (sześć niezależnych przeglądów kodu po plastrze A): `getSavedPlan` zostaje jako **pusty stub na jedno wydanie** (stara apka woła go w `CalendarView.task` _przed_ załadowaniem tygodnia — bez handlera to 3 × 6 s bez acka = 18,75 s pustego kalendarza przy każdej zmianie tygodnia); modele `SharedMealPlan*` zostają w schemacie (DROP w osobnej migracji po wydaniu); `deleteAccount` to **czwarta** ścieżka usuwania członkostwa i też dostaje hook; testy hooka żyją w czystym utilu (jest podmienia `households.service` na stub — plaster C); iOS nie ma UI tworzenia przepisów, więc B4 weryfikuje się tylko testami i `ws:smoke`.

Repozytoria: backend (B), iOS (I). Branch `fix/fundamenty-b` w obu z `develop`. Bez tsc/jest na hoście (kontener), iOS przez `xcodebuild`. Szacunek ~22 h ≈ 3 dni. Pełne specyfikacje (linie, kod, przypadki testowe) leżą w scratchpadzie sesji `scratchpad/specb/*.md` — pierwszy krok wdrożenia kopiuje je do `~/.claude/plans/weekly-meals-ai-agent/plaster-b/`.

**Kolejność wdrożenia (nośna):** backend → dane (dev, potem prod) → iOS. Nowe iOS z `replaceRecipeId` na starym backendzie zostawiłoby w slocie dwa dania (WS ignoruje nieznane pole); iOS z unią alergenów przed czyszczeniem SQL utrwaliłby śmieci i zablokował zapis preferencji.

---

## B1. Wycofanie puli tygodnia (~5 h)

**Backend** (`src/weekly-plans/`):

- `weekly-plans.gateway.ts`: usunąć handlery `listByHousehold`, `create`, `addItem`, `removeItem`, `saveSavedPlan` + ich klasy payloadów, importy DTO, `buildSavedPlanFingerprint`, emit `savedPlanChanged` w `clearWeekPlan`. `getSavedPlan` → stub: `wsRespond(async () => ({ weekStart: payload.weekStart, items: [] }))` z komentarzem DEPRECATED (usunąć w następnym wydaniu razem z `WeeklyPlansGetSavedPlanPayload`).
- `weekly-plans.service.ts`: usunąć `listByHousehold`, `create`, `addItem`, `removeItem`, `getSharedMealPlan`, `saveSharedMealPlan` (z `pruneByMealType` — sam błąd WP-03), gałąź puli w `clearWeekPlan`; sprzątnąć importy (`ConflictException`, DTO, `MealType`).
- `services/shopping-list.service.ts`: `buildShoppingListBase` bez gałęzi `else` z `sharedMealPlan` (`ingredientSources = (weeklyPlan?.items ?? []).map(...)`), `hasShoppingSourceData` tylko po `PlanItem` (jedno zapytanie) — dzięki temu widmowe listy same się zerują przy odczycie; poprawić komentarz nad metodą.
- Usunąć `dto/save-shared-meal-plan.dto.ts` (+spec), `dto/create-plan-item.dto.ts`, `dto/create-weekly-plan.dto.ts`; komentarz w `households/dto/update-meal-times.dto.ts:46-48`.
- `notifications/notification-copy.util.ts`: usunąć `SAVE_PLAN` z unii i gałąź w `buildPlanSummary`; usunąć test w `notification-copy.util.spec.ts:174-189`.
- `commands.txt:28`: przykład `weeklyPlans:listByHousehold` → `weeklyPlans:getByWeek`.
- **Schema bez zmian** (modele zostają; follow-up: DROP TABLE + usunięcie stubu po adopcji nowej apki).
- Testy: `shopping-list.service.spec.ts` — usunąć `poolItem`/`poolWith` i 2 testy puli, dodać 3 (pula ignorowana przy 0 PlanItemów → `[]`, `sharedMealPlan.findUnique` nigdy nie wołany, snapshot bez źródła przebudowuje się do pustej listy); `weekly-plans.service.spec.ts` — `clearWeekPlan` nie dotyka puli + `it.each` „metoda nie istnieje” dla 6 usuniętych.

**iOS** (jeden commit, kolejność 1→5, bo moduł kompiluje się w całości):

1. `CalendarView.swift:298` — usunąć `loadSavedPlanFromBackend`.
2. `WeeklyMealStore.swift` — usunąć `savedPlan`, `hasSavedPlan`, `observeSavedPlanChanges` w init, `applySavedPlanToWeek`, `saveMealPlan`/`clearSavedPlan`, `loadSavedPlanFromBackend`, `saveMealPlanToBackend`, `clearSavedPlanFromBackend`, `handleRemoteSavedPlanChanged`, `scheduleSavedPlanReload`, `mapSavedPlan`, `calendarUsageCounts`, `syncSavedPlanSelectionFlagsWithCalendar`, `cleanupCalendarAndSync`, `syncEntries`, `markAsSelected/Available`, `mutateEntries`, persystencję `saved_plan.json`; części w `resetLocalPlanningState`; w `init` jednorazowe `deleteLegacySavedPlanFile()` (`try? removeItem`).
3. `WeeklyPlanStore.swift` — usunąć `fetchSavedPlan`/`saveSavedPlan`/`observeSavedPlanChanges` z obu protokołów i obu implementacji, DTO `BackendSharedMealPlanDTO`/`ItemDTO`/`BackendSavedPlanChangedDTO`.
4. `SavedMealPlan.swift` — usunąć `PlanEntry`, `SavedMealPlan` (+ extension); **zostawić** `PlanMeal`, `DayMealPlan`.
5. Usunąć `ViewModels/MealPlanViewModel.swift`. Komentarze: `MealSlot.swift:16`, `PlanChangeNotificationService.swift:348`; gałąź `SAVE_PLAN` w kopii powiadomień zostaje na jedno wydanie.

**Dane** (po deployu backendu, dev → prod): diagnostyka `count(*)` puli i zapytanie o tygodnie z pulą bez PlanItemów (spodziewane 0); `pg_dump -t "SharedMealPlan" -t "SharedMealPlanItem" --data-only` → `DELETE FROM "SharedMealPlanItem"; DELETE FROM "SharedMealPlan";` jako osobny krok konserwacyjny.

---

## B2. `replaceRecipeId` — podmiana dania w jednej transakcji (~3,5 h)

**Backend:**

- `dto/upsert-week-slot.dto.ts`: `@IsOptional() @IsUUID() replaceRecipeId?: string` (dekoratory nie działają na WS — strażnik w serwisie).
- `weekly-plans.service.ts`: `parseReplaceRecipeId(value, recipeId)` (UUID albo `VALIDATION_ERROR`; równe `recipeId` = brak podmiany — `PlanSlotPickerSheet` wysyła edytowany przepis także przy zmianie samego audytorium). Przed transakcją: przy podmianie bez `participantIds` pobrać `memberIds`. W transakcji po `weeklyPlan.upsert`: `findFirst` starego wariantu → `planItem.delete` (kaskada uczestników/zjedzonych) **przed** liczeniem limitów; `effectiveParticipantIds` = DTO wygrywa, inaczej przejęte audytorium ∩ członkowie (pełny zbiór lub pusty → `[]`); porcje przez istniejące `resolveUpdatedPlannedServings` (ręczna wartość przeżywa podmianę); obie gałęzie zwracają `changeKind: 'REPLACED'` + `replacedItemIds`; `planItem.create` w `try/catch` P2002 → `AppException('CONFLICT', …, 409)` (dziś 500).
- `weekly-plans.gateway.ts`: push także dla `REPLACED` (`CREATED || REPLACED`); broadcast bez zmian — nadal `action: 'UPSERT_SLOT'` (iOS `singleChangeText` nie ma `default`, nowy string zgasiłby powiadomienie).
- Testy: `weekly-plans.service.spec.ts` — nowy `describe('upsertWeekSlot — replaceRecipeId')` (~12 przypadków: delete+create w jednej tx, przejęcie audytorium, DTO wygrywa, `[]` = Wspólne, porcje ręczne zostają, porcje auto przeliczone, równe id nic nie kasuje, podmiana na obecny przepis = update, limity po usunięciu, P2002 → CONFLICT, nie-UUID → VALIDATION_ERROR, duch nie blokuje); nowy `weekly-plans.gateway.spec.ts` (jeden broadcast `UPSERT_SLOT`, push dla REPLACED/CREATED, brak dla DETAILS_CHANGED/NOOP).

**iOS:** `WeeklyPlanStore.swift` — `replaceRecipeId: UUID?` w `WeeklyPlanRepository` i `String?` w `WeeklyPlanTransportClient`, transport wysyła pole tylko gdy ≠ `recipeId`, repozytorium przekazuje `uuidString`; `WeeklyMealStore.upsertWeekSlot` — bez wstępnego `removeWeekSlot` (optimistic update i rollback bez zmian); opcjonalnie `UserFacingErrorMapper`: „already assigned to that day and meal slot” → „Ten przepis jest już w tym slocie.” Wywołujący (`AddToPlanSheet`, `PlanSlotPickerSheet`, `WeeklyPlanView`) bez zmian sygnatury.

---

## B3. Hooki składu gospodarstwa — duchy i auto-porcje (~5,5 h)

- `utils/week-formatting.util.ts`: `currentWeekStart(now = new Date()): Date` — poniedziałek bieżącego tygodnia jako północ UTC (spójne z `parseWeekStart`); testy w istniejącym spec-u (`it.each` poniedziałek/czwartek/niedziela 23:59/przełom roku + round-trip przez `parseWeekStart`).
- Nowy `utils/plan-roster.util.ts` — czyste funkcje na `tx` (wzorzec `settleHouseholdAfterMemberLeft`, bez DI i bez cyklu modułów):
  - `onMemberLeft(tx, householdId, userId, now)`: dla tygodni ≥ bieżący poniedziałek: itemy, gdzie odchodzący był **jedynym** uczestnikiem → `planItem.deleteMany` (kaskada); potem `planItemParticipant.deleteMany` i `planItemConsumption.deleteMany` dla tego usera; `newMemberCount = membership.count`; przeliczenie auto-porcji (`reDeriveSharedServings(old = new+1, new)`); `shoppingList.updateMany({ weekStart >= monday }, isStale: true)` (nie `markShoppingListStale` — upsert zakładałby listy dla tygodni bez listy); zwraca `{ touchedWeekStarts, deletedItemIds, reDerivedItemCount }`.
  - `onRosterChanged(tx, householdId, old, new, now)`: `planItem.updateMany({ plannedServings: clamp(old), participants: { none: {} }, weeklyPlan: { householdId, weekStart ≥ monday } }, { plannedServings: clamp(new) })` + stale tylko gdy coś zmieniono. Udokumentowana granica: ręczna wartość równa staremu składowi jest nieodróżnialna od auto (jak w `resolveUpdatedPlannedServings`; docelowo kolumna `servingsMode`). Przeszłe tygodnie nietknięte.
- Miejsca wywołań (w istniejących transakcjach, po `settleHouseholdAfterMemberLeft`, pomijając wynik `DELETED`): `households.service.ts` `acceptInvitation` (pętla opuszczanych domów → `onMemberLeft`; wokół `upsert` członkostwa liczniki przed/po → `onRosterChanged`), `removeMember` (uwaga: odchodzący to `memberUserId`, nie `userId`), `leave`; `users.service.ts deleteAccount` — hook **przed** `tx.user.delete`, dopóki wiersze uczestnictwa istnieją. Zwracać `touchedWeekStarts` (addytywnie) z `removeMember`/`leave`/`acceptInvitation`.
- `households.gateway.ts` (P2, zalecane): po `emitMembersChanged` dla każdego `touchedWeekStart` emit `weeklyPlans:weekChanged` i `shoppingListChanged` z `action: 'MEMBERSHIP_CHANGED'` (iOS przeładowuje tydzień bez powiadomienia — `singleChangeText` `default: nil`).
- Testy: nowy `plan-roster.util.spec.ts` z pamięciowym store’em `tx` (duchy tylko ≥ poniedziałek; item solo skasowany, współdzielony zostaje; przeszłość nietknięta; 2→1 i 1→2; ręczne 4 zostaje; imienne nietknięte; stale marking; 13→14 nic; `touchedWeekStarts`).
- **Dane** (po deployu; dev → prod): diagnostyka (duchy uczestników/zjedzonych ≥ poniedziałek i w przeszłości; lista itemów do skasowania — przejrzeć), backup `CREATE TABLE "_bak_wp04_*" AS SELECT …`, czyszczenie w jednej transakcji (itemy bez żywego składu → uczestnicy-duchy → zjedzone-duchy → `isStale`), ponowna diagnostyka = 0 dla przyszłości. Historycznego dryfu porcji **nie** poprawiać hurtowo (nieodróżnialne od ręcznych).

---

## B4. `RecipesService` — jeden normalizator, makro liczone przy tworzeniu (~4 h)

- Nowy `src/common/normalize-text.util.ts` (wariant **zwijający białe znaki** — ten, którym loader pisze `normalizedName`); pięć kopii przez re-eksport/import: `recipes/ingredient-amount.util.ts` (re-export), `weekly-plans/utils/text-normalization.util.ts` (re-export), `recipes.service.ts` (usunąć), `prisma/seed.ts`, `scripts/load-ingredient-catalog.ts`, `scripts/normalize-ingredients-polish.ts` (piąta kopia spoza audytu — pisze `normalizedName`).
- `recipe-nutrition.util.ts`: `roundTotalsForStorage` (zaokrąglenie do całości) współdzielone z `scripts/recompute-recipe-nutrition.ts` (usunąć lokalne `forStorage`).
- `recipes.service.ts`: usunąć `NormalizedIngredient`, trzy tabele (`:105-141`), `normalizeText`/`normalizeIngredientAmount` (`:218-287`); importy z utili; nowe prywatne `resolveRecipeIngredients` (strażniki: jednostka ∈ `ALLOWED_UNITS`, `amount > 0`, brak duplikatów `ingredientId` — nowa unikalność z A3 dawałaby 500; select z polami `nutrition*Per100` + `gramsPerPiece`; błąd utilu → `VALIDATION_ERROR`) i `resolveRecipeNutrition` (**serwer liczy zawsze**, gdy są składniki; wartości z DTO ignorowane poza `nutritionSalt`; brak makro/`gramsPerPiece` → `VALIDATION_ERROR` z `details`); `create` z `resolveSuitableMealTypes` jak importer; cała walidacja przed `recipe.create`; `invalidateRecipesList` zostaje.
- Testy: nowy `ingredient-amount.util.spec.ts` (15 wierszy tabeli w tym `przyprawa uniwersalna` → 4 g, bramka kategorii, `normalizeText` zwija spacje, parytet `ALLOWED_UNITS` z DTO); nowy `recipes.service.spec.ts` (12 przypadków: makro ze składników ignoruje DTO, sztuki przez `gramsPerPiece`, odrzucenie bez makro / bez `gramsPerPiece`, 4 g dla przyprawy, `suitableMealTypes` z klasyfikatora, cache, duplikat id, nieznana jednostka, błąd bramki → 400, bez składników makro z DTO, nie-członek).
- **Dane:** `SELECT` przepisów z `authorId <> bot` (spodziewane 0 na dev i prod → nic do naprawy); jeśli są: backup, `UPDATE normalizedAmount` dla przyprawy uniwersalnej, `recompute --db-only --write`.

---

## B5. Alergeny — biała lista, klamry makr, unia w iOS (~4,5 h)

**Backend:** nowy `src/common/allergens.ts` (`ALLERGEN_IDS` = 7 rawValue z `DietPreference.swift`, `isAllergenId`, `normalizeAllergenIds` → trim/lower/dedupe/sort, nieznane → `VALIDATION_ERROR` z listą w komunikacie); `users.service.ts` — użyć w `updatePreferences`, `clampMacro` 0..400/300/800 (`null` zostaje, nie-liczba → `VALIDATION_ERROR`); `update-preferences.dto.ts` — `@IsIn(ALLERGEN_IDS, { each: true })` + komentarz, że WS ich nie uruchamia. Testy: `common/allergens.spec.ts`, nowy `users/users.service.spec.ts` (normalizacja, odrzucenie bez zapisu, pusta lista, klamry, `null`, wartości nieliczbowe, regresja `calorieGoal`/`activityLevel`/`timeZone`).

**Dane (przed iOS!):** `SELECT unnest(allergens)` spoza listy i makra poza zakresem; jeśli są: backup + `UPDATE` (strip nieznanych, `LEAST/GREATEST` null-safe).

**iOS:** `SettingsView.swift` — `allergenTokens`/`unknownAllergens`/`allergensPayload` (computed), `toggleAllergen` i debounced sync wysyłają unię znane ∪ nieznane, `hasCustomisedPreferences` po tokenach, reset czyści wszystko (celowo); `WelcomeView.swift` — `@State unknownAllergens` z init, zapis unii; `SessionStore.swift` — dedupe/trim przy zapisie, komentarz przy `saveUserPreferences`, log gdy `ok:false` (dziś odrzucony zapis wygląda jak sukces). `RecipePersonalization.allergens(from:)` bez zmian (filtr).

---

## Kolejność commitów i wdrożenia

**Backend `fix/fundamenty-b`** (jeden PR, osobne commity): B2 → B1 (oba dotykają gatewaya) → B3 → B4 → B5 (+ `commands.txt`). CI: `backend-ci.yml` biegnie na PR.
**iOS `fix/fundamenty-b`**: B2 (replaceRecipeId) → B1 (martwa pula) → B5 (unia). Merge **po** deployu backendu na prod i po SQL z B5.

1. Backend → `develop` → dev compose: testy w kontenerze, `tsc --noEmit`, e2e, `ws:smoke`; dane B3/B5 na dev.
2. Backend `develop` → `main` (prod), `/ops/health` z nowym commitem; dane B3/B5/B1 na prod (diagnostyka → backup → czyszczenie → weryfikacja); `UPDATE "ShoppingList" SET "isStale"=true`.
3. iOS → `develop` → `main` → TestFlight.
4. Follow-up (następne wydanie): usunąć stub `getSavedPlan` + payload, gałąź `SAVE_PLAN` w iOS, migracja `DROP TABLE "SharedMealPlanItem", "SharedMealPlan"`.

## Weryfikacja

- Kontener: **najpierw** `docker compose exec api rm -rf /app/src /app/test` (docker cp scala katalogi — usunięte spec-i puli zostałyby i przechodziły), potem `docker cp src test jest.config.js tsconfig.json`, `npx jest src/weekly-plans src/households src/recipes src/users src/common`, pełne `npx jest`, `npx tsc -p tsconfig.json --noEmit`, e2e `npx jest --config ./test/jest-e2e.json --runInBand`; na końcu `docker compose up -d --build api`.
- `ws:smoke` (w kontenerze): `getSavedPlan` → `{ok:true, items:[]}`; `listByHousehold` → timeout (oczekiwany); `upsertWeekSlot` z `replaceRecipeId` → `changeKind: REPLACED`, tydzień bez starego dania; `replaceRecipeId: "abc"` → `VALIDATION_ERROR`; `households:removeMember` → posiłki solo znikają, wspólne 2→1; `users:preferences:update` z `shellfish` → `VALIDATION_ERROR`, z `proteinG: 9999` → 400 w bazie; `recipes:create` z łyżeczką przyprawy uniwersalnej → `normalizedAmount: 4`, makro policzone.
- iOS: `xcodebuild -project "weekly meals.xcodeproj" -scheme "weekly meals" -destination "generic/platform=iOS Simulator" build`; na dwóch telefonach: podmiana dania = jeden banner i brak mignięcia pustego slotu; tryb samolotowy w trakcie zapisu → rollback do starego dania; partner opuszcza dom → jego solo znikają, wspólne 2→1, „Zapisz porcje” działa, przeszły tydzień nietknięty; powrót partnera → 1→2, ręczne 4 zostaje; stara apka na nowym backendzie przełącza tygodnie bez 18 s zwłoki; alergeny: `UPDATE … ARRAY['gluten','celery']` → toggle jaj → w bazie `{celery,eggs,gluten}`.
