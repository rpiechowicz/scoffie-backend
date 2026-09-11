# Powiadomienia mailowe

Stan na 11.09.2026. Wdrożone na gałęzi `feat/powiadomienia-mailowe`.
Plan i źródła projektu: `docs/plans/powiadomienia-mailowe/`.
Kod: `src/mail/`. Podgląd: `pnpm mail:preview`. Próba: `pnpm mail:test <adres>`.

## Ograniczenia wynikające z kodu

- **Nie ma haseł.** `AuthProvider` = `GOOGLE | APPLE | DEV`, w modelu `User` nie
  ma pola hasła. Odpada reset hasła, „hasło zmienione", „nowe logowanie".
- **`email String?` jest opcjonalny**, `emailVerified` domyślnie `false`. Część
  kont nie ma adresu w ogóle, a przy Sign in with Apple bywa to alias
  `@privaterelay.appleid.com`.
- **Private Relay wymaga rejestracji domeny nadawczej** w Apple Developer
  (Sign in with Apple for Email Communication). Bez tego maile do aliasów się
  odbijają. To warunek wstępny całej roboty, nie detal.
- **Zaproszenia to celowo anonimowe linki.** Komentarz w modelu `Invitation`
  wprost odrzuca zapraszanie mailem, bo zapraszający nie zna adresu relay.
  Maila z zaproszeniem nie robimy.
- **Kasowanie konta jest natychmiastowe** — jedna transakcja w
  `users.service.ts:552`, bez karencji i bez soft-delete. Nie ma czego
  anulować, więc mail musi wyjść PRZED transakcją i nie może mieć przycisku
  „cofnij".
- **`identityHash` przeżywa skasowanie konta** — pula próbna i subskrypcja wiszą
  na nim, więc założenie konta od nowa nie da nowego triala. Trzeba to napisać
  wprost w mailu pożegnalnym.
- **Płatności są po stronie Apple.** Apple sam wysyła paragony i przypomnienia
  o odnowieniu; nasze maile mówią wyłącznie o skutkach w aplikacji.
- **Nie ma zgody marketingowej.** `CONSENT_KINDS` to `TERMS, PRIVACY,
  AI_ASSISTANT, COOKIDOO, AGE_16, HEALTH_DATA`. Żadnych newsletterów ani
  podsumowań tygodnia, dopóki nie dojdzie nowy rodzaj zgody.
- **Push już działa** (APNs, cisza nocna, batching). Mail ma robić to, czego
  push nie potrafi: docierać, gdy apki nie ma pod ręką, i nieść link.

## Siedem szablonów i ich wyzwalacze

| # | Mail | Wyzwalacz |
|---|---|---|
| A | Witaj w Scoffie | `User.onboardingCompletedAt` ustawione, `email` niepuste |
| B | Witaj w gospodarstwie | `Invitation.redeemedAt` — do osoby dołączającej |
| C | Limit asystenta wyczerpany | `AiUsageCounter` dobił do puli (dwa stany: trial / plan) |
| D | Problem z płatnością | `SubscriptionStatus` → `GRACE` (PRO wciąż działa) |
| E | Subskrypcja wygasła | `SubscriptionStatus` → `EXPIRED` / `REVOKED` |
| F | Konto usunięte | przed transakcją w `deleteAccount` |
| G | Zmiana regulaminu lub polityki | podbicie daty w `LEGAL_DOCUMENT_VERSIONS` |

Odrzucone świadomie:

- **Potwierdzenie adresu e-mail** — logowanie idzie przez Sign in with Apple,
  własnego adresu się nie wpisuje, więc nie ma czego weryfikować.
- **„Ktoś dołączył do gospodarstwa" do właściciela** — to on wysłał link, wie,
  że zadziałał.
- **„Dane gotowe do pobrania"** — `data-export` jest dziś synchroniczne
  (`@Get`). Wróci, gdy eksport stanie się zadaniem w tle z linkiem.
- **Wyjście z domu, usunięcie członka, zmiana roli** — zostają na pushu, bo przy
  tych zdarzeniach człowiek i tak jest w aplikacji.

## Stan wdrożenia

Szablonów jest OSIEM, nie siedem: „limit asystenta" ma dwa niezależne stany
(pula próbna i pula w opłaconym planie), a każdy z nich jeszcze rozróżnia,
KTÓRY licznik padł — wiadomości i zapisy planu to dwa osobne liczniki i dwa
różne błędy (`AI_QUOTA_EXCEEDED`, `AI_PLAN_QUOTA_EXCEEDED`).

| Szablon | Identyfikator | Wyzwalacz w kodzie | Klucz deduplikacji |
|---|---|---|---|
| A | `WELCOME` | `users.service.ts` — pierwsze domknięcie onboardingu | `welcome:<userId>` |
| B | `HOUSEHOLD_JOINED` | `households.service.ts` — przyjęcie zaproszenia | `joined:<invitationId>` |
| C1 | `AI_TRIAL_EXHAUSTED` | `agent-quota-mail.service.ts` (pula próbna) | `trial-quota:<zakres>:<licznik>` |
| C2 | `AI_QUOTA_EXHAUSTED` | `agent-quota-mail.service.ts` (opłacony plan) | `quota:<zakres>:<okres>:<userId>:<licznik>` |
| D | `SUBSCRIPTION_GRACE` | `subscriptions.service.ts` — przejście do `GRACE` | `grace:<subId>:<txId>` |
| E | `SUBSCRIPTION_EXPIRED` | to samo — przejście do `EXPIRED`/`REVOKED` | `expired:<subId>:<txId>` |
| F | `ACCOUNT_DELETED` | `users.service.ts` — W TRANSAKCJI kasującej konto | `deleted:<userId>` |
| G | `LEGAL_UPDATE` | ręcznie, przy publikacji nowej wersji dokumentów | `legal:<wersja>:<userId>` |

### Co treść musiała zmienić wobec makiety

Audyt szablonów wobec kodu (10.09.2026) wywrócił kilka zdań, które brzmiały
dobrze, ale nie miały pokrycia:

- **A nie każe zakładać domu.** Gospodarstwo powstaje w OSTATNIM kroku kreatora
  w iOS, a `completeOnboarding` stempluje się dopiero po nim — w chwili wysyłki
  dom już stoi, a drugi kończy się `HOUSEHOLD_ALREADY_MEMBER`.
- **B nie obiecuje prywatnych przepisów.** W modelu ich nie ma: przepis należy
  do GOSPODARSTWA, a widzą go wszyscy domownicy. Nie obiecuje też dodawania
  pozycji do listy zakupów — lista liczy się wyłącznie z planu.
- **C2 ma dwa warianty.** Pula wisi na `sub:<id>`, czyli na UMOWIE wspólnej dla
  domu; adresatem bywa domownik, który niczego nie opłaca i dla którego
  przycisk „Zmień plan" byłby martwy.
- **D nie podaje ceny.** `Subscription` nie przechowuje kwoty ani waluty.
  Nie zmyśla też daty końca łaski — `graceExpiresAt` bywa `null`.
- **E nie mówi „PRO".** To nazwa poziomu w kodzie; użytkownik widzi „plan Solo"
  i ekran „Asystent i plan". Ręczne układanie planu NIGDY nie miało limitu.
- **F nie twierdzi, że przepisy zniknęły.** `deleteAccount` przepisuje je na
  konto bota katalogu i zostawia w gospodarstwie. Mail mówi też o subskrypcji,
  która PRZEŻYWA skasowanie konta i dalej pobiera opłaty w App Store.
- **G ma punkty zmian jako parametr**, nie w kodzie, i osobne zdanie na wypadek
  zmiany wymagającej ponownej zgody.

## Jak to działa

Skrzynka nadawcza w bazie (`MailMessage`) + robotnik w tle
(`MailWorkerService`, `setInterval` z `unref`, jak `SubscriptionsReconcileService`).
Kod domeny NIGDY nie woła dostawcy w trakcie żądania — wstawia wiersz, najlepiej
w tej samej transakcji co zmiana, którą mail opisuje.

Trzy rzeczy, które z tego wynikają i których nie da się osiągnąć inaczej:

1. **Pożegnanie przeżywa transakcję kasującą konto.** Wiersz idzie `tx`-em
   w środku, a `MailMessage.userId` jest `SetNull` — kaskada go nie zabiera.
   Dowód na żywych kluczach: `test/mail.e2e-spec.ts`.
2. **Deduplikacja przez UNIQUE + `createMany({ skipDuplicates: true })`.**
   NIE `create` z łapaniem `P2002`: w Postgresie naruszenie unikatu unieważnia
   CAŁĄ transakcję, więc druga próba usunięcia konta wywróciłaby operację,
   którą mail miał tylko opisać.
3. **Ponowienia z narastającą zwłoką** (1 min → 5 → 30 → 2 h → 6 h) i drugą
   linią obrony w postaci `Idempotency-Key` u dostawcy — na wypadek, gdyby
   odpowiedź zgubiła się PO wysłaniu.

Odrzuty i skargi wracają webhookiem (`POST /mail/webhooks/resend`) i lądują
w `MailSuppression`. Podpis liczy się z SUROWEGO ciała (`rawBody: true`
w `main.ts`) — przeparsowany JSON daje inny HMAC.

Retencja: 30 dni po wysyłce z wiersza znika adres, temat i `payload`, zostaje
sam dowód nadania; po roku znika wiersz. Wiersz przeżywa konto, więc bez tego
trzymałby dane osoby, której u nas już nie ma.

## Runbook

- **Podgląd bez wysyłki:** `pnpm mail:preview` → `var/mail-preview/index.html`
  (18 stanów × 600 i 320 px + wersje tekstowe). Tryb ciemny sprawdzasz,
  przełączając motyw systemu.
- **Próba na żywym dostawcy:** `MAIL_TRANSPORT=resend RESEND_API_KEY=…
  pnpm mail:test <adres> [klucz-stanu]`. Adres podaje się W POLECENIU — skrypt
  nigdy nie czyta odbiorców z bazy.
- **Włączenie na produkcji:** `MAIL_ENABLED=true`, `MAIL_TRANSPORT=resend`,
  `RESEND_API_KEY`, `MAIL_WEBHOOK_SECRET`. `MAIL_REDIRECT_TO` musi być PUSTE —
  niepuste wywraca start (asercja w `assert-env.ts`).
- **Kolejka stoi?** `SELECT status, count(*) FROM "MailMessage" GROUP BY 1;`
  Wiersze `FAILED` mają powód w `lastError`; alert idzie na
  `OPS_ALERT_WEBHOOK_URL` raz na szablon.
- **Pusta ramka zamiast znaku w Apple Mail, choć adres obrazka odpowiada 200**
  = obrazek stoi za Cloudflare, a Bot Fight Mode (Static Resource Protection)
  odbija proxy prywatności Apple. Dlatego znak leci z `api.scoffie.app/static/`
  (Railway, bez Cloudflare). Nie przestawiać `MAIL_ASSET_BASE_URL` na
  `scoffie.app`, dopóki w Cloudflare nie ma wyjątku dla `/email/*`.
- **Nagły wysyp odrzutów z `@privaterelay.appleid.com`** = domena nadawcza
  wypadła z rejestru „Sign in with Apple for Email Communication". To pierwsza
  rzecz do sprawdzenia; alert `mail-relay-bounce` mówi o tym wprost.

## Zanim pierwszy mail pójdzie do użytkownika

1. **Deploy `scoffie-web`.** Maile linkują do `/otworz` (most do aplikacji,
   bo Universal Links nie ma) i ładują znak z `/email/scoffie-mark.png`.
   Do czasu deployu jedno daje 404, drugie pustą ramkę w nagłówku.
2. **Webhook w panelu Resendu** na `https://api.scoffie.app/mail/webhooks/resend`,
   sekret do `MAIL_WEBHOOK_SECRET`.
3. **Wpis do polityki prywatności i rejestru czynności** o Resend jako podmiocie
   przetwarzającym. Region: Irlandia (eu-west-1), czyli dane zostają w EOG.
4. **Zmienne na Railway PRZED merge do `main`** — asercja sekretów przy starcie.

## Świadomie poza zakresem

- **Zgoda `MARKETING`.** Osiem stanów to wiadomości o koncie. Dopóki nie dojdzie
  nowy rodzaj zgody, nic cyklicznego nie wychodzi — i dlatego w stopce nie ma
  „wypisz się", tylko zdanie, dlaczego ta wiadomość przyszła.
- **Mail z zaproszeniem.** Zaproszenia są celowo anonimowymi linkami;
  zapraszający nie zna adresu relay.
- **Potwierdzenie adresu.** Logowanie idzie przez Sign in with Apple, własnego
  adresu się nie wpisuje.
- **„Dane gotowe do pobrania".** `data-export` jest dziś synchroniczny.

## Źródła projektu

Makieta z Claude Design (kit i szablony) leży w
`docs/plans/powiadomienia-mailowe/design/`. To ŹRÓDŁO TREŚCI, nie kodu —
implementacja w `src/mail/templates/` różni się od niej wszędzie tam, gdzie
audyt pokazał rozjazd z kodem (patrz „Co treść musiała zmienić wobec makiety").
