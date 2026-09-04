# Subskrypcje PRO — jak to działa i dlaczego tak

Dokument operacyjny: co jest w kodzie, jakie zagrożenia zamyka, co trzeba
ustawić przed sprzedażą. Cennik i skąd wzięły się limity — osobno, w
`docs/plans/scoffie-ai-agent/cennik-i-limity-2026-09.md` §16–19.

**Nazewnictwo.** `PRO` jest nazwą WEWNĘTRZNĄ poziomu (płatny kontra próbny):
enum w bazie, pole `tier` w odpowiedzi serwera, `AI_TIER_OVERRIDE`. Człowiek
tego słowa nie widzi nigdzie. Kupuje **Solo**, **We dwoje** albo **Rodzina** i
tak nazywa się to na paywallu, na ekranie limitów i w komunikatach o
wyczerpanej puli. Przycisk otwierający paywall to „Wybierz plan".

---

## 1. Dwie decyzje, na których stoi całość

### „Uprawnienie się WYLICZA, nie zapisuje"

Nigdzie w bazie nie ma pola „to gospodarstwo ma PRO". Przy każdym żądaniu
`AiUsageCountersService.resolvePlan` pyta: _czy któryś z obecnych domowników ma
teraz żywą subskrypcję?_ — i odpowiada od zera.

Pierwsza wersja projektu robiła inaczej: `HouseholdSubscription` z kluczem
głównym `householdId`. Cztery niezależne testy obalające wskazały tę samą wadę.
Zdarzeń, które takie przypisanie PSUJĄ, jest sześć — wyjście z domu, usunięcie
członka, skasowanie konta, sprzątnięcie pustego domu, przyjęcie zaproszenia,
przegrana w regule „wyższy limit wygrywa". Miejsc, które je NAPRAWIAJĄ, były
dwa, i żadne nie leżało na ścieżce, którą naprawdę chodzi człowiek (założenie
własnego domu). Wynik: **płacę Apple i nie mam asystenta, i nie ma przycisku,
który by to odkręcił.**

Wyliczanie usuwa całą tę klasę błędów naraz. Nie ma czego przypiąć, więc nie ma
czego zgubić.

### „Pula należy do UMOWY, nie do domu"

`AiUsageCounter.scopeId` to teraz:

| źródło PRO                            | zakres licznika           | dlaczego                                              |
| ------------------------------------- | ------------------------- | ----------------------------------------------------- |
| subskrypcja                           | `sub:<id>`                | wędruje z płatnikiem — przeprowadzka nie odnawia puli |
| pula próbna                           | `trial:<hasz tożsamości>` | jedna na życie OSOBY, nie domu                        |
| nadanie operatora, `AI_TIER_OVERRIDE` | UUID domu                 | nadanie nigdzie nie wędruje                           |

Bez tego jedna opłata za 29,99 zł dawała 30 wiadomości **w każdym odwiedzonym
domu**: kup Solo, wypal pulę, wyjdź z domu, załóż nowy, powtórz. Trzy kliknięcia
w aplikacji, zero łamania regulaminu.

**Okres też należy do umowy** (decyzja Rafała, 4.09.2026). `AiUsageCounter.periodKey`:

| źródło PRO                            | okres                   | odnawia się                          |
| ------------------------------------- | ----------------------- | ------------------------------------ |
| subskrypcja                           | `okres:<YYYY-MM-DD>`    | w dniu odnowienia u Apple (15.09 → 15.10) |
| pula próbna                           | `trial`                 | nigdy — jedna na życie osoby         |
| nadanie operatora, `AI_TIER_OVERRIDE` | `YYYY-MM`               | pierwszego dnia miesiąca UTC         |

Data w kluczu to `expiresAt` z Apple, czyli koniec opłaconego okresu. To jedyna
data, która przesuwa się DOKŁADNIE przy odnowieniu, więc nowa wartość sama
otwiera nową pulę — bez crona i bez pilnowania, kiedy „minął miesiąc". W łasce
płatniczej `expiresAt` stoi w miejscu, więc przeterminowana karta nie daje
świeżej puli, tylko resztę tej opłaconej.

---

## 2. Odpowiedzi na dwa pytania, od których się zaczęło

### „User ma Solo i zaprasza domownika — czy domownik ma asystenta?"

**Ma. Od razu, w pełni, bez kupowania czegokolwiek i bez żadnej akcji ze strony
płatnika.** Pula (30 wiadomości i 8 zapisów planu przy Solo) jest WSPÓLNA dla
całego domu — dokładnie tak, jak wspólny jest plan tygodnia i lista zakupów,
które ten asystent układa.

Dlaczego nie „domownik musi dokupić":

- Produkt jest wspólny. Asystent układa JEDEN plan dla JEDNEGO domu. Sprzedawać
  drugi dostęp do tej samej rzeczy to sprzedawać powietrze.
- Nazwy planów już to mówią. „We dwoje" i „Rodzina" różnią się WYŁĄCZNIE
  wielkością puli, bo liczba osób jest etykietą zużycia, a nie bramką na
  miejsca. Blokowanie domownika przeczyłoby własnemu cennikowi.
- Bramka na miejsca zniechęcałaby do dodania alergicznego dziecka jako
  domownika — a wtedy twarda bramka alergenowa przestaje je widzieć. To ryzyko
  zdrowotne, nie handlowe.
- Wyczerpana pula egzekwuje się sama: pięcioosobowy dom na planie Solo skończy
  wiadomości w tydzień i zobaczy ekran „Zwiększ limit". To lepszy moment na
  sprzedaż niż komunikat „nie możesz zaprosić żony".

Co widzi domownik: asystent działa normalnie, licznik pokazuje wspólną pulę,
paywalla nie ma, przycisku „Zarządzaj subskrypcją" też nie (bo nie on płaci).

Co się dzieje, gdy płatnik wychodzi z domu: dom traci PRO w tej samej sekundzie
i wraca na to, co ma sam — pulę próbną albo własną subskrypcję. Płatnik zabiera
swoje PRO ze sobą razem z niewykorzystaną pulą.

Dwie subskrypcje w jednym domu: wygrywa ta o wyższym limicie. Druga nie ginie —
leży nieużywana u swojego płatnika i odżywa, gdy ten się wyprowadzi. Nie sumujemy
pul, bo suma zachęcałaby do kupowania Solo „na głowę" zamiast Rodziny.

### „Ktoś użyje darmowej próby, usunie konto i zarejestruje się od nowa"

Nie dostanie nowej próby. Pula próbna nie wisi na koncie ani na domu, tylko na
**haszu tożsamości zakupowej**: HMAC-SHA256 z `authProvider:sub` i pieprzu
serwera. Apple wydaje ten sam `sub` temu samemu człowiekowi w tej samej
aplikacji na zawsze, więc po skasowaniu konta i ponownym zalogowaniu hasz jest
ten sam — a licznik `trial:<hasz>` leży nietknięty, bo `AiUsageCounter` nie ma
klucza obcego do użytkownika i nie ginie kaskadą.

Ten sam mechanizm działa w drugą stronę i to jest jego druga zaleta: **kto miał
opłacone PRO, skasował konto i wrócił, odzyskuje subskrypcję automatycznie.**
Apple pobiera pieniądze niezależnie od tego, czy konto u nas istnieje, więc
utrata dostępu byłaby po prostu kradzieżą.

Dlaczego hasz, a nie sam `appleSub`: człowiek, który poprosił o usunięcie
danych, nie ma prawa zostawić u nas swojego identyfikatora Apple. Z 64 znaków
heksadecymalnych nie da się go odtworzyć, a do rozpoznania tej samej osoby
wystarczą. To pseudonimizacja — dalej dane osobowe, opisane w §6.

**Pieprz `PURCHASE_IDENTITY_PEPPER` jest NIEROTOWALNY.** Zmiana przestawia
wszystkie hasze: każdy dostaje świeżą próbę, a każda opłacona subskrypcja
przestaje pasować do właściciela. Rotacja = migracja danych.

---

## 3. Bramka pieniężna

Wszystko, co nadaje PRO, przechodzi przez `src/billing/apple-jws.verifier.ts`.

1. **Algorytm.** Tylko `ES256`. Bez tego `alg: none` albo podmiana na HMAC
   z certyfikatem w roli sekretu przechodzi jako prawdziwy podpis Apple.
2. **Łańcuch `x5c` do przypiętego korzenia.** Napastnik podpisuje własny ładunek
   własnym kluczem i wkłada własny certyfikat do nagłówka; kod, który bierze
   klucz „z liścia", przyjmie to jako prawdę. Korzeń (Apple Root CA - G3) jest
   wpisany w kodzie, nie pobierany z sieci — pobieranie znaczyłoby, że przejęcie
   tego połączenia przejmuje weryfikację zakupów. Sprawdzamy ważność w czasie,
   podpis każdego ogniwa przez następne, zgodność wystawcy i odcisk korzenia.
3. **Zero odczytu bez weryfikacji.** `decodeJwt` i `decodeProtectedHeader` z
   `jose` są zablokowane regułą ESLint poza testami.
4. **Czy to w ogóle nasze.** `bundleId` musi być nasz (podpis Apple pod cudzą
   transakcją jest równie prawdziwy), `environment` musi się zgadzać (sandbox
   nie daje PRO na produkcji — inaczej każdy z TestFlightem ma darmowe PRO).
5. **Telefon to tylko WSKAZÓWKA.** Zweryfikowana transakcja mówi wyłącznie
   „sprawdź tę subskrypcję". Stan bierzemy z App Store Server API, bo transakcja
   nic nie wie o zwrocie pieniędzy sprzed godziny.
6. **Nie przejmiesz cudzej.** `originalTransactionId` jest unikalny; zgłoszenie
   z konta o innym haszu tożsamości dostaje 409, a nie przepięcie.
7. **`appAccountToken` musi wskazywać zgłaszającego.** Telefon wkłada w zakup
   UUID konta, a Apple go podpisuje — to jedyny dowód, kto naprawdę klikał
   „Kup". Bez tego sprawdzenia podpisana transakcja, która komuś wyciekła,
   należałaby do tego, kto zgłosi ją pierwszy; prawowity właściciel dostawałby
   potem `BILLING_TRANSACTION_TAKEN` i nie miał jak tego odkręcić bez obsługi.
8. **Chmura Rodzinna jest odrzucana** (`BILLING_FAMILY_SHARING_UNSUPPORTED`),
   dopóki `APPLE_ACCEPT_FAMILY_SHARED` nie powie inaczej. Powód niżej, w §7.

**Poprawka z 4.09.2026, warta zapamiętania.** Weryfikator owijał klucz publiczny
z liścia w `createPublicKey()`. Ta funkcja przyjmuje z `KeyObject` wyłącznie
klucz PRYWATNY, więc rzucała `ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE`, a wyjątek
wpadał w `catch` obok i zamieniał się w „podpis się nie zgadza". Skutek: KAŻDY
prawdziwy podpis Apple kończył się `BILLING_TRANSACTION_INVALID`. Paywall
pobierałby pieniądze i nie potwierdził ani jednego zakupu, a z zewnątrz
wyglądałoby to na awarię App Store. Nie widział tego żaden test, bo wszystkie
odrzucały token WCZEŚNIEJ — na algorytmie, łańcuchu albo korzeniu — i do tej
linii nigdy nie docierały. Stąd `apple-jws.verifier.positive.spec.ts`: własny
łańcuch (korzeń P-384, pośredni i liść P-256), prawdziwy podpis ES256 i
przypięcie własnego korzenia przez `rootPem`. **Test, który tylko odrzuca, nie
dowodzi niczego o przyjmowaniu.**

Odcisk korzenia do sprawdzenia własnoręcznie:

```
curl -sO https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
openssl x509 -in AppleRootCA-G3.cer -inform DER -fingerprint -sha256 -noout
# 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
```

---

## 4. Powiadomienia Apple i uzgadnianie

`POST /billing/apple/notifications` — bez `JwtAuthGuard` (to Apple woła) i z
`@SkipThrottle()`. Globalny limiter liczy po adresie IP, a odbicie
powiadomienia 429-tką wygląda dla Apple jak awaria: ponowi pięć razy przez trzy
doby, potem przestanie i zdarzenie przepadnie na zawsze.

Kolejność: **zweryfikuj podpis → zapisz surowy ładunek → przetwórz →
odpowiedz 200.** Deploy w złej sekundzie kosztuje wtedy jedno ponowienie, a nie
utratę zdarzenia.

Trzy rzeczy, których przetwarzanie celowo NIE robi:

- **Nie mapuje `notificationType` na stan.** Typ idzie tylko do dziennika; stan
  bierze się z podpisanych danych w ładunku. Nowy albo nieznany typ nigdy nikogo
  nie odetnie.
- **Nie cofa nowszego stanu.** Zdarzenie starsze niż `lastNotificationAt` jest
  odnotowywane i pomijane — po awarii u Apple powiadomienia przychodzą nie po
  kolei.
- **Nie zgaduje właściciela.** Zdarzenie o nieznanej subskrypcji leży zapisane
  i doczeka się zgłoszenia z telefonu.

`SubscriptionsReconcileService` co godzinę ponawia nieprzetworzone zdarzenia
i odświeża subskrypcje niesprawdzane od `APPLE_RECONCILE_AFTER_HOURS`. Przy
awarii Apple przebieg **nic nie zmienia** — lepiej dać dzień PRO za darmo niż
odciąć płacącego przez cudzą awarię.

---

## 5. Panel operatora (`x-ops-token`)

| endpoint                                                                  | do czego                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /ops/billing/subscriptions?userId=…` albo `?originalTransactionId=…` | „zapłaciłem i nie mam PRO"                                  |
| `POST /ops/billing/subscriptions/:id/reconcile`                           | wymuszone uzgodnienie z Apple                               |
| `POST /ops/billing/subscriptions/:id/revoke`                              | odebranie dostępu po zwrocie, gdy powiadomienie nie doszło  |
| `POST /ops/billing/subscriptions/:id/unhold`                             | zdjęcie ręcznej blokady i natychmiastowe uzgodnienie        |
| `GET /ops/billing/notifications/failed`                                  | zdarzenia Apple, których nie udało się przetworzyć          |
| `GET /ops/billing/subscriptions/:id/usage`                                | „ile mi zostało" przez wsparcie                             |
| `POST /ops/billing/grant`                                                 | konto recenzenta App Store, rekompensata, rodzina testująca |
| `POST /ops/billing/households/:id/cost-reset`                             | zwolnienie sufitu kosztu, który odciął płacącego            |
| `POST /ops/billing/sweep`                                                 | cały przebieg uzgadniania od ręki                           |

Sufit `AI_HOUSEHOLD_MONTHLY_COST_USD` jest bezpiecznikiem przed pętlą błędów, a
nie limitem sprzedanym klientowi — dlatego musi mieć przycisk zwalniający.

**Odebranie dostępu zostawia TRWAŁĄ blokadę** (`Subscription.operatorHoldAt`).
Do 4.09.2026 ustawiało tylko `status` i `revokedAt` — czyli dokładnie te pola,
które przepisuje każde uzgodnienie z Apple i każde zgłoszenie z telefonu.
Klient odzyskiwał dostęp naciskając „Przywróć zakupy", a obsługa nie miała jak
się o tym dowiedzieć. Blokady nie czyści nic poza `…/unhold`.

**Nadanie ręczne sprawdza, do kogo trafia.** Wcześniej przyjmowało dowolny napis
jako hasz: literówka dawała 201 z identyfikatorem wiersza i nie robiła NIC, bo
`resolvePlan` szuka po haszach domowników. Teraz wygodniej podać `userId`
(serwer policzy hasz sam); nadanie na hasz bez konta wymaga `force: true`.

---

## 6. RODO

Nowe dane: `User.identityHash` (pseudonim), `Subscription` (produkt, status,
daty, środowisko), `AppleNotification` (surowe zdarzenia Apple).

- **Podstawa dla subskrypcji:** wykonanie umowy (art. 6 ust. 1 lit. b).
- **Podstawa dla `identityHash`:** prawnie uzasadniony interes (art. 6 ust. 1
  lit. f) — zapobieganie nadużyciu darmowej próby i odtworzenie opłaconego
  świadczenia po powrocie na konto.
- **To jedyny ślad, który zostaje po usunięciu konta.** Musi być wymieniony
  w polityce prywatności i w odpowiedzi na żądanie z art. 15.
- **Eksport (art. 15)** zawiera subskrypcje tej osoby — bez hasza, bo hasz jest
  naszym kluczem wewnętrznym i jego wydanie ułatwiałoby powiązanie danych
  z kontem, którego już nie ma.
- **Usunięcia konta NIE blokujemy** przy żywej subskrypcji (App Store 5.1.1(v),
  RODO art. 17). Zostaje ostrzeżenie w logu: człowiek dalej płaci Apple.
- **Danych karty ani adresu nie widzimy nigdy** — płatność w całości po stronie
  Apple.

---

## 7. Czego jeszcze NIE ma

- **Zakup w aplikacji jest wyłączony** (`SubscriptionCatalog.purchasesEnabled =
false` w iOS). Paywall pokazuje ofertę i nie pobiera pieniędzy.
- **Chmura Rodzinna jest ODRZUCANA w kodzie**, nie tylko wyłączona w App Store
  Connect. Wcześniejszy komentarz mówił, że „pula i tak jest jedna na umowę,
  więc strata jest zerowa" — to była nieprawda. Przy Chmurze Rodzinnej KAŻDY
  członek rodziny dostaje własną transakcję z własnym `originalTransactionId`,
  a `originalTransactionId` jest unikalny: powstaje osobny wiersz, osobne
  `sub:<id>` i osobna PEŁNA pula. Sześć osób na jednej opłacie 29,99 zł to
  sześciokrotny rachunek u dostawcy modelu przy jednym przychodzie.
  `APPLE_ACCEPT_FAMILY_SHARED=true` włącza to świadomie; wtedy w logu leci
  ostrzeżenie przy każdym takim wierszu.
- ~~Okres kwoty to miesiąc kalendarzowy UTC~~ — **zrobione 4.09.2026, decyzja
  Rafała.** Pula idzie za UMOWĄ: kupione 15.09 odnawia się 15.10, a nie 1.10.
  Kluczem okresu jest `expiresAt` z Apple (`okres:<YYYY-MM-DD>`), bo to jedyna
  data, która przesuwa się DOKŁADNIE przy odnowieniu — nowa wartość sama otwiera
  nową pulę, bez crona. W łasce płatniczej `expiresAt` stoi w miejscu, więc
  przeterminowana karta nie daje świeżej puli, tylko resztę opłaconej. Nadanie
  operatora i wieczyste nie mają okresu rozliczeniowego i zostają przy miesiącu
  kalendarzowym.
- **Recenzent App Store kupuje w sandboxie**, a sandbox nie daje PRO na
  produkcji (i nie może, bo wtedy każdy z TestFlightem miałby PRO za darmo).
  Dla recenzji trzeba nadać dostęp ręcznie: `POST /ops/billing/grant` z
  `months: 0` na koncie demo podanym w notatkach do recenzji.

---

## 8. Lista kontrolna przed sprzedażą

**App Store Connect**

1. Trzy produkty subskrypcji w jednej grupie:
   `app.scoffie.pro.{solo,duet,family}.monthly` — 29,99 / 39,99 / 49,99 zł.
2. W opisie każdego: liczba wiadomości i zapisów planu w miesiącu (3.1.2(c)).
   Muszą się zgadzać z `src/config/subscription-products.ts` i z paywallem iOS.
3. Chmura Rodzinna: **wyłączona**.
4. Klucz App Store Server API (Integrations → Keys) → `APPLE_ISSUER_ID`,
   `APPLE_BILLING_KEY_ID`, `APPLE_BILLING_PRIVATE_KEY`. To INNY klucz niż ten
   od „Zaloguj się przez Apple".
5. Adres powiadomień (Production i Sandbox osobno):
   `https://<serwer>/billing/apple/notifications`, wersja **2**.
6. Wyślij powiadomienie testowe i sprawdź, czy przyszło 200.

**Railway**

7. `PURCHASE_IDENTITY_PEPPER` — długi, losowy, **ustawiony raz na zawsze**.
8. `APPLE_ENVIRONMENT=Production`, `APPLE_ACCEPT_SANDBOX=false`.
9. `BILLING_ENABLED=true` — dopiero po punktach 4–8.
10. **`AI_TIER_OVERRIDE` — wyczyścić albo skasować.** Od 4.09.2026 jedno i
    drugie znaczy to samo. Wcześniej BRAK zmiennej znaczył `PRO`, więc
    skasowanie wiersza w Railway rozdawało asystenta za darmo wszystkim.
    Start ostrzega o `PRO` niezależnie od `BILLING_ENABLED`.
11. Reszta zmiennych z decyzji cennikowej: `AI_MAX_TURN_COST_USD=0.6`,
    `AI_LIMIT_MESSAGES_PER_MONTH=50`, `AI_LIMIT_PLANS_PER_MONTH=12`,
    `AI_MAX_CONCURRENT_TURNS_PER_HOUSEHOLD=1`, `AI_MODEL_TOOLS` puste.

11a. `APPLE_ACCEPT_FAMILY_SHARED=false` (domyślnie) — i przełącznik Chmury
    Rodzinnej wyłączony także w App Store Connect.
11b. Konto demo dla recenzenta App Store + `POST /ops/billing/grant` z
    `months: 0` na jego tożsamość; login i hasło w notatkach do recenzji.

**iOS**

12. `SubscriptionCatalog.purchasesEnabled = true`.
13. Zgłaszanie transakcji na `POST /billing/apple/transaction` + „Przywróć
    zakupy" wołające ten sam endpoint po `AppStore.sync()`.
14. Ekran stanu subskrypcji z `GET /billing/subscription` (3.1.2(a)) i odnośnik
    do zarządzania w Ustawieniach iOS.

**Dokumenty**

15. Regulamin i polityka prywatności: warunki płatnych planów, brak zwrotów po
    stronie sprzedawcy (zwroty robi Apple), `identityHash` jako ślad po
    usunięciu konta.
16. Rejestr czynności i DPIA: czynność „obsługa subskrypcji".
