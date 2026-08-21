-- Ręcznie ustawione makra w preferencjach użytkownika.
--
-- Kolumny są nullable i to jest istota rzeczy: dopóki użytkownik ich nie
-- tknie, klient wylicza białko / tłuszcze / węglowodany z celu, sylwetki
-- i liczby treningów, a wyliczona wartość ma podążać za zmianami tamtych.
-- Zapis do bazy następuje dopiero wtedy, gdy ktoś nadpisze je ręcznie —
-- NULL znaczy „licz za mnie", a nie „zero gramów".

ALTER TABLE "UserPreference" ADD COLUMN "proteinG" INTEGER;
ALTER TABLE "UserPreference" ADD COLUMN "fatG"     INTEGER;
ALTER TABLE "UserPreference" ADD COLUMN "carbsG"   INTEGER;
