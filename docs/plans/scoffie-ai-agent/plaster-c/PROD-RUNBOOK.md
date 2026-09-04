# Plaster C — runbook wdrożenia na prod

Kolejność jest nośna: zmienne Railway PRZED merge, bo od C1 backend odmawia
startu na `NODE_ENV=production` bez poprawnych sekretów (crash-loop).
Żadnego SQL. Rollback = revert kodu; zmienne Railway mogą zostać.

## 0. Stan wyjściowy (zweryfikowany 28.08)

- Railway `Backend`: `AUTH_DEV_LOGIN_ENABLED=false`, `JWT_SECRET` 72 zn.,
  **`REFRESH_TOKEN_PEPPER` 10 zn. (za krótki)**, `SAFE_MIGRATE_BACKFILL_R2_IMAGE_URLS=true`,
  brak `OPS_TOKEN`, brak `NODE_ENV` (obraz ustawia `production`).
- Gałęzie: backend `fix/fundamenty-c` (9 commitów C2→C1→C3→C4→C9→C6→C7→C8→C5),
  iOS `fix/fundamenty-c` (C5 kontrakt + C9 cache).

## 1. Railway — przed merge (serwis `Backend`, `--skip-deploys`)

```sh
railway variables --service Backend --skip-deploys \
  --set "REFRESH_TOKEN_PEPPER=$(openssl rand -base64 32)" \
  --set "OPS_TOKEN=$(openssl rand -base64 24)"
railway variables --service Backend --skip-deploys --unset SAFE_MIGRATE_BACKFILL_R2_IMAGE_URLS
railway variables --service Backend | grep -E "AUTH_DEV_LOGIN_ENABLED|OPS_TOKEN|REFRESH_TOKEN_PEPPER|SAFE_MIGRATE"
```

Oczekiwane: `AUTH_DEV_LOGIN_ENABLED=false`, pepper ≥ 32 zn. (≠ JWT*SECRET),
`OPS_TOKEN` ustawiony, brak `SAFE_MIGRATE*\*`. Rotacja peppera unieważnia
refresh tokeny — iOS ich nie używa, nikt tego nie zauważy.
Zapisz `OPS_TOKEN`w 1Password/Keychain — potrzebny do`/ops/metrics`.

## 2. Merge backendu

`fix/fundamenty-c` → `develop` (CI: lint, typecheck, build, unit, e2e) → `main` → Railway deploy.

Weryfikacja (`$API` = URL prod, `$OPS` = OPS_TOKEN):

```sh
curl -s $API/ops/health | jq '.commit, .status'          # nowy commit
curl -s -o /dev/null -w '%{http_code}\n' $API/ops/metrics                          # 403
curl -s -H "x-ops-token: $OPS" $API/ops/metrics | jq '.http.wsErrors'             # 200 + {total, byCode}
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/auth/google -H 'content-type: application/json' -d '{}'  # 404
curl -s -X POST $API/auth/dev -H 'content-type: application/json' -d '{}' | jq    # {code:"DEV_LOGIN_DISABLED"|"VALIDATION_ERROR", requestId}
curl -s -X POST $API/auth/refresh -H 'content-type: application/json' -d '{"refreshToken":"x"}' | jq   # {code:"UNAUTHORIZED", message, requestId}
```

Log startu Railway: brak `Odmowa startu`, HEALTHCHECK w obrazie przechodzi
(Railway i tak używa własnego healthchecka po `/ops/health`).
ws-smoke (z lokalnego kontenera na prod, `WS_URL=$API`): `users:findAll` → brak ACK
(timeout), `weeklyPlans:getByWeek` z obcym householdId → `{code:"NOT_HOUSEHOLD_MEMBER", status:403, requestId}`.

## 3. Dev (lokalnie) — zrobione 28.08

`.env`: nowe `JWT_SECRET`/`REFRESH_TOKEN_PEPPER`/`OPS_TOKEN` (32 B base64);
`docker compose up -d --build api` → `docker inspect --format '{{.State.Health.Status}}' scoffie-api` = `healthy`,
`node -v` = v22, `id -u` = 1000. Dev-apka na telefonie: jedno ponowne logowanie (nowy JWT_SECRET).

## 4. iOS

`fix/fundamenty-c` → `develop` → `main` → archiwum → TestFlight. Niezależne od
backendu: nowy iOS czyta `error` ze starego backendu, stary iOS czyta
`error/code/status` z nowego (teksty komunikatów bez zmian).
Ręczny test na telefonie: obcy slot przez ws-smoke → „Nie należysz do tego
gospodarstwa"; tryb samolotowy → „Problem z połączeniem na żywo"; wylogowanie →
`recipes_catalog_cache_v11.json` znika z Documents; zaproszenie po terminie →
„To zaproszenie wygasło".

## 5. Po wdrożeniu

- Rotować hasło Postgresa na Railway (było w terminalu przy plastrze B).
- `SAFE_MIGRATE_REBUILD_DB` na prod wymaga teraz `SAFE_MIGRATE_REBUILD_CONFIRM=<dziś UTC>`
  i `SAFE_MIGRATE_ALLOW_PROD_REBUILD=<host z DATABASE_URL>` — bez tego skrypt
  odmawia (kod 1) i loguje host.
- Backfill R2: jednorazowo `pnpm exec tsx scripts/backfill-recipe-image-urls-from-r2.ts` (commands.txt).

## Wykonane 28.08.2026 (przebieg)

- Merge poszedł PRZED zmiennymi: deploy `1ade5920` (10:39, commit `60e3339`) padł na asercji
  sekretów, prod nie odpowiadał (timeout) ~10 min — Railway zdążył usunąć stary deployment.
- 10:49 ustawione `REFRESH_TOKEN_PEPPER` (44 zn.) i `OPS_TOKEN` (32 zn.) → deployment `78cb5bf4` SUCCESS 10:50,
  `/ops/health` = `60e3339`. Potem skasowana `SAFE_MIGRATE_BACKFILL_R2_IMAGE_URLS` — delete NIE wyzwala redeployu, więc bieżący
  kontener nadal ma flagę (backfill `scanned=0`, nieszkodliwy); zniknie przy następnym deployu.
- Weryfikacja prod OK: `/ops/metrics` 403/200, `/auth/google` 404, `DEV_LOGIN_DISABLED`, `VALIDATION_ERROR`+details,
  `x-request-id`, WS `NOT_HOUSEHOLD_MEMBER`+requestId, `users:findAll` bez ACK, `wsErrors.byCode` liczy.
- Follow-up: `railway.json` z `healthcheckPath: /ops/health`, żeby padający kontener nie dostawał ruchu.
