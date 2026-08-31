---
name: project-railway-prod-ops
description: Jak robić operacje na prod Railway (nazwy serwisów, import katalogu, SQL przez lokalny kontener psql) i dyscyplina „zmiana w JSON katalogu = import na prod”.
metadata:
  type: project
---

Projekt Railway `soothing-celebration`, środowisko `production`, serwisy: **`Backend`** (API,
domena `weakly-meals-backend-production.up.railway.app`), **`Postgres`**, **`Cookidoo`**.
`railway variables/run --service weakly-meals-backend` zwraca „Service not found” — poprawna
nazwa to `Backend` (poprawione w `commands.txt` 28.08.2026). CLI bywa podlinkowany do
`Cookidoo` (`railway status`), więc `--service` podawać zawsze jawnie.

Gospodarstwo katalogu na prod: `9c5156e9-2df3-4768-84b6-800213c205a1` (nazwa „Home”, 89 przepisów)
— ustawione w Variables serwisu Backend jako `RECIPE_IMPORT_HOUSEHOLD_ID` i `AUTO_RECOVER_HOUSEHOLD_ID`
(28.08.2026). Na dev: `f23f827f-1ecb-4e07-8c91-9adbf6127ead` w `.env`.

**Operacje na bazie prod** robi się z Maca przez lokalny kontener Postgresa (ma psql i wyjście
do internetu): `docker compose exec -T db psql "$PROD_DB" -c "…"`, gdzie `$PROD_DB` =
`DATABASE_PUBLIC_URL` z serwisu Postgres, trzymany tylko w `export` w Terminalu — nigdy w plikach.
Import katalogu na prod: `docker exec -e DATABASE_URL="$PROD_DB" -e RECIPE_IMPORT_FILE=… -e
RECIPE_IMPORT_CLEAR_EXISTING=false weeklymeals-api pnpm exec tsx scripts/import-recipes-from-json.ts`
(lokalny obraz API musi być zbudowany z gałęzi z właściwym JSON-em).

**Dyscyplina:** każda zmiana w `prisma/catalog/recipes-catalog-full-v2.json` na `develop` wymaga
importu na prod. Inaczej plik i baza rozjeżdżają się po cichu, a kolejny import zatrzymuje się
na bramce RETITLE (tak było 28.08: „poprawka jogurtu” z `2d7133b` nie trafiła na prod;
zdjęcie w R2 potwierdziło wersję z JSON-a, import poszedł z `RECIPE_IMPORT_ALLOW_RETITLE=true`).
Przed użyciem tej flagi ZAWSZE sprawdzić zdjęcie `recipe-images/<id>.png` — patrz
[[project-recipe-ids-vs-r2-images]].

**Skrypty jednorazowe na prod (od 28.08.2026): `railway ssh --service Backend -- sh -c 'cd /app && pnpm exec tsx scripts/<skrypt>.ts'`**
— wykonuje się W działającym kontenerze (ma `scripts/`, `prisma/catalog`, pnpm, wewnętrzny `DATABASE_URL`), bez hasła
do bazy i bez lokalnego obrazu. Tak poszedł loader tagów (plaster D). Import katalogu też może iść tą drogą
(`RECIPE_IMPORT_FILE=… RECIPE_IMPORT_CLEAR_EXISTING=false pnpm exec tsx scripts/import-recipes-from-json.ts`).
Lokalny kontener z `$PROD_DB` zostaje do SQL (`psql`) i diagnostyki.

**Deploy i zmienne (lekcja z plastra C, 28.08.2026):** Railway deployuje z `main` natychmiast po merge i
przełącza ruch na nowy kontener, zanim ten jest zdrowy — kontener padający na starcie (asercja sekretów)
= prod nie odpowiada (timeout, nie 502), stary deployment już REMOVED. Zmienne wymagane przez nowy kod
ustawiać PRZED merge (`railway variables --service Backend --skip-deploys --set K=V`); `railway variable
delete K --service Backend` nie ma `--skip-deploys` i NIE wyzwala redeployu — usunięta zmienna znika
z kontenera dopiero przy następnym deployu (`railway redeploy --service Backend -y`, jeśli pilne). Serwis startuje komendą
`pnpm start:prod` (ustawienie Railway), nie CMD z Dockerfile. `/ops/metrics` wymaga nagłówka
`x-ops-token` = `OPS_TOKEN` z Variables serwisu Backend. Follow-up: `healthcheckPath: /ops/health` w `railway.json`.

Hasło do bazy prod trafiło do transkryptu sesji 28.08.2026 — Rafał ma je zrotować w Railway.
Powiązane: [[project-weekly-meals-stack]], [[project-ai-agent-decision]].
