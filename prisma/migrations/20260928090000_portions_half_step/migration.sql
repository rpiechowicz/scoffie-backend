-- Porcje per osoba: krok 0,5 porcji (10 jednostek po 1/20) od 27.09.2026.
-- Istniejące porcje spoza kroku zaokrąglamy do najbliższego 0,5 (połówki w górę,
-- minimum 0,5), przeliczamy `plannedServings = ceil(Σ)` pozycji i podbijamy
-- rewizje (tydzień, pozycja, jej porcje), żeby tokeny sprzed zaokrąglenia nie
-- przeszły. Schemat bez zmian.

CREATE TEMP TABLE "_half_step_items" AS
  SELECT DISTINCT "planItemId" AS "id"
  FROM "PlanItemPortion"
  WHERE "units" % 10 <> 0;

UPDATE "PlanItemPortion"
SET "units" = GREATEST(10, (ROUND("units" / 10.0) * 10)::int)
WHERE "units" % 10 <> 0;

UPDATE "WeeklyPlan" AS wp
SET "revision" = wp."revision" + 1
WHERE wp."id" IN (
  SELECT pi."weeklyPlanId"
  FROM "PlanItem" AS pi
  JOIN "_half_step_items" AS h ON h."id" = pi."id"
);

UPDATE "PlanItem" AS pi
SET
  "revision" = wp."revision",
  "plannedServings" = LEAST(12, GREATEST(1, CEIL((
    SELECT SUM(p."units") FROM "PlanItemPortion" AS p WHERE p."planItemId" = pi."id"
  ) / 20.0)))::int
FROM "WeeklyPlan" AS wp, "_half_step_items" AS h
WHERE h."id" = pi."id" AND wp."id" = pi."weeklyPlanId";

UPDATE "PlanItemPortion" AS p
SET "revision" = pi."revision"
FROM "PlanItem" AS pi, "_half_step_items" AS h
WHERE h."id" = p."planItemId" AND pi."id" = p."planItemId";

DROP TABLE "_half_step_items";
