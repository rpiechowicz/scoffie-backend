-- Przydział koloru awatara kontom założonym przed wprowadzeniem `avatarColor`.
--
-- Bez tego kolor mieli tylko nowi użytkownicy, a wszyscy dotychczasowi
-- spadali na wariant liczony z hasza e-maila po stronie klienta — czyli dwa
-- różne mechanizmy obok siebie i brak gwarancji, że domownicy mają różne
-- odcienie.
--
-- Numerujemy w obrębie gospodarstwa po dacie dołączenia, więc pierwszy
-- członek dostaje 0, drugi 1 i tak dalej. Modulo 12 domyka się na rozmiarze
-- palety (`AVATAR_COLOR_COUNT` w users.service.ts oraz `gradientPairs`
-- w ProfileAvatar) — dopiero w trzynastoosobowym gospodarstwie kolory
-- zaczną się powtarzać.
--
-- Użytkownicy bez gospodarstwa nie mają z kim kolidować, więc dostają kolor
-- z reszty modulo po kolejności założenia konta.

WITH ranked AS (
    SELECT
        m."userId" AS user_id,
        (ROW_NUMBER() OVER (
            PARTITION BY m."householdId"
            ORDER BY m."createdAt", m."userId"
        ) - 1) % 12 AS color
    FROM "Membership" m
)
UPDATE "User" u
SET "avatarColor" = ranked.color
FROM ranked
WHERE u.id = ranked.user_id
  AND u."avatarColor" IS NULL;

WITH orphans AS (
    SELECT
        u.id AS user_id,
        (ROW_NUMBER() OVER (ORDER BY u."createdAt", u.id) - 1) % 12 AS color
    FROM "User" u
    WHERE u."avatarColor" IS NULL
)
UPDATE "User" u
SET "avatarColor" = orphans.color
FROM orphans
WHERE u.id = orphans.user_id;
