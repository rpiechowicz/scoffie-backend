# Plaster D — runbook prod

Kolejność nośna: **backend → loader tagów na prod → iOS**. Nowy iOS traktuje `[]`
z serwera jako fakt („bez alergenów”), więc między deployem backendu a loaderem
nie wolno wypuścić iOS. Stary iOS w tym oknie działa jak dotąd (heurystyka).

## 1. Backend

PR `fix/fundamenty-d` → `develop` (CI: lint, typecheck, build, unit, e2e) → `main`.
Zmienne Railway: bez zmian. Migracja `20260828150000_tagi_skladnikow_i_przepisow`
idzie sama przy starcie (`ADD COLUMN IF NOT EXISTS`, GIN). Zdrowie:

```sh
curl -s $API/ops/health | jq .commit
```

(Opcjonalnie najpierw `fix/railway-healthcheck` → `main`: `railway.json` z `healthcheckPath`.)

## 2. Loader tagów na prod (jednorazowo po deployu; idempotentny)

Lokalny obraz API musi być zbudowany z gałęzi z plikiem tagów (`docker compose build api`).

```sh
# w Terminalu: export PROD_DB='…'  (DATABASE_PUBLIC_URL z serwisu Postgres; nigdy w plikach)
docker exec -e DATABASE_URL="$PROD_DB" scoffie-api pnpm exec tsx scripts/load-ingredient-tags.ts
```

Oczekiwane: `[tags] done. version=ingredient-tags-pl-v1, wpisow=403, skladnikow zaktualizowanych=403,
przepisow sprawdzonych=89(+), zmienionych=89(+)`, bez `UWAGA: … bez wpisu w pliku tagow`.
Uwaga: lista przepisów jest cache'owana w procesie 90 s — tagi w `recipes:findAll` pojawią się
najpóźniej po TTL.
Weryfikacja (tylko odczyt):

```sh
docker compose exec -T db psql "$PROD_DB" -c "select count(*) filter (where cardinality(allergens)>0) from \"Ingredient\" where \"isActive\""   # 135+ (składniki z alergenem)
docker compose exec -T db psql "$PROD_DB" -c "select title, allergens, \"dietTags\" from \"Recipe\" where title in ('Żurek z białą kiełbasą i jajkiem','Hummus z warzywami do maczania')"
```

Żurek → `{celery,eggs,gluten,lactose}` / `{DAIRY,EGG,GLUTEN_GRAIN,GRAIN,MEAT,PROCESSED}`;
Hummus → `{sesame}` / `{LEGUME}`.

## 3. iOS

`fix/fundamenty-d` → `develop` → `main` → TestFlight. Ręcznie: Ustawienia → alergeny: chipy
„Seler”, „Gorczyca”, „Sezam”; zaznacz „Seler” → z katalogu znikają m.in. Rosół, Żurek,
Leczo (bulion/Vegeta); zaznacz „Gluten” → znika „Skyr z granolą” (A2); dieta wegańska →
zostaje tylko Hummus.

## 4. Po wdrożeniu

- Każda zmiana `ingredient-tags-pl-v1.json` na `develop` = ponowny loader na prod (jak przy
  katalogu przepisów). Nowy składnik w txt bez wpisu w pliku → golden spec czerwony w CI.
- Import przepisów (`recipes:import:json`) liczy tagi sam — loader nie jest potrzebny po imporcie,
  o ile tagi składników już są.
- Nadal wisi: rotacja hasła Postgresa; `railway.json` (healthcheck) do merge.

## Wykonane 28.08.2026

- Backend `main` = `090d10d` (PR-y `fix/fundamenty-d` + `fix/railway-healthcheck`), deployment `19884edf` SUCCESS 12:06,
  migracja `20260828150000` zastosowana, bootstrap „skipped: database already has data” (poprawnie).
- iOS `main` = `bbc220e` — wypuszczony PRZED loaderem (okno ~15 min z pustymi tagami = „bez alergenów”).
- 12:20 loader przez `railway ssh --service Backend -- sh -c 'cd /app && pnpm exec tsx scripts/load-ingredient-tags.ts'`:
  403 składniki, 89 przepisów; Żurek na prod → `{celery,eggs,gluten,lactose}` / `{DAIRY,EGG,GLUTEN_GRAIN,GRAIN,MEAT,PROCESSED}`.
  `railway ssh` zastępuje lokalny kontener z `$PROD_DB` dla skryptów jednorazowych.
