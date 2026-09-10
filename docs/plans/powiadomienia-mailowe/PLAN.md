# Powiadomienia mailowe — plan wdrożenia

Stan na 10.09.2026. Ustalenia produktowe, lista siedmiu szablonów i prompt do
Designu leżą w `docs/POWIADOMIENIA-MAILOWE.md` — tamten plik mówi CO wysyłamy
i dlaczego akurat to. Ten mówi JAK to zbudować i w jakiej kolejności.

## Decyzje z 10.09.2026

- **Dostawca: Resend.** Jedno żądanie HTTP (`POST https://api.resend.com/emails`),
  bez SDK — cienki klient na wstrzykiwanym `fetch`, dokładnie jak
  `OpsAlertService`. Dzięki temu cała ścieżka wysyłki testuje się bez sieci
  i bez klucza. Konsekwencja prawna: podmiot przetwarzający spoza EOG, więc
  polityka prywatności i `docs/rejestr-czynnosci-i-dpia.md` wymagają wpisu.
- **Zakres: infrastruktura + wszystkie siedem szablonów (A–G).**
- **Noc kończy się realną wysyłką** siedmiu maili na JEDEN adres — przez
  `MAIL_REDIRECT_TO`, nigdy do prawdziwych użytkowników.

## 1. Architektura

Skrzynka nadawcza w bazie (outbox) + robotnik w tle. Kod domeny NIGDY nie woła
Resendu w trakcie żądania.

```
zdarzenie domenowe            worker (co 15 s)              Resend
  |                              |                             |
  +-- enqueue(tx, {...}) ------> | claim QUEUED -> SENDING     |
      wiersz MailMessage         | render (html + text) -------+--> POST /emails
      w TEJ SAMEJ transakcji     | sukces -> SENT              |
                                 | blad  -> nextAttemptAt      |
                                 |          (1m/5m/30m/2h/6h)  |
                                 |          po 5 -> FAILED + alert
webhook Resendu ---------------> MailSuppression (odrzut, skarga)
```

**Dlaczego outbox, a nie wysyłka w miejscu zdarzenia:**

1. Kasowanie konta to JEDNA transakcja (`users.service.ts:552`). Mail wysłany
   przed nią wychodzi także wtedy, gdy transakcja padnie; wysłany po niej ginie,
   gdy padnie proces. Wiersz w tej samej transakcji rozwiązuje oba przypadki.
2. Resend ma prawo oddać 429 albo 503. Bez ponowień „witaj w Scoffie" po prostu
   nie dochodzi i nikt się o tym nie dowiaduje.
3. Deduplikacja. Apple potrafi przysłać to samo powiadomienie dwa razy,
   uzgadnianie subskrypcji chodzi co godzinę — bez klucza idempotencji
   ktoś dostaje trzy maile „subskrypcja wygasła".
4. Ślad. Przy reklamacji („nie dostałem") widać wiersz, status i odpowiedź
   dostawcy zamiast zgadywania z logów Railway.

Robotnik: `setInterval` + `unref` w `OnApplicationBootstrap`, jak
`SubscriptionsReconcileService` i `AgentRetentionService`. Jedna instancja
Railway, więc żadnego Redisa ani BullMQ — dokładanie ich tylko pod maile byłoby
nową infrastrukturą do utrzymania dla siedmiu szablonów.

## 2. Model danych (Prisma)

```prisma
model MailMessage {
  id        String     @id @default(uuid()) @db.Uuid
  /// Klucz idempotencji, np. `welcome:<userId>` albo `grace:<subId>:<txId>`.
  /// UNIQUE robi całą robotę: druga próba tego samego zdarzenia odbija się
  /// o bazę, zamiast wysyłać drugi mail.
  dedupeKey String     @unique
  template  String
  /// Adres SKOPIOWANY w chwili kolejkowania. Mail pożegnalny wychodzi po
  /// skasowaniu konta, więc nie wolno go czytać z relacji.
  to        String
  userId    String?    @db.Uuid
  payload   Json
  status    MailStatus @default(QUEUED)
  attempts  Int        @default(0)
  nextAttemptAt DateTime @default(now())
  lastError String?
  providerMessageId String?
  sentAt    DateTime?
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt

  /// SetNull, nie Cascade — kaskada skasowałaby mail pożegnalny w tej samej
  /// transakcji, w której go kolejkujemy.
  user User? @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([status, nextAttemptAt])
  @@index([userId])
}

enum MailStatus { QUEUED SENDING SENT FAILED SKIPPED }

/// Adresy, na które nie wysyłamy nigdy więcej: twardy odrzut albo skarga.
/// Klucz to adres pisany małymi literami — wyklucza też konto założone
/// od nowa na ten sam adres, i o to chodzi.
model MailSuppression {
  email     String   @id
  reason    String   // HARD_BOUNCE | COMPLAINT | MANUAL
  detail    String?
  createdAt DateTime @default(now())
}
```

**Retencja (RODO).** Wiersz niesie adres i nazwę wyświetlaną, czyli dane
osobowe, i ma przeżyć skasowanie konta. Sprzątanie w tym samym przebiegu co
wysyłka: po 30 dniach od `sentAt` czyścimy `to` i `payload`, zostawiając
`template`, `status` i daty jako dowód wysyłki. Po 12 miesiącach wiersz znika.

## 3. Moduł `src/mail/`

| Plik | Co robi |
|---|---|
| `mail.module.ts` | Spina; NIE importuje `src/agent/` (reguła jednokierunkowa) |
| `mail-outbox.service.ts` | `enqueue(client, {...})` — przyjmuje `tx` albo `prisma` |
| `mail-eligibility.ts` | Czysta funkcja: brak adresu / wykluczenie / `MAIL_ENABLED=false` → `SKIPPED` z powodem |
| `mail-worker.service.ts` | Pętla, claim, ponowienia, backoff, retencja, alert |
| `mail-backoff.ts` | Czysta funkcja `nextAttempt(attempts)` — osobno, bo testowalna bez zegara |
| `providers/resend.client.ts` | `fetch` wstrzykiwany; mapuje 4xx/5xx na „ponawiać czy nie" |
| `providers/stub.client.ts` | Zapisuje `var/mail/*.html` i loguje; domyślny poza produkcją |
| `mail-webhook.controller.ts` | `POST /mail/webhooks/resend`, podpis liczony z surowego ciała |
| `templates/layout.ts` | Wspólne klocki z Designu: nagłówek, stopka, przycisk, blok klucz–wartość, karta gospodarstwa, blok ostrzegawczy, kroki, zestawienie planów |
| `templates/<a-g>.ts` | Po jednym na szablon: `subject`, `preheader`, `html`, `text` |
| `templates/fixtures.ts` | Dane przykładowe i stany brzegowe — WSPÓLNE dla snapshotów i podglądu |
| `mail-preview.controller.ts` | `GET /ops/mail/preview[/:template]` za `OpsTokenGuard` |

Kopia (tematy, preheadery, treść) siedzi w `templates/`, tak jak kopia pushy
siedzi w `notification-copy.util.ts` — jedno miejsce, snapshoty w testach.

Każda podstawiana wartość przechodzi przez `esc()`. Nazwa gospodarstwa
i nazwa wyświetlana pochodzą od użytkownika; test z `<script>` w nazwie jest
w zestawie obowiązkowym.

## 4. Wyzwalacze — mapa na kod

| # | Szablon | Miejsce | Klucz deduplikacji |
|---|---|---|---|
| A | `WELCOME` | `users.service.ts:~255` (koniec onboardingu) | `welcome:<userId>` |
| B | `HOUSEHOLD_JOINED` | `households.service.ts:~365` (przyjęcie zaproszenia) | `joined:<invitationId>` |
| C | `AI_QUOTA_EXHAUSTED` | `agent-turns.service.ts:~395` (`AI_QUOTA_EXCEEDED`) | `quota:<zakres>:<okres>` |
| D | `SUBSCRIPTION_GRACE` | `subscriptions.service.ts` — przejście `ACTIVE → GRACE` | `grace:<subId>:<txId>` |
| E | `SUBSCRIPTION_EXPIRED` | to samo — `ACTIVE\|GRACE → EXPIRED\|REVOKED` | `expired:<subId>:<txId>` |
| F | `ACCOUNT_DELETED` | `users.service.ts:552`, W TRANSAKCJI, przed kasowaniem | `deleted:<userId>` |
| G | `LEGAL_UPDATE` | skrypt `scripts/enqueue-legal-update.ts`, odpalany ręcznie | `legal:<wersja>:<userId>` |

Szczegóły, które łatwo przeoczyć:

- **C** ma dwa stany (trial / opłacony plan) i wychodzi TYLKO do osoby, która
  wyczerpała pulę, nie do całego domu. `src/agent/` wolno zawołać `src/mail/`;
  odwrotnie nie (`no-restricted-imports`).
- **D/E**: statusy zapisuje kilka miejsc (`:461`, `:734`, `:828`, `:856`). Każde
  ma w ręku poprzedni stan (`existing`) i wie, czy zapis wszedł
  (`updateMany().count`) — kolejkujemy dopiero po udanym zapisie i tylko na
  PRZEJŚCIU, nigdy na „stan jest taki od tygodnia". `purchaserUserId` bywa
  `null` (konto skasowane) — wtedy nie ma adresata i nie ma maila.
- **F**: adres czytamy PRZED transakcją, wiersz wstawiamy `tx`-em w środku.
- **G**: skrypt bierze plik z podsumowaniem zmian (2–4 punkty) i wersją
  z `LEGAL_DOCUMENT_VERSIONS`; kolejkuje wszystkim z adresem. Odpalany
  z Railway, nigdy automatycznie przy deployu.

## 5. Konfiguracja

```
MAIL_ENABLED=false           # false = nic się nie kolejkuje (nie: kolejkuje i nie wysyła)
MAIL_TRANSPORT=stub          # stub | resend
RESEND_API_KEY=
MAIL_FROM="Scoffie <...>"    # do ustalenia — patrz sekcja 8
MAIL_REPLY_TO=
MAIL_REDIRECT_TO=            # niepuste = KAŻDY mail leci tu; prawdziwy adres w temacie
MAIL_WEBHOOK_SECRET=         # z panelu Resendu
MAIL_WORKER_INTERVAL_MS=15000
MAIL_MAX_ATTEMPTS=5
```

`MAIL_REDIRECT_TO` jest bezpiecznikiem, nie wygodą: bez niego pierwsza pomyłka
w środowisku deweloperskim wysyła maila prawdziwemu człowiekowi. Asercja przy
starcie: `NODE_ENV=production` z niepustym `MAIL_REDIRECT_TO` = odmowa startu.

## 6. Kolejność pracy w nocy

Każdy krok kończy się zieloną weryfikacją; następny startuje z czystego stanu.

1. Gałąź `feat/powiadomienia-mailowe` od `develop`, od razu `push -u`.
2. Modele i migracja (baza z `docker compose` stoi) + `pnpm prisma:generate`.
3. Rdzeń: typy, `mail-eligibility`, `mail-backoff`, outbox, klient `stub`,
   worker, moduł. Testy jednostkowe (backoff, claim, ponowienia, retencja).
4. Klient Resendu, webhook i wykluczenia. Wymaga włączenia surowego ciała
   żądania (`rawBody`) — weryfikacja podpisu liczy HMAC z BAJTÓW, nie
   z przeparsowanego JSON-a. Testy: wektory podpisu, 429 → ponów,
   422 → nie ponawiaj i wyklucz adres.
5. Layout i wspólne klocki z Designu → siedem szablonów (HTML + tekst + temat
   do 45 znaków + preheader). Snapshoty na każdy szablon i na stany brzegowe.
6. Podgląd `/ops/mail/preview` — wszystkie szablony i warianty w przeglądarce,
   bez wysyłki.
7. Podpięcie siedmiu wyzwalaczy, każdy ze swoim testem.
8. e2e `test/mail.e2e-spec.ts`: kasowanie konta zostawia wiersz F i przeżywa
   kaskadę; webhook wyklucza adres; `MAIL_ENABLED=false` nie kolejkuje nic.
9. `.env.example`, aktualizacja `docs/POWIADOMIENIA-MAILOWE.md` o runbook,
   notatka w `docs/handover/memory/`.
10. Pełna weryfikacja: `pnpm typecheck`, `pnpm test`, `pnpm lint:check`,
    `pnpm build`, e2e na żywej bazie.
11. Realna wysyłka: `pnpm mail:test <adres>` — siedem maili na jeden adres
    przez prawdziwego Resendu.
12. Commity porcjami po polsku, gałąź wypchnięta. PR otwierasz Ty (brak `gh`).

Jeśli któryś krok się zablokuje (np. design nie obejmuje szablonu G), robię
resztę do końca i zostawiam brakujący element opisany w PR — nie zwężam zakresu
po cichu.

## 7. Co dostarczasz Ty

1. **Design** — plik albo link do galerii siedmiu szablonów. Bez tego kroki 5–6
   stoją, a reszta (1–4, 7–10) idzie normalnie.
2. **Klucz Resendu** — `RESEND_API_KEY` do lokalnego `.env` (jest w gitignore).
   Na pierwszy test wystarczy nadawca z domeny testowej Resendu: wysyła
   wyłącznie na adres właściciela konta, więc realna wysyłka udaje się jeszcze
   przed DNS-em. Do wysyłki komukolwiek innemu trzeba już własnej,
   zweryfikowanej domeny.
3. **DNS na Cloudflare** (do wysyłki spod `scoffie.app`): rekordy DKIM i SPF
   z panelu Resendu plus `_dmarc` z `p=none` na start. Rekomendacja: nadawaj
   z korzenia `scoffie.app` — domena jest młoda i nie chodzi z niej żadna inna
   poczta, więc osobna subdomena tylko utrudniłaby rejestrację u Apple.
4. **Apple Developer** — „Sign in with Apple for Email Communication":
   zarejestrowana domena nadawcza i adresy nadawców. BEZ TEGO maile na aliasy
   `@privaterelay.appleid.com` się odbijają, a to znaczna część kont. SPF musi
   być na miejscu wcześniej, bo Apple je sprawdza przy weryfikacji.
5. **Adres nadawcy i Reply-To** — propozycja: `Scoffie <czesc@scoffie.app>`
   jako nadawca i `pomoc@scoffie.app` jako Reply-To, przekierowany przez
   Cloudflare Email Routing na Twoją skrzynkę. Adres, który nie przyjmuje
   odpowiedzi, jest sam w sobie sygnałem spamowym.
6. **Decyzja o CTA** — patrz sekcja 8, punkt „Otwórz Scoffie".
7. **Zmienne na Railway** przed merge do `main` (asercja sekretów przy starcie).

## 8. Otwarte, do rozstrzygnięcia

- **„Otwórz Scoffie" nie ma dokąd prowadzić.** iOS ma tylko schemat
  `scoffie://` (`Scoffie-Info.plist`), a Universal Links nie ma — w `scoffie-web`
  nie ma pliku `apple-app-site-association`. Gmail nie klika niestandardowych
  schematów, więc przycisk z `scoffie://` jest w połowie skrzynek martwy.
  Dwie drogi: (a) mała strona `/otworz` w `scoffie-web`, która próbuje schematu
  i spada do App Store — robię ją w nocy, nie wymaga Maca; (b) prawdziwe
  Universal Links — wymagają zmiany uprawnień w Xcode, czyli Maca. Proponuję
  (a) teraz, (b) przy najbliższym buildzie. Potrzebna Twoja decyzja i link do
  karty w App Store, jeśli już istnieje.
- **Zgoda `MARKETING`** — poza zakresem tej roboty. Siedem szablonów to maile
  transakcyjne dotyczące konta; dopóki nie dojdzie nowy rodzaj zgody, nic
  cyklicznego nie wysyłamy.
- **Wpis do polityki prywatności i rejestru czynności** o Resend jako podmiocie
  przetwarzającym poza EOG. Tekst przygotuję, publikacja na stronie po Twojej
  akceptacji.

## 9. Ryzyka

| Ryzyko | Co robię |
|---|---|
| Aliasy Apple odbijają się, bo domena nie jest zarejestrowana | Wykluczenia z webhooka i alert, gdy odrzutów przybywa; w runbooku wprost jako pierwsza rzecz do sprawdzenia |
| Podpis webhooka liczony ze złego ciała | Test na wektorach; endpoint odrzuca, gdy `rawBody` nie dojechało — cicha akceptacja byłaby gorsza |
| Mail do prawdziwych użytkowników z deweloperki | `MAIL_ENABLED=false` domyślnie, `MAIL_REDIRECT_TO` i asercja przy starcie |
| Zalew maili po włączeniu na prod | `MAIL_ENABLED=false` nie kolejkuje NIC — po włączeniu nie ma zaległej kolejki do wypchnięcia |
| Szablon renderuje się dobrze u mnie, źle w Gmailu | Podgląd i realna wysyłka na Twój adres; sprawdzenie w Gmailu i Apple Mail zostaje po Twojej stronie |
