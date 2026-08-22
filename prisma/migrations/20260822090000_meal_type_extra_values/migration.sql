-- Nowe sloty posiłków: II śniadanie, podwieczorek, przekąska.
--
-- Osobna migracja tylko na rozszerzenie enuma. Postgres pozwala dodać
-- wartość w transakcji (PG 12+), ale nie pozwala jej *użyć* w tej samej
-- transakcji — a Prisma odpala każdy plik migracji w jednej transakcji.
-- Backfill i DEFAULT-y korzystające z tych wartości siedzą więc w
-- kolejnej migracji (20260822091000_extra_meal_slots).
--
-- `BEFORE` / `AFTER` zamiast dopisania na koniec: Postgres sortuje enum po
-- kolejności definicji, a plan tygodnia porządkuje posiłki właśnie przez
-- `ORDER BY "mealType"`. Dopisanie na koniec dałoby podwieczorek po kolacji.

ALTER TYPE "MealType" ADD VALUE IF NOT EXISTS 'SECOND_BREAKFAST' BEFORE 'LUNCH';
ALTER TYPE "MealType" ADD VALUE IF NOT EXISTS 'AFTERNOON_SNACK' BEFORE 'DINNER';
ALTER TYPE "MealType" ADD VALUE IF NOT EXISTS 'SNACK' AFTER 'DINNER';
