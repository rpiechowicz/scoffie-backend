-- Absolutny kres sesji refresh (7.10.2026, audyt 5.09.2026 punkt 2.3.1).
--
-- Okno `REFRESH_TOKEN_DAYS` (60 d) przesuwa się z każdą rotacją, więc rodzina
-- tokenów odświeżana choć raz na dwa miesiące żyła bez końca. Nowa kolumna
-- `sessionStartedAt` = chwila logowania; rotacja i ratunek zgubionej rotacji
-- KOPIUJĄ ją do następcy, a `/auth/refresh` odmawia (to samo 401 co wygasły
-- token) po `REFRESH_ABSOLUTE_DAYS` (180 d) od niej.
--
-- Istniejące wiersze: początek sesji = `createdAt` TEGO tokenu, czyli chwila
-- ostatniej rotacji (prawdziwego początku sesji baza nie zna). Nikt nie
-- wylatuje po wdrożeniu: żywy token ma `createdAt` > teraz − `REFRESH_TOKEN_DAYS`
-- (60 d; inaczej by wygasł), więc każda żywa sesja dostaje ≥ 120 dni, a aktywny
-- telefon ~180 (odświeża co godzinę, więc jego ostatni token jest świeży). `now()` dałby każdemu pełne
-- 180 dni, ale udawałby, że sesja zaczęła się w dniu wdrożenia — `createdAt`
-- jest bliżej prawdy przy tej samej gwarancji. Wiersze unieważnione też
-- dostają wartość: ratunek zgubionej rotacji kopiuje ją ze starego tokenu.
--
-- Kolumna z wartością domyślną NOT NULL = bez przepisywania tabeli
-- (Postgres 11+); stara instancja, która w trakcie wdrożenia wydaje tokeny
-- bez tej kolumny, dostaje `CURRENT_TIMESTAMP` ≈ jej `createdAt`.

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "sessionStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "RefreshToken" SET "sessionStartedAt" = "createdAt";
