-- Porcje per osoba (workstream assistant-backend-optimization, Etap 2.2).
--
-- Nowa tabela, bez backfillu: pozycja planu BEZ wierszy liczy się dokładnie
-- jak dotąd (plannedServings / liczba jedzących). `units` = 1/20 porcji,
-- CHECK pilnuje widełek 0,1–6 porcji na osobę (2–120 jednostek) także przy
-- zapisie spoza aplikacji. Rollback: DROP TABLE "PlanItemPortion" — pozycje
-- wracają do równego podziału, `plannedServings` zostaje w kolumnie.
CREATE TABLE "PlanItemPortion" (
    "planItemId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "units" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanItemPortion_pkey" PRIMARY KEY ("planItemId","userId"),
    CONSTRAINT "PlanItemPortion_units_check" CHECK ("units" BETWEEN 2 AND 120)
);

CREATE INDEX "PlanItemPortion_userId_idx" ON "PlanItemPortion"("userId");

ALTER TABLE "PlanItemPortion" ADD CONSTRAINT "PlanItemPortion_planItemId_fkey" FOREIGN KEY ("planItemId") REFERENCES "PlanItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlanItemPortion" ADD CONSTRAINT "PlanItemPortion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
