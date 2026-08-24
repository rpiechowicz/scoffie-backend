-- Preferencje powiadomień push po stronie serwera.
--
-- Dotąd przełączniki z Ustawień („Powiadomienia", „Plan tygodniowy", „Lista
-- zakupów") siedziały wyłącznie w `UserDefaults` telefonu i bramkowały jedynie
-- lokalne powiadomienia rysowane z socketu. Pushe APNs składa serwer, który tych
-- wartości nigdy nie widział — więc wyciszenie powiadomień w aplikacji nie
-- wyciszało niczego, co przychodziło z zewnątrz. Kolumny są tutaj po to, żeby
-- decyzję „wysyłać czy nie" podejmowała ta strona, która wysyła.
--
-- DEFAULT true odtwarza dzisiejsze zachowanie dla wszystkich istniejących
-- wierszy: nikt nie traci powiadomień przez samą migrację. Zmiana głośności
-- bierze się z tego, JAK teraz wysyłamy (zbiorczo, bez dźwięku), a nie z tego,
-- czy wysyłamy.
ALTER TABLE "UserPreference"
    ADD COLUMN IF NOT EXISTS "pushPlanChanges"  BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "pushShoppingList" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "pushHousehold"    BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "pushQuietHours"   BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "timeZone"         TEXT;
