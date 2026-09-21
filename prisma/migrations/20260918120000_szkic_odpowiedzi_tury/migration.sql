-- Szkic odpowiedzi tury, dopisywany w trakcie generowania.
--
-- Tura biegnie na serwerze i telefon odpytuje ją co sekundę (patrz kontrakt
-- POST /agent/conversations/:id/messages → 202). Dotąd tekst pojawiał się
-- dopiero przy DONE — po 25–240 s ciszy. Dostawca streamuje z modelu, runner
-- zapisuje tu narastający tekst, a telefon pokazuje go w miarę odpytywania.
-- Ten sam kanał, co postęp (`progress`): bez nowego połączenia, z tą samą
-- odpornością na telefon w tle. Czyszczony przy domknięciu tury — wtedy
-- prawdą jest `AgentMessage`, nie szkic.
ALTER TABLE "AgentTurn" ADD COLUMN "draftText" TEXT;
