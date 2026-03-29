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
JWT_SECRET=replace-me
REFRESH_TOKEN_PEPPER=replace-me
CORS_ORIGIN=https://your-web-or-preview-host
WS_CORS_ORIGIN=https://your-web-or-preview-host
AUTH_DEV_LOGIN_ENABLED=true
```

Notes:

- Keep `AUTH_DEV_LOGIN_ENABLED=true` only as long as the shipped client still depends on `/auth/dev`.
- For public release after real auth lands, set `AUTH_DEV_LOGIN_ENABLED=false`.
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

Never enable `SAFE_MIGRATE_REBUILD_DB=true` in production unless you intentionally want a destructive rebuild and have a verified backup plus explicit approval.

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

1. `GET /ops/health` returns `status: ok`
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
