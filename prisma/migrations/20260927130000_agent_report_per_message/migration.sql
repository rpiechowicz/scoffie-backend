-- Jedno zgłoszenie odpowiedzi asystenta na osobę i wiadomość: drugie wysłanie poprawia
-- pierwsze, więc serwis szuka go po (userId, messageId). Indeks, nie unikat — stare dublety zostają.
--
-- Addytywnie: sam indeks. Rollback: DROP INDEX "AgentReport_userId_messageId_idx".

-- CreateIndex
CREATE INDEX "AgentReport_userId_messageId_idx" ON "AgentReport"("userId", "messageId");

