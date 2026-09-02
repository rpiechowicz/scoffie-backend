## Findings — test & CI integrity (backend `B=/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend`)

### T1 — `households.service.spec.ts` tests a stub with a different API; real `HouseholdsService` has zero unit coverage — **P0**

**Evidence**

- `B/jest.config.js:22-25` — mapper is unconditional (same on Mac, in CI, anywhere):
  `'^(\\./|.*/)households\\.service$': '<rootDir>/households/households.service.stub'`
- `B/.git/index` contains `src/households/households.service.ts` (read-only grep hit = 1) → Linux CI checkout has the real file; the "APFS-inline inaccessible on Linux" premise (`households.service.stub.ts:2-3`) is a local iCloud/Docker artifact (see T9), not a CI reality.
- Stub vs real API (would not even compile against the real class):
  - stub `createHousehold(userId, {name})` (`stub.ts:19`) — real is `create(userId, dto)` (`households.service.ts:88`)
  - stub `acceptInvitation(userId, token: string)` (`stub.ts:54`) — real `acceptInvitation(userId, dto: AcceptInvitationDto)` (`:132`), checks `invitation.redeemedAt` (`:139`) vs stub `usedAt` (`stub.ts:61`)
  - stub `updateMemberRole(req, hh, target, role: string)` (`stub.ts:84-89`) — real takes `dto: UpdateMemberRoleDto` (`:531-536`)
  - stub uses `this.prisma.householdInvitation` (`stub.ts:49,55,75`) — no such model; schema has only `model Invitation` (`prisma/schema.prisma:297`), real uses `this.prisma.invitation` (`:122,133`)
- Real methods with **no test at all**: `previewInvitation`, `listPendingInvitations`, `declineInvitation`, `updateName`, `updateMealTypes`, `updateMealTimes`, `removeMember`, `leave` (`households.service.ts:270-627`).
- Blast radius of the mapper is limited: only `households.gateway.ts:11`, `households.module.ts:3` and the spec import `households.service`; no other spec pulls it transitively. `test/jest-e2e.json` has no mapper → e2e boots the real service.

**Why it escalates:** the assistant's household context (members, enabled slots, meal times → slot validator, "2 servings for a 2-person home") is served by this class; today any regression there is invisible while CI reports 17 green households tests.
**Fix (backend only):** delete `households.service.stub.ts` + the `moduleNameMapper`; rewrite the spec against the real signatures (Prisma mock delegates `household`, `membership`, `invitation`, `$transaction`), cover `acceptInvitation` (redeemed/expired/already-member/REQUIRES_LEAVE), `updateMealTypes` (base slots never removable), `leave`/`removeMember` (owner settlement via `settleHouseholdAfterMemberLeft`). Effort **3-4 h**. **FIX-BEFORE-PHASE-0**

### T2 — Unit specs are never type-checked anywhere (transpile-only), so spec/signature drift is silent — **P0**

**Evidence**

- `B/tsconfig.json:7` `"isolatedModules": true` → ts-jest `node_modules/ts-jest/dist/legacy/config/config-set.js:229` `this.isolatedModules = this.parsedTsConfig.options.isolatedModules ?? false;` → `ts-compiler.js:74` `if (!this.configSet.isolatedModules) { …diagnostics… }` skipped.
- `B/tsconfig.build.json:3` excludes `**/*spec.ts`, `**/*.stub.ts` → `pnpm build` never sees specs; ESLint (`projectService: true`) reports lint rules, not TS semantic errors.
- Drift already present: T1's non-existent methods; `weekly-plans.service.spec.ts:213` `dayOfWeek: 1,` while the DTO is `'MON'|…` (`dto/upsert-week-slot.dto.ts:16-22`) and the same spec uses `dayOfWeek: 'MON'` at `:241`.

**Why it escalates:** validator/tool specs for the assistant would be the primary safety net; a spec that no longer matches the service signature still passes.
**Fix (backend only):** add a CI step `pnpm exec tsc -p tsconfig.json --noEmit` (its `include` already covers `src/**` and `test/**`, `tsconfig.json:26`) before `pnpm test`; fix whatever surfaces (at minimum the two cases above). No local run needed (Mac can't run tsc per memory). Effort **1 h + fixes**. **FIX-BEFORE-PHASE-0**

### T3 — Two copies of the ingredient-normalization tables have already diverged; API path and script path write different `normalizedAmount` — **P0**

**Evidence**

- Util (imported by `scripts/import-recipes-from-json.ts:10` and `scripts/recompute-recipe-nutrition.ts:22`): `src/recipes/ingredient-amount.util.ts:34-52` — includes `'przyprawa uniwersalna': 4,` (`:51`). Header `:4-6` literally says it was extracted so that "each place doesn't own its own spoon table".
- Private duplicate in `src/recipes/recipes.service.ts:101-137` (tables) and `:215-284` (`normalizeText`, `normalizeIngredientAmount`) — `SPICE_GRAMS_PER_TEASPOON_BY_NAME` at `:109-128` **lacks** `przyprawa uniwersalna` → falls to default `?? 2.5` (`:279`). Computed: 1 łyżeczka → **4 g** via scripts vs **2.5 g** via WS `recipes:create/update` (`recipes.service.ts:611-612` writes `normalized.normalizedAmount`).
- No `ingredient-amount.util.spec.ts` exists (util list above: `----  src/recipes/ingredient-amount.util.ts (129 lines)`).
- Third copy of `normalizeText` in `src/weekly-plans/utils/text-normalization.util.ts:9-24` and a fourth in `prisma/seed.ts:5-21` (functionally equal today).

**Why it escalates:** the assistant's ingredient-balance math and macro digest read `RecipeIngredient.normalizedAmount`; the number depends on which writer touched the row, and every future table edit lands in only one copy.
**Fix (backend only):** delete the private copy; `RecipesService` imports `normalizeIngredientAmount`/`ALLOWED_UNITS` from the util and rethrows `Error` as `BadRequestException`; single `normalizeText` in `src/common`. Add `ingredient-amount.util.spec.ts` (table-driven: g/kg/ml/l/szt, łyżka ×3, szczypta /16, liquid condiments → ml, unknown spice 2.5 default, category gate). Data: run `pnpm recipes:recompute:nutrition` in the scratch container **after verifying** it rewrites `normalizedAmount` (it recomputes from raw amount/unit at `scripts/recompute-recipe-nutrition.ts:127`; if it only recomputes nutrition, add a 20-line rewrite step). Effort **2 h**. **FIX-BEFORE-PHASE-0**

### T4 — `parseWeekStart` accepts any date (no Monday/format check), untested; a wrong anchor silently creates a parallel week — **P1 (P0 once the assistant writes plans)**

**Evidence**

- `src/weekly-plans/utils/week-formatting.util.ts:6-16` — only `Number.isNaN(parsed.getTime())` is rejected; no `getUTCDay() === 1`, no `YYYY-MM-DD` regex. Used at 6 sites in `weekly-plans.service.ts` and 5 in `shopping-list.service.ts`.
- Uniqueness is per exact timestamp: `prisma/schema.prisma:346` `@@unique([householdId, weekStart])` (also `:474,489,525,560,574`).
- No validation upstream on WS (dev-documented: `weekly-plans.service.ts:688-696` "class-validator nie zagląda … `@Min/@Max` na DTO nigdy się nie uruchamiają"); gateway passes `payload.weekStart` straight through (`weekly-plans.gateway.ts:479-483`).
- The smoke e2e demonstrates the hole: `test/smoke.e2e-spec.ts:24-32` builds "next Monday" with local `setHours(0,0,0,0)` then `toISOString().slice(0,10)` → on a Europe/Warsaw machine that is the **Sunday** date; the test still passes and writes a Sunday-keyed `WeeklyPlan`. CI is UTC so it passes there for the wrong reason.

**Why it escalates:** the assistant (or the model) will emit `weekStart`; an off-by-one anchor writes a week the iOS app never displays, and the shopping list/archives key on the same value.
**Fix (backend only; iOS already sends Mondays):** strict regex + UTC-Monday check → `AppException('VALIDATION_ERROR', …, 400)`; `week-formatting.util.spec.ts` (valid Monday, Sunday, ISO-with-time, garbage, leap day); fix the e2e helper to use `Date.UTC`. One-off audit SQL in the container: `SELECT count(*) FROM "WeeklyPlan" WHERE extract(isodow FROM "weekStart") <> 1` (repeat for `SharedMealPlan`, `ShoppingList*`). Effort **1.5 h**. **FIX-BEFORE-PHASE-0**

### T5 — Shopping-list identity logic (productKey, canonical name, department) has no tests; the shopping spec covers aggregation only — **P1**

**Evidence**

- Untested: `utils/department-classifier.util.ts` (193 lines; `canonicalizeIngredientName:31`, `resolveDepartment:174`), `utils/shopping-classification.constants.ts` (289), `utils/text-normalization.util.ts` (`normalizeProductKey:3`), `utils/shopping-items.util.ts` (`itemSignature:13`), `utils/week-formatting.util.ts`, `auth/jwt-expiration.util.ts`.
- `shopping-list.service.ts:148-154` — `baseAmount = ingredient.normalizedAmount ?? ingredient.amount` (silent fallback to raw amount when normalization is missing), key = `normalizeProductKey(canonicalizeIngredientName(name, unit), unit)`. `shopping-list.service.spec.ts` (322 lines, 11 cases) forces `isStale: true` (`:98-105`) and asserts totals via a diacritic-folded substring match (`:130-137`), so canonicalization/department are never pinned; nothing covers archive `revision`/`signature` (`service.ts:586-628`), check-state carry-over across rebuild, or the `?? amount` fallback.
- `resolvePlannedServings`/`resolveUpdatedPlannedServings` are private (`weekly-plans.service.ts:683,729`) but well covered indirectly (`weekly-plans.service.spec.ts:239-497`, 16 cases incl. clamp 1..12, CREATED/DETAILS_CHANGED/NOOP) — FINE.

**Why it escalates:** "ingredient balance" in the assistant means merging by productKey; a keyword/regex edit in the classifier silently splits or merges products and there is no golden test to show which.
**Fix (backend only):** golden spec in the style of `suitable-meal-types.util.spec.ts` (real catalog names from `prisma/catalog/recipes-catalog-full-v2.json` → expected canonical name + department + productKey), plus 3 shopping-list cases: check carry-over on rebuild, `normalizedAmount: null` must **not** fall back silently (log or exclude), archive signature stability. Effort **3 h**. **FIX-BEFORE-PHASE-0**

### T6 — E2E smoke boots without the production pipes and depends on dev-login; a boot-time AI guard would break CI — **P1**

**Evidence**

- `test/smoke.e2e-spec.ts:67-73` `createNestApplication(); await app.init()` — `main.ts:21-27` `useGlobalPipes(new ValidationPipe({ whitelist, forbidNonWhitelisted, transform }))` is never applied → no test exercises HTTP DTO validation.
- Smoke's two auth/WS tests call `POST /auth/dev` (`:108,138`); `auth.service.ts:174` only refuses when `AUTH_DEV_LOGIN_ENABLED === 'false'`; CI sets `'true'` (`.github/workflows/backend-ci.yml:34`). Phase 0 (disable dev login) will break the smoke unless a test login path stays.
- CI env (`backend-ci.yml:30-39`) has only `COOKIDOO_ENCRYPTION_KEY` — added precisely because `CookidooIntegrationService` throws at boot; no `COOKIDOO_SERVICE_URL/TOKEN` (client defaults; no test touches it — fine). An `AI_*` guard implemented the same fail-fast way makes `test:e2e:ci` red on day one.
- Smoke never cleans rows it creates (no `deleteMany`) — acceptable in ephemeral CI Postgres.

**Fix (backend only):** extract `configureApp(app)` from `main.ts` and call it in the e2e; make dev login `NODE_ENV=test`-gated rather than env-string gated; new module must default to `AI_ENABLED=false` and never throw at boot when disabled; add `AI_*` to the workflow env. Effort **1 h**. **FOLD-INTO-PHASE-0**

### T7 — Type/lint gates are soft, and `scripts/` (the DB writers) are outside every gate — **P2 (agent override: P1)**

**Evidence**

- `eslint.config.mjs:31-35` all `no-unsafe-*` = `'warn'`; `package.json` `lint:check` has no `--max-warnings` → warnings never fail CI. `tsconfig.json:22` `noImplicitAny: false`. Explicit `any` in non-test `src`: 5 occurrences / ~12k lines (auth 2, common 1, integrations 1, users 1) — the risk is untyped callback params, not explicit `any`.
- `tsconfig.json:26` include = `src/**`, `test/**`; lint glob `{src,apps,libs,test}` → `scripts/*.ts` (import/recompute/backfills that write `normalizedAmount`, nutrition, servings) are only ever run via `tsx` (transpile-only): no typecheck, no lint, no tests.
- A per-directory `noImplicitAny` via a second tsconfig is **not** cleanly feasible: `tsc -p tsconfig.agent.json` also type-checks everything `src/agent` imports (services → whole graph). Feasible now: ESLint `files: ['src/agent/**/*.ts']` override with `no-unsafe-*`/`no-explicit-any`/`no-floating-promises` = `error`, plus `--max-warnings 0` scoped via a second script `lint:agent`.

**Fix:** (a) ESLint override for `src/agent/**` (0.5 h, FOLD-INTO-PHASE-0); (b) add `scripts/**/*.ts` to lint + a `tsconfig.scripts.json` `--noEmit` CI step (1 h); (c) non-blocking CI job `tsc --noEmit --noImplicitAny` to count errors, flip to blocking at zero (LATER). Backend only.

### T8 — iOS has no test target; Cookidoo has no CI; backend CI ignores `develop` pushes — **P2**

**Evidence:** `weekly-meals-ios/weekly meals.xcodeproj/project.pbxproj` — one `PBXNativeTarget`, `productType = "com.apple.product-type.application"`, 0 matches for `XCTest|Tests`; `ios-ci.yml:36-49` builds `generic/platform=iOS Simulator` only, on PR. `weekly-meals-cookidoo` has 6 mocked pytest cases (`tests/test_smoke.py:34-111`, no network) and no `.github/` dir. `backend-ci.yml:3-8` triggers on `pull_request` + push to `main/master` only. **LATER** (add an iOS `Tests` target when the assistant UI lands; a 15-line pytest workflow for Cookidoo is 0.5 h).

### T9 — Sources live in iCloud-synced `~/Desktop` and get evicted; this is the actual origin of the stub — **P2 (fix together with T1)**

**Evidence:** first scan `find src -flags +dataless` listed `main.ts`, `app.module.ts`, `auth/*`, and `ls -lO src/households` showed `compressed,dataless` on all 9 files (they materialized after reading; a later count showed 0). `Dockerfile:21` `COPY . .` reads them on the Mac → EIO on evicted files (matches memory "bind-mount wywala EIO"). No empty files under `src/`; the 39 files < 1 KB are legitimate modules/DTOs. **Fix:** move the three repos out of iCloud (or "Keep Downloaded"), then remove the stub. 0.5 h. **FIX-BEFORE-PHASE-0**

---

## (7) Minimal test scaffolding to add before the assistant (~8 h, backend)

1. `test/fixtures/household.ts` — 2-member household as Prisma-shaped rows: Anna (`dietPreference: VEGETARIAN`, `allergens: ['orzechy','laktoza']`, `calorieGoal: 1800`), Marek (`NONE`, `[]`, `2600`), `enabledMealTypes` with one optional slot, meal times. Fields exist today (`schema.prisma:59-70`, enums `:664-680`); `prisma/seed.ts` creates **no** `UserPreference` rows, so nothing reusable exists. Usable by mock-Prisma unit tests and by DB-backed e2e via `prisma.household.create`. (2 h)
2. `test/fixtures/week.ts` — `WEEK_MONDAY = '2026-04-13'`, UTC `weekOf()`, a Plan v2 week with a split slot, a solo slot and a `plannedServings` override; move the `dayItem/poolItem/weekPlanWith` builders out of `shopping-list.service.spec.ts:45-84` so both specs and the future validator spec share them. (1 h)
3. `test/fixtures/recipes.ts` — 6 real entries (ids + ingredients with `normalizedAmount/normalizedUnit/department`) picked from `prisma/catalog/recipes-catalog-full-v2.json` to cover allergen hit, vegan, high-kcal, snack-only `suitableMealTypes`. (1 h)
4. `src/agent/model-client.ts` — `interface ModelClient { complete(req): Promise<res> }` with `FakeModelClient` (scripted tool calls) and `RecordedModelClient` (JSON cassettes under `test/cassettes/`, keyed by request hash, **fail on miss in CI**) so validator/tool tests run with no network and no API key. (3 h)
5. `validator.spec.ts` skeleton — table-driven: allergen, diet, kcal band, `servings` vs `plannedServings`, slot ∈ household enabled slots, `suitableMealTypes`, weekStart Monday. (1 h)
6. CI: `tsc --noEmit` step (T2), `AI_ENABLED=false` in workflow env (T6).

---

## Checked and found FINE

- `common/crypto.util.spec.ts` — round-trip with Polish chars, random IV, GCM tamper, wrong key, bad format, 32-byte key rule; real code.
- `auth/auth.service.spec.ts` refresh — rotation sets `revokedAt`, unknown/revoked/expired → 401; e2e `smoke.e2e-spec.ts:106-133` proves real rotation + reuse → 401 on Postgres. No token family/cascade exists (`schema.prisma:99-111` has no `familyId`) — Phase 0 design item, not a test gap.
- `recipes/recipe-nutrition.util.spec.ts` — per-100 basis, `gramsPerPiece`, missing-nutrition reporting, Atwater, rounding; scripts import the same util (no duplication there).
- `recipes/suitable-meal-types.util.spec.ts` — 587 lines, real-catalog golden fixture, idempotence/invariants; the pattern to copy for T5.
- `save-shared-meal-plan.dto.spec`, `invitation-status.util.spec`, `household-cleanup.util.spec`, `notification-batcher.spec`, `notification-copy.util.spec`, `quiet-hours.util.spec`, `apple-identity.service.spec` — all exercise real code; the mapper regex matches only `households.service`.
- `test/jest-e2e.json` — no mapper; e2e boots the real `HouseholdsService`; CI applies migrations to Postgres 16 first (`backend-ci.yml:62-63`) and runs `--runInBand`.
- `tsconfig.build.json:3` excludes `*.stub.ts` → stub never in `dist`; Docker runner executes `dist/main` and never runs jest, so the mapper is irrelevant to the image.
- Lockfile pairing `ts-jest@29.4.6` + `jest@30.2.0` + `typescript@5.9.3` is a supported combination.
- Husky pre-commit is `pnpm lint-staged` only (no tests); CI `lint:check` remains the gate; local bypass is `HUSKY=0`.
- No `anthropic|openai|AI_ENABLED` references anywhere in `src/`, `scripts/`, `test/`, workflows or `.env.example` (0 hits) — clean slate for the module.
- WS payload non-validation is known and documented by the developer (`weekly-plans.service.ts:688-696`); the assistant's tool layer will call services directly, so its validator must not rely on class-validator decorators either.
- Cookidoo tests are hermetic (monkeypatched `cookidoo_client`, `INTERNAL_TOKEN` set in-process) and correct for what they cover.
