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
- Weekly plan and shared saved-plan flows
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
- `pnpm recipes:import:json` - import recipes from JSON
- `pnpm generate:recipe:images` - generate recipe images
- `pnpm upload:recipe:images:r2` - upload generated assets to Cloudflare R2
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
- `RECIPES_LIST_CACHE_ENABLED`
- `RECIPES_LIST_CACHE_TTL_SECONDS`

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
- E2E smoke tests

## Current product note

The current iOS client still uses the dev-login flow. For internal and staging environments, `AUTH_DEV_LOGIN_ENABLED=true` may still be required. Public `1.0` should switch to real auth and then disable dev login in production.

## Related docs

- [`APNS_SETUP.md`](./APNS_SETUP.md)
- [`DEPLOYMENT.md`](./DEPLOYMENT.md)
- [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md)
