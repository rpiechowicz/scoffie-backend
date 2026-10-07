-- Przepisy domów bez utrwalonych adresów generatora obrazków (7.10.2026,
-- audyt 5.09.2026 punkt 2.2.5, review Codexa).
--
-- Kopia „Zapisz u siebie” (od 29.09.2026) zapisywała w `imageUrl` ROZWIĄZANY
-- adres pollinations — z tytułem i opisem przepisu w ścieżce. Od 7.10 serwer
-- takiego adresu w przepisie domu nie oddaje (`resolveRecipeImageUrl` →
-- `null`), a kopia go nie zapisuje; tu czyścimy wiersze, które już go mają,
-- żeby nie wychodził też eksportem ani kolejną ścieżką odczytu.
--
-- Tylko `isCatalog = false`: katalog jest publiczny (i ma komplet zdjęć).
-- Wyzwalacze katalogu (`CatalogChange`, slug) przepisy domów pomijają, więc
-- log synchronizacji się nie przesuwa; telefony dostają stan domu w całości
-- (`recipes:householdState`), a odczyt i tak zwraca `null` niezależnie od
-- tej migracji. `updatedAt` rośnie jak przy zwykłym zapisie.
-- Lokalnie (kopie katalogu i bazy dev) 0 takich wierszy; na prod przepisów
-- domów jest mało, kopie istnieją od 29.09.

UPDATE "Recipe"
SET "imageUrl" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "isCatalog" = false
  AND "imageUrl" LIKE 'http%://image.pollinations.ai/%';
