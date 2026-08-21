-- Płeć użytkownika i waga z częścią dziesiętną.
--
-- Płeć jest potrzebna wyłącznie do wzoru Mifflina-St Jeora: BMR różni się
-- w nim tylko stałą (+5 dla mężczyzn, −161 dla kobiet). Bez niej klient
-- liczył ze średniej, co dawało rozjazd rzędu ±83 kcal. Kolumna jest
-- nullable, więc konta założone wcześniej działają bez zmian i dalej
-- korzystają ze średniej.
--
-- Waga przechodzi z INTEGER na DOUBLE PRECISION. Wagi ciała podaje się
-- z dokładnością do 0,1 kg, a zaokrąglanie 83,5 do 84 psuło i BMI,
-- i policzone zapotrzebowanie. Konwersja jest bezstratna w tę stronę.

CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE');

ALTER TABLE "User" ADD COLUMN "sex" "Sex";

ALTER TABLE "User"
    ALTER COLUMN "weightKg" TYPE DOUBLE PRECISION USING "weightKg"::DOUBLE PRECISION;
