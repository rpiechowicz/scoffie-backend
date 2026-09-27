-- Bezpieczna edycja porcji per osoba (ADR plan-portions-safe-editing):
-- monotoniczna rewizja treści tygodnia i stemple pozycji/porcji z tego samego
-- licznika. Addytywnie, bez backfillu — istniejące plany startują od 0.
ALTER TABLE "WeeklyPlan" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlanItem" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlanItemPortion" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
