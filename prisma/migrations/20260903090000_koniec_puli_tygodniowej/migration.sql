-- Pula tygodniowa (SharedMealPlan) została wycofana w WP-03: od tamtej pory
-- jedynym źródłem prawdy jest PlanItem, nikt do tych tabel nie pisze ani
-- z nich nie czyta (handler weeklyPlans:getSavedPlan odpowiada stałą pustą
-- pulą bez dotykania bazy). Puste tabele z kluczami obcymi do Recipe i
-- Household tylko komplikowały kasowanie kont i audyt danych osobowych.
DROP TABLE IF EXISTS "SharedMealPlanItem";
DROP TABLE IF EXISTS "SharedMealPlan";
