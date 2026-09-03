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

### Sign in with Apple — unieważnianie tokenów przy kasowaniu konta

Wytyczne App Store 5.1.1(v): usunięcie konta ma unieważnić tokeny Apple.
Serwer robi to w `users:delete`, gdy telefon przyśle świeży
`appleAuthorizationCode`, i gdy są ustawione:

- `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (klucz `.p8` „Sign in
  with Apple” z portalu deweloperskiego; PEM, znaki nowej linii mogą być
  zapisane jako `\n`), opcjonalnie `APPLE_CLIENT_ID` (domyślnie bundle id).

Brak zmiennych = kasowanie działa jak dotąd, w logu ostrzeżenie
`kasowanie konta Apple bez unieważnienia tokenów`.

### Cloudflare R2

Configure:

- `R2_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_PUBLIC_BASE_URL`
- `R2_ACCOUNT_ID` or `R2_ENDPOINT`
- `R2_KEY_PREFIX`

## Cookidoo service (second Railway service)

The Thermomix integration talks to a small Python service
(repository `weekly-meals-cookidoo`). Deploy it as a second service in the
same Railway project and wire it through private networking:

| Where    | Variable                        | Value                                                                              |
| -------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| Cookidoo | `INTERNAL_TOKEN`                | `openssl rand -base64 32`                                                          |
| Cookidoo | `COOKIDOO_COUNTRY`              | `pl`                                                                               |
| Backend  | `COOKIDOO_SERVICE_URL`          | `http://<cookidoo-service-name>.railway.internal:8000` (default is `localhost`, which on Railway means "nothing") |
| Backend  | `COOKIDOO_SERVICE_TOKEN`        | the same value as `INTERNAL_TOKEN`                                                 |
| Backend  | `COOKIDOO_ENCRYPTION_KEY`       | `openssl rand -base64 32` (32 bytes) — losing it means users reconnect            |
| Backend  | `COOKIDOO_INTEGRATION_ENABLED`  | `false` hides the integration in the app (status still lets users disconnect)    |

The backend starts without the Cookidoo service; the first Cookidoo call
then answers `COOKIDOO_SERVICE_UNAVAILABLE` and raises an ops alert.

## Safe migration behavior

The container starts with (see `Dockerfile`; `exec` hands SIGTERM to
Node so Railway can stop it cleanly):

```bash
node scripts/prisma-migrate-deploy-safe.js && exec node dist/main
```

`pnpm start:prod` runs the same pair without `exec` — for local use only.

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

The tag loader at startup runs **only** on a database whose ingredients carry
no tags at all. Any later change to `ingredient-tags-pl-v1.json` — including
the 2.09.2026 extension to the 14 EU allergens (`milk`, `crustaceans`,
`molluscs`, `lupin`, `sulphites`) — must be applied by hand after the deploy:

```bash
railway ssh --service Backend -- sh -c 'cd /app && pnpm catalog:ingredients:tags'
```

It is idempotent and recomputes `Recipe.allergens`/`dietTags` from the
ingredients. Until it has run, the assistant's allergen gate does not know the
new ids, so a household allergy to `milk` would not block anything.

## Backups

Two independent copies, because a Railway-side backup dies with the Railway
project:

1. **Railway volume backups** on the `Postgres` service (panel → Backups) —
   enable and note the retention.
2. **Off-platform dump to Cloudflare R2**: `.github/workflows/db-backup.yml`
   runs `pg_dump` (client 17, custom format) every night at 03:15 UTC and
   uploads it to a dedicated private bucket, pruning copies older than 30
   days. Repository secrets: `DATABASE_PUBLIC_URL`, `R2_BACKUP_ENDPOINT`,
   `R2_BACKUP_BUCKET`, `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`
   (an R2 token scoped to that bucket only). Run it once by hand from the
   Actions tab after adding the secrets — a dump under 20 KB fails the job.

Every run also restores the fresh dump into a throwaway Postgres 17 on the
runner and counts tables and accounts — a red workflow means the copy is not
restorable, not just "not uploaded".

The dump contains personal data, so it is encrypted with an `age` public key
before upload. One-time setup (on the Mac: `brew install age`; on Windows:
`winget install FiloSottile.age`):

```bash
age-keygen -o weekly-meals-backup-key.txt      # keep this file in the password manager
grep 'public key' weekly-meals-backup-key.txt  # "age1…" → repository secret BACKUP_AGE_PUBLIC_KEY
```

Without the secret the workflow still uploads (with a warning) — an unencrypted
copy beats no copy, but treat that as a transition state.

Restore by hand:

```bash
aws s3 cp s3://<bucket>/weekly-meals/<file>.dump.age . --endpoint-url <endpoint>
age -d -i weekly-meals-backup-key.txt -o <file>.dump <file>.dump.age
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" <file>.dump
```

Railway side: point-in-time recovery and a nightly volume backup are enabled
on the `Postgres` service (3.09.2026) — three independent layers in total.

## Operator alerts (`OPS_ALERT_WEBHOOK_URL`)

Optional webhook (Discord, Slack, ntfy — anything that accepts a JSON POST)
that receives one Polish sentence when the assistant's daily budget is
exhausted (once per day) or the provider breaker opens (once per 6 h). Empty
variable = no alerts. Messages carry no conversation content and no personal
data. Pair it with an external HTTP probe on `/ops/health` (e.g. a free
uptime monitor) — the process cannot report its own death.

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
2. Ship the iOS build that sends the token in the handshake and refreshes it
   — **done**: every iOS build since PR #69 (`main` from 31.08.2026) sends it.
3. Watch `GET /ops/metrics` → `http.wsAuth.handshakes.legacy` and `legacyActs`.
   The counters live in process memory and reset on every restart, so take
   two readings at least an hour apart with a growing `http.uptimeSeconds`
   and the same `commit` in `/ops/health`. When they stop growing, set
   `WS_AUTH_MODE=strict` on the `Backend` service — no token = `connect_error`
   with `{code: 'UNAUTHORIZED', reason: 'missing'}`. Rollback is the same
   variable back to `soft`.

Until `strict` is on, a socket without a token is accepted as `legacy` with the
identity taken from the payload, and every household broadcast is also sent to
the shared `legacy` room. That is why this switch is the first item of the
2.09.2026 remediation plan, not a cosmetic one.

`WS_AUTH_MODE` is read per handshake; a typo is a boot violation in production.
Refresh tokens now default to 60 days (`REFRESH_TOKEN_DAYS`), reuse of a rotated
refresh token revokes the whole family (deliberate: a lost refresh response
means re-login on every device of that user), and `POST /auth/logout` revokes
one refresh token — the access token stays valid until its `exp` (30 days by
default), which is why the next step after iOS adoption is a shorter
`JWT_EXPIRES_IN`. A verification outage (database) during the handshake is
reported as `SERVICE_UNAVAILABLE`, not `UNAUTHORIZED`, so clients keep their
auto-reconnect instead of refreshing tokens.

## Stan produkcji asystenta (aktualizacja 2.09.2026)

Fazy 0 i 1, hartowanie, ekran iOS, karty z propozycjami (E1–E5), pamięć
gospodarstwa, poprawianie pytania i ograniczenia domownika są na `main` obu
repozytoriów. Wydany build iOS (od PR #74) rozmawia z asystentem po REST,
wysyła token w handshake WebSocketu i deklaruje obsługę kart
(`clientCapabilities: ["cards.v1"]`) w każdym żądaniu. Sekcja „Fazy 0 + 1"
z 31.08 była listą kontrolną pierwszego wejścia i została wykonana; poniżej
jest to, co obowiązuje TERAZ.

Zasada bez zmian: każda zmienna `AI_*`, `THROTTLE_*` i `WS_*` ma wartość
domyślną w kodzie, więc merge do `main` nigdy nie wymaga zmiennej na Railway
(incydent z 28.08.2026: nowy build asertujący brakującą zmienną kosztował
~10 minut przestoju). Zmienne są czytane per żądanie — zmiana na Railway
działa po restarcie, bez builda; zła wartość to nieudany deploy (healthcheck),
nie przestój, bo stary kontener zostaje.

## Assistant rollout (`AI_ENABLED`, `AI_CARDS_MODE`, `AI_ALLOWED_USERS`)

### Co asystent może ZMIENIĆ w bazie

Siedemnaście narzędzi, w czterech grupach:

| Grupa                 | Narzędzia                                                                                                          | Skutek w bazie                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| czyta                 | `get_household_context`, `get_week_plan`, `get_week_balance`, `search_ingredients`                                 | żaden                                                                            |
| proponuje (tryb kart) | `propose_week_plan`, `propose_day_plan`, `propose_swap`, `propose_household_split`                                 | wiersz `AgentProposal`; plan zmienia się DOPIERO po „Dodaj do planu" w telefonie |
| karty bez skutków     | `ask_clarifying_question`, `offer_options`, `show_macro_gap`, `show_shopping_list`                                 | żaden — karta w rozmowie                                                         |
| pisze                 | `apply_week_plan` (tylko tryb `off`), `create_recipe`, `update_recipe`, `delete_recipe` (miękkie), `remember_note` | plan tygodnia / przepisy gospodarstwa / notatka pamięci (30 na dom)              |

Bariery są po stronie serwera, nie w prompcie: przepisu z alergenem albo
wykluczonym składnikiem domownika nie da się wstawić do posiłku, który ta
osoba je (`RECIPE_ALLERGEN_CONFLICT`, `RECIPE_EXCLUDED_INGREDIENT`), przepisu
katalogowego nie da się edytować ani skasować (`RECIPE_NOT_EDITABLE`), przepisu
użytego w planie nie da się usunąć (`RECIPE_IN_USE`). Przy JAKIMKOLWIEK
naruszeniu zapis tygodnia nie zapisuje NICZEGO. Do modelu NIE idzie sylwetka
domowników (płeć, wzrost, waga, rok urodzenia) — tylko dieta, alergeny,
wykluczenia, cel i policzone zapotrzebowanie.

**Cofanie.** W trybie kart zapisana propozycja ma przycisk „Cofnij" przez
`AI_PROPOSAL_UNDO_WINDOW_MS` (domyślnie godzina) i serwer odmawia cofnięcia,
jeśli ktoś w międzyczasie zmienił plan ręcznie (`AI_PROPOSAL_STALE`). W trybie
`off` przycisku nie ma: plan wraca ręcznie w aplikacji, przepis —
`UPDATE "Recipe" SET "isActive" = true WHERE id = …`. To główny powód, żeby na
produkcji nie zostawiać trybu `off`.

### Tryb kart (`AI_CARDS_MODE`)

| Wartość          | Kto zapisuje plan                                | Kiedy                                                                                  |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `off` (domyślna) | MODEL, w trakcie tury, po `dry_run`              | dźwignia awaryjna; bez karty, bez „Cofnij", bez rozgłoszenia zmiany po sockecie        |
| `soft`           | użytkownik, jeśli klient zadeklarował `cards.v1` | **wartość na produkcję**: wydany iOS deklaruje zawsze, stary build dostaje `off`       |
| `strict`         | użytkownik, dla wszystkich klientów              | po potwierdzeniu, że nikt nie siedzi na buildzie sprzed kart (dostałby turę bez karty) |

Domyślna w kodzie jest `off`, więc **bez zmiennej na Railway asystent zapisuje
plan sam**, mimo że telefon pokazuje interfejs kart. Lista narzędzi jest w obu
trybach identyczna (liczy się do prefiksu cache); tryb przełącza akapit
w bloku gospodarstwa, a bramką jest kod (`AI_TOOL_NOT_IN_MODE` jako dane dla
modelu).

### Kto może rozmawiać (`AI_ALLOWED_USERS`)

Aplikacja jest w App Store i każdy może założyć konto. Do czasu zgód, polityki
i paywalla `AI_ALLOWED_USERS` (identyfikatory użytkowników albo e-maile po
przecinku; pusta = wszyscy) jest jedyną bramką między „rodzina testuje" a „obcy
palą klucz". Konto spoza listy dostaje `503 AI_DISABLED` z
`details: ['not_allowed']` — telefon pokazuje „asystent niedostępny" i blokuje
pole. Bramka stoi tylko na założeniu rozmowy i wysłaniu wiadomości; odczyt
historii i kasowanie własnych rozmów zostają otwarte. Identyfikator konta:
`SELECT id, email, "displayName" FROM "User" ORDER BY "createdAt";`.

### Włączanie, w tej kolejności

1. **Klucz PIERWSZY**:
   `railway variables --service Backend --skip-deploys --set ANTHROPIC_API_KEY=...`.
   Przy `AI_ENABLED=true` bez klucza asystent zachowuje się jak wyłączony (503),
   więc zła kolejność kosztuje błąd, nie awarię. Równolegle: limit wydatków
   i alert w konsoli Anthropic — drugi hamulec poza kontenerem.
2. **Lista dozwolonych kont** (`AI_ALLOWED_USERS`), dopóki asystent jest dla
   rodziny.
3. **Limity.** Trzy hamulce, wszystkie z wartością domyślną:

   | Zmienna                       | Domyślnie                      | Zakres                         | Co robi po przekroczeniu                          |
   | ----------------------------- | ------------------------------ | ------------------------------ | ------------------------------------------------- |
   | `AI_GLOBAL_DAILY_BUDGET_USD`  | `5` (na dobę, cała instalacja) | liczba ≥ 0, `off` = bez limitu | `503 AI_BUDGET_PAUSED`                            |
   | `AI_LIMIT_MESSAGES_PER_MONTH` | `200` (na gospodarstwo)        | liczba całkowita               | `429 AI_QUOTA_EXCEEDED`                           |
   | `AI_LIMIT_PLANS_PER_MONTH`    | `30` (na gospodarstwo)         | liczba całkowita               | narzędzie / apply oddaje `AI_PLAN_QUOTA_EXCEEDED` |

   Zmierzone tury (Sonnet 5, `medium`): układanie tygodnia $0,30, trzy dni
   z alergią $0,14, poprawka dwóch kolacji $0,12, żądanie niewykonalne $1,00.
   Domyślne 200 wiadomości to **$25–60 miesięcznie na jedno gospodarstwo**.
   Do czasu paywalla, spójnie z planowanym cennikiem (darmowe 6, płatne 40):

   ```
   AI_LIMIT_MESSAGES_PER_MONTH=30
   AI_LIMIT_PLANS_PER_MONTH=6
   ```

   Budżet dobowy zostaje przy domyślnych $5: $2 to 2–16 tur dziennie dla całej
   instalacji i wyłączyłoby asystenta rodzinie w środku tygodnia — hamulcem ma
   być alert w konsoli Anthropic, nie bezpiecznik. Budżet jest sprawdzany
   PRZED turą, więc przekroczenie kosztuje jeszcze jedną turę. Limit planów
   liczy się przy ZAPISIE (w trybie kart: przy „Dodaj do planu"); dry-run,
   odmowa i zapis bez zmian nie kosztują nic; cofnięcie oddaje kwotę.

4. **Tryb kart**: `AI_CARDS_MODE=soft`.
5. `AI_ENABLED=true` i restart usługi.
6. **Weryfikacja** (nie tylko `/ops/health`): jedna tura z telefonu kończy się
   kartą propozycji, plan NIE zmienia się sam, „Dodaj do planu" zapisuje,
   „Cofnij" przywraca. `GET /ops/metrics` → `agent.turns`
   (started/done/failed), `agent.rejected` (disabled/quota/budget/upstream/
   inProgress), `agent.usage.costMicroUsd`. Rachunek u dostawcy sprawdzaj
   niezależnie — licznik zna tylko tury, które przeszły przez ten kontener.

### Po zmianie pliku tagów składników

Loader przy starcie biegnie tylko na bazie bez tagów. Każda zmiana
`ingredient-tags-pl-v1.json` (np. 14 alergenów UE z 2.09.2026) wymaga po
deployu ręcznego `railway ssh --service Backend -- sh -c 'cd /app && pnpm
catalog:ingredients:tags'` — patrz „Safe migration behavior". Do tego czasu
bramka alergenowa nie zna nowych id.

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
