# Backend platform hygiene — findings (read-only audit, verified against source)

`B` = `/Users/rafi/Desktop/Scoffie App/scoffie-backend`, `I` = `/Users/rafi/Desktop/Scoffie App/scoffie-ios/Scoffie`, `C` = `/Users/rafi/Desktop/Scoffie App/scoffie-cookidoo`.

---

## F1 — P0 — JWT secret and refresh pepper silently fall back to public defaults; nothing refuses to boot in production

**Evidence**

- `B/src/auth/auth.module.ts:13` — `secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',`
- `B/src/auth/auth.service.ts:46-47` — `refreshTokenPepper = process.env.REFRESH_TOKEN_PEPPER ?? process.env.JWT_SECRET ?? 'dev-pepper';`
- `grep -rn NODE_ENV B/src B/scripts` → 0 hits. `B/Dockerfile:29` sets `ENV NODE_ENV=production` but nothing reads it. The only fail-fast in the codebase is `parseEncryptionKey` (`B/src/integrations/cookidoo-integration.service.ts:34-36`).
  **Why it escalates:** the assistant will be REST + `JwtAuthGuard`. One lost/renamed Railway var and every access token is forgeable with a string committed to the repo → free use of a metered LLM endpoint billed to you, plus impersonation of any household.
  **Fix:** `src/config/assert-env.ts` called first thing in `bootstrap()`: if `NODE_ENV==='production'` and (`JWT_SECRET` missing / `< 32` chars / equals `replace-me` or the default, or `REFRESH_TOKEN_PEPPER` missing, or `COOKIDOO_SERVICE_TOKEN` empty — see F13) → throw before `NestFactory.create`. Backend only, no migration. **Effort 1h. FIX-BEFORE-PHASE-0.**

## F2 — P0 — `POST /auth/google` mints a full session for any `googleId` in the body; iOS never uses it

**Evidence**

- `B/src/auth/auth.service.ts:55-60` — `if (!dto.googleId || !dto.displayName) throw …; const user = await this.prisma.user.upsert({ where: { googleId: dto.googleId },` — no Google token verification at all (`GoogleOauthDto` is just strings, `B/src/auth/dto/google-oauth.dto.ts:8`).
- Dev users are keyed `googleId = 'dev:<email>'` (`auth.service.ts:184-185`) and auto-recovered users `googleId: 'legacy-<uuid>'` (`B/src/recipes/recipes.service.ts:152`) → `/auth/google` with that string returns access+refresh tokens for an existing account.
- `grep -rn "auth/google" I` → 0 hits; iOS only calls `auth/apple` (`I/Models/Stores/SessionStore.swift:251`).
  **Why it escalates:** unauthenticated account creation and takeover of any user whose `googleId` is known (and `users:findAll` leaks them all — F5).
  **Fix:** delete the endpoint, DTO, `loginWithGoogle` and its 4 spec cases (`auth.service.spec.ts:206-262`). If Google login is ever wanted, verify an ID token with `google-auth-library`. **Effort 0.5h. FIX-BEFORE-PHASE-0.**

## F3 — P0 — `/auth/dev` is enabled by default (opt-out), and every doc/example ships it enabled

**Evidence**

- `B/src/auth/auth.service.ts:174` — `if (process.env.AUTH_DEV_LOGIN_ENABLED === 'false')` — only the literal `'false'` disables it.
- `B/.env.example:9` `AUTH_DEV_LOGIN_ENABLED=true`; `B/DEPLOYMENT.md:23` lists `AUTH_DEV_LOGIN_ENABLED=true` in the _minimum production_ set.
- iOS has no dev-login code path (`grep loginDev|DevLogin I` → 0; only an error-string mention at `I/Models/Stores/UserFacingErrorMapper.swift:27`).
- Each call with a new `displayName`/`email` creates a user row (L187-202); no rate limit (F6).
  **Why it escalates:** same as F2 — free tokens for the paid endpoint; unbounded ghost users pollute anything the assistant aggregates.
  **Fix:** invert to `!== 'true'`; set Railway var `false`; update `.env.example`/`DEPLOYMENT.md`. CI already sets `'true'` explicitly (`B/.github/workflows/backend-ci.yml:34`) and the smoke e2e needs it (`B/test/smoke.e2e-spec.ts:106-116`), so nothing else changes. Closes RELEASE_CHECKLIST P0 lines 5-6. **Effort 0.5h. FIX-BEFORE-PHASE-0.**

## F4 — P0 — iOS never calls `/auth/refresh`; the 30-day access JWT expires and REST features die silently while the app keeps working over WS

**Evidence**

- `B/src/auth/jwt-expiration.util.ts:7` — `DEFAULT_JWT_EXPIRES_IN: JwtExpiresIn = '30d';` (`.env.example:6` same).
- `grep -rn "auth/refresh" <whole iOS repo>` → 0 hits. `SessionStore.swift` touches `refreshToken` only for Keychain save/delete (L1417, L1482). The comment at L371 ("backend zwróci 401 i wtedy zadziała refresh/logout") describes a handler that does not exist.
- `I/Networking/Integrations/IntegrationsAPIClient.swift:116-120` maps 401 → `"UNAUTHORIZED"`; `I/Models/Stores/CookidooIntegrationStore.swift:148-149` shows "Sesja wygasła. Zaloguj się ponownie" — but WS transport carries no JWT, so the rest of the app works and nothing logs the user out.
- `RollingTokenInterceptor` (`B/src/auth/rolling-token.interceptor.ts`) is registered (`auth.module.ts:24,26`) but never applied (`grep UseInterceptors B/src` → 0), and iOS never reads `x-access-token` (grep → 0).
  **Why it escalates:** the assistant will sit behind the same guard. Every user ~30 days after install loses the assistant with a confusing message, in an otherwise-working app. First TestFlight cohort hits this a month after Phase 0 ships.
  **Fix (both repos):** iOS — refresh-on-401 in `IntegrationsAPIClient.perform` (POST `/auth/refresh` with Keychain refresh token, persist new pair, retry once; 401 from refresh → `logout()`). Backend — delete `RollingTokenInterceptor`; once refresh exists, shorten `JWT_EXPIRES_IN` to ≤1d. Pair with F8. **Effort iOS 3h, backend 0.5h. FOLD-INTO-PHASE-0** (Phase 0 must include the client side, not just server auth).

## F5 — P0 — Unauthenticated Socket.IO `users:findAll` dumps the whole `User` table; `users:create` / `users:findById` / `users:delete` are open too

**Evidence**

- `B/src/users/users.gateway.ts:67-70` — `@SubscribeMessage('users:findAll') findAll() { return wsRespond(() => this.usersService.findAll()); }`
- `B/src/users/users.service.ts:57-59` — `findAll() { return this.prisma.user.findMany({ orderBy: { createdAt: 'desc' } }); }` — no `select`: full rows incl. `googleId`, `appleSub`, `email`, `weightKg`, `sex`, `yearOfBirth`, `heightCm` (`B/prisma/schema.prisma:10-37`).
- `users.gateway.ts:101-104` — `users:delete` → `deleteAccount(payload.userId)` (`users.service.ts:407-441`) deletes any account by id from the payload.
- No gateway verifies a JWT (`grep -l "handshake|verifyAsync" B/src/**/*.gateway.ts` → none); `B/src/common/ws-gateway-options.ts:5-6` default CORS `'*'`.
- iOS uses only `users:delete` of these (`I/Models/Stores/SessionStore.swift:333`); `findAll`/`findById`/`create` are unused by any client.
  **Why it escalates:** PII leak today; `googleId` leak + F2 = takeover of every Google/dev/legacy account; once the assistant stores dietary/health context per user the leaked surface grows; guessed UUID + `users:delete` = account destruction.
  **Fix now (independent of WS auth):** delete the three unused handlers, `UsersService.findAll/findById/create`, and `CreateUserDto`. `users:delete` needs Phase 0 WS auth. **Effort 0.5h. FIX-BEFORE-PHASE-0** (full WS auth = Phase 0).

## F6 — P1 — No rate limiting anywhere; `@nestjs/throttler` is installed and unused; `req.ip` is not the client IP

**Evidence**

- `B/package.json:50` `"@nestjs/throttler": "^6.5.0"`; `grep -rni Throttler B/src` → 0.
- `/auth/dev`, `/auth/google` insert rows per call; `/integrations/cookidoo/connect` (`B/src/integrations/integrations.controller.ts:20-23`) proxies a real login to Vorwerk per request → credential-stuffing relay from your IP.
- `B/src/main.ts` never sets `trust proxy`, so `ip=` in `B/src/observability/request-logging.interceptor.ts:61` is Railway's proxy address.
  **Why it escalates:** the assistant endpoint is metered per call; one loop drains the budget.
  **Fix:** `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }])` + `APP_GUARD: ThrottlerGuard`; `@Throttle({ default: { limit: 5, ttl: 60_000 } })` on `AuthController` and the future assistant controller; `app.set('trust proxy', 1)`. Backend only. **Effort 1.5h. FOLD-INTO-PHASE-0.**

## F7 — P1 — `JwtAuthGuard` never checks the user still exists → deleted accounts keep a valid token for up to 30 days and produce 500s

**Evidence**

- `B/src/auth/jwt-auth.guard.ts:30-31` — `const payload = await this.jwtService.verifyAsync<{ sub: string }>(token); request.user = { id: payload.sub };`
- `users.service.ts:438` `tx.user.delete` cascades `RefreshToken` (schema L107 `onDelete: Cascade`) but not the outstanding access JWT (`{ sub }` only, `auth.service.ts:234`).
- `B/src/integrations/health-steps.service.ts:31-39` upserts `DailyStepCount` keyed by that `userId` → FK violation P2003 → no exception filter → default 500.
  **Why it escalates:** every assistant write keyed by `userId` from the JWT becomes a 500 for a deleted user, and a deleted user can still spend LLM budget.
  **Fix:** in the guard, `prisma.user.findUnique({ where: { id: sub }, select: { id: true } })` → 401 if missing (or a `tokenVersion` column embedded in the JWT). **Effort 1h. FOLD-INTO-PHASE-0.**

## F8 — P1 — Refresh rotation is non-atomic, has no family revocation on reuse, and rows are never pruned

**Evidence**

- `B/src/auth/auth.service.ts:209-224` — `findUnique` → check `revokedAt`/`expiresAt` → separate `update({ where: { tokenHash }, data: { revokedAt } })`. Two concurrent requests with the same token both pass L213-219 before either reaches L221 → two live token families from one refresh.
- Reuse of a revoked token → `UnauthorizedException` only (L218); nothing revokes the user's other tokens.
- `grep "refreshToken\.(deleteMany|updateMany)" B/src B/scripts` → 0. Every login (`buildAuthResult` L246-248) and refresh inserts a row; `@@index([expiresAt])` (schema L110) is unused.
- Smoke e2e covers the happy path + single reuse only (`B/test/smoke.e2e-spec.ts:106-132`).
  **Why it escalates:** F4 makes this path hot; the race hands out orphan tokens; table grows unbounded.
  **Fix:** `updateMany({ where: { tokenHash, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } })` and treat `count === 0` as 401; on reuse of a revoked token `updateMany({ where: { userId, revokedAt: null } })`; prune `expiresAt < now OR revokedAt < now-7d` at boot in the safe-migrate script (no scheduler exists). Backend only. **Effort 1.5h. FOLD-INTO-PHASE-0.** Then tick RELEASE_CHECKLIST L7.

## F9 — P1 — Error contract is three different wire shapes; `AppErrorCode` drift; no global exception filter; WS leaks raw error messages

**Evidence**

- 25 `new AppException(` vs 56 bare Nest exceptions in non-spec `B/src` (`weekly-plans.service.ts` 9, `households.service.ts` 10, `recipes.service.ts` 6, `auth.service.ts` 6, `jwt-auth.guard.ts` 2, …), e.g. `B/src/weekly-plans/weekly-plans.service.ts:147` `throw new NotFoundException('Weekly plan not found');`, `B/src/recipes/recipes.service.ts:202` `throw new ForbiddenException('User not found');`.
- Over HTTP: `AppException` → `{ code, message, details }` (`B/src/common/app-exception.ts:11-17`); bare Nest → `{ statusCode, message, error }`; `ValidationPipe` (`main.ts:21-27`) → `{ statusCode, message: string[], error }`. iOS reads only `code`/`message` (`I/Networking/Integrations/IntegrationsDTOs.swift:71-77`) and falls back to `HTTP_ERROR` (`IntegrationsAPIClient.swift:118-119`).
- Over WS `wsRespond` (`B/src/common/ws-response.ts:59-67`) synthesizes `NOT_FOUND`/`FORBIDDEN` from status, so the same error has a code on WS and none on HTTP. Non-`HttpException` errors return the raw `error.message` to the client (`ws-response.ts:70-71`) — Prisma messages carry model/field names and, for validation errors, the full args object.
- `grep -rE "APP_FILTER|ExceptionFilter|@Catch" B/src` → 0.
- Union entries never thrown via `AppException`: `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT`, `COOKIDOO_SUBSCRIPTION_INACTIVE`, `INTERNAL_ERROR`. Thrown-but-not-in-union: none in Nest (TS enforces); across the service boundary the Python service emits `COOKIDOO_UPSTREAM_ERROR` (HTTP 502, `C/app/cookidoo_client.py:53-59`) which `B/src/integrations/cookidoo-service.client.ts:105-113` collapses into `COOKIDOO_SERVICE_UNAVAILABLE` 503 "chwilowo niedostępna" — a Vorwerk-side failure is indistinguishable from "our microservice is down" in metrics and on the phone.
  **Why it escalates:** the assistant's tool layer must tell NOT_FOUND / FORBIDDEN / VALIDATION apart to decide retry vs re-plan vs tell-the-user; with three shapes each tool needs bespoke parsing and the iOS chat UI needs a second mapper. Cheapest to fix before writing tools on top.
  **Fix:** (a) global `@Catch()` filter normalizing everything to `{ code, message, details?, requestId }` — map bare Nest by status (reuse `STATUS_CODE_MAP`), Prisma P2002→`CONFLICT`, P2025→`NOT_FOUND`, P2003→`VALIDATION_ERROR`, class-validator → `VALIDATION_ERROR` + `details: string[]`, unknown → `INTERNAL_ERROR` with message hidden and stack logged with `requestId`; (b) `wsRespond` uses the same mapper; (c) add `COOKIDOO_UPSTREAM_ERROR` (502) to the union and the client switch; either throw `COOKIDOO_SUBSCRIPTION_INACTIVE` in `connect()` when `subscription?.active === false` (`cookidoo-integration.service.ts:55-58` ignores it) or delete it. The 56-throw sweep can follow gradually. **Effort 3h (filter + mapper + tests). FIX-BEFORE-PHASE-0** for the filter/union; throw-site sweep LATER.

## F10 — P1 — `SAFE_MIGRATE_REBUILD_DB` drops the production schema on _every_ container start for as long as the env var stays set

**Evidence**

- `B/scripts/prisma-migrate-deploy-safe.js:445-455` — `if (process.env.SAFE_MIGRATE_REBUILD_DB === 'true') { … if (confirm !== 'YES_I_UNDERSTAND') exit(1); await rebuildDatabaseFromScratch(prisma); }` → L375 `DROP SCHEMA IF EXISTS public CASCADE;`
- `B/Dockerfile:55` runs this script in `CMD` on every start; platform env vars persist across restarts; no `NODE_ENV`/host check/one-shot nonce. `.env.example:72-73` lists the flag among ordinary settings; `DEPLOYMENT.md:75` only warns.
  **Why it escalates:** once the assistant persists conversations/plans, a forgotten flag + a routine redeploy or OOM restart = total loss, with the backup process still unchecked (`RELEASE_CHECKLIST.md:12`).
  **Fix:** require `SAFE_MIGRATE_REBUILD_CONFIRM` to equal today's UTC `YYYY-MM-DD` (self-expiring); refuse under `NODE_ENV==='production'` unless `SAFE_MIGRATE_ALLOW_PROD_REBUILD` equals the `DATABASE_URL` host; log the host before dropping. **Effort 0.5h. FIX-BEFORE-PHASE-0.**

## F11 — P1 — Prod image: EOL Node 20 (CI/README say 22), boot-time `tsx` R2 backfill on every start, root user, no HEALTHCHECK, ships `src`/`test`/devDeps

**Evidence**

- `B/Dockerfile:1,13,24` `node:20-bookworm-slim` vs `B/README.md:26` "Node.js 22+" and `B/.github/workflows/backend-ci.yml:53` `node-version: 22`. Node 20 reached end-of-life 2026-04-30 (today 2026-08-27) → prod runs an unsupported runtime that CI never tests.
- `prisma-migrate-deploy-safe.js:562` `runOptionalR2ImageBackfill()` unconditional unless `=== 'false'` (L416); it spawns `pnpm exec tsx scripts/backfill-recipe-image-urls-from-r2.ts` (L428-432) which does one R2 `HEAD` per recipe per extension (`backfill-recipe-image-urls-from-r2.ts:127-135`, 4 extensions L24) before `node dist/main` starts, and merely warns on failure (L433-437).
- `Dockerfile:9` `pnpm install --frozen-lockfile` (no prod prune), `:32` full `node_modules`, `:34-35` `COPY src`/`test`; no `HEALTHCHECK`, no `USER`. The CMD depends on `prisma` and `tsx` which are devDependencies (`package.json:79,87`).
  **Why it escalates:** every restart pays TS compile + R2 scan before `/ops/health` answers → slow recovery loops under OOM once an LLM SDK is loaded; root + shipped sources widen the blast radius of any tool-layer RCE.
  **Fix:** `node:22-bookworm-slim` (5 min, matches CI); set `SAFE_MIGRATE_BACKFILL_R2_IMAGE_URLS=false` on Railway and keep the backfill as a `commands.txt` one-off; add `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/ops/health').then(r=>process.exit(r.ok?0:1))"` and `USER node` after `chown`. Moving `prisma`/`tsx` to `dependencies` + `pnpm prune --prod` is optional. **Effort 1h. FIX-BEFORE-PHASE-0** (Node bump + backfill flag); rest LATER.

## F12 — P2 — Recipes cache is process-local 90 s with no catalog version; content scripts bypass it; phones converge on next launch — fine today, needs a version once the assistant has a digest

**Evidence**

- `B/src/recipes/recipes-cache.service.ts:15-19` in-memory, TTL 90 s; keys are shared `userId: 'global'` (`recipes.service.ts:442-461`); invalidation only in `create` (`:627`) and `setFavorite` (`:667`). The 10 content scripts (`scripts/recompute-recipe-nutrition.ts`, `import-recipes-from-json.ts`, `backfill-suitable-meal-types.ts`, `fix-recipe-image-urls.ts`, …) run out-of-process (`B/commands.txt:63-72` `railway run … tsx scripts/…`) → API serves stale rows ≤ 90 s. Acceptable.
- iOS `I/Models/Stores/RecipeCatalogStore.swift:26` `cacheMaxAge = 12 h`, but `loadIfNeeded()` (L92-102) serves the cache then immediately `reload()`s all pages, and every socket reconnect reloads (L70-82). The `_v10` filename (L40-51) is the manual schema-version mechanism. So prod content reaches phones on next cold launch/foreground, not after 12 h.
- No version/ETag: `Recipe.updatedAt` exists (schema L154) but the list DTO exposes no `max(updatedAt)`/count, so a phone cannot cheaply ask "changed?".
  **Why it escalates:** the assistant's catalog digest (from DB) and a phone's catalog can differ for ≤ 90 s + until next foreground; recipe ids the assistant proposes may not yet be in the phone's list after an import.
  **Fix (when the digest exists):** expose `catalogVersion = max(updatedAt)|count(isActive)` on `recipes:findAll` and in the digest; iOS compares before re-pulling; server derives cache validity from it. Both repos. **Effort 2h. LATER.**

## F13 — P2 — Cookidoo drift items

- `B/src/integrations/cookidoo-service.client.ts:23` `token = process.env.COOKIDOO_SERVICE_TOKEN ?? ''` — no fail-fast; Python does fail-fast (`C/app/config.py:15-19`) and compares with `hmac.compare_digest` (`C/app/security.py:13`), so an empty Nest token surfaces as `INTERNAL_UNAUTHORIZED`→503 at first use. Add to the F1 assertion (5 min).
- `COOKIDOO_SUBSCRIPTION_INACTIVE` declared (`app-error-code.ts:28`), never thrown; `COOKIDOO_UPSTREAM_ERROR` not modeled — both covered in F9.
- Python `POST /v1/my-week/remove` (`C/app/main.py:71-85`) has no Nest caller — harmless dead surface. **LATER.**

## F14 — P2 — `/ops/metrics` public; request-id HTTP-only; shutdown hooks never fire

- `B/src/observability/ops.controller.ts:16-28` `@Get('metrics')` unguarded → route list, per-route error counts, migration names (`:55-74`), cache stats. `/ops/health` public is fine.
- `B/src/observability/request-logging.interceptor.ts:26-28` returns early for non-HTTP → no correlation id on WS.
- `B/src/main.ts` never calls `app.enableShutdownHooks()` → `PrismaService.onModuleDestroy` (`B/src/prisma/prisma.service.ts:13-15`) and `NotificationsService.onModuleDestroy` never run on SIGTERM despite the `exec` rationale in `Dockerfile:52-55`.
  **Fix:** `OPS_TOKEN` header check on `/ops/metrics` (10 min); `app.enableShutdownHooks()` (1 line); WS request-id LATER. **Effort 0.5h. FOLD-INTO-PHASE-0.**

## F15 — P2 — Migration hygiene (note only)

- Manual timestamps (`…HHMM00`, e.g. `20260821140000`, `20260827120000`): fine for one developer; `migrate deploy` applies unapplied files in name order.
- `IF NOT EXISTS` convention starts at `20260822090000`; `20260819190000_plan_item_consumptions:8,16,19,22-29`, `20260820120000_…:21-28`, `20260821120000_…:13,15`, `20260821140000_…:9-11`, `20260821160000_…:13` are unguarded. Already applied on prod and each file runs in one transaction, so re-run only happens via the safe-script `resolve --applied` path (`prisma-migrate-deploy-safe.js:540-551`), which correctly requires a clean `migrate diff` first (`:518-537`). No action.
- The `20260216094429_ingredient_catalog_v1` auto-repair (`:465-481, :491-502`) is dead weight on a healthy prod DB; harmless. **LATER/none.**

## F16 — P2 — Dead code/deps

`RollingTokenInterceptor` (F4), `@nestjs/throttler` unused (F6), `swagger-ui-express` + `@nestjs/swagger` decorators with no `SwaggerModule.setup` in `main.ts`, `users:create/findAll/findById` (F5), Python `remove` route (F13). **Effort 0.5h. LATER** except where folded above.

---

### RELEASE_CHECKLIST P0 items closable cheaply

- L5-6 (dev login / `AUTH_DEV_LOGIN_ENABLED=false`) → F3.
- L7 (refresh rotation) → `test/smoke.e2e-spec.ts:106-132` already proves rotation+reuse→401; tick after F8.
- L11 (data deletion) → `users:delete` exists but is unauthenticated (F5) → tick after Phase 0 WS auth.
- L12 (backup/rollback) → not cheap, but F10 makes it urgent.

### Checked and found FINE

- Apple sign-in: JWKS signature, `iss`, `aud` allow-list (default `app.scoffie`, `apple-identity.service.ts:62-65`), nonce sha256 check.
- Refresh token entropy/storage: 64 random bytes, sha256+pepper, `tokenHash @unique`, cascade on user delete.
- All 17 `AppException` codes thrown are in the union (TS-enforced); no cast-around.
- Cookidoo credentials: AES-256-GCM with fail-fast key parse; password never decrypted in `status()`; bodies never logged.
- HTTP CORS is an allow-list from `CORS_ORIGIN`; `WS_CORS_ORIGIN='*'` is moot until WS auth exists (Phase 0).
- Body limits: Express default 100 kB JSON, Socket.IO default 1 MB — adequate; helmet unnecessary for a JSON API with an empty `public/` (0 B).
- Safe-migrate unknown-failure path requires a clean `prisma migrate diff` before `resolve --applied` — correct.
- `.dockerignore` excludes `.env`; CI injects dummy secrets explicitly.
- `20260823100000_plan_item_planned_servings` backfill idempotent via `WHERE "plannedServings" = 1`; all migrations from `20260822` on are guarded (`IF NOT EXISTS` / `DO $$`).
- `HealthStepsService.toUtcDate` round-trip validation prevents `2026-02-30` drift and Prisma 500s.
- `/ops/health` has no DB dependency and exposes the commit.
- `RecipesCacheService` honours `RECIPES_LIST_CACHE_ENABLED`/TTL; `stats()` accurate; list ordering `createdAt desc, id desc` is deterministic for pagination.
- `ValidationPipe` `whitelist + forbidNonWhitelisted + transform` on all HTTP DTOs; `SendToWeekDto` date regex, `SyncHealthStepsDto` bounds.
- `runSerializable` retry on P2034; `PrismaService.$connect` on init.
