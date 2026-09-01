-- Poprawianie własnego pytania.
--
-- Wiadomości NIE KASUJEMY: poprawka to nowa tura, a to, co było przed nią,
-- zostaje w bazie. Powód jest prozaiczny — `AgentTurn` i `AgentProposal`
-- wskazują na te wiersze, a kasowanie zamieniłoby historię użycia i księgę
-- kosztów w dziury. Ukrywamy więc odczyt i tyle.
ALTER TABLE "AgentMessage" ADD COLUMN IF NOT EXISTS "hiddenAt" TIMESTAMP(3);

-- Odczyt rozmowy filtruje po `hiddenAt IS NULL`, więc indeks częściowy trafia
-- dokładnie w to zapytanie i nie rośnie razem z ukrytymi wierszami.
CREATE INDEX IF NOT EXISTS "AgentMessage_conversationId_createdAt_visible_idx"
  ON "AgentMessage" ("conversationId", "createdAt")
  WHERE "hiddenAt" IS NULL;
