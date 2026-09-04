# Railway od zera — projekt „scoffie"

Instrukcja stawiania środowiska produkcyjnego po rebrandingu. Kolejność ma
znaczenie: backend przy pierwszym starcie sam migruje bazę i zasiewa katalog,
więc baza musi istnieć wcześniej niż jego pierwszy deploy.

Zmienne do wklejenia leżą w pliku `scoffie-railway-sekrety.txt` na pulpicie,
poza repozytoriami. Sekrety są w nim wygenerowane, wartości `TWOJ_...` trzeba
uzupełnić. **Skasuj ten plik, gdy skończysz.**

---

## 1. Usuń usługę `scoffie-ios`

Nie da się zbudować aplikacji iOS na Railway i nie ma po co. To repozytorium
buduje się w GitHub Actions i idzie do TestFlighta. Czerwony build tej usługi
to nie awaria, tylko usługa, której nie powinno tam być.

## 2. Dodaj bazę

`Add` → `Database` → `PostgreSQL`. Nazwa `Postgres` (tak nazywa się odwołanie
`${{Postgres.DATABASE_URL}}` w zmiennych backendu — jeśli nazwiesz inaczej,
popraw je).

## 3. Wklej zmienne

`scoffie-backend` → `Variables` → `Raw Editor` → wklej blok backendu.
`scoffie-cookidoo` → to samo z blokiem mikroserwisu.

Trzy rzeczy, które muszą się zgadzać, bo inaczej wszystko wygląda na zepsute
bez czytelnego błędu:

- `COOKIDOO_SERVICE_TOKEN` backendu **musi** równać się `INTERNAL_TOKEN`
  mikroserwisu. W wygenerowanym pliku już są identyczne.
- `DATABASE_URL` to odwołanie do usługi bazy, nie wklejony adres. Dzięki temu
  zmiana hasła bazy nie wymaga ruszania backendu.
- `PURCHASE_IDENTITY_PEPPER` ustawiasz **raz i nigdy nie zmieniasz**. Na tym
  haszu wisi darmowa próba i przypisanie subskrypcji do osoby.

## 4. Deploy w tej kolejności

1. Baza (sama).
2. `scoffie-cookidoo`.
3. `scoffie-backend` — przy pierwszym starcie zrobi migracje, wgra katalog
   składników, ich tagi i 145 przepisów razem z adresami zdjęć.

Zasiew katalogu chodzi **wyłącznie na pustej bazie**. Baza z danymi nigdy nie
jest ruszana, więc kolejne deploye niczego nie nadpiszą.

## 5. Sprawdź, że stoi

- `GET /ops/health` — bez nagłówków, powinno oddać `ok`.
- `GET /ops/metrics` z nagłówkiem `x-ops-token` równym `OPS_TOKEN` — jest tam
  stan migracji.
- W bazie: `SELECT count(*) FROM "Recipe";` powinno dać **145**, a
  `SELECT count(*) FROM "Recipe" WHERE "imageUrl" IS NULL;` — **0**.

## 6. Czego jeszcze nie włączamy

`BILLING_ENABLED=false` zostaje, dopóki w App Store Connect nie ma trzech
produktów i klucza do App Store Server API. Wtedy uzupełniasz `APPLE_ISSUER_ID`,
`APPLE_BILLING_KEY_ID`, `APPLE_BILLING_PRIVATE_KEY`, `APPLE_APP_APPLE_ID`
i przestawiasz przełącznik. Aplikacja odblokuje przycisk zakupu sama, bez
nowego builda — pyta o to serwer.

`AI_TIER_OVERRIDE` zostaje **puste**. Wpisanie tam `PRO` daje asystenta za
darmo wszystkim i wyłącza całą ścieżkę płatności.

`APNS_USE_SANDBOX=true` jest właściwe dla TestFlighta. Przy wydaniu do sklepu
przestaw na `false`, inaczej powiadomienia przestaną dochodzić.

## 7. Po pierwszym udanym starcie

- Zmień adres serwera w aplikacji iOS na nowy adres Railway.
- Ustaw adres powiadomień App Store w App Store Connect na
  `https://<adres>/billing/apple/notifications`, wersja 2.
- Skasuj `scoffie-railway-sekrety.txt` z pulpitu.
