# Pierwszy zakup — jak sprawdzić, że działa, zanim ktoś zapłaci

Lista z `SUBSKRYPCJE.md` §8 mówi, CO skonfigurować. Ten plik mówi, PO CZYM
POZNAĆ, że to działa — krok po kroku, z tym, co masz zobaczyć, i z tym, co
znaczy każdy błąd. Dwa audyty i ~450 agentów sprawdziły kod na papierze;
**ten test jest jedynym dowodem, który liczy się naprawdę**, bo nic w tym
kodzie nie rozmawiało jeszcze z prawdziwym Apple.

Cały test odbywa się w sandboxie Apple. Nikt nie płaci prawdziwych pieniędzy.

---

## 0. Zanim zaczniesz

- [ ] Aplikacja **zbudowana na Macu** i wgrana do TestFlighta. Kod iOS nie był
      kompilowany od kilku dni — pierwszy build może wymagać drobnych poprawek.
- [ ] W App Store Connect: trzy produkty w stanie „Ready to Submit",
      klucz **In-App Purchase** (Users and Access → Integrations → Keys →
      In-App Purchase — NIE „App Store Connect API"), konto testowe sandbox
      (Users and Access → Sandbox → Testers).
- [ ] Railway: `BILLING_ENABLED=true`, `APPLE_ENVIRONMENT=Production`,
      **`APPLE_ACCEPT_SANDBOX=true`** (na czas testu — sandbox ma dawać dostęp),
      `AI_TIER_OVERRIDE` puste albo skasowane.

## 1. Sprawdź klucz — jedno żądanie, bez telefonu

```
POST https://<serwer>/ops/billing/preflight
x-ops-token: <OPS_TOKEN>
```

| odpowiedź            | znaczy                                                      | co zrobić                                  |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `"stan": "ok"`       | Apple przyjmuje nasz token. Idź dalej.                      | —                                          |
| `"stan": "klucz"`    | Apple odrzuca token. **Paywall jest zgaszony automatycznie.** | Zły typ klucza, zły issuer albo urwany PEM w Railway. Popraw, zrób deploy, powtórz. |
| `"stan": "nieznany"` | Nie doszło do Apple (sieć, timeout).                        | Powtórz za minutę. Jeśli się utrzymuje — `szczegol` mówi dlaczego. |

Bez `"ok"` nie idź dalej. Przycisk „Kup" w telefonie i tak się nie włączy.

## 2. Powiadomienia — czy Apple do nas dociera

App Store Connect → App → App Store Server Notifications → wpisz
`https://<serwer>/billing/apple/notifications` w **Sandbox** i **Production**,
wersja **2** → „Request a Test Notification".

- W logach Railway: żadnego `Odrzucone powiadomienie`.
- `GET /ops/billing/notifications/failed` z `x-ops-token` → pusta lista.
- Jeśli test nie dochodzi: adres, HTTPS, albo serwer nie odpowiada w 5 s.

## 3. Zakup na telefonie

Na iPhonie: Ustawienia → App Store → **Konto Sandbox** → zaloguj konto testowe.
Otwórz aplikację z TestFlighta, zaloguj się przez Apple, wejdź w Ustawienia →
**Asystent i plan**.

| krok                         | co masz zobaczyć                                                   | jeśli nie                                             |
| ---------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| otwarcie ekranu              | trzy plany z **cenami z App Store** (nie zapasowymi 29,99 zł)      | „Zakupy wkrótce" = produkty nie doszły: nie są „Ready to Submit", inny bundle id, albo brak konta sandbox na telefonie |
| przycisk                     | „Wybierz plan" aktywny                                             | nieaktywny = serwer mówi `purchasesEnabled: false` → wróć do kroku 1 |
| po zakupie w arkuszu Apple   | **„Dziękujemy! Plan jest włączony."** i plakietka **„Plan Solo"**   | patrz tabela błędów niżej                             |
| Railway, log                 | `Apple nie zna … na produkcji — pytam sandbox.` a potem zapis      | brak drugiej linii = pytanie nie zeszło na sandbox     |
| baza                         | `SELECT status, environment, "expiresAt" FROM "Subscription";` → `ACTIVE`, `Sandbox`, data kilka minut w przód | —                              |
| asystent                     | pula 30 wiadomości, w limitach data odnowienia za kilka minut       | pula próbna = `resolvePlan` nie widzi wiersza: sprawdź `identityHash` w `User` |

Sandbox przyspiesza czas: miesiąc trwa **kilka minut** (tempo ustawiasz w App
Store Connect przy koncie testowym), a subskrypcja odnawia się **do 12 razy** i
gaśnie. To jest cecha, nie błąd — i darmowy test odnowienia i wygaśnięcia:

- [ ] Po pierwszym odnowieniu `expiresAt` w bazie przesunęło się, a **pula
      wróciła** (klucz okresu w `AiUsageCounter` ma nową datę). Przesuwa je
      powiadomienie z kroku 2 — bez adresu sandbox w ASC zobaczysz to dopiero
      po godzinnym przebiegu uzgadniania.
- [ ] Po ostatnim odnowieniu status `EXPIRED`, asystent wraca na próbę,
      w ekranie planu „Plan wygasł …". Apple ostrzega, że w sandboxie bywają
      krótkie luki między wygaśnięciem a odnowieniem — w produkcji też.

## 4. „Przywróć zakupy" i skasowanie konta

- [ ] Usuń aplikację, zainstaluj ponownie, zaloguj tym samym Apple ID →
      „Przywróć zakupy" → plan wraca **bez** ponownego kupowania.
- [ ] Ustawienia → profil → **Usuń konto** → zaloguj ponownie tym samym
      Apple ID → „Przywróć zakupy" → plan wraca. To jest przypadek, który
      wczorajsza poprawka łamała; dziś rozstrzyga hasz tożsamości.

## 5. Po teście

- [ ] `APPLE_ACCEPT_SANDBOX` → **`false`** przed wydaniem do sklepu, chyba że
      świadomie zostawiasz `true` na czas recenzji Apple (wtedy każdy tester
      z TestFlighta ma PRO za darmo — na tyle, ile trwa sandboxowa subskrypcja,
      czyli do 12 przyspieszonych odnowień).
- [ ] Konto demo dla recenzenta: `POST /ops/billing/grant` z `userId` i
      `months: 0`. Login i hasło w notatkach do recenzji.

---

## Co znaczą błędy na ekranie zakupu

| komunikat w aplikacji                                             | przyczyna                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| „App Store chwilowo nie odpowiada" + w logu `KLUCZ DO APP STORE NIE DZIAŁA` | zły klucz — wróć do kroku 1                       |
| „App Store jeszcze nie widzi tego zakupu"                         | opóźnienie Apple (2–5 min). Transakcja jest **otwarta**; odczekaj i „Przywróć zakupy" |
| „Ten zakup pochodzi ze środowiska testowego"                      | `APPLE_ACCEPT_SANDBOX` nie jest `true`                     |
| „Ten zakup należy do innego konta"                                | to samo Apple ID, ale inny hasz tożsamości — pieprz się zmienił? patrz `ROTACJA-SEKRETOW.md` |
| „Ta subskrypcja jest udostępniona przez Chmurę Rodzinną"          | transakcja ma `FAMILY_SHARED` — celowo odrzucana; do testu Rodziny sandbox patrz `APPLE_ACCEPT_FAMILY_SHARED` |
| „Zakupy wkrótce"                                                  | telefon nie dostał produktów z App Store — nie serwer      |

Każda odmowa, której nie ma w tej tabeli, powinna trafić do `lastError`
w aplikacji i do logu Railway z `requestId`. Z tym `requestId` szukaj w logach.

---

**Dopóki tabela z kroku 3 nie jest odhaczona w całości na prawdziwym telefonie,
subskrypcje nie są „gotowe na produkcję" — są gotowe na ten test.**
