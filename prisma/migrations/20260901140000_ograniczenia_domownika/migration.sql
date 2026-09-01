-- Ograniczenia domownika, których nie da się wyrazić alergenem.
--
-- „Nie jem pieczarek" i „mam najwyżej pół godziny" to były do tej pory zdania
-- w rozmowie z asystentem — ginęły razem z turą. Teraz są w bazie, więc
-- wchodzą do kontekstu każdego kolejnego pytania.
ALTER TABLE "UserPreference"
  ADD COLUMN IF NOT EXISTS "excludedIngredientIds" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "maxPrepTimeMinutes" INTEGER;
