---
name: Poczta transakcyjna — skrzynka nadawcza
description: Osiem maili o koncie, skrzynka nadawcza w bazie, pułapki wyzwalaczy i kolejność włączania na prod
type: project
originSessionId: cf5b81ba-7cdf-47f4-bc17-28cc40b2cb6f
---

Fakt: Od 11.09.2026 backend ma pocztę transakcyjną (`src/mail/`) — osiem stanów
wiadomości o koncie, skrzynka nadawcza w bazie (`MailMessage`) i robotnik
w tle. Gałąź `feat/powiadomienia-mailowe`; strona-most `/otworz` w osobnej
gałęzi `feat/strona-otworz` w `scoffie-web`. Dokument operacyjny:
`docs/POWIADOMIENIA-MAILOWE.md`.

**Why:** Push nie dociera, gdy apki nie ma pod ręką, i nie niesie linku. Mail
robi to, czego push nie potrafi — ale wysyłka w trakcie żądania nie przeżyłaby
ani kasowania konta (jedna transakcja), ani 429 od dostawcy, ani zdublowanego
powiadomienia od Apple.

**How to apply:**

- **Kolejkuje się przez `MailOutboxService.enqueue(client, …)`**, gdzie `client`
  to `prisma` ALBO klient transakcji. Wstawka idzie przez
  `createMany({ skipDuplicates: true })`, nigdy `create` z łapaniem `P2002`:
  w Postgresie naruszenie unikatu unieważnia CAŁĄ transakcję, a pożegnanie
  kolejkuje się w środku transakcji kasującej konto.
- **Trzy pułapki wyzwalaczy**, każda kosztowała osobne przemyślenie:
  1. Pożegnanie — `tx`-em w środku transakcji, adres czytany PRZED nią,
     `MailMessage.userId` jest `SetNull` (nie kaskadą).
  2. Wyczerpana pula — mail dopiero PO wyjściu wyjątku 429, bo kwota schodzi
     w transakcji, którą odmowa wycofuje.
  3. Subskrypcja — tylko na PRZEJŚCIU statusu i tylko po udanym zapisie
     (`updateMany` ze strażnikiem kolejności przegrywa cicho).
- **Poczta jest wszędzie `@Optional()`** — testy jednostkowe budują serwisy bez
  niej. Nowy serwis wołający `enqueue` = nowy stub w spec-u, inaczej Nest nie
  rozwiąże zależności (zdarzyło się w trzech spec-ach propozycji).
- **`MAIL_ENABLED=false` nie kolejkuje NIC** (nie „kolejkuje i nie wysyła"),
  żeby włączenie na prod nie wypchnęło zaległych powitań.
- **Przed pierwszym mailem do użytkownika**: deploy `scoffie-web` (bo `/otworz`
  i znak `email/scoffie-mark.png` żyją tam), webhook w panelu Resendu na
  `https://api.scoffie.app/mail/webhooks/resend`, zmienne na Railway PRZED
  merge do `main`.

**Czego NIE robić:** nie ufać makiecie maila jako źródłu faktów. Audyt
10.09.2026 (50 agentów, wszystko z dowodem `plik:linia`) wywrócił kilkanaście
zdań — m.in. „załóż dom" w powitaniu (dom powstaje w ostatnim kroku kreatora
iOS), „prywatne przepisy zostają Twoje" (prywatnych przepisów nie ma) i
„prywatne przepisy zostały usunięte" w mailu o RODO (`deleteAccount` przepisuje
je na bota katalogu). Każda nowa treść maila = ponowne sprawdzenie w kodzie.
