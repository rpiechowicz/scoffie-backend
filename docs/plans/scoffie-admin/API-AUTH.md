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

Kolejność w `AdminGuard`: bramka → `X-Robots-Tag` → sesja → limit żądań
(`admin:<id>` z sesją, `ip:<adres>` bez) → brak sesji na trasie `required` =
to samo 404 → `mustReenroll` poza trasami konfiguracji = 403 `NOT_ALLOWED` →
brak uprawnienia = 404 → step-up = 403 `STEP_UP_REQUIRED`.

## Trasy

Tryb sesji: `none` (logowanie), `optional` (bootstrap / wylogowanie),
`required` (reszta). „Reenroll” = dostępne po wejściu kodem odzyskiwania.

| Metoda i ścieżka | Sesja | Ciało | Odpowiedź |
| --- | --- | --- | --- |
| `GET /admin/auth/state` | none | — | `AuthState` |
| `POST /admin/auth/passkey/login/options` | none | `{}` | `PublicKeyCredentialRequestOptionsJSON` |
| `POST /admin/auth/passkey/login` | none | `{ response }` | `AdminSession` + ciasteczko |
| `POST /admin/auth/totp/login` | none | `{ code }` | `AdminSession` + ciasteczko |
| `POST /admin/auth/recovery/login` | none | `{ code }` | `AdminSession` (`mustReenroll: true`) + ciasteczko |
| `POST /admin/auth/passkey/register/options` | optional, reenroll | `{ name? }` | `PublicKeyCredentialCreationOptionsJSON` |
| `POST /admin/auth/passkey/register` | optional, reenroll | `{ name?, response }` | `AdminPasskey` (+ ciasteczko przy bootstrapie) |
| `POST /admin/auth/totp/setup` | required, reenroll | `{}` | `{ otpauthUrl, secret }` |
| `POST /admin/auth/totp/confirm` | required, reenroll | `{ code }` | `{ recoveryCodes: string[] \| null }` |
| `POST /admin/auth/recovery/regenerate` | required, **step-up** | `{}` | `{ recoveryCodes: string[] }` |
| `POST /admin/auth/step-up/options` | required | `{}` | `PublicKeyCredentialRequestOptionsJSON` |
| `POST /admin/auth/step-up` | required | `{ passkey }` albo `{ totp }` | `{ stepUpUntil }` |
| `GET /admin/auth/sessions` | required | — | `AdminSessionInfo[]` |
| `DELETE /admin/auth/sessions/:id` | required | — | 204 (bieżąca = też kasuje ciasteczko) |
| `GET /admin/auth/passkeys` | required, reenroll | — | `AdminPasskey[]` |
| `DELETE /admin/auth/passkeys/:id` | required, **step-up** | — | 204 |
| `GET /admin/session` | required, reenroll | — | `AdminSession` |
| `DELETE /admin/session` | optional, reenroll | — | 204 zawsze (wylogowanie nie może „się nie udać”) |

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
  10 nowych (pokazywane RAZ). Wymiana działającego TOTP wymaga step-upu.
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
- **Sesje.** 30 min bezczynności, 12 h twardo; `lastSeenAt` odświeżane co
  najwyżej raz na minutę. Wygasła / unieważniona sesja = 404 na trasie
  `required` (front traktuje to jako „zaloguj się ponownie”).
- **Blokada.** 5 nieudanych prób w 15 min — liczone osobno per e-mail i per
  IP — = 429 `LOCKED` z `lockedUntil`, także przy poprawnym kodzie.
  `state.lockedUntil` pokazuje blokadę przed próbą.
- **Ostatnia metoda.** Usunięcie ostatniego passkeya bez TOTP = 409
  `LAST_METHOD`.

## Błędy

Ciało: `{ code, message, lockedUntil?, requestId }`.

| Kod | HTTP | Kiedy |
| --- | --- | --- |
| `INVALID_CODE` | 401 | zły / zużyty kod TOTP albo odzyskiwania |
| `PASSKEY_FAILED` | 401 | weryfikacja WebAuthn nie przeszła |
| `LOCKED` | 429 | blokada po 5 porażkach (`lockedUntil`) |
| `STEP_UP_REQUIRED` | 403 | akcja wymaga świeżego potwierdzenia |
| `NOT_ALLOWED` | 403 | drugi bootstrap, obcy e-mail, sesja `mustReenroll` poza konfiguracją |
| `LAST_METHOD` | 409 | usunięcie ostatniej metody wejścia |

Poza tym: 404 (bramka, brak sesji, brak uprawnienia — celowo nieodróżnialne),
400 (walidacja DTO), 503 `SERVICE_UNAVAILABLE` (brak klucza TOTP albo
konfiguracji WebAuthn).

## Audyt i alerty

Każde logowanie, bootstrap, włączenie TOTP, step-up, nowe kody, dodanie /
usunięcie passkeya, unieważnienie sesji i wylogowanie to wiersz
`AdminAuditLog` (PENDING → SUCCESS / FAILED). Nieudane próby lądują
w `AdminLoginAttempt` (licznik blokady). Każde udane logowanie wysyła alert
przez `OpsAlertService` (klucz `admin-login:<sessionId>`).

## Zmienne środowiska (`src/config/admin-env.ts`)

| Zmienna | Prod | Po co |
| --- | --- | --- |
| `ADMIN_ACCESS_TEAM_DOMAIN` | `empty-dream-49ba.cloudflareaccess.com` | wydawca tokenów Access; brak = panel zamknięty (404) |
| `ADMIN_ACCESS_AUD` | tag aplikacji Access (`724efc95…`) | `aud` tokenu; brak = panel zamknięty |
| `ADMIN_BOOTSTRAP_EMAIL` | adres Rafała | kto może założyć pierwsze konto |
| `ADMIN_BOOTSTRAP_NAME` | opcjonalnie | wyświetlana nazwa pierwszego konta (domyślnie z adresu) |
| `ADMIN_WEBAUTHN_RP_ID` | `dashboard.scoffie.app` | RP ID passkeyów |
| `ADMIN_WEBAUTHN_ORIGIN` | `https://dashboard.scoffie.app` | dozwolone pochodzenie (lista po przecinku) |
| `ADMIN_TOTP_ENCRYPTION_KEY` | 32 bajty base64 (`openssl rand -base64 32`) | szyfrowanie TOTP i klucz HMAC kodów; brak = tylko passkeye |
| `ADMIN_ACCESS_DEV_EMAIL` | **NIGDY** | obejście bramki lokalnie; z `NODE_ENV=production` odmowa startu, na każdym środowisku Railwaya ignorowana |
| `THROTTLE_ADMIN_LIMIT` | domyślnie 300 / min | limit żądań z sesją |
| `THROTTLE_ADMIN_AUTH_LIMIT` | domyślnie 30 / min | limit żądań bez sesji (per IP) |

Zmiana `ADMIN_TOTP_ENCRYPTION_KEY` unieważnia włączone TOTP i wszystkie kody
odzyskiwania — zostają passkeye; po zmianie TOTP włącza się od nowa.
