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
- `WS_CORS_ORIGIN`
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
- `AI_LIMIT_MESSAGES_PER_MONTH` (200) / `AI_LIMIT_PLANS_PER_MONTH` (30) —
  per household, counted in `AiUsageCounter` on UTC months. A message is
  charged when the turn starts and refunded when it fails; a plan is charged
  when the week is actually **written** — a dry run, a rejected write and a
  write that changed nothing all cost nothing. Out of plans, the tool answers
  the model with `AI_PLAN_QUOTA_EXCEEDED` instead of killing the turn.
- `AI_ALLOWED_USERS` (empty = everyone) — comma-separated user ids or
  e-mails allowed to start a conversation or send a message; anyone else
  gets `503 AI_DISABLED` with `details: ['not_allowed']`, which the shipped
  iOS build renders as "assistant unavailable". The gate for the period
  between "family is testing" and consents + paywall.
- `AI_CONSENT_REQUIRED` (`false`) — when `true`, a turn needs a valid
  `AI_ASSISTANT` consent of the caller (`GET`/`POST /me/consents`, append-only
  `ConsentEvent`, document versions in `src/common/legal-documents.ts`) and
  only household members with their own consent reach the model; the others'
  allergens and exclusions are still enforced by the write gate. Missing
  consent answers `403 AI_CONSENT_REQUIRED`. Turn it on only once the shipped
  iOS build has the consent screen.
- `AI_GLOBAL_DAILY_BUDGET_USD` (`5`) — daily cost cap for the whole
  installation; over it, `/agent` answers `503 AI_BUDGET_PAUSED`. `off` means
  no cap at all — an empty variable takes the default, because "unset" must not
  silently mean "unlimited"; `0` stops every turn.

Usage is written to `AiUsage` per turn and summarised in `GET /ops/metrics` →
`agent`. `DELETE /agent/conversations` wipes a user's conversations and works
even with the assistant disabled.

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
