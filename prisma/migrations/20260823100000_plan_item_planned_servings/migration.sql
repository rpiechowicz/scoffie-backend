-- Liczba porcji gotowanych w slocie planu.
--
-- Skalar na "PlanItem", a nie kilka wierszy „po jednym na porcję": slotu pilnuje
-- @@unique([weeklyPlanId, dayOfWeek, mealType, recipeId]), więc ten sam przepis
-- fizycznie nie może wystąpić w slocie dwa razy. Zwielokrotnianie wierszy
-- wymagałoby rozluźnienia tego klucza, a to on trzyma plan w ryzach — bez niego
-- dwa równoległe zapisy z dwóch telefonów robią duplikat dania w tym samym
-- posiłku.
--
-- To liczba łączna, nie „na osobę". Lista zakupów mnoży składniki przepisu przez
-- "plannedServings" / "Recipe"."servings", więc obiad na cztery osoby z przepisu
-- napisanego na dwie kupuje wreszcie podwójnie.
--
-- DEFAULT 1 jest wyłącznie po to, żeby ALTER TABLE przeszedł na istniejących
-- wierszach: kolumna NOT NULL bez wartości domyślnej wywróciłaby migrację na
-- niepustej tabeli.
ALTER TABLE "PlanItem"
    ADD COLUMN IF NOT EXISTS "plannedServings" INTEGER NOT NULL DEFAULT 1;

-- Backfill wyjątkowo TUTAJ, a nie tylko w scripts/backfill-plan-item-servings.ts.
--
-- Konwencja projektu każe trzymać backfille w skryptach, ale ta migracja wchodzi
-- razem ze zmianą wagi pozycji na liście zakupów: dotąd każdy item planu liczył
-- się jako 1 × przepis, od teraz jako "plannedServings" / "Recipe"."servings".
-- Cały katalog ma servings = 2, więc w oknie między `migrate deploy` a ręcznym
-- uruchomieniem skryptu KAŻDY istniejący tydzień kupowałby połowę składników.
-- Takiego okna nie wolno zostawić, bo nikt go nie zauważy — lista po prostu
-- pokaże za małe gramatury.
--
-- Wolno to zrobić w migracji, bo to nie jest heurystyka ani zgadywanie: liczba
-- porcji wynika deterministycznie z danych, które już leżą w bazie — z audytorium
-- posiłku ("PlanItemParticipant"), a dla dania „Wspólne" (brak uczestników) z
-- liczby domowników w gospodarstwie planu.
--
-- Licznik kalorii się od tego nie ruszy: udział jednej osoby to
-- "plannedServings" / liczba jedzących, a tu ustawiamy licznik równy mianownikowi,
-- czyli dokładnie 1.0 porcji na osobę — tyle, ile aplikacja pokazywała dotąd.
--
-- Idempotencja: ruszamy wyłącznie wiersze, które nadal mają wartość domyślną 1,
-- więc powtórny `migrate deploy` (albo późniejsze uruchomienie skryptu) nie
-- nadpisze niczego, co użytkownik ustawił stepperem. Ceną jest to, że świadomie
-- wybranej jedynki nie odróżniamy od domyślnej — osobnej flagi „ruszane ręcznie"
-- nie wprowadzamy dla jednorazowego backfillu.
UPDATE "PlanItem" pi
SET "plannedServings" = LEAST(
        12,
        GREATEST(
            1,
            COALESCE(
                -- Zero uczestników znaczy „Wspólne", a nie „nikt nie je" — NULLIF
                -- przepycha ten przypadek do liczby domowników poniżej.
                NULLIF(
                    (
                        SELECT COUNT(*)
                        FROM "PlanItemParticipant" pip
                        WHERE pip."planItemId" = pi.id
                    ),
                    0
                ),
                (
                    SELECT COUNT(*)
                    FROM "Membership" m
                    JOIN "WeeklyPlan" wp ON wp.id = pi."weeklyPlanId"
                    WHERE m."householdId" = wp."householdId"
                )
            )
        )
    )::INTEGER
WHERE pi."plannedServings" = 1;
