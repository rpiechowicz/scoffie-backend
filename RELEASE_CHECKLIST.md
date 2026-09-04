# Scoffie — lista kontrolna wydań

Stan na 2.09.2026 (po audycie całości i planie naprawczym). Pozycje z dawnej
listy „1.0" są zamknięte i przeniesione niżej; otwarte punkty są uporządkowane
tak, jak plan naprawczy: najpierw to, co blokuje wpuszczenie obcych
użytkowników do asystenta, potem to, co blokuje subskrypcję.

## Zrobione (nie sprawdzać drugi raz)

- [x] Logowanie tylko przez Sign in with Apple; dev-login opt-in, na prod
      `AUTH_DEV_LOGIN_ENABLED=false` asertowane przy starcie
- [x] Rotacja refresh tokenów z wykrywaniem ponownego użycia, `POST /auth/logout`
- [x] APNs na fizycznym iPhonie (środowisko per urządzenie, fallback sandbox/prod)
- [x] Polityka prywatności i warunki w aplikacji + strona `docs/` w repo iOS
- [x] Usunięcie konta z aplikacji (`users:delete`) — od 2.09 bez utraty przepisów
      i planu innych domowników
- [x] Asystent: Fazy 0 i 1, hartowanie, karty z propozycjami, pamięć,
      ograniczenia domownika; ekran iOS wydany

## Przed wpuszczeniem obcych użytkowników do asystenta

- [ ] Railway: `WS_AUTH_MODE=strict` po dwóch odczytach metryk `legacy`
      w odstępie ≥ 1 h (DEPLOYMENT.md, „WebSocket auth rollout")
- [ ] Railway: `AI_CARDS_MODE=soft`, `AI_ALLOWED_USERS`, limity 30/6
      (DEPLOYMENT.md, „Assistant rollout")
- [ ] Kopia zapasowa Postgresa (Railway Backups) + niezależny zrzut do R2 + jedna próba odtworzenia na dev
- [ ] Rotacja hasła Postgresa (wyciek do transkryptu 28.08) — najpierw
      sprawdzić, czy `DATABASE_URL` serwisów to referencja, nie literał
- [ ] Limit wydatków i alert w konsoli Anthropic
- [ ] Polityka prywatności v2 (Anthropic, USA, dane o domownikach, Zdrowie,
      Cookidoo, retencja per kategoria, wiek 16+) — ta sama treść w aplikacji
      i na www; działający adres w App Store Connect
- [ ] Zgody: tabela zdarzeń, ekran zgody na asystenta przed pierwszą
      wiadomością, cofnięcie w Ustawieniach, deklaracja wieku
- [ ] iOS: „rozmawiasz z AI, może się mylić", „Zgłoś odpowiedź", polityka
      w Ustawieniach, manifest prywatności, chipy nowych alergenów
- [ ] Unieważnianie logowania Apple przy kasowaniu konta (zmienne `APPLE_*`
      PRZED merge)
- [ ] Sonda na `/ops/health` + Sentry + alert przy `AI_BUDGET_PAUSED`
- [ ] Po deployu alergenów 14 UE: `pnpm catalog:ingredients:tags` na prod
- [ ] `JWT_EXPIRES_IN` w godzinach po potwierdzeniu adopcji buildu z refreshem

## Przed subskrypcją (tylko na sygnał Rafała)

- [ ] Decyzje: per gospodarstwo, darmowy przydział, cena, Family Sharing
- [ ] Uprawnienia na serwerze i limity per plan; `GET /agent/usage`
- [ ] Weryfikacja zakupów (App Store Server Notifications), StoreKit 2, paywall
- [ ] App Store Connect: umowa Paid Apps, podatki, Small Business Program
- [ ] Regulamin v2 z zasadami subskrypcji i limitów

## Każde wydanie

- [ ] PR → `develop` z zielonym CI (lint, typy, build, unit, e2e)
- [ ] Nowe zmienne mają domyślną w kodzie i są ustawione na Railway PRZED
      merge do `main`
- [ ] Po deployu: `/ops/health` → `commit` = HEAD `main`,
      `/ops/metrics.migrations.latest` = ostatnia migracja w repo
- [ ] Jedna tura asystenta z telefonu kończy się kartą (tryb kart), plan nie
      zmienia się sam
