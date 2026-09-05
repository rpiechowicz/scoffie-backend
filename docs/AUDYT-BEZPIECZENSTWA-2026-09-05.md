# Audyt bezpieczeństwa — 5.09.2026

Przegląd 20 punktów (klucze, git, RLS, auth, IDOR, walidacja, nagłówki, HTTPS,
zależności) na trzech repozytoriach: `scoffie-backend`, `scoffie-cookidoo`,
`scoffie-ios`, plus sondy działającej produkcji `https://api.scoffie.app`.

Jak używać tego pliku: sekcja 2 to lista do odhaczania — robimy punkt po
punkcie, każdy zamknięty dostaje `[x]` i datę. Sekcja 1 mówi, co już weszło
do kodu; sekcja 3 to stan wszystkich 20 punktów po audycie.

## 1. Co już naprawione (commity z 5.09.2026)

**Backend** — `fix(bezpieczeństwo): poprawki po audycie 5.09.2026`

- prompt asystenta: nazwa domu i imiona zakresu w ogrodzeniu `<nazwa>`/`<zakres>`
  przez `fenceSafe` (`src/agent/fence-safe.ts`);
- `users:me` bez `appleSub`, `googleId`, `identityHash`, `tokenVersion`;
  lista domowników bez e-maili; `GET /billing/subscription` bez powodu
  blokady operatora;
- `imageUrl` przepisu tylko pełny adres `https`;
- limit handshake'ów WS liczy IP z OSTATNIEGO wpisu `X-Forwarded-For`;
- `WS_AUTH_MODE=soft` przy `NODE_ENV=production` = odmowa startu;
  `COOKIDOO_SERVICE_URL` po publicznym `http` = odmowa startu;
  krótki `OPS_TOKEN` = ostrzeżenie;
- CSP `default-src 'none'`; jawne `HS256`; `authTagLength: 16` w AES-GCM;
- `@MaxLength` na hasło Cookidoo, refresh token, token Apple, DTO ops,
  dev-login; `assertUuid` na każdym `:id` w `/ops`;
- webhook Apple: 600/min per IP zamiast `@SkipThrottle()`;
- tura asystenta wymaga bieżącego członkostwa (jak rozmowa);
- `basename()` w `scripts/upload-recipe-images-to-r2.ts`;
- prawdziwy host proxy bazy prod zastąpiony fikcyjnym w specach,
  `.env.example` i `commands.txt`; `.pyc` poza repo; `pnpm audit --prod` w CI;
- `.env.example`: `JWT_EXPIRES_IN=1h`, komentarz o `soft`; `CLAUDE.md`
  i `DEPLOYMENT.md` zgodne z kodem.

Weryfikacja: `pnpm typecheck`, `pnpm test` (2252), `pnpm lint:check`,
`pnpm build`, `pnpm test:e2e:ci` (173) na jednorazowym Postgresie 17.

**Cookidoo** — `fix(bezpieczeństwo): /docs wyłączone, limity długości pól, log bez treści wyjątku`
(pytest 8/8; `/docs`, `/openapi.json` → 404).

**iOS** — `chore(bezpieczeństwo): .gitignore, xcuserdata poza repo, SPM przypięte do 16.1.1, CI`
(bez zmian w Swift; `socket.io-client-swift` commit `42da871` = tag `v16.1.1`).

## 2. Do zrobienia — punkt po punkcie

### 2.1. Pilne, poza kodem

- [ ] **Zrotować hasło produkcyjnego Postgresa.** Trafiło do transkryptu
      sesji 28.08.2026 i wg `docs/ROTACJA-SEKRETOW.md` nadal nie było
      rotowane. Railway → Postgres → Variables → nowe hasło; Backend czyta
      przez referencję → restart. Potem zaktualizować `DATABASE_PUBLIC_URL`
      w sekretach GitHuba (workflow `DB backup`) i odpalić go ręcznie.
- [ ] **Sprawdzić zmienne na Railway PRZED merge do `main`**
      (`railway variables --service Backend`). Nowy kod odmówi startu przy:
  - `WS_AUTH_MODE=soft` → usunąć zmienną (domyślne na prod to `strict`);
  - `COOKIDOO_SERVICE_URL` po publicznym `http://` → `http://<serwis>.railway.internal:8000`
    albo `https://`.
    Przy okazji potwierdzić: `JWT_EXPIRES_IN` usunięte albo `≤ 1h`
    (kod domyślnie 1h; stare `.env.example` miało 30d = miesiąc dostępu po
    wylogowaniu), `AI_TIER_OVERRIDE` puste, `AUTH_DEV_LOGIN_ENABLED` nie
    istnieje, `APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY` ustawione
    (unieważnianie tokenów Apple przy kasowaniu konta, App Store 5.1.1(v)),
    `OPS_TOKEN` ≥ 32 znaki.
- [ ] **DNS `scoffie.app`.** 5.09.2026 domena nie miała rekordu A na
      1.1.1.1 ani 8.8.8.8, `www` nie istnieje — polityka prywatności i
      regulamin z GitHub Pages (`scoffie-ios/docs`, CNAME `scoffie.app`) są
      niedostępne, a App Store wymaga działającego adresu polityki. Dodać
      rekordy A/AAAA GitHub Pages u rejestratora, włączyć „Enforce HTTPS”
      w ustawieniach repo `scoffie-ios`.
- [ ] **Ustawienia GitHuba** (nie widać ich z repo): ochrona gałęzi `main`
      i `develop` (PR + zielone CI), Dependabot alerts włączone w trzech
      repo, retencja artefaktów.

### 2.2. Decyzje produktowe (wymagają Twojego „tak”, potem kod)

- [ ] **Dane zdrowotne domowników.** `households:memberPreferences`,
      `GET /agent/context` i `weeklyPlans:balance` z `memberUserId` oddają
      alergeny, dietę, cele i makra WSZYSTKICH domowników każdemu członkowi
      domu — bez zgody tych osób (art. 9 RODO). Opcje: (a) przełącznik
      „udostępniaj domownikom” per użytkownik na wzór zgody `AI_ASSISTANT`,
      (b) domownicy widzą tylko to, czego wymaga planowanie (alergeny jako
      flagi, bez celów i makr), a bilans tylko własny.
- [ ] **RLS w Postgresie.** Dziś zero polityk i ról; izolacja gospodarstw
      jest w 100% aplikacyjna (spójna: 47 tras + 45 handlerów WS z bramką).
      Minimum: osobna rola aplikacyjna bez DDL. Docelowo `ENABLE ROW LEVEL
    SECURITY` na tabelach z `householdId`/`userId` i polityki na
      `current_setting('app.user_id')` ustawiane `SET LOCAL` w transakcji.
- [ ] **Zaproszenia przez Universal Links (iOS).** Token zaproszenia idzie
      w `scoffie://invite?token=…` (`SessionStore.swift`), a inna aplikacja
      może zarejestrować ten sam schemat i przejąć token. Potrzeba:
      entitlement `associated-domains` (`applinks:scoffie.app`), plik AASA
      na `scoffie.app` (po naprawie DNS), linki `https://scoffie.app/invite?token=…`,
      schemat jako fallback.
- [ ] **Poświadczenia Cookidoo domu.** Każdy domownik może skasować albo
      nadpisać cudze poświadczenia (`cookidoo-integration.service.ts`
      `connect`/`disconnect`). Ograniczyć do `connectedById === userId` albo
      OWNER-a; wymaga zmiany w UI (przycisk „Rozłącz” tylko dla właściciela).
- [ ] **Obrazek dla prywatnego przepisu bez `imageUrl`** buduje adres
      pollinations.ai z tytułem i opisem w ścieżce (`recipes.service.ts`
      ~473–491) — telefon wysyła treść przepisu do strony trzeciej. Opcja:
      generowany adres tylko dla `isCatalog: true`, dla domu `null`.

### 2.3. Backend — niskie, do zrobienia przy okazji

- [ ] Refresh token ma okno przesuwne 60 dni bez absolutnego kresu sesji
      (`auth.service.ts` ~383–398). Dołożyć twardy limit (np. 180 dni od
      pierwszego logowania rodziny tokenów).
- [ ] `GET /ops/health` zdradza pełny SHA commitu bez tokenu. Skrót 7 znaków
      albo pełny tylko w `/ops/metrics`.
- [ ] `AI_ALLOWED_USERS` dopasowuje po e-mailu bez `emailVerified`, a
      `POST /auth/apple` ma fallback e-maila z DTO, gdy brak claimu
      (`auth.service.ts` ~90–91). Dopasowywać po `id` albo wymagać
      `emailVerified`; rozważyć usunięcie fallbacku.
- [ ] `ConsentEvent.householdId` z klienta bez walidacji członkostwa
      (`consents.service.ts` ~62) — `ensureMembership` albo dom z
      najstarszego członkostwa (uwaga: zgoda bywa zapisywana przed
      założeniem domu).
- [ ] Kolejność 404→403 zdradza istnienie identyfikatorów
      (`households.service.ts` `getHouseholdOrThrow` przed `ensureMembership`,
      `recipes.service.ts` `findById`). Członkostwo pierwsze albo ten sam 404.
- [ ] `weeklyPlans:getByWeek` oddaje `recipe.authorId`, `recipe.householdId`
      i pełne `RecipeIngredient`; `households:findAll/findById` oddają
      `tierOverride` i `createdById`. Ujednolicić z `recipeListSelect` /
      `HouseholdDto`.
- [ ] Eksport RODO: notatki pamięci domu (`createdByUserId`) i karty
      `PLAN_WEEK`/`SWAP` niosą imiona i `participantIds` innych domowników
      (`user-export.ts` ~228–232, 332–346). Redagować do własnego id.
- [ ] `PURCHASE_IDENTITY_PEPPER` pusty na prod = stały fallback z kodu i
      tylko ostrzeżenie (`billing-env-problems.ts`). Przy `BILLING_ENABLED=true`
      traktować jako naruszenie (świadomie łamie zasadę „płatności nie
      blokują startu” — do decyzji).
- [ ] `NODE_ENV` inne niż `production` na zdalnej bazie egzekwuje tylko
      sekrety, nie dev-login (`assert-env.ts`). Przy nielokalnej bazie
      `AUTH_DEV_LOGIN_ENABLED=true` też jako naruszenie.
- [ ] Throttler i limitery WS w pamięci procesu — poprawne dla jednej
      instancji Railway. Przy skalowaniu: `ThrottlerStorageRedis` i wspólny
      licznik WS.
- [ ] `prisma-migrate-deploy-safe.js` na Windows używa `shell: true` z
      `DATABASE_URL` jako argumentem (tylko dev). `shell: false` + ścieżka
      do `node_modules/.bin`.
- [ ] Opcjonalnie: App Attest na `POST /auth/apple` i wysyłce wiadomości do
      asystenta, gdy asystent stanie się publicznie płatny.

### 2.4. Cookidoo — niskie

- [ ] Brak pliku blokady zależności (`requirements.txt` przypina tylko 3
      pakiety, transitive idą luzem). `pip-compile --generate-hashes`
      z Pythona 3.12 (jak w Dockerfile) i instalacja `--require-hashes`.
- [ ] Sprawdzić, czy serwis nie ma publicznej domeny na Railway (zgadywane
      nazwy dawały 404; ma być tylko `*.railway.internal`).

### 2.5. iOS — do zrobienia na Macu (wymagają builda)

- [ ] `NSAllowsLocalNetworking` w `Scoffie-Info.plist` obowiązuje też w
      Release. `INFOPLIST_PREPROCESS` z `#if DEBUG` albo osobny plist per
      konfiguracja.
- [ ] Zdjąć `userId` z payloadów WS (`WebSocketRecipeTransportClient.swift`,
      `WebSocketShoppingListTransportClient.swift`, `SessionStore.swift`) —
      serwer w `strict` bierze tożsamość wyłącznie z tokenu.
- [ ] Profil, sylwetka, alergeny, dieta i e-mail leżą w `UserDefaults`
      (jawny plist w backupie). Przenieść do pliku JSON z
      `.completeFileProtectionUntilFirstUserAuthentication` i
      `isExcludedFromBackup = true`; e-mail do Keychain.
- [ ] Cache domowników, katalogu, planu i listy zakupów w `Documents` bez
      wykluczenia z backupu. `Application Support` + `isExcludedFromBackup`
      albo `Caches`.
- [ ] Nieznany kod błędu pokazuje surowy komunikat serwera
      (`UserFacingErrorMapper.swift:127`, `ConsentStore.swift:106`) — kopia
      generyczna, szczegóły tylko w DEBUG.
- [ ] Opcjonalnie: `NSPinnedDomains` dla `api.scoffie.app` (pin na klucz CA
      pośredniego + zapas).
- [ ] CI: akcje przypięte do SHA zamiast tagów; ID klucza App Store Connect
      w `env:` zamiast w nazwie pliku trafiającej do `GITHUB_OUTPUT`.
- [ ] Polityka prywatności i stopka logowania wymieniają Sentry jako
      odbiorcę błędów aplikacji, a aplikacja nie ma SDK Sentry (tylko
      backend) — doprecyzować „błędów serwera”.

### 2.6. Dokumentacja i higiena

- [ ] `docs/handover/memory/` — zapisać datę rotacji hasła bazy po jej
      wykonaniu (zasada z `docs/ROTACJA-SEKRETOW.md`).
- [ ] Node na maszynie Windows to 24, projekt chce 22 (`engines`). Działa,
      ale CI i Docker chodzą na 22 — rozważyć `fnm`/`nvm` na hoście.
- [ ] Port 5432 na Windows trzyma stary kontener `weeklymeals-db`
      (poprzednia nazwa projektu) — `docker compose up db` nie wstanie,
      dopóki on żyje. Usunąć, jeśli niepotrzebny.

## 3. Stan 20 punktów po audycie

| Punkt                         | Stan      | Uwagi                                                                                                              |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| Hide API keys                 | OK        | Klucze tylko w env; `.env` w gitignore i dockerignore; iOS bez kluczy; fallbacki w kodzie blokuje asercja na prod. |
| Purge secrets from Git        | OK        | Historia 3 repo bez prawdziwych kluczy; gitleaks w CI; host proxy bazy prod usunięty ze speców (5.09).             |
| Expose only the public DB key | N/A       | Klient nie rozmawia z bazą; jedyny publiczny adres to bucket R2 ze zdjęciami.                                      |
| Enable row-level security     | BRAK      | Izolacja aplikacyjna, spójna. Decyzja w 2.2.                                                                       |
| Encrypt sensitive data        | OK        | AES-256-GCM (Cookidoo), sha256+pepper (refresh), HMAC (tożsamość zakupowa), kopie bazy `age`; tag GCM przypięty.   |
| Enforce server-side auth      | OK        | Każdy kontroler za JWT/ops; WS przez `actorId`; `soft` na prod = odmowa startu (5.09).                             |
| Lock record access            | OK        | 0 IDOR w 47 trasach i 45 handlerach; tura asystenta z członkostwem (5.09); Cookidoo disconnect w 2.2.              |
| Block field tampering         | OK        | whitelist+forbid, `validateDto` na WS, brak spreadów DTO, pola wrażliwe poza DTO.                                  |
| Secure session cookies        | OK        | Bearer w nagłówku, Keychain bez iCloud, rotacja + reuse detection; `JWT_EXPIRES_IN` do sprawdzenia na Railway.     |
| Hash passwords                | OK        | Brak haseł użytkowników (Apple); hasło Cookidoo z konieczności odwracalne; tokeny ops w stałym czasie.             |
| Rate limit login              | OK        | `/auth/*` 20/min/IP, Cookidoo 5/10 min, WS handshake z ostatnim XFF (5.09), webhook Apple 600/min (5.09).          |
| Add bot protection            | CZĘŚCIOWO | Brak App Attest/captcha; hamulce: Apple ID, kwoty AI, budżet dobowy, allowlista. Opcja w 2.3.                      |
| Parameterize queries          | OK        | Prisma; 2 `$queryRaw` parametryzowane; brak `Unsafe`; regexy nie z wejścia.                                        |
| Validate all input            | OK        | Pipe + `validateDto` + `assertUuid`; `imageUrl` https (5.09); MaxLength (5.09); pydantic `max_length` (5.09).      |
| Escape user content           | OK        | Tylko JSON, Swagger niezamontowany; prompt ogrodzony (5.09).                                                       |
| Restrict file uploads         | OK        | Brak uploadu; `/static` bez listingu; serwer nie pobiera adresów użytkownika.                                      |
| Trim API responses            | CZĘŚCIOWO | `users:me`, domownicy, billing przycięte (5.09); dane zdrowotne domowników w 2.2; drobiazgi w 2.3.                 |
| Add security headers          | OK        | HSTS 1 rok, nosniff, X-Frame-Options, Referrer-Policy, COOP, CORP, CSP `none` (5.09); CORS bez obcych origin.      |
| Force HTTPS                   | OK        | 301 na krawędzi Railway; ATS bez wyjątków; `COOKIDOO_SERVICE_URL` pilnowany (5.09); DNS `scoffie.app` w 2.1.       |
| Scan dependencies             | OK        | `pnpm audit` 0 (i w CI od 5.09), OSV PyPI/Swift 0, Dependabot w 3 repo, SPM przypięte do wersji (5.09).            |

## 4. Jak to sprawdzono

- Historia gita: `git log --all -p` trzech repo przefiltrowane wzorcami
  kluczy (Anthropic, AWS, PEM, JWT, GitHub, Slack/Discord, Sentry DSN,
  `postgresql://` z hasłem, przypisania `*_SECRET`/`*_KEY`), plus lista
  plików kiedykolwiek dodanych o nazwach `.env`, `.p8`, `.p12`, `.pem`.
- Zależności: `pnpm audit` (all i `--prod`), OSV API dla `cookidoo-api`,
  `fastapi`, `uvicorn`, `pytest`, `httpx`, `Starscream`, `socket.io-client-swift`.
- Produkcja: `GET /ops/health`, `http://` → 301, `/api`, `/docs`, `/api-json`,
  `/static/`, `/ops/metrics` bez tokenu (403), `POST /auth/dev` ({}), `OPTIONS`
  z obcym `Origin`, `/socket.io/` polling; DNS przez 1.1.1.1 i 8.8.8.8.
- Kod: cztery równoległe przeglądy (auth/WS/limity; IDOR/mass-assignment/
  odpowiedzi; iniekcje/walidacja/kryptografia/nagłówki; klient iOS) z
  odniesieniami do linii; kluczowe ustalenia zweryfikowane ręcznie.
