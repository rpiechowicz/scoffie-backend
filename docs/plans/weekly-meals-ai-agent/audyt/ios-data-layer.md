## iOS data-layer correctness — findings

### F1 — `szczypta` ingredients are silently dropped on the phone (118 of 745 catalog ingredients, 69/89 recipes) — **P0**

**Evidence**

- `weekly-meals-ios/weekly meals/Networking/Recipes/BackendRecipeDTOs.swift:170-172`
  ```swift
  let mappedIngredients = ingredients.compactMap { item -> Ingredient? in
      let unit = IngredientUnit(rawValue: item.unit)
      guard let mappedUnit = unit else { return nil }
  ```
- `Models/Components/RecipesModel.swift:61-70` — `IngredientUnit` = `g, kg, ml, l, szt, łyżeczka, łyżka, szklanka`; no `szczypta`.
- Backend serves the raw unit on both projections: `weakly-meals-backend/src/recipes/recipes.service.ts:54` and `:318` (`unit: true`), and accepts it on write: `src/recipes/ingredient-amount.util.ts:14-25` (`ALLOWED_UNITS … 'szczypta'`), `src/recipes/dto/create-recipe.dto.ts:27`.
- Data (computed in memory from `prisma/catalog/recipes-catalog-full-v2.json`, 89 recipes): 118/745 ingredients have unit `szczypta` → 69/89 recipes lose rows; names: `pieprz czarny` ×67, `sól` ×50, `papryka ostra mielona` ×1. Across all import files: 303 `szczypta` rows.
- What the phone shows: `RecipeDetail.swift:499-516` renders `recipe.ingredients(forServings:)` → list without salt/pepper; kcal/macros unaffected (from `nutritionKcal…`, `BackendRecipeDTOs.swift:206-213`); shopping list unaffected (server uses `normalizedUnit`, see FINE list).

**Why it escalates:** the assistant's tools read `RecipesService` (12 ingredients) while the proposal card on the phone shows 10; any "ingredient balance / what you need to buy" the assistant explains will not match the visible list; a recipe the assistant creates/edits with a pinch of salt loses it on the phone with no error (compactMap, no telemetry). Also `BackendRecipeIngredientDTO` (`:5-15`) does not decode `normalizedAmount/normalizedUnit`, so the client cannot reproduce the server's balance math at all.

**Fix (iOS only):** add `case pinch = "szczypta"` to `IngredientUnit` + a `kitchenRounded` branch (whole pinches, min 1); consider a last-resort `.other(String)` so unknown units never delete rows; decode optional `normalizedAmount/normalizedUnit` into `Ingredient`; bump cache to `recipes_catalog_cache_v11`. No migration. **Effort:** 1 h. **Verdict: FIX-BEFORE-PHASE-0.**

### F2 — Shopping list shows "0 g" for pinch-level spices (and "1 szt" for half pieces) — **P1**

**Evidence**

- `Models/Components/ShoppingItemModel.swift:12-15`
  ```swift
  let roundedValue = Int(totalAmount.rounded(.toNearestOrAwayFromZero))
  ```
  displayed as `"\(item.formattedAmount) \(item.unit)"` (`Views/Dashboard/Products/ProductsView.swift:386`).
- Backend normalizes `1 szczypta sól` → `6 g/tsp × 1/16 = 0.375 g` (`src/recipes/ingredient-amount.util.ts:34-36,114-128`; `recipes.service.ts:266-282`), pepper `2.3/16 = 0.14 g`; sums are stored unrounded (`src/weekly-plans/services/shopping-list.service.ts:148-166`), portion factor `plannedServings / recipe.servings` (`:103-105`). One or two planned meals ⇒ "Sól 0 g", "Pieprz czarny 0 g". `0.5 szt` ⇒ "1 szt"; `0.25 szt` ⇒ "0 szt".

**Why it escalates:** the assistant's ingredient-balance math from `normalizedAmount` says 0.375 g while the user sees 0 g; the same formatter will be reused for the proposal card. **Fix (iOS):** extract `RecipeDetailFormat.kitchenRounded` (`RecipeDetail.swift:1380-1392`, currently `private`) into a shared formatter (g/ml < 10 → 1 decimal, min 0.1; szt → halves) and use it in `ShoppingItem.formattedAmount`; optionally round `totalAmount` server-side in the snapshot. **Effort:** 1 h. **Verdict: FIX-BEFORE-PHASE-0.**

### F3 — Two different week-start rules; on Sundays with a Sunday-first region the app shows the NEXT week — **P1**

**Evidence**

- `ViewModels/DatesViewModel.swift:19-25`
  ```swift
  let weekStart = calendar.dateInterval(of: .weekOfYear, for: targetDate)?.start
  let monday = calendar.date(byAdding: .day, value: calendar.firstWeekday == 1 ? 1 : 0, to: weekStart)
  ```
  With `firstWeekday == 1` (e.g. region US, language Polish) on a Sunday the interval starts _that_ Sunday, +1 day = next Monday ⇒ `weekStartISO` (`:34-39`) = next week for Plan/Calendar/Shopping.
- `Views/Dashboard/Recipes/Components/AddToPlanSheet.swift:707-711` uses a fixed `Calendar(identifier: .gregorian); firstWeekday = 2` and its own `weekStartFormatter` (`:694`) ⇒ "Dodaj do planu" writes to the correct week while the tabs display another.
- Backend takes the string verbatim: `src/weekly-plans/utils/week-formatting.util.ts:6-16`.

**Why it escalates:** the assistant's notion of "this week" is Monday-based server-side; on Sundays such users would not see the proposal land where the app is looking. **Fix (iOS):** one shared Monday-first calendar (`planCalendar`) used by `DatesViewModel`, `AddToPlanSheet`, `WeekDateMapper` (`Models/Stores/WeeklyPlanStore.swift:138-172`). **Effort:** 0.5-1 h. **Verdict: FIX-BEFORE-PHASE-0.**

### F4 — REST client (the one the assistant will inherit) has no refresh/401 recovery; access token expires in 30 d while sockets keep working — **P1**

**Evidence**

- `Networking/Integrations/IntegrationsAPIClient.swift:92-94` (throw `notAuthenticated` if no token), `:103` (`timeoutInterval = 30`), `:116-120` (401 → `code = "UNAUTHORIZED"`), no retry, `URLSession.shared`, plain `JSONDecoder()` (`:123`).
- No `auth/refresh` call anywhere in iOS (grep); backend has it: `src/auth/auth.controller.ts:92`, `src/auth/auth.service.ts:207-229`; default expiry `'30d'` (`src/auth/jwt-expiration.util.ts:7`).
- `Models/Stores/CookidooIntegrationStore.swift:148` maps `UNAUTHORIZED` to a "Sesja wygasła" string, no logout/refresh. Socket carries no token (`SocketIORecipeSocketClient.swift:15-31`), so the rest of the app never notices.
- Dates travel as strings parsed ad hoc in two places (`SessionStore.swift:162-172`, `CookidooIntegrationStore.swift:160-168`).

**Why it escalates:** every assistant call would fail with UNAUTHORIZED after 30 days while the app looks healthy. **Fix:** generic authenticated client (401 → refresh once → retry → logout on failure), shared decoder with ISO-8601 + fractional fallback, consistent `IntegrationsAPIError.backend(code:status:)`. **Effort:** 3-4 h iOS. **Verdict: FOLD-INTO-PHASE-0** (it _is_ the auth fix).

### F5 — WS error `code` is thrown away; UI maps errors by English substrings — **P1**

**Evidence**

- Backend sends codes on every WS error: `src/common/ws-response.ts:59-71` (`code: extractCode(response) ?? STATUS_CODE_MAP[status] ?? 'HTTP_ERROR'`), catalogue in `src/common/app-error-code.ts:1-29`.
- iOS decodes it (`Networking/Recipes/RecipeProtocols.swift:57-63` `let code: String?`) then drops it: `WebSocketRecipeTransportClient.swift:37` `throw RecipeDataError.serverError(message: envelope.error ?? …)` (same at `:57,79`; `WeeklyPlanStore.swift:404`; `WebSocketShoppingListTransportClient.swift:99`).
- `Models/Stores/UserFacingErrorMapper.swift:34-65` substring-matches; `:67 return baseMessage` leaks raw English for everything else — e.g. `'Recipe not found'`, `'Plan item not found'`, `'Planned meal not found in this slot'`, `'Shopping list is empty and cannot be archived'` (`shopping-list.service.ts:573`), `PLAN_SLOT_LIMIT_REACHED` / `'Not a household member: …'` (`weekly-plans.service.ts:221-237,455-465,664-665`). Backend wording is mixed: Nest exceptions English, Cookidoo `AppException`s Polish (`cookidoo-integration.service.ts:135,153,174`), `'Nieprawidłowa data'`.

**Why it escalates:** the deterministic validator will add many new codes (allergen/diet/kcal/slot); a substring mapper needs one line per wording and breaks silently when backend copy changes. **Fix:** `RecipeDataError.backend(code:message:status:)` filled from the envelope; mapper code-first, message fallback; one error enum shared with the REST client (F4). Backend optional: add codes for the plain `NotFoundException`s. **Effort:** 2-3 h iOS. **Verdict: FOLD-INTO-PHASE-0.**

### F6 — Plan-embedded recipe projection is thinner than the catalog one — **P2**

**Evidence:** `src/weekly-plans/weekly-plans.service.ts:34-55` selects no `suitableMealTypes`, `sourceProvider`, `sourceRecipeId`, `sourceInstructions`, and `imageUrl` is raw (no `resolveRecipeImageUrl`, which lives only in `recipes.service.ts:380-390`). On iOS the `PlanMeal.recipe` snapshot therefore has `suitableSlots == [base]` and `isThermomix == false`; the detail sheet is right only because empty steps force a refetch (`RecipeCatalogStore.swift:162-168`). **Why it escalates:** proposal cards built from plan snapshots vs catalog entries disagree on "Pasuje też na" / Thermomix badge / image. **Fix (backend):** reuse `recipeListSelect` + `effectiveSuitableMealTypes`/`resolveRecipeImageUrl` for plan items; or iOS merges by id with the catalog. **Effort:** 1 h. **Verdict: LATER.**

### F7 — Three different "which household" rules, and `households.create` allows a second membership — **P2**

**Evidence:** login = oldest membership (`src/auth/auth.service.ts:249-254` `orderBy: { createdAt: 'asc' }`); restore = `user.memberships.first` (`SessionStore.swift:1391`) with no `orderBy` in `users.service.ts:70-79`; shopping fallback = `households:findAll` newest-first (`households.service.ts:76-79` `'desc'`) after matching the hard-coded name `"Home"` (`WebSocketShoppingListTransportClient.swift:21,64-78`); `create` adds a membership without checking existing ones (`households.service.ts:88-100`); only `acceptInvitation` enforces the single-household rule (`:161-181`). **Why it escalates:** an assistant tool calling `households:create` (or any API client) produces a user whose household differs by entry path. **Fix:** guard `create` (409 if a membership exists), `orderBy createdAt asc` in `getMe`, delete the "Home" fallback. **Effort:** 1 h backend + 0.5 h iOS. **Verdict: FOLD-INTO-PHASE-0.**

### F8 — Catalog cache is not household-scoped and survives logout — **P2**

**Evidence:** `RecipeCatalogStore.swift:36-52` single file `recipes_catalog_cache_v10.json` (holds per-household `favourite` flags); no removal in `logout()`/`clearRuntimeStores` (grep `recipes_catalog_cache` → only the store). Shopping cache is namespaced `\(userId)_\(householdId)` (`ShoppingListStore.swift:55-58`) — inconsistent. **Fix:** namespace by householdId or delete on logout. **Effort:** 0.5 h. **Verdict: LATER.**

### F9 — Unit labels are not declined — **P2**

**Evidence:** `RecipeDetail.swift:1360` `return "\(amount) \(ingredient.unit.rawValue)"` ⇒ "1,5 łyżeczka", "2 szklanka", "3 łyżka" (catalog has `0.5 łyżeczka sól` in 15+ recipes; at 1 serving → `kitchenRounded` 0.5). `PolishPlural.swift:30-48` covers only porcja/posiłek. **Fix:** `IngredientUnit.label(for:)` via `PolishPlural.form` (fractions → "łyżeczki"). **Effort:** 1 h. **Verdict: LATER** (do with F1).

### F10 — Dead code inventory (safe to delete now) — **P2**

- `Models/Stores/ProductModel.swift` (104 lines), `Constants/HeaderConstants.swift` + `Models/Components/HeaderModel.swift`, `ViewModels/MealPlanViewModel.swift` (142 lines): zero references outside themselves (grep).
- After removing `MealPlanViewModel`, the pool chain is dead: `WeeklyMealStore.applySavedPlanToWeek / saveMealPlan / clearSavedPlan / saveMealPlanToBackend / clearSavedPlanFromBackend / markAsSelected / markAsAvailable / cleanupCalendarAndSync` (`WeeklyMealStore.swift:388-520, 643-728`), `SavedMealPlan`/`PlanEntry` (`SavedMealPlan.swift:345-452` — keep `PlanMeal`/`DayMealPlan` in the same file), `saved_plan.json`, transport `fetchSavedPlan/saveSavedPlan/observeSavedPlanChanges` + `BackendSharedMealPlanDTO` (`WeeklyPlanStore.swift:84-95, 389-452`). The only live caller is `CalendarView.swift:298 loadSavedPlanFromBackend` whose result is read by no view — one wasted `weeklyPlans:getSavedPlan` round-trip per week switch. Keep `resetLocalPlanningState` (`SessionStore.swift:899,1099`) minus its savedPlan part.
- `ShoppingListStore.selectArchivedList` (`ShoppingListStore.swift:257-267`) + repo/transport/protocol (`weeklyPlans:selectShoppingListArchive`): no UI caller.
- `ProductsView.historySheet` (`:692-855`): `showHistorySheet` is only ever set to `false` (`:11,295,711,764,821`) — unreachable.
- Backend keeps its saved-plan events (legacy path in `shopping-list.service.ts:114-141`).
  **Recommendation:** delete; explicitly do not build "apply proposal" on `applySavedPlanToWeek` (positional, sequential, non-atomic). **Effort:** 2-3 h. **Verdict: LATER.**

---

## Checked and found FINE

- Per-serving math: single division `portions / max(1, servings)` (`RecipesModel.swift:339-363`); `PlanMeal.nutritionPerPerson = nutrition(forServings: effectiveServings/eaterCount)` (`SavedMealPlan.swift:82-128`) — auto rule gives exactly 1.0 serving/person, so kcal = whole-recipe/servings; no double halving anywhere (`grep nutritionPerServing|nutritionPerPerson|scaled(by`).
- Calendar counter sums `Double` and rounds once (`CalendarView.swift:96-115`); `knownHouseholdMemberCount` is nil until members load (`:77-80`), so no ×N flash; Plan card/row/EditorialMealCard use the same helper (`PlanDayCard.swift:242-247`, `PlanMealSlotRow.swift:150`, `EditorialMealCard.swift:208`).
- Backend default `plannedServings` = member count for shared meals (`weekly-plans.service.ts:180,683-697`) — matches the iOS `eaterCount` rule; catalog convention confirmed (all 89 recipes `servings: 2`, e.g. kcal 894 ⇒ 447/serving).
- `toAppRecipe` row drop only on non-UUID id / unknown mealType; MealType parity 6/6 (`MealSlot.swift:152-172` ↔ `prisma/schema.prisma:634-641`, `src/common/meal-types.ts:8-15`); `RecipePage.receivedCount` protects pagination (`RecipeProtocols.swift:18-22`, `ApiRecipeRepository.swift:12-18`); plan items would drop under the same conditions only (`WeeklyPlanStore.swift:476-480`).
- Catalog cache: v10 + 12 h TTL, but a full background `reload()` runs on every cold start (`RecipeCatalogStore.swift:86-97`) and on socket reconnect (`:72-83`); server list cache TTL 90 s (`recipes-cache.service.ts:16-17`) — a prod title/macro fix reaches the phone at next launch/reconnect. `loadRecipeDetail` fetches unknown ids via `recipes:findById` and appends (`:161-183`) — assistant proposals referencing uncached ids resolve.
- Departments: backend enum (`shopping-department.enum.ts:3-21`) and iOS constants (`ProductConstants.swift:5-23`) are the same 17 labels; iOS order (`ProductsView.swift:74-92`) = `DEPARTMENT_ORDER`; unknown labels rank 999 but are shown under their own header (not folded into "Inne"); DB `RecipeIngredient.department` = `Ingredient.category` from `CATEGORY_BY_FILE` (`load-ingredient-catalog.ts:7-25`, `import-recipes-from-json.ts:478`) using the same labels; `RecipeDietProfile.Department` normalized names match (`RecipeDietProfile.swift:301-308`).
- `UserFacingErrorMapper` substrings do match the _current_ real messages (`households.service.ts:56,114,142,149,157,179`, `auth-checks.util.ts:33`); the differently-worded `households.service.stub.ts` is unreferenced.
- Session restore: userId from UserDefaults → Keychain → JWT `sub` (`SessionStore.swift:1533-1542, 2104-2124`; backend signs `{ sub }` `auth.service.ts:234`); householdId mirrored in both stores; membership re-validated via `users:me` on every restore with removal handling (`:1355-1410`); Keychain `AfterFirstUnlockThisDeviceOnly` (`KeychainService.swift:26`).
- `MealSlotConfiguration`/`MealSlotSchedule` compactMap unknown backend values and always keep core slots (`MealSlotConfiguration.swift:70-71`, `meal-types.ts:51-59`).
- `kitchenRounded` never yields 0 for non-zero input (`RecipeDetail.swift:1380-1392`); `PolishPlural` teen rule correct (`PolishPlural.swift:14-27`).
- `BackendRecipeDTO` decoding tolerant: `sourceInstructions` shape `{step,text}` (`import-recipes-from-json.ts:557-560`) handled by all-optional keys (`BackendRecipeDTOs.swift:94-99,182-190`); missing `ingredients` ⇒ `[]` (`:87`).
- `isActive`: backend filters `isActive: true` in `findAll` (`recipes.service.ts:413`); `findById` does not (`:505-512`) — acceptable for planned meals referencing retired recipes.
- Shopping aggregation uses `normalizedAmount/normalizedUnit` (g/ml/szt) and `productKey = name::unit` (`shopping-list.service.ts:148-166`, `text-normalization.util.ts:3-5`), so pinch ingredients do reach the list (modulo F2 display).
- Backend `weekStart` round-trips as a string (`week-formatting.util.ts:6-20`); iOS day mapping is Monday-offset based (`WeeklyPlanStore.swift:147-172`).
- Socket ack path: 6 s timeout × 3 attempts with backoff and JSON validation (`SocketIORecipeSocketClient.swift:10-11,156-197`).
