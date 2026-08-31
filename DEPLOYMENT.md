# Deployment Guide

## Runtime shape

Recommended production topology:

- one API container built from `Dockerfile`
- one PostgreSQL database
- optional Cloudflare R2 bucket for recipe images
- optional APNs credentials for iOS push notifications

## Required environment variables

Minimum backend startup set:

```env
DATABASE_URL=postgresql://...
PORT=3000
JWT_SECRET=<openssl rand -base64 32>
REFRESH_TOKEN_PEPPER=<openssl rand -base64 32, inny niż JWT_SECRET>
OPS_TOKEN=<openssl rand -base64 24>
COOKIDOO_ENCRYPTION_KEY=<openssl rand -base64 32>
COOKIDOO_SERVICE_TOKEN=<ten sam sekret co INTERNAL_TOKEN mikroserwisu Cookidoo>
CORS_ORIGIN=https://your-web-or-preview-host
WS_CORS_ORIGIN=https://your-web-or-preview-host
AUTH_DEV_LOGIN_ENABLED=false
```

Notes:

- The image sets `NODE_ENV=production`; at boot `src/config/assert-env.ts` refuses to start when `JWT_SECRET`/`REFRESH_TOKEN_PEPPER` are shorter than 32 characters, equal to a value from this repo, or equal to each other, when `OPS_TOKEN`/`COOKIDOO_SERVICE_TOKEN`/`DATABASE_URL` are empty, when `COOKIDOO_ENCRYPTION_KEY` is not 32 bytes of base64, or when `AUTH_DEV_LOGIN_ENABLED=true`. Set the variables **before** deploying a new build.
- Dev login is opt-in (`AUTH_DEV_LOGIN_ENABLED=true` only in local dev and CI). The production client signs in with Apple only.
- Rotating `REFRESH_TOKEN_PEPPER` invalidates stored refresh tokens (users sign in again when their access token expires).
- Do not reuse local development secrets in production.

## Optional production integrations

### APNs

Configure:

- `APNS_ENABLED=true`
- `APNS_USE_SANDBOX=false`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `APNS_BUNDLE_ID`
- `APNS_PRIVATE_KEY`

Reference: [`APNS_SETUP.md`](./APNS_SETUP.md)

### Cloudflare R2

Configure:

- `R2_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_PUBLIC_BASE_URL`
- `R2_ACCOUNT_ID` or `R2_ENDPOINT`
- `R2_KEY_PREFIX`

## Safe migration behavior

`pnpm start:prod` already runs:

```bash
node scripts/prisma-migrate-deploy-safe.js && node dist/main
```

That means deploy startup can:

- run pending Prisma migrations
- repair a known broken migration path
- optionally bootstrap recipes
- load ingredient allergen/diet tags once, when the catalog has rows but none
  of them carries a tag (a database that received the tag columns from a
  migration without ever running the loader); empty tags read as "no allergen,
  every diet satisfied", so this must not wait for a manual
  `pnpm catalog:ingredients:tags`
- optionally backfill missing R2 image URLs

## Important safety rule

Never enable `SAFE_MIGRATE_REBUILD_DB=true` in production unless you intentionally want a destructive rebuild and have a verified backup plus explicit approval. The guard (`scripts/lib/rebuild-guard.js`) requires `SAFE_MIGRATE_REBUILD_CONFIRM` to equal today's UTC date (`YYYY-MM-DD`) and, under `NODE_ENV=production`, `SAFE_MIGRATE_ALLOW_PROD_REBUILD` to equal the `DATABASE_URL` host; the host is logged before `DROP SCHEMA`. Remove all three variables right after the rebuild.

## Generic container deploy flow

1. Provision PostgreSQL and prepare `DATABASE_URL`.
2. Set production env vars.
3. Build and deploy the backend image.
4. Let the container start with `pnpm start:prod`.
5. Verify health and smoke checks.

Example local build:

```bash
docker build -t weekly-meals-backend .
docker run --rm -p 3000:3000 --env-file .env weekly-meals-backend
```

## Post-deploy verification

Check these after every deploy:

1. `GET /ops/health` returns `status: ok` — and `commit` matching the image you
   just shipped. Read it before debugging any "works locally, breaks on
   production" report: an old image silently ignores fields it does not know
   (that is how saved plan servings came back as `1`). `GET /ops/metrics`
   reports `migrations.applied` / `migrations.latest` so you can tell a stale
   image apart from a stale database.
2. `GET /ops/metrics` returns JSON
3. dev login or target auth flow works for the current release
4. recipes list loads
5. realtime Socket.IO connection succeeds
6. shopping list updates propagate between two sessions
7. push registration works on a physical iPhone if APNs is enabled

## Rollback

If the deploy is unhealthy:

1. Roll back to the previous image or release on your platform
2. Recheck `/ops/health`
3. Leave database state intact unless the rollback plan explicitly includes schema rollback

Avoid emergency database mutations unless the issue is confirmed to be migration-related.

## WebSocket auth rollout (`WS_AUTH_MODE`)

Since Phase 0 the Socket.IO handshake carries the access token (`auth: { token }`
or `Authorization: Bearer`). Identity comes from the token, broadcasts go to
`household:<id>` rooms. Rollout order, because old iOS builds send no token:

1. Deploy backend with `WS_AUTH_MODE` unset (= `soft`): sockets with a token are
   verified, sockets without one keep working as `legacy` (identity from the
   payload, as before). No Railway variable is required for this step — but
   check with `railway variables --service Backend` that `REFRESH_TOKEN_DAYS`
   is unset or ≥ 60 and `JWT_EXPIRES_IN` is unset or shorter than that; the
   refresh token must outlive the access token for the iOS refresh to work.
2. Ship the iOS build that sends the token in the handshake and refreshes it.
3. Watch `GET /ops/metrics` → `http.wsAuth.handshakes.legacy` and `legacyActs`.
   When they stop growing (both phones updated), set `WS_AUTH_MODE=strict` on
   the `Backend` service — no token = `connect_error` with
   `{code: 'UNAUTHORIZED', reason: 'missing'}`.

`WS_AUTH_MODE` is read per handshake; a typo is a boot violation in production.
Refresh tokens now default to 60 days (`REFRESH_TOKEN_DAYS`), reuse of a rotated
refresh token revokes the whole family (deliberate: a lost refresh response
means re-login on every device of that user), and `POST /auth/logout` revokes
one refresh token — the access token stays valid until its `exp` (30 days by
default), which is why the next step after iOS adoption is a shorter
`JWT_EXPIRES_IN`. A verification outage (database) during the handshake is
reported as `SERVICE_UNAVAILABLE`, not `UNAUTHORIZED`, so clients keep their
auto-reconnect instead of refreshing tokens.

## Assistant rollout (`AI_ENABLED`)

The assistant ships **off**. Every `AI_*` and `THROTTLE_*` variable has a
default, so merging Phase 0 to `main` needs no new Railway variable — this is
deliberate after the 28.08.2026 incident (a new build asserting a missing
variable cost ~10 minutes of downtime).

Turning it on, in this order:

1. Set `ANTHROPIC_API_KEY` on the `Backend` service **first**
   (`railway variables --service Backend --skip-deploys --set ANTHROPIC_API_KEY=...`).
   With `AI_ENABLED=true` and no key the assistant behaves as disabled, so a
   wrong order costs a `503`, not a crash — but check
   `railway logs --service Backend` for the `[env]` warning either way.
2. Optionally cap the spend: `AI_GLOBAL_DAILY_BUDGET_USD` (daily, whole
   installation) and `AI_LIMIT_MESSAGES_PER_MONTH` (per household).
3. Set `AI_ENABLED=true` and let the service restart.
4. Verify: `GET /ops/metrics` → `agent.turns` (started/done/failed),
   `agent.rejected` (disabled/quota/budget/upstream/inProgress),
   `agent.usage.costMicroUsd`.

Turning it off is one variable (`AI_ENABLED=false`) and takes effect on the next
restart — the flag is read per request, and no other module imports
`src/agent/` (enforced by ESLint). Conversations already stored are untouched;
users can delete their own with `DELETE /agent/conversations`, which works
regardless of the flag.

Safety valves that need no operator action: a turn is aborted after
`AI_TURN_TIMEOUT_MS` (`FAILED` / `AI_TIMEOUT`), five provider 429/5xx inside
five minutes open a 60-second circuit breaker (`503 AI_UPSTREAM_PAUSED`), and a
failed turn refunds the message quota it consumed at start.

## Railway — healthcheck wdrożenia

`railway.json` ustawia `deploy.healthcheckPath: /ops/health` (timeout 120 s). Bez tego Railway
przełączał ruch na nowy kontener od razu po starcie procesu — kontener padający na starcie
(np. asercja sekretów z `src/config/assert-env.ts`) oznaczał przestój, a nie nieudany deploy
(28.08.2026: ~10 min bez odpowiedzi po merge'u przed ustawieniem zmiennych). Teraz nowy
deployment dostaje ruch dopiero, gdy `/ops/health` odpowie 200; stary zostaje do tego czasu.
