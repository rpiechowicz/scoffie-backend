# Plaster B — Integration & Ordering Runbook (backend + iOS)

**Verified against current sources on 2026-08-28.** Plaster A is already on `develop`/`main`: `parseWeekStart` is strict (`src/weekly-plans/utils/week-formatting.util.ts:13-28`, regex + `getUTCDay() !== 1` → `VALIDATION_ERROR`), shopping-list names are verbatim (`src/weekly-plans/services/shopping-list.service.ts:150-151`), importer keys by explicit id, migration `prisma/migrations/20260828120000_unikalny_skladnik_w_przepisie` added `@@unique([recipeId, ingredientId])` (`prisma/schema.prisma:459`), iOS has a `PlanWeek` helper (`AddToPlanSheet.swift:694`), and `test/smoke.e2e-spec.ts:27-39` already builds the Monday in UTC.

## 0. Item inventory (labels used throughout)

| Id     | Item                                                                     | Repos                    | Audit        |
| ------ | ------------------------------------------------------------------------ | ------------------------ | ------------ |
| **B1** | Pool retirement (`SharedMealPlan`)                                       | backend (+iOS dead-code) | WP-03        |
| **B2** | `replaceRecipeId` on `upsertWeekSlot`                                    | backend → iOS            | WP-05        |
| **B3** | Membership hooks (ghost participants + servings re-derive)               | backend only             | WP-04, WP-07 |
| **B4** | Recipes normalizer dedup + nutrition on create                           | backend only             | D3, T3       |
| **B5** | Allergen whitelist + clamps (backend) / union-preserving write (iOS)     | backend → iOS            | A4, A5       |
| **B0** | Unblocker: delete `households.service.stub.ts` + `jest.config.js` mapper | backend only             | T1           |

**B0 is a hard prerequisite for B3's tests.** `jest.config.js:22-25` maps _every_ import of `households.service` to the stub:

```js
22    moduleNameMapper: {
23      // Redirect APFS-blocked households.service to an accessible stub file
24      '^(\\./|.*/)households\\.service$': '<rootDir>/households/households.service.stub',
25    },
```

The stub (`src/households/households.service.stub.ts:19` `createHousehold(userId, {name})`) has no `leave`/`removeMember`/`acceptInvitation` in the real shape, so **any B3 spec written against the real service will silently test the stub instead**. Ship B0 in the same PR chain, before B3.

---

## 1. Backward-compat matrix — old iOS build vs new backend

### 1.1 What actually happens when the server drops a `@SubscribeMessage`

Nest binds message handlers by event name; an unknown event has no handler and **no ack callback is ever invoked** — the client's ack function is never called, there is no error frame. On iOS that path is:

- `SocketIORecipeSocketClient.swift:128-134` — `emitWithAck(...).timingOut(after: 6)`; on timeout SocketIO-client-swift invokes the handler with `["NO ACK"]`, which is mapped to `RecipeDataError.serverError("Brak ACK dla eventu <event>.")`.
- `SocketIORecipeSocketClient.swift:156-197` — 3 attempts (`maxAckAttempts = 3`, `ackTimeoutSeconds = 6`), backoff 250 ms then 500 ms.
- **Total wall time before the throw: 6 + 0.25 + 6 + 0.5 + 6 = 18.75 s** (plus up to 3 s per attempt in `ensureConnected`, `:90-95`, if the socket is down).
- `UserFacingErrorMapper.swift:9-14` — `"brak ack"` counts as a connectivity issue → `ConnectivityErrorGate.publish` defers the banner by 2 s (`ConnectivityErrorGate.swift:23,36-41`).

So the old-client symptom is **an 18.75 s stall, not an immediate error**, and the banner may never appear if another load calls `connectivityErrorGate.reset()` first.

### 1.2 Matrix

| Event                                               | Old-iOS caller                                                                                                          | Reachable in normal use?                                                                     | New-backend behaviour if removed                                               | Old-app symptom                                                                                                                                                                                                                                                                                                                        | Verdict                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `weeklyPlans:getSavedPlan`                          | `WeeklyPlanStore.swift:382-398` ← `WeeklyMealStore.loadSavedPlanFromBackend:451-468` ← **`CalendarView.swift:297-303`** | **YES — every week switch**, and `.task(id:)` `await`s it _before_ `loadWeekPlanFromBackend` | no ack                                                                         | Calendar shows the previous week's meals for **18.75 s** on every swipe; then the real week loads. Banner suppressed because `loadWeekPlanFromBackend` calls `connectivityErrorGate.reset()` (`WeeklyMealStore.swift:126`). Also re-triggered by `savedPlanChanged` → `scheduleSavedPlanReload` (`:579-586`) after any `clearWeekPlan` | **KEEP AS STUB for one release**              |
| `weeklyPlans:saveSavedPlan`                         | `WeeklyPlanStore.swift:406-425` ← `saveMealPlanToBackend:471-495` / `clearSavedPlanFromBackend:498-500`                 | **NO** — no View calls them; `MealPlanViewModel` is never instantiated                       | no ack                                                                         | unreachable                                                                                                                                                                                                                                                                                                                            | **REMOVE**                                    |
| `weeklyPlans:listByHousehold`                       | no iOS transport method at all                                                                                          | NO (only `commands.txt:28` ws-smoke)                                                         | no ack                                                                         | none                                                                                                                                                                                                                                                                                                                                   | **REMOVE**                                    |
| `weeklyPlans:create`                                | none                                                                                                                    | NO                                                                                           | no ack                                                                         | none                                                                                                                                                                                                                                                                                                                                   | **REMOVE**                                    |
| `weeklyPlans:addItem`                               | none                                                                                                                    | NO                                                                                           | no ack                                                                         | none                                                                                                                                                                                                                                                                                                                                   | **REMOVE**                                    |
| `weeklyPlans:removeItem`                            | none                                                                                                                    | NO                                                                                           | no ack                                                                         | none                                                                                                                                                                                                                                                                                                                                   | **REMOVE**                                    |
| `weeklyPlans:upsertWeekSlot` + `replaceRecipeId`    | `WeeklyPlanStore.swift:50`, `WeeklyMealStore.swift:231-246`                                                             | yes                                                                                          | old client omits the field → identical behaviour to today                      | none                                                                                                                                                                                                                                                                                                                                   | **additive, safe both ways**                  |
| **new iOS → old backend** (`replaceRecipeId` sent)  | —                                                                                                                       | —                                                                                            | WS path has no `ValidationPipe` (WP-06), unknown field is **silently ignored** | old variant is **not** deleted → slot ends with 2 variants after "change recipe"                                                                                                                                                                                                                                                       | **iOS must ship after backend**               |
| `users:preferences:update` (unknown allergen → 400) | `SessionStore.swift:1908-1912`                                                                                          | yes                                                                                          | rejects unknown ids                                                            | old app only ever sends the 7 `Allergen` cases (`DietPreference.swift:118-125`) → never triggers. Error is swallowed anyway (`SessionStore.swift:1913-1916`)                                                                                                                                                                           | **safe backend-first**                        |
| **new iOS with new allergen ids → old backend**     | —                                                                                                                       | —                                                                                            | old backend stores anything                                                    | works, but a _third_ old client wipes them (A5)                                                                                                                                                                                                                                                                                        | **backend whitelist must precede any new id** |

### 1.3 Decision: keep `getSavedPlan` as an empty stub for one release

**Spec (backend, `src/weekly-plans/weekly-plans.gateway.ts:607-616` stays, service changes):**

Current:

```ts
607  @SubscribeMessage('weeklyPlans:getSavedPlan')
608  getSavedPlan(@MessageBody() payload: WeeklyPlansGetSavedPlanPayload) {
609    return wsRespond(() =>
610      this.weeklyPlansService.getSharedMealPlan(
611        payload.userId, payload.householdId, payload.weekStart,
612      ),
613    );
614  }
```

Replace `WeeklyPlansService.getSharedMealPlan` (`weekly-plans.service.ts:857-919`) with a body that keeps the two guards and drops the DB read entirely:

```ts
/**
 * DEPRECATED — pula tygodniowa nie istnieje od <data>. Handler zostaje na
 * JEDNO wydanie, bo CalendarView starszej aplikacji czeka na tę odpowiedź
 * ZANIM pobierze tydzień (CalendarView.swift:297-303); usunięcie eventu
 * zamiast błędu daje 18,75 s ciszy przy każdej zmianie tygodnia.
 * Usunąć razem z `savedPlanChanged` po wygaśnięciu buildów < <wersja>.
 */
async getSharedMealPlan(userId: string, householdId: string, weekStart: string) {
  await ensureMembership(this.prisma, userId, householdId);
  parseWeekStart(weekStart);
  return { weekStart, items: [] as never[] };
}
```

Keep `saveSharedMealPlan` deleted, keep the `weeklyPlans:savedPlanChanged` emit in `clearWeekPlan` (`gateway:702-709`) for the same release — old clients refetch the stub (cheap) and end up with an empty `savedPlan`, which is the intended end state. Both go in the follow-up cleanup PR (§2.4).

Kill switch: gate the stub on `LEGACY_SAVED_PLAN_STUB !== 'false'` so prod can turn it into a no-handler after TestFlight adoption without a deploy of new code — optional, only if you want to measure.

---

## 2. Commit / PR plan

Branch in **both** repos: `fix/fundamenty-b`, cut from `develop`.
`scoffie-backend/.github/workflows/backend-ci.yml:3-8` runs on `pull_request` (any base) + push to `main`/`master` — a PR into `develop` is covered. iOS `ios-ci.yml` runs on `pull_request` only; `ios-testflight.yml` fires on push to `main`.

### 2.1 Backend commits (one PR, `fix/fundamenty-b` → `develop`)

| #   | Commit                                                                 | Files                                                                                                                                                                                                                                                                                                                                                                                                     | Independent?                      |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | `test: usuń stub households.service i mapper z jest.config`            | delete `src/households/households.service.stub.ts`; `jest.config.js:22-25`; rewrite `src/households/households.service.spec.ts` against the real API                                                                                                                                                                                                                                                      | yes (B0)                          |
| 2   | `feat(plans): replaceRecipeId w upsertWeekSlot + P2002 → CONFLICT`     | `dto/upsert-week-slot.dto.ts`, `weekly-plans.service.ts:309-497`, `weekly-plans.service.spec.ts`                                                                                                                                                                                                                                                                                                          | yes (B2)                          |
| 3   | `refactor(plans): wycofanie puli tygodniowej`                          | `weekly-plans.gateway.ts` (drop 5 handlers + payload classes + imports), `weekly-plans.service.ts` (drop `listByHousehold/create/addItem/removeItem/saveSharedMealPlan`, stub `getSharedMealPlan`), `services/shopping-list.service.ts:106-143` + `:349-388`, delete `dto/create-weekly-plan.dto.ts`, `dto/create-plan-item.dto.ts`, `dto/save-shared-meal-plan.dto.ts(+.spec)`, update `commands.txt:28` | after #2 (both touch the gateway) |
| 4   | `fix(households): sprzątanie uczestników i porcji przy zmianie składu` | new `src/households/plan-membership-cleanup.util.ts`, `households.service.ts:188-198/588-597/614-619`, `households.module.ts`, `weekly-plans.module.ts` (`exports: [ShoppingListService]`)                                                                                                                                                                                                                | after #1 (tests)                  |
| 5   | `fix(recipes): jeden normalizator + makra liczone przy tworzeniu`      | `recipes.service.ts:105-141,218-287,545-631`, new `src/recipes/ingredient-amount.util.spec.ts`                                                                                                                                                                                                                                                                                                            | yes (B4)                          |
| 6   | `feat(users): whitelist alergenów + klamry makr`                       | new `src/common/allergens.ts`, `users.service.ts:278-286`, `dto/update-preferences.dto.ts`, `users.service.spec.ts` (new file)                                                                                                                                                                                                                                                                            | yes (B5)                          |

Commits 2, 5, 6 are genuinely independent and can be split into their own PRs if you want smaller review units. 3 and 4 are the risky ones and should land together with their data steps.

### 2.2 iOS commits (one PR, `fix/fundamenty-b` → `develop`) — **merge only after the backend deploy is live**

| #   | Commit                                            | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `feat(plan): podmiana dania jednym zapisem`       | `Models/Stores/WeeklyPlanStore.swift:34,50` (add `replaceRecipeId` to both protocol signatures + `WebSocketWeeklyPlanTransportClient.upsertWeekSlot` payload + `ApiWeeklyPlanRepository`), `Models/Stores/WeeklyMealStore.swift:230-246` (delete the `removeWeekSlot` pre-call, pass `replacingRecipeId` through)                                                                                                                                                                                                                                                                                          |
| 2   | `chore(plan): usunięcie martwej puli tygodniowej` | `WeeklyPlanStore.swift:41-43,55-57,382-444,536-549` (drop `fetchSavedPlan`/`saveSavedPlan`/`observeSavedPlanChanges` from both protocols and both classes), `WeeklyMealStore.swift:384-448,450-518,547-568,579-586,597+` (drop `applySavedPlanToWeek`, `loadSavedPlanFromBackend`, `saveMealPlanToBackend`, `clearSavedPlanFromBackend`, `handleRemoteSavedPlanChanged`, `scheduleSavedPlanReload`, `mapSavedPlan`, `savedPlan` storage), `CalendarView.swift:297-303` (drop line 298), delete `ViewModels/MealPlanViewModel.swift` and `Models/Plans/SavedMealPlan.swift` if nothing else references them |
| 3   | `fix(settings): nie kasuj nieznanych alergenów`   | `SettingsView.swift:316-319,366-377,1264-1273`, `WelcomeView.swift:107-113,320-327` — keep `allergensRaw` tokens the enum can't decode and re-send the union                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Wiring check (asked for explicitly):** `SessionStore.bootstrapSession` (`SessionStore.swift:428-548`) constructs `WebSocketWeeklyPlanTransportClient(socket:userId:householdId:)` at `:451-455` and `ApiWeeklyPlanRepository(client:)` at `:463` — it never names the removed methods, so dropping `fetchSavedPlan`/`saveSavedPlan`/`observeSavedPlanChanges` **does not touch bootstrap**. The only conformers are `WebSocketWeeklyPlanTransportClient` (`:187`) and `ApiWeeklyPlanRepository` (`:454`) — no mocks, no previews (grep for `: WeeklyPlanRepository` returns exactly these two). Removing protocol members is therefore a 2-file change plus call sites.

### 2.3 Merge order

1. Backend PR → `develop` → deploy to **dev** (Railway/dev compose). Run §4 dev data steps.
2. Soak ≥ 24 h with the **current TestFlight build** installed (this is the backward-compat proof: only `getSavedPlan` is exercised, via the stub).
3. Backend `develop` → `main` → prod deploy. Run §4 prod data steps.
4. iOS PR → `develop`. Build + device pass (§5).
5. iOS `develop` → `main` → `ios-testflight.yml` builds and uploads.
6. **Follow-up PR (next sprint):** remove the `getSavedPlan` stub, the `savedPlanChanged` emit in `clearWeekPlan` (`gateway:702-709`), `WeeklyPlansGetSavedPlanPayload`, and the `SharedMealPlan`/`SharedMealPlanItem` models + a `DROP TABLE` migration — only after TestFlight/App Store adoption of the new build is ≥ 95 %.

### 2.4 What can ship independently

- **B4** and **B5-backend**: zero client contract change (iOS never calls `recipes:create` — grep for `recipes:create|createRecipe` across `scoffie-ios/**/*.swift` returns **0 hits**). Ship whenever.
- **B3**: server-internal, no event changes. Ship whenever, but pair with its cleanup SQL.
- **B2** and **B1** are the only ones with a release-order constraint.

---

## 3. Test loop (nothing runs on the developer Mac)

### 3.1 Jest inside the `api` container

The image (`Dockerfile:24-43`) copies `node_modules` from the `deps` stage, which ran `pnpm install --frozen-lockfile` **without `--prod`** — jest, ts-jest, `@nestjs/testing` and typescript are all present. `jest.config.js` is **not** in the image's COPY list, hence the explicit `docker cp`.

```bash
# 0. stack up (keeps the DB volume)
docker compose up -d --build

# 1. wipe the container copies first — `docker cp` MERGES directories and will
#    leave deleted files (old DTOs, save-shared-meal-plan.dto.spec.ts) behind,
#    which would keep running as green tests against code that no longer exists.
docker compose exec api rm -rf /app/src /app/test

# 2. push the working tree
docker cp src            scoffie-api:/app/src
docker cp test           scoffie-api:/app/test
docker cp jest.config.js scoffie-api:/app/jest.config.js
docker cp tsconfig.json  scoffie-api:/app/tsconfig.json

# 3. run the four affected suites
docker compose exec api npx jest src/weekly-plans src/households src/recipes src/users

# 4. full unit run before opening the PR
docker compose exec api npx jest

# 5. type-check specs (they are transpile-only under ts-jest — T2)
docker compose exec api npx tsc -p tsconfig.json --noEmit

# 6. e2e (needs the compose Postgres; AUTH_DEV_LOGIN_ENABLED must not be 'false')
docker compose exec api npx jest --config ./test/jest-e2e.json --runInBand
```

Restore the container to the built image afterwards with `docker compose up -d --build api`.

WS-level check after the backend deploy (removed handlers must **hang**, the stub must answer):

```bash
docker compose exec api pnpm ws:smoke weeklyPlans:getSavedPlan \
  '{"userId":"<U>","householdId":"<H>","weekStart":"2026-08-31"}'   # → {"ok":true,"data":{"weekStart":"2026-08-31","items":[]}}
WS_TIMEOUT_MS=8000 docker compose exec api pnpm ws:smoke weeklyPlans:listByHousehold \
  '{"userId":"<U>","householdId":"<H>"}'                            # → operation has timed out (expected)
```

`scripts/ws-smoke.ts:35-41` rejects on the ack timeout, so "timed out" is the pass criterion for a removed event. **Also delete/replace `commands.txt:28`**, which still advertises `weeklyPlans:listByHousehold`; replace with `weeklyPlans:getByWeek '{"userId":"<U>","householdId":"<H>","weekStart":"<MONDAY>"}'`.

### 3.2 New spec files expected

| File                                                                   | Covers                                                                                                                                       | Item   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/households/households.service.spec.ts` (**rewrite**)              | real API: `acceptInvitation` (redeemed / expired / already-member / `INVITATION_REQUIRES_LEAVE`), `leave`, `removeMember`, `updateMealTypes` | B0     |
| `src/households/plan-membership-cleanup.util.spec.ts` (new)            | ghost participant purge, empty-audience item deletion for weeks ≥ current, servings re-derive on join/leave                                  | B3     |
| `src/recipes/ingredient-amount.util.spec.ts` (new)                     | g/kg/ml/l/szt, łyżka ×3, szczypta /16, `przyprawa uniwersalna` → 4 g, unknown spice → 2.5 g, liquid condiments → ml, category gate           | B4     |
| `src/users/users.service.spec.ts` (new)                                | allergen whitelist reject, dedupe/sort/lowercase, macro clamps                                                                               | B5     |
| `src/weekly-plans/weekly-plans.service.spec.ts` (**extend**)           | `replaceRecipeId` cases; delete the `saveSharedMealPlan` describe blocks                                                                     | B1, B2 |
| `src/weekly-plans/services/shopping-list.service.spec.ts` (**extend**) | week with 0 `PlanItem` + a `SharedMealPlan` row → empty list, not a ghost list                                                               | B1     |
| **deleted:** `src/weekly-plans/dto/save-shared-meal-plan.dto.spec.ts`  | —                                                                                                                                            | B1     |

All new specs follow the house pattern in `src/weekly-plans/weekly-plans.service.spec.ts:92-182`: a `makePrismaMock()` factory of `jest.fn()` delegates plus

```ts
174    $transaction: jest.fn().mockImplementation((cbOrOps: any, _opts?: any) => {
175      if (typeof cbOrOps === 'function') {
176        return cbOrOps(mock);
177      }
178      return Promise.all(cbOrOps);
179    }),
```

and `Test.createTestingModule({ providers: [Svc, { provide: PrismaService, useValue: prisma }] }).compile()` (`:191-200`). B3's spec additionally needs `runSerializable` (`src/weekly-plans/utils/transaction-runner.util.ts:16`) to work against the same mock — it takes the Prisma client, so the `$transaction` mock above already covers it.

### 3.3 iOS

```bash
cd "/Users/rafi/Desktop/Scoffie App/scoffie-ios"
xcodebuild -resolvePackageDependencies -project "weekly meals.xcodeproj"
xcodebuild \
  -project "weekly meals.xcodeproj" \
  -scheme "Scoffie" \
  -destination "generic/platform=iOS Simulator" \
  -sdk iphonesimulator \
  build \
  ARCHS=arm64 CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=YES EXCLUDED_ARCHS=x86_64
```

(identical to `.github/workflows/ios-ci.yml:36-49`; the `EXCLUDED_ARCHS` flag is required on arm64 runners). There is **no test target** (T8) — the compile is the whole gate, which is exactly why removing protocol members is safe to do in bulk: any missed conformer or call site is a build error.

---

## 4. Data steps — dev first, then prod, in this order

Run everything through `docker compose exec db psql -U scoffie -d scoffie -c "…"` on dev, and `railway run --service Backend …`/the prod psql console on prod. **Diagnose → back up → clean → verify.** Take a DB snapshot before any `DELETE`/`UPDATE` on prod.

### 4.1 Diagnostics (read-only, run before the deploy)

```sql
-- B1: how much pool data exists at all
SELECT count(*) AS plans FROM "SharedMealPlan";
SELECT count(*) AS items FROM "SharedMealPlanItem";
-- B1: weeks that would show a GHOST list today (pool rows, no day items)
SELECT s."householdId", s."weekStart", count(i.id) AS pool_items
FROM "SharedMealPlan" s
JOIN "SharedMealPlanItem" i ON i."sharedMealPlanId" = s.id
LEFT JOIN "WeeklyPlan" w ON w."householdId" = s."householdId" AND w."weekStart" = s."weekStart"
LEFT JOIN "PlanItem" p ON p."weeklyPlanId" = w.id
WHERE p.id IS NULL
GROUP BY 1,2 ORDER BY 2 DESC;

-- B3: ghost participants (user no longer a member of the item's household)
SELECT count(*) FROM "PlanItemParticipant" pp
JOIN "PlanItem" pi ON pi.id = pp."planItemId"
JOIN "WeeklyPlan" w ON w.id = pi."weeklyPlanId"
WHERE NOT EXISTS (SELECT 1 FROM "Membership" m
                  WHERE m."userId" = pp."userId" AND m."householdId" = w."householdId");
-- B3: same for eaten marks
SELECT count(*) FROM "PlanItemConsumption" pc
JOIN "PlanItem" pi ON pi.id = pc."planItemId"
JOIN "WeeklyPlan" w ON w.id = pi."weeklyPlanId"
WHERE NOT EXISTS (SELECT 1 FROM "Membership" m
                  WHERE m."userId" = pc."userId" AND m."householdId" = w."householdId");
-- B3: items that would become audience-less after the purge (future weeks only)
SELECT pi.id, w."householdId", w."weekStart", pi."dayOfWeek", pi."mealType"
FROM "PlanItem" pi
JOIN "WeeklyPlan" w ON w.id = pi."weeklyPlanId"
WHERE w."weekStart" >= date_trunc('week', now())
  AND EXISTS (SELECT 1 FROM "PlanItemParticipant" pp WHERE pp."planItemId" = pi.id)
  AND NOT EXISTS (
    SELECT 1 FROM "PlanItemParticipant" pp
    JOIN "Membership" m ON m."userId" = pp."userId" AND m."householdId" = w."householdId"
    WHERE pp."planItemId" = pi.id);

-- B3/WP-07: shared items whose plannedServings ≠ current member count (future weeks)
SELECT w."householdId", count(*) AS shared_items,
       (SELECT count(*) FROM "Membership" m WHERE m."householdId" = w."householdId") AS members
FROM "PlanItem" pi
JOIN "WeeklyPlan" w ON w.id = pi."weeklyPlanId"
WHERE w."weekStart" >= date_trunc('week', now())
  AND NOT EXISTS (SELECT 1 FROM "PlanItemParticipant" pp WHERE pp."planItemId" = pi.id)
  AND pi."plannedServings" <> (SELECT count(*) FROM "Membership" m WHERE m."householdId" = w."householdId")
GROUP BY 1;
```

Record every count in the PR description — they are the rollback baseline.

### 4.2 Cleanup (after the backend deploy, in this order)

```sql
-- 1) B3: ghost audience rows. Do this FIRST: step 3 re-derives servings and
--    must not count phantom eaters.
DELETE FROM "PlanItemParticipant" pp
USING "PlanItem" pi, "WeeklyPlan" w
WHERE pi.id = pp."planItemId" AND w.id = pi."weeklyPlanId"
  AND NOT EXISTS (SELECT 1 FROM "Membership" m
                  WHERE m."userId" = pp."userId" AND m."householdId" = w."householdId");

DELETE FROM "PlanItemConsumption" pc
USING "PlanItem" pi, "WeeklyPlan" w
WHERE pi.id = pc."planItemId" AND w.id = pi."weeklyPlanId"
  AND NOT EXISTS (SELECT 1 FROM "Membership" m
                  WHERE m."userId" = pc."userId" AND m."householdId" = w."householdId");

-- 2) B3: items left with an empty audience in weeks >= current week are deleted,
--    NOT promoted to „Wspólne" (promotion would silently buy food for everyone).
--    Past weeks keep their history.
--    Run only for the ids listed by the diagnostic query above.
DELETE FROM "PlanItem" pi
USING "WeeklyPlan" w
WHERE w.id = pi."weeklyPlanId"
  AND w."weekStart" >= date_trunc('week', now())
  AND pi.id IN (<ids from the diagnostic>);

-- 3) B1: retire the pool. Scope by week if you want to keep archives readable;
--    the code no longer reads these tables after the deploy.
DELETE FROM "SharedMealPlanItem";
DELETE FROM "SharedMealPlan";

-- 4) B1 + B3: force every list to rebuild from PlanItems (renamed/changed rows,
--    dropped ghost pool sources). isChecked state for changed productKeys is lost.
UPDATE "ShoppingList" SET "isStale" = true;
```

**Do not** drop the `SharedMealPlan*` tables in this release — the rollback path in §6 needs them.

### 4.3 Verification (after cleanup)

```sql
SELECT count(*) FROM "SharedMealPlan";                                   -- expect 0
SELECT count(*) FROM "SharedMealPlanItem";                               -- expect 0
-- re-run both ghost queries from 4.1                                    -- expect 0, 0
SELECT count(*) FROM "ShoppingList" WHERE "isStale" = false;             -- expect 0 immediately after
SELECT count(*) FROM "PlanItem" pi JOIN "WeeklyPlan" w ON w.id = pi."weeklyPlanId"
  WHERE w."weekStart" >= date_trunc('week', now())
    AND EXISTS (SELECT 1 FROM "PlanItemParticipant" pp WHERE pp."planItemId" = pi.id)
    AND NOT EXISTS (SELECT 1 FROM "PlanItemParticipant" pp
                    JOIN "Membership" m ON m."userId" = pp."userId" AND m."householdId" = w."householdId"
                    WHERE pp."planItemId" = pi.id);                      -- expect 0
-- sanity: nothing lost
SELECT count(*) FROM "PlanItem";                                         -- compare to the pre-run baseline
```

Then open the app on two devices, walk the current week, and confirm the shopping list re-materialises (`isStale` flips back to `false` on the first `getShoppingList`).

**Migrations:** B1–B5 need **no schema migration**. The only DDL in this whole plaster is the deferred `DROP TABLE "SharedMealPlanItem"/"SharedMealPlan"` in the follow-up PR. B5's whitelist is a code-level constraint on an existing `String[]` column — no migration, and pre-existing junk values stay readable until the next write.

---

## 5. Manual device checklist (2 phones, same household, both signed in)

**B2 — replace a recipe in a slot**

1. Plan → tap an occupied slot → pick a different recipe → Save.
2. Phone A: the tile swaps **in one step**; no empty flash between remove and upsert (the pre-call at `WeeklyMealStore.swift:231-238` is gone).
3. Phone B: **exactly one** plan-change banner / push, not two. Watch the Xcode console for a single `weeklyPlans:weekChanged` with `action: "UPSERT_SLOT"` (previously `REMOVE_SLOT` + `UPSERT_SLOT`).
4. Shopping list on B updates once.
5. Turn airplane mode on mid-save → the tile rolls back to the **old** recipe and the slot on the server is unchanged (previously the remove had already committed).
6. Two phones replace the same slot with the same recipe simultaneously → the loser sees a "conflict" message, **not** `INTERNAL_ERROR` (P2002 → `CONFLICT`).

**B3 — partner leaves the household**

1. Phone B: Settings → leave household.
2. Phone A, current week: meals that were **solo for B** disappear; meals **shared** ("Wspólne") stay and their servings drop from 2 → 1 (open the meal detail, check the stepper shows 1, and the kcal-per-person figure doubles back).
3. Meals where A was an explicit participant alongside B keep A and now show 1 serving.
4. Open a **past** week: nothing changed there (history preserved).
5. Meal detail → "Zapisz porcje" on a formerly-shared meal succeeds (previously `PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD`).
6. Audience chips on that meal no longer silently read "Wspólne" for a set that contained a ghost.
7. Shopping list on A rebuilds with halved amounts.
8. Reverse: invite B back → shared meals in weeks ≥ current go 1 → 2 servings; a meal where A had manually set 4 servings **stays at 4**.

**B1 — pool retirement**

1. Old TestFlight build installed, new backend deployed: swipe Calendar across 4 weeks — each switch feels normal (**not** an 18.75 s stall). This is the stub doing its job; if it stalls, the stub is missing.
2. New build: Calendar week switch loads the week directly; no `getSavedPlan` in the Xcode network/console log.
3. A week that had a legacy pool row and zero day meals shows an **empty** shopping list, not a ghost list.
4. Clear week plan → list empties, no phantom items return on refetch.

**B5 — allergens**

1. Settings → Dieta i alergeny: toggle two chips, background the app, reopen → both survive.
2. Simulate an unknown token: with psql set `UPDATE "UserPreference" SET allergens = ARRAY['gluten','celery'] WHERE "userId" = '<A>';` → open Settings on A (gluten chip on, `celery` invisible), toggle **eggs** on → re-read the row: it must contain `celery`, `eggs`, `gluten`. Before this fix `celery` was deleted.
3. `pnpm ws:smoke users:preferences:update '{"userId":"<A>","data":{"allergens":["nonsense"]}}'` → `{"ok":false,"code":"VALIDATION_ERROR","status":400}`; the row is unchanged.
4. `…{"proteinG": 99999}` → stored clamped, not 99999.

**B4 — recipe create: note explicitly**
There is **no iOS UI for recipe creation** — grep for `recipes:create|createRecipe` across `scoffie-ios` returns 0 hits. B4 is verifiable **only** via `ws:smoke`/unit tests:

```bash
docker compose exec api pnpm ws:smoke recipes:create \
  '{"userId":"<U>","title":"Test przyprawa","mealType":"LUNCH","difficulty":"EASY","prepTimeMinutes":10,"servings":2,"householdId":"<H>","ingredients":[{"ingredientId":"<id przyprawy uniwersalnej>","amount":1,"unit":"łyżeczka"}]}'
```

Expected: `normalizedAmount = 4` (not 2.5 — `recipes.service.ts:113-132` lacked `'przyprawa uniwersalna'`, `ingredient-amount.util.ts:51` has it), and `nutritionKcal` computed from `Ingredient.nutrition*Per100` rather than the `?? 0` at `recipes.service.ts:591-596`. A create whose ingredients have `null` per-100 values or a `szt` unit without `gramsPerPiece` must be **rejected**, not stored as zeros. Note that the ingredient `select` at `recipes.service.ts:557-561` currently pulls only `id/name/category` and must be widened to the five `nutrition*Per100` columns + `gramsPerPiece` (`prisma/schema.prisma:184-191`).

---

## 6. Risks and rollback

| Item                             | Risk                                                                                                                                                                               | Blast radius                                                                                                              | Detection                                                                                         | Rollback                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** stub                      | Someone deletes `getSavedPlan` entirely instead of stubbing it                                                                                                                     | every old-build user: 18.75 s stall per Calendar week switch, silent (banner suppressed)                                  | `ws:smoke weeklyPlans:getSavedPlan` returns instead of timing out                                 | re-add the 6-line handler + service stub; backend-only redeploy, no data                                                                                                                                                                                                                                                                                                                                   |
| **B1** pool DELETE               | A household had _only_ pool data for a future week → its list becomes empty                                                                                                        | limited to the rows counted by the 4.1 ghost query (expected 0 in an app that has used Plan v2 since the split migration) | pre-run count > 0 → decide per household before deleting                                          | restore `SharedMealPlan*` from the pre-run snapshot; the tables are still in the schema this release                                                                                                                                                                                                                                                                                                       |
| **B1** shopping fallback removal | A week loses its list even though its pool row was legitimate                                                                                                                      | same as above                                                                                                             | §4.3 verification + device check 3                                                                | revert commit #3's `shopping-list.service.ts:106-143` hunk                                                                                                                                                                                                                                                                                                                                                 |
| **B2** iOS ships before backend  | "Change recipe" leaves 2 variants in the slot (unknown DTO field is silently dropped — no `ValidationPipe` on WS)                                                                  | every user on the new build                                                                                               | duplicate tiles in a slot                                                                         | ship backend first (§2.3); if it slips: users fix it manually by deleting the extra variant, or hotfix iOS back to remove+upsert                                                                                                                                                                                                                                                                           |
| **B2** P2002 mapping             | Concurrent same-recipe creates now surface `CONFLICT` where the old client expected a generic error                                                                                | cosmetic                                                                                                                  | —                                                                                                 | keep the message user-facing; `UserFacingErrorMapper` already falls through to the server text                                                                                                                                                                                                                                                                                                             |
| **B3** empty-audience DELETE     | Deletes a meal the remaining member wanted to keep                                                                                                                                 | only future-week items whose _entire_ audience left                                                                       | the 4.1 id list is reviewed before running                                                        | restore those `PlanItem` rows from the snapshot; participants are gone either way (they were ghosts)                                                                                                                                                                                                                                                                                                       |
| **B3** servings re-derive        | Over-writes a user's manual `plannedServings` that happens to equal the old member count (the known limit of the heuristic — see the comment at `weekly-plans.service.ts:724-727`) | shared items only, weeks ≥ current                                                                                        | device check 8 ("manual 4 stays 4")                                                               | none needed at DB level; the user re-sets the stepper. Long-term fix is the `servingsMode AUTO\|MANUAL` column (WP-07 "LATER")                                                                                                                                                                                                                                                                             |
| **B3** module wiring             | `HouseholdsModule` needs `ShoppingListService.markShoppingListStale`; `WeeklyPlansModule` has **no `exports`** today (`weekly-plans.module.ts:9`)                                  | app fails to boot with `Nest can't resolve dependencies`                                                                  | e2e smoke boots the whole `AppModule` (`test/smoke.e2e-spec.ts:74-79`) → caught in CI             | add `exports: [ShoppingListService]` to `WeeklyPlansModule` and `WeeklyPlansModule` to `HouseholdsModule.imports`. **No cycle**: `NotificationsModule` has no imports, `WeeklyPlansModule → NotificationsModule` only. Alternative if you dislike the coupling: inline `tx.shoppingList.updateMany({ where: { householdId, weekStart: { gte } }, data: { isStale: true } })` in the households transaction |
| **B0** stub removal              | The real `HouseholdsService` was never unit-tested; rewriting the spec may expose real bugs mid-plaster                                                                            | CI red                                                                                                                    | first container jest run                                                                          | fix forward — do **not** re-add the mapper. Note T9: the stub exists because the repo sits in iCloud-synced `~/Desktop` and files get evicted (`compressed,dataless`); if `docker cp`/build hits EIO, mark the repo "Keep Downloaded" or move it off iCloud rather than restoring the stub                                                                                                                 |
| **B4** nutrition rejection       | `recipes:create` starts rejecting payloads it used to accept (ingredients without per-100 data)                                                                                    | no iOS caller today; future assistant tool callers                                                                        | unit spec                                                                                         | make the rejection `AI_*`-independent but log loudly; if it blocks an import path, fall back to `?? 0` behind an env flag                                                                                                                                                                                                                                                                                  |
| **B4** normalizer change         | `normalizedAmount` written by the API path changes for spice rows (2.5 → 4 g for `przyprawa uniwersalna`)                                                                          | only rows created via `recipes:create` after the deploy; catalog rows were always written by the script path              | `SELECT DISTINCT "normalizedAmount" FROM "RecipeIngredient" WHERE name = 'przyprawa uniwersalna'` | none — the new value is the correct one; optionally run `pnpm recipes:recompute:nutrition` in the container to converge existing rows (verify first that it rewrites `normalizedAmount`, not just nutrition — `scripts/recompute-recipe-nutrition.ts:127`)                                                                                                                                                 |
| **B5** whitelist                 | A user whose stored `allergens` already contains junk cannot save preferences at all if the whitelist is applied to the _stored_ set                                               | any user with legacy junk                                                                                                 | 4.1-style `SELECT DISTINCT unnest(allergens) FROM "UserPreference";` before the deploy            | validate only the **incoming** payload, never the stored row; junk is dropped on the next full write from iOS                                                                                                                                                                                                                                                                                              |
| **B5** new allergen ids          | Adding `celery/mustard/sesame` (A3) before iOS's union-preserving write lands (B5-iOS #3) makes an old phone wipe them                                                             | any 2-device household                                                                                                    | —                                                                                                 | **do not add new ids in this plaster.** Whitelist ships with exactly the 7 existing values (`DietPreference.swift:119-125`); ids get added in Plaster C after the union fix is on ≥ 95 % of installs                                                                                                                                                                                                       |

**Global rollback:** everything in B1–B5 is a code revert plus a redeploy, except the §4.2 `DELETE`s. Take the DB snapshot immediately before step 4.2 and keep it until the device checklist passes on prod. `git revert` of the backend PR restores the removed handlers verbatim; the iOS PR can be reverted independently because the new backend still accepts the old two-call replace sequence (`removeWeekSlot` + `upsertWeekSlot` are both untouched).
