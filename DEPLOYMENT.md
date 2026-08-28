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
