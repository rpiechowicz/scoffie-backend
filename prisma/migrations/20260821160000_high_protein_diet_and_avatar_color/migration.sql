-- Dieta wysokobiałkowa i kolor awatara.
--
-- HIGH_PROTEIN dokłada się do listy sposobów odżywiania. Klient traktuje ją
-- jak pozostałe: odsiewa przepisy, które nie spełniają progu, tyle że próg
-- jest tu liczbowy (udział energii z białka), a nie składnikowy.
--
-- `avatarColor` to indeks gradientu przydzielany raz, przy kończeniu
-- onboardingu. Nullable, bo konta założone wcześniej go nie mają i dla nich
-- klient dalej wylicza kolor z hasza adresu e-mail.

ALTER TYPE "DietPreferenceValue" ADD VALUE IF NOT EXISTS 'HIGH_PROTEIN';

ALTER TABLE "User" ADD COLUMN "avatarColor" INTEGER;
