-- Dzienne kroki z Apple Health (HealthKit), per użytkownik i dzień — także dla
-- Garmina (Garmin Connect dopisuje kroki do Zdrowia, my czytamy je stamtąd).
-- Telefon nadpisuje kroczące okno ostatnich ~7 dni, bo źródła potrafią dopisywać
-- próbki z opóźnieniem — pojedynczy zapis dnia bieżącego by nie wystarczył.
-- "stepsGoal" to zrzut celu z dnia zapisu, żeby przyszłe statystyki znały
-- ówczesny cel. "date" jako czysta DATE liczona w strefie telefonu — serwer
-- (UTC) nie reinterpretuje jej, jak przy Cookidoo send-to-week.
CREATE TABLE IF NOT EXISTS "DailyStepCount" (
    "userId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "steps" INTEGER NOT NULL,
    "stepsGoal" INTEGER NOT NULL,
    -- APPLE_HEALTH | GARMIN. Tekst, nie enum — defensywna migracja enuma
    -- wymaga bloków DO $$, a wartości i tak waliduje DTO.
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyStepCount_pkey" PRIMARY KEY ("userId", "date")
);

-- Kasowanie użytkownika zabiera jego kroki — to dane osobiste, nie wspólne
-- dla gospodarstwa.
ALTER TABLE "DailyStepCount"
    DROP CONSTRAINT IF EXISTS "DailyStepCount_userId_fkey";
ALTER TABLE "DailyStepCount"
    ADD CONSTRAINT "DailyStepCount_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
