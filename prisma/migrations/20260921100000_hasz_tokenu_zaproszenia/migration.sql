-- Hasz tokenu zaproszenia — krok 1 z 2 („expand").
--
-- `Invitation.token` leżał w bazie jawnym tekstem: zrzut tabeli był kompletem
-- działających linków (ważnych do 30 dni). Od tej migracji aplikacja szuka
-- zaproszeń wyłącznie po `tokenHash` = sha256(token) w hex i surowej wartości
-- nigdy nie zapisuje.
--
-- Przeliczenie istniejących wierszy dzieje się W BAZIE (`sha256` jest wbudowane
-- od Postgresa 11) — tokeny nie opuszczają serwera bazy, nie trafiają do logów
-- ani do żadnego skryptu. Otwarte linki działają dalej bez zmian.
--
-- Kolumna `token` ZOSTAJE na to jedno wdrożenie (nullable): poprzednia wersja
-- aplikacji czyta ją i zapisuje w oknie deployu oraz po ewentualnym
-- rollbacku. Usuwa ją krok 2 — patrz docs/ZAPROSZENIA-HASZ-TOKENU.md.

ALTER TABLE "Invitation" ADD COLUMN "tokenHash" TEXT;

UPDATE "Invitation"
SET "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex');

ALTER TABLE "Invitation" ALTER COLUMN "tokenHash" SET NOT NULL;
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

ALTER TABLE "Invitation" ALTER COLUMN "token" DROP NOT NULL;

-- Zgodność ze STARĄ wersją aplikacji: jej INSERT nie zna `tokenHash`, więc bez
-- tego wyzwalacza tworzenie zaproszeń kończyłoby się naruszeniem NOT NULL
-- (w oknie deployu i po rollbacku). Nowa wersja zawsze podaje hasz sama
-- i wyzwalacz jej nie dotyczy. Znika razem z kolumną `token` w kroku 2.
CREATE FUNCTION "invitation_fill_token_hash"() RETURNS trigger AS $$
BEGIN
  IF NEW."tokenHash" IS NULL AND NEW."token" IS NOT NULL THEN
    NEW."tokenHash" := encode(sha256(convert_to(NEW."token", 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "invitation_fill_token_hash"
BEFORE INSERT ON "Invitation"
FOR EACH ROW EXECUTE FUNCTION "invitation_fill_token_hash"();
