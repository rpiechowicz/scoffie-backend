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

## Wydanie „Fazy 0 + 1" na produkcję — lista kontrolna

To pierwsze wejście na prod całego dorobku asystenta: 33 commity, dwie migracje
(`20260828200000_asystent_rozmowy_tury_i_ledger`, `20260831120000_katalog_a_przepisy_gospodarstwa`),
uwierzytelniony WebSocket, jawna walidacja DTO, limity żądań i cały moduł `src/agent/`.
**Asystent w tym wydaniu jest WYŁĄCZONY** — właczenie to osobny krok niżej.

Sprawdzone przed wydaniem (31.08.2026, nie trzeba powtarzać):

- **Żadna nowa zmienna nie jest wymagana.** Wszystkie `AI_*`, `THROTTLE_*` i
  `WS_*` mają domyślne, a `assert-env` przy `AI_ENABLED` pustym nie żąda niczego.
  Deploy nie powtórzy incydentu z 28.08.
- **Stary build iOS (App Store) przeżyje.** Koperty zdarzeń walidują się łagodnie
  (`validateWsPayload`), więc `userId` i inne pola sprzed Fazy 0 nie są błędem.
  Pola w `data` porównane 1:1 z payloadami z gałęzi `main` iOS — zero rozjazdu.
  `WS_AUTH_MODE` zostaje `soft`, bo wydany build nie wysyła jeszcze tokenu.
- **Limity nie zabolą telefonu.** 120 żądań/min na użytkownika po HTTP i tyle samo
  po WebSockecie; iOS ma 42 miejsca wysyłające i żadnej pętli.

Do sprawdzenia NA PRODUKCJI przed merge'em (`psql "$PROD_DB"`):

1. **Przepisy gospodarstw** — decyduje o `isCatalog`, szczegóły w sekcji niżej.
2. **Pokrycie alergenów i tagów diet** — od hartowania asystenta bramka
   `RECIPE_ALLERGEN_CONFLICT` czyta `Recipe.allergens`. Puste tablice na prodzie
   znaczyłyby, że bramka przepuszcza wszystko, a model widzi `A:` bez treści:

   ```sql
   SELECT count(*) FILTER (WHERE array_length("dietTags", 1) IS NULL) AS bez_tagow_diet,
          count(*) AS wszystkie
   FROM "Recipe";
   ```

   `bez_tagow_diet` większe od zera = uruchomić `pnpm catalog:ingredients:tags`
   (idempotentny, przelicza `allergens`/`dietTags` ze składników) zanim asystent
   dostanie prawo zapisu. Przepisy BEZ alergenów to normalne (na dev 8 z 89) —
   alarmujące są dopiero puste tagi diet, bo każdy przepis jakiś ma.

Po deployu: `/ops/health` 200, `/ops/metrics` → `http.wsAuth.handshakes.legacy`
rośnie (stary build), `agent.turns` zeruje się i takie zostaje (asystent wyłączony).

## Assistant rollout (`AI_ENABLED`)

Asystent wchodzi na prod **wyłączony**. Każda zmienna `AI_*` i `THROTTLE_*` ma
wartość domyślną, więc merge do `main` nie wymaga żadnej zmiennej na Railway —
świadomie, po incydencie z 28.08.2026 (nowy build asertujący brakującą zmienną
kosztował ~10 minut przestoju).

### Zanim włączysz — co asystent może ZMIENIĆ w bazie

Od Fazy 1 asystent nie tylko czyta. Ma osiem narzędzi, z czego cztery piszą:
`apply_week_plan` (cały tydzień naraz), `create_recipe`, `update_recipe`,
`delete_recipe` (miękkie, `isActive=false`). Pozostałe cztery
(`get_household_context`, `get_week_plan`, `get_week_balance`,
`search_ingredients`) tylko czytają.

Bariery są po stronie serwera, nie w prompcie: przepisu z alergenem domownika
nie da się wstawić do posiłku, który ta osoba je (`RECIPE_ALLERGEN_CONFLICT`),
przepisu katalogowego nie da się edytować ani skasować (`RECIPE_NOT_EDITABLE`),
a przepisu użytego w planie nie da się usunąć (`RECIPE_IN_USE`). Przy JAKIMKOLWIEK
naruszeniu `applyWeekPlan` nie zapisuje NICZEGO — nie ma stanu „pół tygodnia".

Cofnięcie tego, co asystent narobił, nie ma dziś przycisku: plan wraca ręcznie
w aplikacji, przepis — `UPDATE "Recipe" SET "isActive" = true WHERE id = …`.

### Włączanie, w tej kolejności

1. **Klucz PIERWSZY**:
   `railway variables --service Backend --skip-deploys --set ANTHROPIC_API_KEY=...`.
   Przy `AI_ENABLED=true` bez klucza asystent zachowuje się jak wyłączony (503),
   więc zła kolejność kosztuje błąd, nie awarię — ale i tak sprawdź
   `railway logs --service Backend` pod kątem ostrzeżenia `[env]`.
2. **Budżet — USTAW GO ŚWIADOMIE.** `AI_GLOBAL_DAILY_BUDGET_USD` domyślnie
   **nie istnieje, czyli BEZ LIMITU**; `AI_LIMIT_MESSAGES_PER_MONTH` to 200 na
   gospodarstwo. Zmierzone tury (Sonnet 5, `medium`): układanie tygodnia $0,30,
   trzy dni z alergią $0,14, poprawka dwóch kolacji $0,12, żądanie niewykonalne
   $1,00. Czyli domyślne 200 wiadomości to **$25–60 miesięcznie na jedno
   gospodarstwo**. Przy koncie z $20 kredytu rozsądny start:

   ```
   AI_GLOBAL_DAILY_BUDGET_USD=2
   AI_LIMIT_MESSAGES_PER_MONTH=60
   ```

   Budżet dobowy jest globalny (licznik `AiUsageCounter`, kind `costMicroUsd`)
   i sprawdzany PRZED turą, więc jego przekroczenie kosztuje jeszcze jedną turę
   — ustawiaj go o tę jedną turę niżej, niż wynosi ból. Po przekroczeniu tury
   wracają `503 AI_BUDGET_PAUSED` i nic nie idzie do API; wyczerpana kwota
   miesięczna to `429 AI_QUOTA_EXCEEDED`.

   **`AI_LIMIT_PLANS_PER_MONTH` jest dziś martwy** — wartość czyta się z env,
   ale nic jej nie egzekwuje (asystent zapisuje plany bez własnego licznika).
   Do domknięcia razem z decyzjami o subskrypcji i freemium; do tego czasu
   jedynym hamulcem planów jest limit wiadomości.

3. `AI_ENABLED=true` i restart usługi.
4. Weryfikacja: `GET /ops/metrics` → `agent.turns` (started/done/failed),
   `agent.rejected` (disabled/quota/budget/upstream/inProgress),
   `agent.usage.costMicroUsd`. Rachunek u dostawcy sprawdzaj niezależnie —
   licznik zna tylko tury, które przeszły przez ten kontener.

### Czego brakuje, żeby włączenie miało sens

**Aplikacja iOS nie ma dziś ekranu asystenta** — w kodzie nie ma ani jednego
odwołania do `/agent/*`. Kontrakt jest gotowy po stronie serwera
(`POST /agent/conversations/:id/messages` → `202` + `Location`, klient odpytuje
`GET /agent/turns/:id`), ale dopóki nie powstanie klient, `AI_ENABLED=true`
niczego nie udostępnia użytkownikom — włączać dopiero razem z buildem iOS.

Zaległość klienta niezależna od asystenta: `UserFacingErrorMapper` nie ma kopii
dla `RECIPE_NOT_SUITABLE_FOR_SLOT`, `RECIPE_NOT_EDITABLE`, `RECIPE_IN_USE`
i `RECIPE_ALLERGEN_CONFLICT`, a aplikacja nie nasłuchuje `recipes:changed`.
Do buildu użytkownik zobaczy polski komunikat prosto z serwera.

### Wyłączanie i zawory bezpieczeństwa

Wyłączenie to jedna zmienna (`AI_ENABLED=false`) i działa po restarcie — flaga
czyta się per żądanie, a żaden inny moduł nie importuje `src/agent/` (pilnuje
ESLint). Zapisane rozmowy zostają nietknięte; użytkownik kasuje swoje przez
`DELETE /agent/conversations`, co działa niezależnie od flagi.

Zawory, które nie wymagają operatora: tura jest przerywana po `AI_TURN_TIMEOUT_MS`
(`FAILED` / `AI_TIMEOUT`), pięć błędów 429/5xx dostawcy w pięć minut otwiera
60-sekundowy bezpiecznik (`503 AI_UPSTREAM_PAUSED`), a nieudana tura zwraca
kwotę wiadomości pobraną na starcie. Od hartowania koszt nieudanej tury i tak
trafia do księgi — bezpiecznik chroni przed pętlą, nie przed rachunkiem.

## Catalog vs household recipes (`isCatalog`) — before deploying

Migration `20260831120000_katalog_a_przepisy_gospodarstwa` adds `Recipe.isCatalog`
and, by design, marks **every recipe that exists at deploy time** as catalog. That
is the no-regression choice: those recipes are visible to everyone _today_, so
nothing disappears from anyone's list. New recipes default to `false`.

The consequence to check first: if production already holds recipes created by a
household (not by the import bot), they stay globally visible instead of becoming
private. Verify before deploying:

```sql
SELECT "householdId", "authorId", count(*)
FROM "Recipe"
GROUP BY 1, 2
ORDER BY 3 DESC;
```

One row (the catalog household, author = import bot) means nothing to do. Extra
rows are household recipes — after the deploy, flip them by hand:

```sql
UPDATE "Recipe" SET "isCatalog" = false WHERE "householdId" <> '<catalog household>';
```

The migration itself is idempotent and safe to re-run: the backfill rides on the
column's `DEFAULT` at `ADD COLUMN` time (then the default flips to `false`), so a
second run cannot re-mark recipes created after it.

## Railway — healthcheck wdrożenia

`railway.json` ustawia `deploy.healthcheckPath: /ops/health` (timeout 120 s). Bez tego Railway
przełączał ruch na nowy kontener od razu po starcie procesu — kontener padający na starcie
(np. asercja sekretów z `src/config/assert-env.ts`) oznaczał przestój, a nie nieudany deploy
(28.08.2026: ~10 min bez odpowiedzi po merge'u przed ustawieniem zmiennych). Teraz nowy
deployment dostaje ruch dopiero, gdy `/ops/health` odpowie 200; stary zostaje do tego czasu.
