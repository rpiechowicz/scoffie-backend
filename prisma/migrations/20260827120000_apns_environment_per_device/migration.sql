-- Token APNs jest ważny tylko w tym środowisku, które go wydało: build z
-- Xcode (aps-environment: development) odpowiada wyłącznie na
-- api.sandbox.push.apple.com, build z TestFlight wyłącznie na
-- api.push.apple.com. Jeden globalny APNS_USE_SANDBOX nie opisuje floty, w
-- której są oba naraz — stąd środowisko per urządzenie.
-- NULL = urządzenie sprzed tej zmiany; wtedy obowiązuje ustawienie globalne,
-- a serwer i tak dopyta drugi host, zanim uzna token za martwy.
ALTER TABLE "PushDevice" ADD COLUMN IF NOT EXISTS "apnsEnvironment" TEXT;
