# Weekly plan & week identity — findings

Verified against source (read-only). Line numbers refer to `weakly-meals-backend/src/...` and `weekly-meals-ios/weekly meals/...`.

---

## WP-01 · Shopping list renames/merges ingredients via regex canonicalizer ("fasola" → "Sól") — **P0**

**Evidence**
- `weekly-plans/services/shopping-list.service.ts:150-154,163`: `canonicalName = canonicalizeIngredientName(ingredient.name, baseUnit); productKey = normalizeProductKey(canonicalName, baseUnit)` … `name: canonicalName`.
- `weekly-plans/utils/department-classifier.util.ts:142`: `if (/sol/.test(raw)) return 'Sól';` (no word boundary) — also `:111 /bavette|wołowin|wolowin/ → 'Wołowina bavette'`, `:124 /soczewic/ → 'Soczewica brązowa'`, `:133 /seler/ → 'Seler naciowy'`, `:107/:108/:112` collapse every chicken/turkey/kiełbasa cut.
- `RecipeIngredient.name` is already the canonical catalog name (`scripts/import-recipes-from-json.ts:473 name: found.name`), so this pass is pure loss.
- Computed over `prisma/catalog/recipes-catalog-full-v2.json` (131 distinct names): merges → `Sól ← {fasola biała z puszki, fasola czerwona z puszki, sól}`, `Wołowina bavette ← {wołowina, wieprzowina i wołowina mielona}`, `Kurczak ← {filet z kurczaka, noga z kurczaka}`, `Indyk ← {filet z indyka, indyk mielony}`, `Kiełbasa ← {biała, śląska}`; renames `seler korzeniowy → Seler naciowy`. Affected recipes today: *Fasolka po bretońsku* (480 g beans → "Sól 480 g"), *Chili con carne* (240 g), *Quesadilla z serem i fasolą* (200 g), *Bitki wołowe* (500 g → "Wołowina bavette"), *Spaghetti…*, *Zapiekanka…*, *Rosół*, *Krupnik*. Across the 403 txt names 34 more mis-hits (`fasolka szparagowa → Sól`, `soczewica czerwona → brązowa`, …).
- Department labels themselves resolve correctly (verified all 17 `CATEGORY_BY_FILE` values through `DEPARTMENT_KEYWORD_RULES`), but the merged row inherits whichever department came first.

**Why it escalates**: the assistant's catalog digest and ingredient-balance math will use `Ingredient.name/normalizedName`; the list users see uses different names and summed-across-products amounts → "why does it want 480 g of salt?" and every balance answer is wrong. Archives freeze the wrong names.

**Fix** (backend only): drop `canonicalizeIngredientName`; use `ingredient.name` verbatim (better: `productKey = ingredientId::normalizedUnit`, needs `ingredientId` in the select), department = `Ingredient.category` mapped once. Keep the "(unit)" disambiguation. After deploy run `UPDATE "ShoppingList" SET "isStale"=true` (non-stale snapshots don't rebuild). Existing `isChecked` state for renamed keys is lost (acceptable). Add a regression test with `fasola`. **Effort 2–3 h. FIX-BEFORE-PHASE-0.**

---

## WP-02 · Week key is unvalidated on the server and locale-dependent on iOS — **P1**

**Evidence**
- `weekly-plans/utils/week-formatting.util.ts:7-8`: `const parsed = new Date(weekStart); if (Number.isNaN(...))` — accepts `'2026-08-31T00:00:00+02:00'` (= `2026-08-30T22:00Z`, a *different* `WeeklyPlan`/`ShoppingList` row than `'2026-08-31'`), any weekday, any time. `weekly-plans.service.ts:137` and `:157` bypass even that (`weekStart: new Date(weekStart)` → Invalid Date → Prisma error → `INTERNAL_ERROR 500`).
- `ViewModels/DatesViewModel.swift:15,20,25`: `Calendar.current` … `dateInterval(of: .weekOfYear)` … `value: calendar.firstWeekday == 1 ? 1 : 0`. With region/"First Day of Week" = Sunday: on a Sunday the interval starts *that* Sunday, +1 → **next** Monday → Plan/Calendar/Products show next week and "today" is not in `dates`. With Saturday-first (`firstWeekday == 7`): no correction → `weekStartISO` is a **Saturday** → backend happily stores Saturday-keyed `WeeklyPlan` rows.
- `Views/Dashboard/Recipes/Components/AddToPlanSheet.swift:707-716` computes its own Monday with `firstWeekday = 2` (correct) and `:694` sends it → same household writes two overlapping "weeks"; `WeeklyMealStore.swift:531` then ignores the `weekChanged` for the sheet's week because `observedWeekStart` differs.
- DB rows at risk: only from devices with non-Monday `firstWeekday` (developer's pl_PL never triggers). Check: `SELECT * FROM "WeeklyPlan" WHERE EXTRACT(DOW FROM "weekStart") <> 1 OR "weekStart"::time <> '00:00'` (same for `ShoppingList`, `SharedMealPlan`, `ShoppingItemCheck`, `ShoppingListArchive`, `ShoppingListArchiveState`).

**Why it escalates**: `weekStart` is the primary key of every write the assistant makes; a proposal for "next week" must land on the same row iOS reads.

**Fix**: backend `parseWeekStart` → `/^\d{4}-\d{2}-\d{2}$/`, build with `Date.UTC`, require `getUTCDay() === 1`, else `VALIDATION_ERROR`; use it in `getByHouseholdAndWeek`/`create`. iOS: one `PlanWeek` helper (gregorian, `firstWeekday = 2`, `.current` tz) used by `DatesViewModel`, `AddToPlanSheet`, `WeekDateMapper`. Run the diagnostic SQL; migrate any non-Monday rows by hand. **Effort 1 h + 1 h. FIX-BEFORE-PHASE-0.**

---

## WP-03 · Dormant pool endpoint still live and prunes PlanItems in *all* slots — **P1**

**Evidence**
- `weekly-plans.service.ts:944-951` builds `countsByMealType` for all `MEAL_TYPES_IN_DAY_ORDER`; `:1062-1066` prunes every one of them; `addressedMealTypes` (`:933`) is only used at `:1006`. So a legacy `{breakfastRecipeIds:[…]}` deletes all `PlanItem`s in SECOND_BREAKFAST/AFTERNOON_SNACK/SNACK, and `{recipeIdsByMealType:{}}` deletes the whole week's day plan — contradicting `dto/save-shared-meal-plan.dto.ts:145-147` ("reszta zostaje nietknięta").
- iOS reachability: grep shows no View calls `saveMealPlanToBackend`/`clearSavedPlanFromBackend`/`applySavedPlanToWeek`; `MealPlanViewModel(` is never instantiated; the only live use is a read (`Views/Dashboard/Calendar/CalendarView.swift:298 loadSavedPlanFromBackend`). Same for `weeklyPlans:create` (`:152-160`, raw `new Date`), `addItem` (`:162-274`, no participants), `removeItem`, `listByHousehold` (`:114-127`, loads every week with full recipes — unbounded).
- Shopping list still falls back to `SharedMealPlan` when a week has 0 `PlanItem`s (`shopping-list.service.ts:106-143`, `348-387`): remove all meals individually and a week with an old pool row shows a ghost list (only `clearWeekPlan` deletes the pool, `:805-812`).

**Why it escalates**: a whole-week "replace" that ignores `enabledMealTypes` is exactly the shape of `applyProposal`; if anyone reuses it, disabled-slot meals vanish. The fallback makes the assistant's balance math diverge from what the list shows.

**Fix**: delete the six legacy handlers + `SharedMealPlan` read path (or return `410`), drop `hasShoppingSourceData`'s pool branch, one-off `DELETE FROM "SharedMealPlanItem"; DELETE FROM "SharedMealPlan";` (verify with `SELECT count(*)` first), iOS: drop `loadSavedPlanFromBackend` call and `savedPlan` observers (can stay dormant). **Effort 2 h backend (+spec), 1 h iOS. FIX-BEFORE-PHASE-0.**

---

## WP-04 · Ghost participants/eaten marks after a member leaves — **P1**

**Evidence**
- `prisma/schema.prisma:391-392` (`PlanItemParticipant`) and `:409-410` cascade only on `PlanItem`/`User`; `Membership` (`:291-292`) is unrelated. `households.service.ts:188-198` (accept + leave others), `:588-597` (`removeMember`), `:614-619` (`leave`) and `household-cleanup.util.ts:34-59` delete only the membership.
- Consequences today: `Views/Dashboard/WeeklyPlan/WeeklyPlanView.swift:467` re-sends `participantIds: target.meal.participantIds` → `weekly-plans.service.ts:661-667` throws `PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD` → "Zapisz porcje" fails on every meal the ex-member was on. An item for `[ghost]` only is visible to nobody (`SavedMealPlan.swift:194-197`) yet still bought (`buildShoppingListBase` ignores participants). `PlanAudienceChips.swift:47-55` silently turns `[ghost]` into `[]` = "Wspólne" on the next audience edit; `resolveUpdatedPlannedServings` (`:763-766`) computes `previousAuto` from the ghost set.

**Why it escalates**: validator rule "participants ⊆ members" would reject/flag existing rows; per-person kcal divides by a phantom eater.

**Fix**: in the three membership-removal transactions delete `PlanItemParticipant`/`PlanItemConsumption` where `userId` and `planItem.weeklyPlan.householdId` match; items whose participant set becomes empty (and had participants) → delete for today/future weeks (don't silently promote to "Wspólne"); `markShoppingListStale` for touched weeks; one-off cleanup SQL (`DELETE FROM "PlanItemParticipant" p USING "PlanItem" i, "WeeklyPlan" w WHERE … NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."userId"=p."userId" AND m."householdId"=w."householdId")`). **Effort 2–3 h. FIX-BEFORE-PHASE-0.**

---

## WP-05 · "Change recipe" = REMOVE + UPSERT, two acks, no server-side replace — **P1**

**Evidence**: `Models/Stores/WeeklyMealStore.swift:235-250` (`removeWeekSlot` then `upsertWeekSlot`); callers `AddToPlanSheet.swift:673,691`, `PlanSlotPickerSheet.swift:454`. `dto/upsert-week-slot.dto.ts:19-60` has no `replaceRecipeId`; `weekly-plans.service.ts:354-356` documents that upsert never removes other variants.

**Failure window**: remove acked, upsert fails (ack timeout 6 s×3, `PLAN_*` caps, `NOT_FOUND`) → server slot empty; iOS rolls back to `previous` (`:275`) showing a meal that no longer exists; the REMOVE broadcast's 250 ms refetch then blanks it. Old meal's participants/servings/eaten marks are gone. Also 2× `weekChanged`, 2× `shoppingListChanged`, 2 push batch entries per swap. Concurrent same-recipe create from two phones hits the unique index and surfaces as `INTERNAL_ERROR` (P2002 is caught in `addItem :254-264` but not in `upsertWeekSlot :469-481`).

**Fix**: add `replaceRecipeId?: string` to `UpsertWeekSlotDto`; in the same `$transaction` delete that variant then create; catch P2002 → `CONFLICT`. iOS: single call. **Effort 1.5 h + 0.5 h. FIX-BEFORE-PHASE-0** (applyProposal is swap-heavy; expose it as `WeeklyPlansService.replaceSlot`).

---

## WP-06 · Zero payload validation on the WS path — **P1**

**Evidence**: `main.ts:21-27` `useGlobalPipes(ValidationPipe)` — Nest global pipes do not apply to gateways; envelope classes (`weekly-plans.gateway.ts:96-101`, `households.gateway.ts:70-74`) carry no decorators / `@ValidateNested`. Acknowledged in `weekly-plans.service.ts:688-696`. `households.service.ts:499-502` writes `mealSlotTimes: dto.mealSlotTimes` as-is.

**Consequences**: `{"BREAKFAST":"480"}` or `"8:00"` from any client → iOS `SessionDTOs.swift:96 let mealSlotTimes: [String: Int]?` fails decoding the household → session bootstrap breaks for everyone in that household. `dayOfWeek: 'Monday'`/bad UUID → Prisma error → `INTERNAL_ERROR 500`; `plannedServings` is saved only by the service clamp (`:697-702`); `weekStart` (WP-02).

**Fix**: `@UsePipes(new ValidationPipe({whitelist, forbidNonWhitelisted, transform}))` on each gateway + decorate envelopes (`@IsUUID userId/householdId`, `@Matches(/^\d{4}-\d{2}-\d{2}$/) weekStart`, `@ValidateNested() @Type(() => Dto) data`) — with `whitelist`, undecorated fields would be stripped, so decorate everything. Alternatively validate in services (which is what the assistant's tools will call). **Effort 2–3 h. FOLD-INTO-PHASE-0** (auth phase replaces `userId`-in-payload anyway).

---

## WP-07 · Auto `plannedServings` never re-derived on membership change → silent halving — **P1**

**Evidence**: `memberCount` is read only at write time (`weekly-plans.service.ts:649-652`); unchanged audience keeps the stored value (`:759-761`); `households.service.ts` has no reference to `plannedServings` (grep). Backfill migration `20260823100000` set shared items to member count *at that moment*.
Scenario: 1-person household plans "Wspólne" meals (auto = 1); partner joins → iOS `SavedMealPlan.swift:119-122` `servingsPerPerson = 1/2 = 0.5` → kcal per person halves, `isCustomServings` (`:106-110`) shows a "1 porcja" badge nobody set, shopping list buys for one. Reverse (member leaves) over-buys. Ghost participants (WP-04) compound it.

**Why it escalates**: validator "servings vs eaters" would flag every legacy shared item after any roster change; the assistant may "fix" user-chosen values.

**Fix**: in the membership add/remove transactions, for weeks ≥ current: `UPDATE PlanItem SET plannedServings = newCount WHERE no participants AND plannedServings = oldCount` (same heuristic the service already uses) + stale-mark. Long-term: `servingsMode AUTO|MANUAL` column (the code comments at `:724-727` admit the heuristic's limit). **Effort 2 h (hook) / 4 h (column + iOS). FIX-BEFORE-PHASE-0 (hook), LATER (column).**

---

## P2 (hygiene)

- **WP-08** Broadcasts are global: `this.server.emit(...)` at `weekly-plans.gateway.ts:220,487,544,592,645,653,694,702`, no `.to()`/`join()` anywhere → every socket receives every household's `changedByDisplayName`/actions; iOS filters client-side (`WeeklyPlanStore.swift:378-381`). Use per-household rooms once sockets are authenticated. **1–2 h, FOLD-INTO-PHASE-0.**
- **WP-09** `szczypta`/`łyżeczka` are converted at import (`recipes/ingredient-amount.util.ts:114-128`: pinch = tsp/16 → sól 0.375 g, generic 0.156 g) so the list shows "Sól 0.38 g" rows (`shopping-items.util.ts:57` rounds to 2 dp). Correct but noise; render `< 1 g` SPICES as "do smaku". **1 h, LATER.**
- **WP-10** `WeeklyMealStore.swift:37-42` `dateFormatter` sets neither `calendar` nor `timeZone` while `WeekDateMapper.swift:138-145`, `DatesViewModel.swift:41-48`, `EditorialWeekBar.swift:23-26` pin gregorian — on a Buddhist/Japanese device calendar local keys diverge from backend keys (plan looks empty / duplicates). **15 min, LATER** (fold into WP-02's helper).
- **WP-11** `upsertWeekSlot` checks neither `enabledMealTypes`, `Recipe.isActive`, nor recipe ownership (`utils/auth-checks.util.ts:6-19` `_householdId` unused). Disabling a slot intentionally keeps items (`households.service.ts:462-465`; iOS shows them while non-empty, `WeeklyPlanView.swift:142-145`) — fine, but the assistant's validator must own all three checks. Ownership check → **FOLD-INTO-PHASE-0**; others → validator design note.
- **WP-12** Rebuild does one `upsert` per product inside an interactive tx (`shopping-list.service.ts:318-343`) and two extra `findUnique`s on every non-stale read (`:457-461`). **LATER.**

---

## What the assistant would inherit (ranked)
1. WP-01 — every ingredient-balance number and list name wrong for beans/beef/celery/lentils.
2. WP-02 — writes landing on a different week row than the app reads.
3. WP-04 + WP-07 — validator rejects/mis-scores existing rows; per-person kcal off.
4. WP-05 — applyProposal swaps leave empty slots on partial failure.
5. WP-03 — a ready-made "replace week" that nukes disabled slots.
6. WP-06/WP-11 — nothing below the gateway validates; tools must validate in services.

---

## Checked and found FINE
- `changeVersion = Date.now()` (`gateway:232-234`) + iOS `changeVersion > previous` (`WeeklyMealStore.swift:533-537`, `ShoppingListStore.swift:84-87`): only same-millisecond duplicates are dropped and the 250 ms debounced refetch covers them; survives restarts (wall clock); only an NTP backward step could drop events.
- `WeekDateMapper` DST (`WeeklyPlanStore.swift:157-180`): calendar-day arithmetic from local midnight + `startOfDay` diff — correct across CET/CEST.
- `plannedServings` semantics: server clamp 1..12 (`service:697-702`), `resolveUpdatedPlannedServings` audience-toggle cases covered by spec (`weekly-plans.service.spec.ts:239-497`); iOS never substitutes 1 for unknown (`SavedMealPlan.swift:69`, `WeeklyMealStore.swift:214-215`, `WeeklyPlanStore.swift:491`); `resolveParticipants` collapse/dedupe (`:639-674`) matches `PlanAudienceChips.collapsed`.
- Shopping scaling `max(1,plannedServings)/max(1,recipe.servings)` (`shopping-list.service.ts:101-105`) with spec coverage (`shopping-list.service.spec.ts:199-262`); `isChecked` carry-over/reset-on-growth (`:266-282`); archive signature dedupe via `@@unique([householdId, weekStart, signature])` (`:586-611`); `clearWeekPlan` cleans all week tables in one serializable tx (`:774-844`).
- All 17 catalog department labels (`scripts/load-ingredient-catalog.ts:7-25`) resolve to the intended `ShoppingDepartment` via `DEPARTMENT_KEYWORD_RULES` (computed); only `Inne → OTHER` by design.
- `enabledMealTypes`: core trio forced, unknowns dropped, canonical order (`common/meal-types.ts:57-66`); `mealSlotTimes` constraint is correct when it runs (`households/dto/update-meal-times.dto.ts:18-38`) — see WP-06.
- `PlanItem` unique `(weeklyPlanId, dayOfWeek, mealType, recipeId)` + caps 6/42/252 derived from enum length (`service:109-112`); `PlanItemParticipant`/`Consumption` cascade on `PlanItem` and `User` delete — no orphans from those paths.
- iOS filters `weekChanged`/`shoppingListChanged` by `householdId` and `weekStart` before acting; own shopping echo suppressed (`ShoppingListStore.swift:71-83`).
- `weekStart` timezone: iOS sends the phone-local calendar date, backend stores UTC midnight of that date — consistent "calendar date" semantics; members in different time zones is a known limitation, not a bug. `prisma/seed.ts:228` uses a Monday UTC.
- `saveSavedPlan` fingerprint gate (`gateway:236-253,629-642`) and `setMealEaten` idempotency (`service:606-618`) behave as documented.