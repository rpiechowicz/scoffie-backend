-- Klucz idempotencji wywołania w księdze kosztu (review Etapu 1).
--
-- Unikat (turnId, callIndex) nie deduplikował wierszy po usunięciu tury:
-- kasowanie rozmowy przepisuje turnId na NULL (FK SET NULL), a ponowienie
-- zapisu przy nieistniejącej turze wstawiało (NULL, NULL) — w Postgresie
-- NULL-e nie kolidują w indeksie unikalnym, więc ten sam koszt liczył się
-- dwa razy. `callKey` jest NOT NULL i nie zależy od FK.
--
-- Istniejące wiersze: wywołanie tury dostaje ten sam klucz, który policzy
-- dla niego kod (`turn:<turnId>:<callIndex>`), reszta (fazy sprzed 26.09,
-- podgrzewanie cache, wiersze po skasowanych rozmowach) — `legacy:<id>`,
-- unikalny z definicji. Żadne dane nie znikają i nie zmieniają kosztu.
ALTER TABLE "AiUsage" ADD COLUMN "callKey" TEXT;

UPDATE "AiUsage"
   SET "callKey" = CASE
     WHEN "turnId" IS NOT NULL AND "callIndex" IS NOT NULL
       THEN 'turn:' || "turnId"::text || ':' || "callIndex"::text
     ELSE 'legacy:' || "id"::text
   END;

ALTER TABLE "AiUsage" ALTER COLUMN "callKey" SET DEFAULT (gen_random_uuid())::text;
ALTER TABLE "AiUsage" ALTER COLUMN "callKey" SET NOT NULL;

CREATE UNIQUE INDEX "AiUsage_callKey_key" ON "AiUsage"("callKey");

-- Stary unikat na kolumnach nullable — zastąpiony przez `callKey`.
DROP INDEX "AiUsage_turnId_callIndex_key";
