# Panel admina — logowanie (`/admin/auth/*`, `/admin/session`)

Kontrakt logowania do panelu. Typy odpowiedzi: `src/admin/contract.ts`
(kopia `scoffie-dashboard/src/api/types.ts`). Dlaczego tak, a nie inaczej:
`ROADMAPA.md` §4. Dowód na żywej bazie: `test/admin-auth.e2e-spec.ts`
(passkeye podpisuje programowy uwierzytelniacz P-256, backend weryfikuje je
prawdziwym `@simplewebauthn/server`).

## Warstwy

1. **Cloudflare Access** — każde żądanie `/admin/*` niesie
   `Cf-Access-Jwt-Assertion`; `AccessJwtVerifier` sprawdza podpis (JWKS
   zespołu), `aud`, `iss`, ważność. Brak / zły token = **404 identyczne
   z nieistniejącą trasą** (`Cannot GET …`, bez `X-Robots-Tag`). Panel nie
   istnieje dla nikogo spoza bramki.
2. **Własna tożsamość** — `AdminUser` (nie rola na `User`), sesja w
   ciasteczku `__Host-scoffie_admin` (`HttpOnly; Secure; SameSite=Strict;
Path=/`), w bazie tylko sha256 tokenu.

Token Access weryfikuje `AdminGateMiddleware` na CAŁYM prefiksie `/admin` —
także na ścieżkach, których nie ma — i odkłada wynik w żądaniu; guard go nie
liczy drugi raz. Czas odpowiedzi nie zdradza więc, które trasy istnieją.

Kolejność w `AdminGuard`: bramka → `X-Robots-Tag` → CSRF (niżej) → sesja → limit żądań
(`admin:<id>` z sesją, `ip:<adres>` bez) → brak sesji na trasie `required` =
to samo 404 → `mustReenroll` poza trasami konfiguracji = 403 `NOT_ALLOWED` →
brak uprawnienia = 404 → step-up = 403 `STEP_UP_REQUIRED`.

## Trasy

Tryb sesji: `none` (logowanie), `optional` (bootstrap / wylogowanie),
`required` (reszta). „Reenroll” = dostępne po wejściu kodem odzyskiwania.

| Metoda i ścieżka                            | Sesja                             | Ciało                         | Odpowiedź                                          |
| ------------------------------------------- | --------------------------------- | ----------------------------- | -------------------------------------------------- |
| `GET /admin/auth/state`                     | none                              | —                             | `AuthState`                                        |
| `POST /admin/auth/passkey/login/options`    | none                              | `{}`                          | `PublicKeyCredentialRequestOptionsJSON`            |
| `POST /admin/auth/passkey/login`            | none                              | `{ response }`                | `AdminSession` + ciasteczko                        |
| `POST /admin/auth/totp/login`               | none                              | `{ code }`                    | `AdminSession` + ciasteczko                        |
| `POST /admin/auth/recovery/login`           | none                              | `{ code }`                    | `AdminSession` (`mustReenroll: true`) + ciasteczko |
| `POST /admin/auth/passkey/register/options` | optional, reenroll                | `{ name? }`                   | `PublicKeyCredentialCreationOptionsJSON`           |
| `POST /admin/auth/passkey/register`         | optional, reenroll                | `{ name?, response }`         | `AdminPasskey` (+ ciasteczko przy bootstrapie)     |
| `POST /admin/auth/totp/setup`               | required, reenroll, **step-up\*** | `{}`                          | `{ otpauthUrl, secret }`                           |
| `POST /admin/auth/totp/confirm`             | required, reenroll, **step-up\*** | `{ code }`                    | `{ recoveryCodes: string[] \| null }`              |
| `POST /admin/auth/recovery/regenerate`      | required, **step-up**             | `{}`                          | `{ recoveryCodes: string[] }`                      |
| `POST /admin/auth/step-up/options`          | required                          | `{}`                          | `PublicKeyCredentialRequestOptionsJSON`            |
| `POST /admin/auth/step-up`                  | required                          | `{ passkey }` albo `{ totp }` | `{ stepUpUntil }`                                  |
| `GET /admin/auth/sessions`                  | required                          | —                             | `AdminSessionInfo[]`                               |
| `DELETE /admin/auth/sessions/:id`           | required                          | —                             | 204 (bieżąca = też kasuje ciasteczko)              |
| `GET /admin/auth/passkeys`                  | required, reenroll                | —                             | `AdminPasskey[]`                                   |
| `DELETE /admin/auth/passkeys/:id`           | required, **step-up**             | —                             | 204                                                |
| `GET /admin/session`                        | required, reenroll                | —                             | `AdminSession`                                     |
| `DELETE /admin/session`                     | optional, reenroll                | —                             | 204 zawsze (wylogowanie nie może „się nie udać”)   |

\* Step-up sprawdza serwis, nie guard: sesja `mustReenroll` (kod odzyskiwania)
jest zwolniona, a `totp/confirm` przyjmuje też step-up, pod którym powstał
oczekujący sekret (`pendingCreatedAt < stepUpUntil` tej sesji) — skanowanie
kodu QR bywa dłuższe niż 5 minut.

Rejestracja passkeya z sesją (nie bootstrap) też wymaga step-upu (poza
`mustReenroll`) — sprawdza serwis.

## Przepływy

- **Pierwsze konto (bootstrap).** `state.bootstrap === true` tylko, gdy
  w bazie nie ma żadnego admina, a e-mail z Access = `ADMIN_BOOTSTRAP_EMAIL`.
  Front woła `passkey/register/options` → `navigator.credentials.create` →
  `passkey/register`; konto (rola `OWNER`) i pierwszy klucz powstają w jednej
  transakcji, sesja otwiera się od razu. Drugi bootstrap = 403 `NOT_ALLOWED`
  (także w wyścigu: unikalny e-mail → P2002 → `NOT_ALLOWED`).
- **Passkey.** `userVerification: 'required'`, wyzwanie w bazie, jednorazowe,
  5 min. Odpowiedź z innego pochodzenia / RP ID, bez UV, z podrobionym
  podpisem albo powtórzona = 401 `PASSKEY_FAILED`. Wejście passkeyem daje od
  razu step-up na 5 min.
- **TOTP.** `totp/setup` szyfruje sekret (AES-256-GCM,
  `ADMIN_TOTP_ENCRYPTION_KEY`) jako OCZEKUJĄCY na 15 min; `totp/confirm`
  pierwszym kodem go włącza i — jeśli konto nie ma kodów odzyskiwania — wydaje
  10 nowych (pokazywane RAZ). KAŻDA konfiguracja TOTP — także pierwsza —
  wymaga świeżego step-upu (audyt 25.09.2026: dawniej sesja bez step-upu
  dopisywała sobie pierwszy TOTP i 10 kodów). Kreator pierwszego wejścia
  działa, bo sesja z bootstrapu ma step-up z logowania passkeyem (5 min), a
  `confirm` akceptuje step-up, pod którym powstał sekret.
  Kod: okno ±1 krok, każdy krok działa raz (warunkowy `updateMany` na
  `lastUsedStep`, więc dwa równoległe żądania z tym samym kodem nie wejdą oba).
- **Kody odzyskiwania.** 10 × jednorazowe, w bazie HMAC (klucz z HKDF
  `ADMIN_TOTP_ENCRYPTION_KEY`), wielkość liter i myślniki bez znaczenia.
  Wejście kodem = sesja `mustReenroll`: widzi tylko konfigurację wejścia
  (trasy „reenroll”), wszystko inne 403 `NOT_ALLOWED`, do czasu dodania
  passkeya albo włączenia TOTP. Bez step-upu.
- **Step-up.** Akcje, które bolą, mają `@RequireStepUp()`; bez świeżego
  potwierdzenia 403 `STEP_UP_REQUIRED`. Front pokazuje dialog, woła
  `step-up/options` + `step-up` (passkey) albo `step-up` z `{ totp }` i ponawia
  żądanie. Ważne 5 min.
- **Sesje.** 2 h bezczynności (do 26.09.2026: 30 min), 12 h twardo; `lastSeenAt` odświeżane co
  najwyżej raz na minutę. Wygasła / unieważniona sesja = 404 na trasie
  `required` (front traktuje to jako „zaloguj się ponownie”).
- **Blokada.** 5 nieudanych prób w 15 min — liczone osobno per e-mail i per
  IP — = 429 `LOCKED` z `lockedUntil`, także przy poprawnym kodzie.
  `state.lockedUntil` pokazuje blokadę przed próbą. Każda próba logowania
  (passkey, TOTP, kod odzyskiwania) i step-upu REZERWUJE miejsce w liczniku
  przed weryfikacją: krótka transakcja pod `pg_advisory_xact_lock` adresu
  (i IP) liczy porażki razem z próbami w toku (`AdminLoginAttempt.result =
'PENDING'`) i wstawia własny wiersz `PENDING`, który wynik domyka na
  `SUCCESS`/`FAILED`. Seria równoległych żądań daje więc najwyżej 5
  weryfikacji (audyt 25.09.2026: było 28 z 200). Przed rezerwacją tani limit
  w pamięci: `THROTTLE_ADMIN_CODE_LIMIT` (10 / min) prób per adres z bramki —
  429 `TOO_MANY_REQUESTS`.
- **Ostatnia metoda.** Usunięcie ostatniego passkeya bez TOTP = 409
  `LAST_METHOD`. Liczenie metod i usunięcie w jednej transakcji z
  `SELECT … FROM "AdminUser" … FOR UPDATE` — dwa równoległe DELETE nie
  skasują obu kluczy.
- **Ten sam klucz drugi raz** (ten sam `credentialId`) = 409 `PASSKEY_EXISTS`.
  Bootstrap sprawdza warunek (`ADMIN_BOOTSTRAP_EMAIL`, brak adminów) drugi raz
  tuż przed zapisem.
- **CSRF w obrębie witryny.** `SameSite=Strict` nie chroni przed inną stroną
  `*.scoffie.app`. Na POST/PUT/PATCH/DELETE po bramce: nagłówek
  `Sec-Fetch-Site` obecny i różny od `same-origin` = 403 `CROSS_SITE`;
  `Content-Type` inny niż `application/json` (albo ciało bez niego) = 415
  `UNSUPPORTED_MEDIA_TYPE`. Żądanie bez ciała i bez `Content-Type` (DELETE
  z panelu) przechodzi. Worker panelu MUSI przekazywać `Sec-Fetch-Site`
  i `Content-Type` przeglądarki bez zmian.

## Błędy

Ciało: `{ code, message, lockedUntil?, requestId }`.

| Kod                      | HTTP | Kiedy                                                                |
| ------------------------ | ---- | -------------------------------------------------------------------- |
| `INVALID_CODE`           | 401  | zły / zużyty kod TOTP albo odzyskiwania                              |
| `PASSKEY_FAILED`         | 401  | weryfikacja WebAuthn nie przeszła                                    |
| `LOCKED`                 | 429  | blokada po 5 porażkach (`lockedUntil`)                               |
| `STEP_UP_REQUIRED`       | 403  | akcja wymaga świeżego potwierdzenia                                  |
| `NOT_ALLOWED`            | 403  | drugi bootstrap, obcy e-mail, sesja `mustReenroll` poza konfiguracją |
| `LAST_METHOD`            | 409  | usunięcie ostatniej metody wejścia                                   |
| `PASSKEY_EXISTS`         | 409  | ten klucz (ten sam `credentialId`) jest już zapisany                 |
| `CROSS_SITE`             | 403  | zapis z `Sec-Fetch-Site` innym niż `same-origin`                     |
| `UNSUPPORTED_MEDIA_TYPE` | 415  | zapis z ciałem innym niż JSON                                        |

Poza tym: 404 (bramka, brak sesji, brak uprawnienia — celowo nieodróżnialne),
400 (walidacja DTO), 429 `TOO_MANY_REQUESTS` (limity w pamięci), 503 `SERVICE_UNAVAILABLE` (brak klucza TOTP albo
konfiguracji WebAuthn).

## Audyt i alerty

Każde logowanie, bootstrap, włączenie TOTP, step-up, nowe kody, dodanie /
usunięcie passkeya, unieważnienie sesji i wylogowanie to wiersz
`AdminAuditLog` (PENDING → SUCCESS / FAILED). Nieudane próby lądują
w `AdminLoginAttempt` (licznik blokady). Każde udane logowanie wysyła alert
przez `OpsAlertService` (klucz `admin-login:<sessionId>`); dodanie i usunięcie
passkeya, włączenie TOTP i nowe kody odzyskiwania — też (klucz
`admin-method:…`, w treści tylko adres, co się stało i skąd — bez sekretów).
Step-up idzie przez `audit.run` (PENDING przed zapisem `stepUpUntil`).
Wylogowanie: błąd zapisu w dzienniku jest logowany, a odpowiedź i tak 204
z kasowaniem ciasteczka.

## Zmienne środowiska (`src/config/admin-env.ts`)

| Zmienna                     | Prod                                                               | Po co                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_ACCESS_TEAM_DOMAIN`  | `empty-dream-49ba.cloudflareaccess.com`                            | wydawca tokenów Access; brak = panel zamknięty (404)                                                                                                       |
| `ADMIN_ACCESS_AUD`          | tag aplikacji Access (`724efc95…`)                                 | `aud` tokenu; brak = panel zamknięty                                                                                                                       |
| `ADMIN_BOOTSTRAP_EMAIL`     | adresy Rafała po przecinku                                         | adresy właściciela: każdym można założyć pierwsze konto, a potem każdy wchodzi na TO SAMO konto (te same klucze i TOTP); adres spoza listy = `NOT_ALLOWED` |
| `ADMIN_BOOTSTRAP_NAME`      | opcjonalnie                                                        | wyświetlana nazwa pierwszego konta (domyślnie z adresu)                                                                                                    |
| `ADMIN_WEBAUTHN_RP_ID`      | `dashboard.scoffie.app`                                            | RP ID passkeyów                                                                                                                                            |
| `ADMIN_WEBAUTHN_ORIGIN`     | `https://dashboard.scoffie.app`                                    | dozwolone pochodzenie (lista po przecinku)                                                                                                                 |
| `ADMIN_TOTP_ENCRYPTION_KEY` | 32 bajty base64 (`openssl rand -base64 32`)                        | szyfrowanie TOTP i klucz HMAC kodów; brak = tylko passkeye                                                                                                 |
| `ADMIN_ACCESS_DEV_EMAIL`    | **NIGDY**                                                          | obejście bramki lokalnie; z `NODE_ENV=production` odmowa startu, na każdym środowisku Railwaya ignorowana                                                  |
| `THROTTLE_ADMIN_LIMIT`      | domyślnie 300 / min                                                | limit żądań z sesją                                                                                                                                        |
| `THROTTLE_ADMIN_AUTH_LIMIT` | domyślnie 30 / min                                                 | limit żądań bez sesji (per IP)                                                                                                                             |
| `THROTTLE_ADMIN_CODE_LIMIT` | domyślnie 10 / min                                                 | próby kodu / klucza (logowanie, step-up) per adres z bramki                                                                                                |
| `ADMIN_PROXY_SECRET`        | ≥ 32 znaki (`openssl rand -base64 48`), ta sama wartość w Workerze | dopiero z nim backend wierzy `CF-Connecting-IP` / `CF-IPCountry`; bez niego IP = adres połączenia, kraj pusty                                              |

### `ADMIN_PROXY_SECRET` i nagłówki Workera

`api.scoffie.app` jest DNS-only (Railway bez proxy Cloudflare), więc
`CF-Connecting-IP` i `CF-IPCountry` może podać każdy, kto ma token Access
i zapuka prosto do backendu — rotując adres, rozbijałby licznik blokady per
IP. Backend przyjmuje je więc WYŁĄCZNIE razem z nagłówkiem
`X-Admin-Proxy-Secret` równym `ADMIN_PROXY_SECRET` (porównanie stałoczasowe
na sha256). Worker panelu ustawia (`headers.set`, nadpisując to, co przyszło
od przeglądarki) na każdym żądaniu do `api.scoffie.app/admin/*`:

- `X-Admin-Proxy-Secret: <ADMIN_PROXY_SECRET>` (sekret Workera, `wrangler secret put`),
- `CF-Connecting-IP: <request.headers.get('CF-Connecting-IP')>`,
- `CF-IPCountry: <request.cf.country>`.

Sekret krótszy niż 32 znaki backend ignoruje (ostrzeżenie w `assert-env`).

Zmiana `ADMIN_TOTP_ENCRYPTION_KEY` unieważnia włączone TOTP i wszystkie kody
odzyskiwania — zostają passkeye; po zmianie TOTP włącza się od nowa.
