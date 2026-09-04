-- Blokada operatora na subskrypcji.
--
-- PO CO. Ręczne odebranie dostępu (`POST /ops/billing/subscriptions/:id/revoke`)
-- ustawiało `status` i `revokedAt` — czyli dokładnie te pola, które przepisuje
-- każde uzgodnienie z Apple i każde zgłoszenie z telefonu. Klient, któremu
-- obsługa odebrała dostęp po zwrocie pieniędzy załatwionym poza Apple,
-- odzyskiwał go naciskając „Przywróć zakupy”.
--
-- Ta kolumna nie jest przez nic przepisywana. Zdejmuje ją wyłącznie operator
-- (`POST /ops/billing/subscriptions/:id/unhold`).
ALTER TABLE "Subscription" ADD COLUMN "operatorHoldAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "operatorHoldReason" TEXT;
