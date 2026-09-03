# Weekly Meals Backend

Backend API for the Weekly Meals iOS app. It serves recipes, households, weekly plans, shopping lists, realtime updates, and push notifications.

## Stack

- NestJS 11
- Prisma + PostgreSQL
- Socket.IO for realtime sync
- APNs for iOS push
- Optional Cloudflare R2 for recipe images

## What lives here

- Auth and refresh-token rotation
- Household creation, membership, and invitations (one household per account —
  accepting an invitation while already in one is an explicit move, see
  `src/households/invitation-status.util.ts`)
- Recipes catalog and favorites
- Weekly plan (target-state writes with hard allergen/exclusion gates) and the
  AI assistant (`src/agent/`: proposals with apply/undo, household memory)
- Shopping list generation, archive history, and realtime updates
- Ops endpoints for health and lightweight metrics

## Requirements

- Node.js 22+
- pnpm 10+
- PostgreSQL 16+

## Local development

### Option A: local API + Docker Postgres

```bash
cp .env.example .env
docker compose up -d db
pnpm install
pnpm prisma:generate
pnpm prisma:migrate:deploy
pnpm start:dev
```

### Option B: full Docker stack

```bash
cp .env.example .env
docker compose up -d --build
```

## Useful checks

- Health: `http://localhost:3000/ops/health`
- Metrics: `http://localhost:3000/ops/metrics`
- Static recipe assets: `http://localhost:3000/static/...`
- WebSocket smoke: `pnpm ws:smoke`

## Important scripts

- `pnpm start:dev` - local development server
- `pnpm start:prod` - production start with safe Prisma migration bootstrap
- `pnpm prisma:migrate:deploy` - safe migration entrypoint used in production
- `pnpm recipes:import:json` - import recipes from JSON (the **only** writer of
  the shared catalog: rows land with `isCatalog: true`)
- `pnpm generate:recipe:images` - generate recipe images
- `pnpm upload:recipe:images:r2` - upload generated assets to Cloudflare R2
- `pnpm agent:smoke` - one REAL assistant turn against the Anthropic API
  (needs `ANTHROPIC_API_KEY`; costs money, never run in CI). Runs on `ts-node`,
  not `tsx`: esbuild does not emit decorator metadata, so Nest DI silently
  injects `undefined` under `tsx`.
- `pnpm agent:measure:tokens` - measure the catalog digest with `count_tokens`
  (needs `ANTHROPIC_API_KEY`; counts tokens only, never runs the model)
- `pnpm lint:check` - CI lint check
- `pnpm test:e2e:ci` - CI-friendly E2E run

## Environment configuration

Use [`.env.example`](./.env.example) as the source of truth.

### Always required

- `DATABASE_URL`
- `JWT_SECRET` (≥32 characters in production)
- `REFRESH_TOKEN_PEPPER` (≥32 characters in production, different from `JWT_SECRET`)
- `COOKIDOO_ENCRYPTION_KEY` (32 bytes base64 — the API refuses to boot without it)

### Required in production only (`NODE_ENV=production`, checked at boot)

- `OPS_TOKEN` (guards `GET /ops/metrics`)
- `COOKIDOO_SERVICE_TOKEN`
- `AUTH_DEV_LOGIN_ENABLED` must not be `true`

### Usually set for every environment

- `PORT`
- `CORS_ORIGIN`
- `WS_CORS_ORIGIN` — allowed socket origins; unset = same list as `CORS_ORIGIN` (never `*` in production)
- `WS_HANDSHAKE_RATE_LIMIT` (300; `0` disables) — socket handshakes per IP per minute, checked before the token
- `AUTH_DEV_LOGIN_ENABLED`
- `WS_AUTH_MODE` (`soft` while old iOS builds are around, then `strict`)
- `RECIPES_LIST_CACHE_ENABLED`
- `RECIPES_LIST_CACHE_TTL_SECONDS`

### Rate limiting

Every HTTP request passes a global throttler (`src/common/throttle/`). Two
counters run per request: `default` (per authenticated user, or per IP when the
request carries no token) and `ip` (a hard net on the address that per-route
overrides cannot loosen). Limits are read from the environment **per request**,
so changing one on Railway needs a restart, not a rebuild, and every limit has a
default — no variable is required to deploy.

- `THROTTLE_DEFAULT_LIMIT` (120/min), `THROTTLE_IP_LIMIT` (300/min)
- `THROTTLE_AUTH_LIMIT` (20/min) — `/auth/*`, always per IP
- `THROTTLE_AGENT_MESSAGE_LIMIT` (20/min), `THROTTLE_AGENT_POLL_LIMIT` (120/min)
- `WS_RATE_LIMIT_PER_MIN` (120; `0` disables) — WebSocket events per user

Rejections come back in the application error contract
(`{code: 'TOO_MANY_REQUESTS', details: ['retryAfterSeconds:n'], requestId}`) over
both HTTP and the socket, and are counted in `GET /ops/metrics` →
`http.throttled`. `GET /ops/health` is never throttled — a 429 there would look
like a dead service to the Railway healthcheck.

### Assistant (opt-in)

The AI assistant (`src/agent/`) is off unless `AI_ENABLED=true`; every `/agent`
endpoint answers `503 AI_DISABLED` otherwise. Contract: `POST
/agent/conversations/:id/messages` returns `202` with `{turnId, messageId,
status, requestId}` plus a `Location` header, and the client polls `GET
/agent/turns/:id` until the status leaves `RUNNING`. Sending the same
`clientMessageId` twice returns the same turn instead of paying twice.

- `AI_PROVIDER` — `anthropic` (default) or `stub` (canned replies, used by
  `test/agent.e2e-spec.ts`; no model call, no API key)
- `ANTHROPIC_API_KEY` — required only with `AI_ENABLED=true` and `anthropic`
- `AI_MODEL` (`claude-sonnet-5`), `AI_TURN_TIMEOUT_MS` (90000)
- `AI_MODEL_TOOLS` (unset) — model routing. When set (e.g. `claude-haiku-4-5`)
  a turn starts in the CHAT phase on that model with read-only tools plus
  `start_planning`, and hands over to `AI_MODEL` with the full tool list the
  moment the model calls `start_planning`. Which tool belongs to which phase is
  one table: `AGENT_TOOL_TIERS` in `src/agent/tools/agent-tools.ts`.
  Request shape (adaptive thinking + effort vs `budget_tokens`) is chosen per
  model in `src/config/model-capabilities.ts` — Haiku 4.5 rejects both
  `thinking: adaptive` and `output_config.effort` with a **400**, which is
  non-retryable and does not refund the user's quota.
- `AI_EFFORT_TOOLS` (`low`) — effort of the CHAT phase; `low` means no thinking
  on budget-thinking models. `AI_EFFORT` stays the planner's effort.
- `AI_TIER_OVERRIDE` (`PRO`) — household plan. Unset/`PRO` = every household
  is PRO (monthly pool, as before). Empty/`off` = trial model: without an
  active `HouseholdSubscription` or an operator grant
  (`POST /ops/households/:id/tier` with `{ "tier": "PRO" }`) a household gets a
  one-time pool of `AI_TRIAL_MESSAGES` (5) messages and `AI_TRIAL_PLANS` (1)
  plan writes under period key `trial`; `GET /agent/usage` returns
  `tier`, `source`, `renews` and `resetsAt: null` for trials.
- `AI_LIMIT_MESSAGES_PER_MONTH` (200) / `AI_LIMIT_PLANS_PER_MONTH` (30) —
  PRO pool per household, counted in `AiUsageCounter` on UTC months. A message is
  charged when the turn starts and refunded when it fails; a plan is charged
  when the week is actually **written** — a dry run, a rejected write and a
  write that changed nothing all cost nothing. Out of plans, the tool answers
  the model with `AI_PLAN_QUOTA_EXCEEDED` instead of killing the turn.
- `AI_ALLOWED_USERS` (empty = everyone) — comma-separated user ids or
  e-mails allowed to start a conversation or send a message; anyone else
  gets `503 AI_DISABLED` with `details: ['not_allowed']`, which the shipped
  iOS build renders as "assistant unavailable". The gate for the period
  between "family is testing" and consents + paywall.
- `AI_CONSENT_REQUIRED` (`true`) — when `true`, a turn needs a valid
  `AI_ASSISTANT` consent of the caller (`GET`/`POST /me/consents`, append-only
  `ConsentEvent`, document versions in `src/common/legal-documents.ts`) and
  only household members with their own consent reach the model; the others'
  allergens and exclusions are still enforced by the write gate. Missing
  consent answers `403 AI_CONSENT_REQUIRED`. Turn it on only once the shipped
  iOS build has the consent screen.
- `AI_CONVERSATION_RETENTION_DAYS` (`90`, `0` disables) — conversations
  (with turns, cards and proposals) older than this since their last message
  are deleted by an in-process sweep every six hours; conversations with a
  running turn are skipped. The `AiUsage` ledger survives (`turnId` becomes
  `NULL`), so billing data never shrinks with clean-ups.
- `AI_MAX_TURN_COST_USD` (`1`, `off` disables) — cap on a single turn; once
  the tool loop has spent that much, the model is asked for a final answer
  without tools. Unknown `AI_MODEL` names are priced at the most expensive
  known rate (and logged once) instead of costing zero.
- `AI_CONSENT_REQUIRED` (default **true** since 3.09.2026) — every turn requires
  a valid `AI_ASSISTANT` **and** `AGE_16` consent (`POST /me/consents`), and
  only consenting members reach the model. Set it to `false` explicitly only
  while the released iOS build has no consent screen; anything else (unset,
  typo) keeps the gate closed.
- `AI_MODEL_TOOLS` (empty = off) — cheaper model for the conversational part
  of a turn (e.g. `claude-haiku-4-5`). The turn starts on it with read-only
  tools plus `start_planning`; when the model calls that tool, the rest of
  the turn (proposals, writes) runs on `AI_MODEL` with the full tool list.
  The client sees the switch as a progress step with `phase: PLANNING`.
  Each round is priced at the rate of the model that ran it.
- `AI_GLOBAL_DAILY_BUDGET_USD` (`5`) — daily cost cap for the whole
  installation; over it, `/agent` answers `503 AI_BUDGET_PAUSED`. `off` means
  no cap at all — an empty variable takes the default, because "unset" must not
  silently mean "unlimited"; `0` stops every turn.

Usage is written to `AiUsage` per turn and summarised in `GET /ops/metrics` →
`agent`. `GET /agent/usage?householdId=` returns the month's `messages` and
`plans` as `{used, limit, remaining}` with `resetsAt` (first day of next
month, UTC) and `tier` (always `FREE` today); a 429 for either quota carries
the same numbers in `details` (`kind`, `limit`, `remaining`, `resetsAt`). `DELETE /agent/conversations` wipes a user's conversations and works
even with the assistant disabled.

Assistant v2 contract (3.09.2026), all under `/agent` with JWT:

- `GET /conversations/:id` — one conversation with `activeTurnId` (the turn to
  keep polling after returning to the app) and `preview`.
- `POST /turns/:id/cancel` — "Stop": the running turn closes as
  `AI_CANCELLED`, the message quota is refunded; idempotent.
- `GET /turns/:id` adds `suggestions` after `AI_TIMEOUT`/`AI_CANCELLED`
  (smaller-scope quick replies) and `progress[].phase = PLANNING` when the
  cheaper model hands the turn over (`AI_MODEL_TOOLS`).
- Assistant messages carry `usedContext` ("Uwzględniłem: …": week, who,
  kcal goal, members withheld for lack of consent).
- `POST /proposals/:id/apply` accepts `{ "force": true }` for a STALE
  proposal ("Zapisz mimo to"); UNDONE and FAILED proposals can be applied
  again with a plain call. Card `state.canApply` reflects this until the
  proposal expires.
- Cards: `PLAN_WEEK.removed[]` carries `dayOfWeek`, `mealType`,
  `recipeId` and a one-word `reason` from the model; `MACRO_GAP.boosters[]`
  each have a `prompt`; `SHOPPING_LIST.groups[]` have `entries` (with
  `isChecked`), `departmentKey`, `hidden`, and the card has
  `emptyDepartments`; `HOUSEHOLD_SPLIT` portions scale kcal by each
  member's calorie goal.
- `GET /context?householdId=&weekStart=` — members with goal label and
  consent flag, the asker's kcal goal, usage and whether handoff is on:
  one source for the context chips and the "Dla kogo liczyć" sheet.
- `GET /memory` notes carry `kind` (PREFERENCE | CONSTRAINT | HABIT);
  `DELETE /memory?householdId=` wipes the household's notes.
- `GET /usage` adds `byUser` (messages per member this month).
- A push "Asystent odpowiedział" / "nie zdążył" is sent to the asking user's
  devices when a turn finishes (plan channel; not after their own Stop).

Error-code names the v2 mock-up uses map to these server codes:
`AI_PROVIDER_UNAVAILABLE` → `AI_UPSTREAM_PAUSED`/`AI_PROVIDER_ERROR`,
`AI_DAILY_BUDGET_EXCEEDED` → `AI_BUDGET_PAUSED`,
`AI_MESSAGE_QUOTA_EXCEEDED` → `AI_QUOTA_EXCEEDED`. Trial/PRO pools from
the mock-up are part of the subscription work, not implemented here.

### Operations

- `SENTRY_DSN` (empty = off) — error tracking; only unexpected errors (5xx) with request id, code and route, never headers, bodies or message contents (`src/instrument.ts`). `SENTRY_TRACES_SAMPLE_RATE` (0) adds performance sampling.
- `OPS_ALERT_WEBHOOK_URL` (empty = off) — webhook that gets a one-line alert
  when the assistant's daily budget is exhausted or the provider breaker
  opens; see `DEPLOYMENT.md` → "Operator alerts".
- Nightly off-platform database dump to R2: `.github/workflows/db-backup.yml`
  (`DEPLOYMENT.md` → "Backups").

### Optional integrations

- `APNS_*` for iOS push notifications
- `R2_*` for Cloudflare R2 image hosting
- `IMAGE_*` for recipe image generation

### Safe-migrate flags

These are powerful and should be reviewed before production deploys:

- `SAFE_MIGRATE_BOOTSTRAP_RECIPES`
- `SAFE_MIGRATE_LOAD_INGREDIENT_TAGS`
- `SAFE_MIGRATE_BACKFILL_R2_IMAGE_URLS`
- `SAFE_MIGRATE_REBUILD_DB`
- `SAFE_MIGRATE_REBUILD_CONFIRM`
- `SAFE_MIGRATE_ALLOW_PROD_REBUILD`

## CI

GitHub Actions workflow: [`backend-ci.yml`](./.github/workflows/backend-ci.yml)

The workflow runs:

- dependency install
- Prisma generate
- Prisma migrate deploy
- lint check
- backend build
- E2E smoke tests (`test/*.e2e-spec.ts`, including WebSocket auth and
  validation, the throttler and the assistant on the `stub` provider)

## Current product note

The shipped iOS client signs in with Apple only. Dev login (`POST /auth/dev`) is opt-in for local development, CI and the smoke scripts; on production `AUTH_DEV_LOGIN_ENABLED=true` is a boot violation (`src/config/assert-env.ts`).

## Related docs

- [`APNS_SETUP.md`](./APNS_SETUP.md)
- [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md)
- [`docs/rodo-wnioski.md`](./docs/rodo-wnioski.md) — wnioski RODO: eksport (`pnpm rodo:export`), usunięcie (`pnpm accounts:delete`), terminy
- [`docs/rejestr-czynnosci-i-dpia.md`](./docs/rejestr-czynnosci-i-dpia.md) — rejestr czynności (art. 30) i ocena skutków (art. 35), pola do uzupełnienia z paneli

### Salt (since 3.09.2026)

`Recipe.nutritionSalt` is the **total** salt per recipe: sodium of the
ingredients (`Ingredient.nutritionSodiumMgPer100`, column `sodiumMg` in the
nutrition table) × 2.5, plus `Recipe.nutritionSaltAdded` — the pinch or
teaspoon the recipe adds by hand. Catalog JSON carries both (`salt`,
`addedSalt`); `pnpm recipes:recompute:nutrition` keeps `salt` in sync. The
DTO field `nutritionSalt` on create/update means *added* salt. On the first
start after this change `prisma-migrate-deploy-safe.js` loads sodium and
recomputes every recipe by itself.
