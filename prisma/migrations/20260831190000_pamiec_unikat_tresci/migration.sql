-- Unikat treści notatki zamiast porównania ILIKE.
--
-- Pierwsza wersja odbijała duplikaty zapytaniem `equals` + `mode: 'insensitive'`,
-- które Prisma kompiluje do `ILIKE` — a to znaczy, że treść notatki była
-- WZORCEM, w którym `%` i `_` są wieloznacznikami. Notatka „Kuba je 100% mięsa"
-- pasowała do „Kuba je 100 dag mięsa", więc nowa po cichu nie powstawała, a
-- model dostawał potwierdzenie z cudzą treścią. Do tego check-then-act
-- przepuszczał dwa równoległe zapisy tego samego zdania.
--
-- Kolumna znormalizowana z UNIKATEM zamyka oba problemy naraz.

ALTER TABLE "AgentMemory"
    ADD COLUMN IF NOT EXISTS "textNormalized" TEXT NOT NULL DEFAULT '';

-- Backfill istniejących wierszy (małe litery, sklejone białe znaki).
UPDATE "AgentMemory"
   SET "textNormalized" = lower(regexp_replace(btrim("text"), '\s+', ' ', 'g'))
 WHERE "textNormalized" = '';

-- Duplikaty sprzed unikatu: zostaje najnowszy wiersz z każdej pary.
DELETE FROM "AgentMemory" a
      USING "AgentMemory" b
      WHERE a."householdId" = b."householdId"
        AND a."textNormalized" = b."textNormalized"
        AND (a."createdAt" < b."createdAt"
             OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));

ALTER TABLE "AgentMemory" ALTER COLUMN "textNormalized" DROP DEFAULT;

CREATE UNIQUE INDEX IF NOT EXISTS "AgentMemory_householdId_textNormalized_key"
    ON "AgentMemory"("householdId", "textNormalized");
