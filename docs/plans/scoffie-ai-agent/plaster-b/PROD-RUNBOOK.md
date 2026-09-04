# Plaster B — runbook wdrożenia (backend → dane → iOS)

Stan na 28.08.2026: kod gotowy na gałęziach `fix/fundamenty-b` w obu repach
(backend `ccfab53`, iOS `18bc95f`), zweryfikowany na dev (jest 338/341 — 3 stare
porażki w `auth/apple-identity.service.spec.ts` niezależne od tej gałęzi; tsc build
czysty; xcodebuild OK; ws-smoke wszystkich pięciu punktów OK; pula na dev skasowana).

Kolejność jest nośna: **backend → SQL → iOS**. Nowy iOS na starym backendzie zostawiłby
dwa dania w slocie (WS ignoruje nieznane `replaceRecipeId`), a iOS z unią alergenów
przed czyszczeniem SQL utrwaliłby śmieci i zablokował zapis preferencji.

## 1. Backend

1. `fix/fundamenty-b` → PR → `develop` → `main` (Railway `Backend` deployuje z `main`).
2. `curl https://scoffie-backend-production.up.railway.app/ops/health` — commit = merge.
3. Żadnej migracji Prismy w tym plastrze (schemat bez zmian; DROP puli w następnym wydaniu).

## 2. Dane na prod (Terminal z `export PROD_DB='…'`, przez lokalny kontener psql)

```bash
P() { docker compose exec -T db psql "$PROD_DB" -At -c "$1"; }
```

### 2.1 Diagnostyka (read-only) — wkleić wyniki do PR

```bash
P "SELECT 'pools='||(SELECT count(*) FROM \"SharedMealPlan\")||'|items='||(SELECT count(*) FROM \"SharedMealPlanItem\");"
# tygodnie z pulą bez PlanItemów (oczekiwane 0 wierszy):
P "SELECT s.\"householdId\"||'|'||s.\"weekStart\"::date||'|items='||count(si.id) FROM \"SharedMealPlan\" s JOIN \"SharedMealPlanItem\" si ON si.\"sharedMealPlanId\"=s.id WHERE NOT EXISTS (SELECT 1 FROM \"WeeklyPlan\" w JOIN \"PlanItem\" pi ON pi.\"weeklyPlanId\"=w.id WHERE w.\"householdId\"=s.\"householdId\" AND w.\"weekStart\"=s.\"weekStart\") GROUP BY s.id, s.\"householdId\", s.\"weekStart\";"
# duchy uczestników / zjedzonych (future ma spaść do 0 po 2.3, past zostaje):
P "SELECT 'ghost_part|future='||count(*) FILTER (WHERE w.\"weekStart\">=date_trunc('week',CURRENT_DATE))||'|past='||count(*) FILTER (WHERE w.\"weekStart\"<date_trunc('week',CURRENT_DATE)) FROM \"PlanItemParticipant\" p JOIN \"PlanItem\" i ON i.id=p.\"planItemId\" JOIN \"WeeklyPlan\" w ON w.id=i.\"weeklyPlanId\" WHERE NOT EXISTS (SELECT 1 FROM \"Membership\" m WHERE m.\"userId\"=p.\"userId\" AND m.\"householdId\"=w.\"householdId\");"
P "SELECT 'ghost_cons|future='||count(*) FILTER (WHERE w.\"weekStart\">=date_trunc('week',CURRENT_DATE))||'|past='||count(*) FILTER (WHERE w.\"weekStart\"<date_trunc('week',CURRENT_DATE)) FROM \"PlanItemConsumption\" p JOIN \"PlanItem\" i ON i.id=p.\"planItemId\" JOIN \"WeeklyPlan\" w ON w.id=i.\"weeklyPlanId\" WHERE NOT EXISTS (SELECT 1 FROM \"Membership\" m WHERE m.\"userId\"=p.\"userId\" AND m.\"householdId\"=w.\"householdId\");"
# itemy do skasowania (cały skład spoza domu, tygodnie >= bieżący) — PRZEJRZEĆ:
P "SELECT w.\"householdId\"||'|'||w.\"weekStart\"::date||'|'||i.\"dayOfWeek\"||'|'||i.\"mealType\"||'|'||i.id FROM \"PlanItem\" i JOIN \"WeeklyPlan\" w ON w.id=i.\"weeklyPlanId\" WHERE w.\"weekStart\">=date_trunc('week',CURRENT_DATE) AND EXISTS (SELECT 1 FROM \"PlanItemParticipant\" p WHERE p.\"planItemId\"=i.id) AND NOT EXISTS (SELECT 1 FROM \"PlanItemParticipant\" p JOIN \"Membership\" m ON m.\"userId\"=p.\"userId\" AND m.\"householdId\"=w.\"householdId\" WHERE p.\"planItemId\"=i.id);"
# alergeny spoza listy i makra poza zakresem (oczekiwane: none / 0):
P "SELECT coalesce(string_agg(v||'='||c, ','),'none') FROM (SELECT v, count(*) c FROM \"UserPreference\" p, unnest(p.allergens) v WHERE v <> ALL (ARRAY['gluten','lactose','eggs','nuts','peanuts','fish','soy']) GROUP BY v) t;"
P "SELECT count(*) FROM \"UserPreference\" WHERE \"proteinG\" NOT BETWEEN 0 AND 400 OR \"fatG\" NOT BETWEEN 0 AND 300 OR \"carbsG\" NOT BETWEEN 0 AND 800;"
# przepisy spoza importera (oczekiwane 0 → B4 nie ma czego naprawiać):
P "SELECT count(*) FROM \"Recipe\" WHERE \"authorId\" <> '11111111-1111-4111-8111-111111111111';"
```

### 2.2 Backupy

```bash
docker compose exec -T db pg_dump "$PROD_DB" -t '"SharedMealPlan"' -t '"SharedMealPlanItem"' --data-only > ~/prod_shared_meal_plan_backup_$(date +%Y%m%d).sql
P "CREATE TABLE \"_bak_wp04_PlanItem\" AS SELECT i.* FROM \"PlanItem\" i JOIN \"WeeklyPlan\" w ON w.id=i.\"weeklyPlanId\" WHERE w.\"weekStart\">=date_trunc('week',CURRENT_DATE);"
P "CREATE TABLE \"_bak_wp04_PlanItemParticipant\" AS SELECT p.* FROM \"PlanItemParticipant\" p JOIN \"PlanItem\" i ON i.id=p.\"planItemId\" JOIN \"WeeklyPlan\" w ON w.id=i.\"weeklyPlanId\" WHERE w.\"weekStart\">=date_trunc('week',CURRENT_DATE);"
P "CREATE TABLE \"_bak_wp04_PlanItemConsumption\" AS SELECT c.* FROM \"PlanItemConsumption\" c JOIN \"PlanItem\" i ON i.id=c.\"planItemId\" JOIN \"WeeklyPlan\" w ON w.id=i.\"weeklyPlanId\" WHERE w.\"weekStart\">=date_trunc('week',CURRENT_DATE);"
P "CREATE TABLE \"_bak_prefs_$(date +%Y%m%d)\" AS SELECT \"userId\", allergens, \"proteinG\", \"fatG\", \"carbsG\" FROM \"UserPreference\";"
```

### 2.3 Czyszczenie (jedna sesja, kolejność jak niżej)

```bash
P "BEGIN;
DELETE FROM \"PlanItem\" i USING \"WeeklyPlan\" w WHERE i.\"weeklyPlanId\"=w.id AND w.\"weekStart\">=date_trunc('week',CURRENT_DATE) AND EXISTS (SELECT 1 FROM \"PlanItemParticipant\" p WHERE p.\"planItemId\"=i.id) AND NOT EXISTS (SELECT 1 FROM \"PlanItemParticipant\" p JOIN \"Membership\" m ON m.\"userId\"=p.\"userId\" AND m.\"householdId\"=w.\"householdId\" WHERE p.\"planItemId\"=i.id);
DELETE FROM \"PlanItemParticipant\" p USING \"PlanItem\" i, \"WeeklyPlan\" w WHERE p.\"planItemId\"=i.id AND i.\"weeklyPlanId\"=w.id AND w.\"weekStart\">=date_trunc('week',CURRENT_DATE) AND NOT EXISTS (SELECT 1 FROM \"Membership\" m WHERE m.\"userId\"=p.\"userId\" AND m.\"householdId\"=w.\"householdId\");
DELETE FROM \"PlanItemConsumption\" c USING \"PlanItem\" i, \"WeeklyPlan\" w WHERE c.\"planItemId\"=i.id AND i.\"weeklyPlanId\"=w.id AND w.\"weekStart\">=date_trunc('week',CURRENT_DATE) AND NOT EXISTS (SELECT 1 FROM \"Membership\" m WHERE m.\"userId\"=c.\"userId\" AND m.\"householdId\"=w.\"householdId\");
UPDATE \"UserPreference\" p SET allergens = COALESCE((SELECT array_agg(DISTINCT v ORDER BY v) FROM unnest(p.allergens) v WHERE v = ANY (ARRAY['gluten','lactose','eggs','nuts','peanuts','fish','soy'])), '{}') WHERE EXISTS (SELECT 1 FROM unnest(p.allergens) v WHERE v <> ALL (ARRAY['gluten','lactose','eggs','nuts','peanuts','fish','soy']));
UPDATE \"UserPreference\" SET \"proteinG\"=LEAST(GREATEST(\"proteinG\",0),400), \"fatG\"=LEAST(GREATEST(\"fatG\",0),300), \"carbsG\"=LEAST(GREATEST(\"carbsG\",0),800) WHERE \"proteinG\" NOT BETWEEN 0 AND 400 OR \"fatG\" NOT BETWEEN 0 AND 300 OR \"carbsG\" NOT BETWEEN 0 AND 800;
DELETE FROM \"SharedMealPlanItem\"; DELETE FROM \"SharedMealPlan\";
UPDATE \"ShoppingList\" SET \"isStale\"=true WHERE \"weekStart\">=date_trunc('week',CURRENT_DATE);
COMMIT;"
```

Potem powtórzyć 2.1: `ghost_*|future=0`, `pools=0`, alergeny `none`, makra `0`.
Historycznego dryfu porcji NIE poprawiać hurtowo (ręczne nieodróżnialne od auto).

### 2.4 Rollback danych

`psql "$PROD_DB" < ~/prod_shared_meal_plan_backup_*.sql`; `INSERT INTO "PlanItem" SELECT * FROM
"_bak_wp04_PlanItem" ON CONFLICT DO NOTHING;` (najpierw PlanItem, potem dzieci); preferencje z
`_bak_prefs_*` po `userId`. Tabele `_bak_*` skasować po jednym wydaniu bez zgłoszeń.

## 3. iOS

`fix/fundamenty-b` → `develop` → `main` → TestFlight. Ręcznie na dwóch telefonach:
podmiana dania = jeden banner, slot nie miga pusto; tryb samolotowy w trakcie zapisu → rollback
do starego dania; partner opuszcza dom → jego solo znikają, wspólne 2→1, „Zapisz porcje” działa,
przeszły tydzień nietknięty; powrót partnera → 1→2, ręczne 4 zostaje; stara apka na nowym
backendzie przełącza tygodnie bez ~18 s zwłoki (stub `getSavedPlan`); alergeny:
`UPDATE "UserPreference" SET allergens=ARRAY['gluten','celery'] WHERE "userId"='<A>'` → toggle
jaj → w bazie `{celery,eggs,gluten}`.

## 4. Follow-up (następne wydanie)

- usunąć stub `weeklyPlans:getSavedPlan` + `WeeklyPlansGetSavedPlanPayload`,
- migracja `DROP TABLE "SharedMealPlanItem", "SharedMealPlan"` + usunięcie modeli z `schema.prisma`,
- iOS: gałąź `case "SAVE_PLAN"` w `PlanChangeNotificationService.singleChangeText`,
- kolumna `servingsMode AUTO|MANUAL` (koniec heurystyki „ręczne = auto ze starego składu”),
- nowe alergeny (seler/gorczyca/sezam) dopiero z tagami składników, backend przed iOS.
