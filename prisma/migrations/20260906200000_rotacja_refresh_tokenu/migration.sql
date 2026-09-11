-- Ślad po rotacji refresh tokenu.
--
-- PO CO. Refresh token jest jednorazowy, a wykrycie ponownego użycia kasuje
-- CAŁĄ rodzinę tokenów użytkownika. To słuszne wobec kradzieży, ale nie
-- odróżniało jej od sytuacji, która na telefonie zdarza się sama: aplikacja
-- wysyła `POST /auth/refresh`, serwer rotuje token, po czym iOS usypia proces
-- i odpowiedź nigdy nie dojeżdża. W Keychain zostaje STARY token, przy
-- następnym uruchomieniu leci nim kolejny refresh, serwer widzi replay i
-- wylogowuje z komunikatem „Sesja wygasła”. Użytkownik nic złego nie zrobił.
--
-- `revokedReason` rozdziela trzy powody unieważnienia (ROTATED / LOGOUT /
-- REUSE), a `replacedByHash` łączy token z następcą wydanym przy jego
-- rotacji. Razem pozwalają rozpoznać zgubioną odpowiedź: stary token wraca
-- w oknie łaski, a jego następca jest NIETKNIĘTY — czyli para faktycznie nie
-- dotarła. Wtedy zamiast kasować rodzinę wydajemy świeżą parę.
--
-- Istniejące wiersze zostają z NULL-ami: nie wiemy, dlaczego zostały
-- unieważnione, więc idą starą ścieżką (kasowanie rodziny). To bezpieczny
-- domyślny wybór.
ALTER TABLE "RefreshToken" ADD COLUMN "revokedReason" TEXT;
ALTER TABLE "RefreshToken" ADD COLUMN "replacedByHash" TEXT;

CREATE INDEX "RefreshToken_replacedByHash_idx" ON "RefreshToken"("replacedByHash");
