-- Skrzynka zaproszeń: zaproszenie przestaje być jednorazowym linkiem, który
-- trzeba złapać w locie.
--
-- Dotąd zaproszenie istniało wyłącznie jako token w URL-u. Kto go otworzył
-- w złym momencie — bo akurat należał już do innego gospodarstwa, bo nie był
-- zalogowany, bo zamknął alert — nie miał jak do niego wrócić: w aplikacji nie
-- było ani listy zaproszeń, ani śladu, że jakieś przyszło. Zapraszający widział
-- tylko, że „nie zadziałało".
--
-- `invitedUserId` zapisuje adresata w chwili, gdy ten pierwszy raz podejrzy
-- link. To jedyny moment, w którym da się go poznać: zaproszenie powstaje jako
-- anonimowy link i zapraszający nie musi znać ani konta, ani adresu
-- zapraszanego (przy Sign in with Apple bywa to `@privaterelay`).
--
-- Pole NIE ogranicza, kto może zaproszenie przyjąć — link zostaje wielorazowy
-- do wykorzystania, więc udostępnienie go dwóm osobom działa jak dotąd.
ALTER TABLE "Invitation"
    ADD COLUMN IF NOT EXISTS "invitedUserId" UUID,
    ADD COLUMN IF NOT EXISTS "declinedAt"    TIMESTAMP(3);

-- `ON DELETE SET NULL`, a nie `CASCADE`: skasowanie konta adresata nie ma
-- kasować zaproszenia, które wciąż należy do gospodarstwa zapraszającego.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Invitation_invitedUserId_fkey'
    ) THEN
        ALTER TABLE "Invitation"
            ADD CONSTRAINT "Invitation_invitedUserId_fkey"
            FOREIGN KEY ("invitedUserId") REFERENCES "User"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Invitation_invitedUserId_idx"
    ON "Invitation"("invitedUserId");
