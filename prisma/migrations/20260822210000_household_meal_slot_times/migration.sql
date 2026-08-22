-- Pory posiłków per gospodarstwo.
--
-- Dotąd godziny żyły wyłącznie na urządzeniu (`UserDefaults` w aplikacji),
-- przez co ekran ustawień musiał się tłumaczyć: lista posiłków wspólna,
-- pory nie. Kolumna zamyka tę asymetrię.
--
-- JSONB, a nie osobna tabela ani sześć kolumn: to mapa slot → minuty od
-- północy, czytana i zapisywana zawsze w całości, nigdy po kluczu. Relacja
-- dawałaby join po sześć wierszy bez żadnego zysku.
--
-- NULL znaczy „gospodarstwo nie ruszało godzin" — klient pokazuje wtedy
-- swoje wartości domyślne. Brak klucza w mapie znaczy „ten posiłek nie ma
-- stałej pory" (tak działa przekąska), więc pusta mapa i NULL to dwie różne
-- rzeczy i nie wolno ich sklejać.
ALTER TABLE "Household"
    ADD COLUMN IF NOT EXISTS "mealSlotTimes" JSONB;
