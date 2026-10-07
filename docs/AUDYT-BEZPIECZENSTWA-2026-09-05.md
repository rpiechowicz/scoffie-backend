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
      **Stan 7.10.2026:** proxy TCP Postgresa usunięte (ryzyko mniejsze), ale
      rotacja dalej potrzebna; krok z `DATABASE_PUBLIC_URL`/workflow `DB backup`
      nieaktualny — kopia to cron na Railwayu; sekrety `DATABASE_PUBLIC_URL`
      i `R2_BACKUP_*` w repo do skasowania.
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
    **Stan 7.10.2026:** warunki blokujące start spełnione (prod działa na
    `dadf008`), reszta do potwierdzenia ręcznie; `JWT_EXPIRES_IN` dłuższe niż
    1h daje od teraz ostrzeżenie w logu startu (`assert-env.ts`, commit `e4fed61`).
- [x] **DNS `scoffie.app`.** 5.09.2026 domena nie miała rekordu A na
      1.1.1.1 ani 8.8.8.8, `www` nie istnieje — polityka prywatności i
      regulamin z GitHub Pages (`scoffie-ios/docs`, CNAME `scoffie.app`) są
      niedostępne, a App Store wymaga działającego adresu polityki. Dodać
      rekordy A/AAAA GitHub Pages u rejestratora, włączyć „Enforce HTTPS”
      w ustawieniach repo `scoffie-ios`.
      **Zamknięte 7.10.2026:** `scoffie.app` stoi na Cloudflare Workers
      (repo `scoffie-web`), `/privacy`, `/terms` i `/support` odpowiadają 200.
- [ ] **Ustawienia GitHuba** (nie widać ich z repo): ochrona gałęzi `main`
      i `develop` (PR + zielone CI), Dependabot alerts włączone w trzech
      repo, retencja artefaktów.
      **Stan 7.10.2026:** repo backend i iOS są publiczne — ochrona gałęzi
      darmowa i nieustawiona; secret scanning wyłączony w backendzie;
      Dependabot alerts wyłączone w iOS, cookidoo, web i dashboard.

### 2.2. Decyzje produktowe (wymagają Twojego „tak”, potem kod)

- [x] **Dane zdrowotne domowników.** `households:memberPreferences`
      i `weeklyPlans:balance` z `memberUserId` oddają
      alergeny, dietę, cele i makra WSZYSTKICH domowników każdemu członkowi
      domu — bez zgody tych osób (art. 9 RODO). Opcje: (a) przełącznik
      „udostępniaj domownikom” per użytkownik na wzór zgody `AI_ASSISTANT`,
      (b) domownicy widzą tylko to, czego wymaga planowanie (alergeny jako
      flagi, bez celów i makr), a bilans tylko własny.
      **Stan 7.10.2026:** sylwetka wypadła z `MemberContext`, asystent wysyła
      alergeny tylko za zgodą; `memberPreferences` dalej oddaje cele/makra —
      iOS z tego korzysta od 23.09 (kcal na osobę), DPIA uznaje to za istotę
      planowania — do potwierdzenia jako świadomy wybór.
      **Świadomy wybór 7.10.2026 (Rafał):** cele i makra domowników zostają
      widoczne w domu. Z nich liczy się kcal na osobę w Planie (pigułka
      i „Cel dnia” z `memberPreferences.targets`) i porcje per osoba — bez nich
      wspólny plan nie wie, ile kto ma zjeść. DPIA
      (`docs/rejestr-czynnosci-i-dpia.md`, 2.1, ryzyko „Wyciek przez konto
      domownika”) uznaje dane potrzebne do planu za istotę wspólnego
      planowania; sylwetka (wzrost, waga, rok urodzenia) dalej niewidoczna dla
      domowników i poza kontekstem modelu, alergeny do modelu tylko za zgodą
      (`membersForModel`), eksport RODO nie oddaje danych innych osób. Bez
      zmian w kodzie; powrót do opcji (a)/(b), gdyby dom przestał być
      zaufanym kręgiem (np. dom współdzielony przez obcych).
- [ ] **RLS w Postgresie.** Dziś zero polityk i ról; izolacja gospodarstw
      jest w 100% aplikacyjna (spójna: 47 tras + 45 handlerów WS z bramką).
      Minimum: osobna rola aplikacyjna bez DDL. Docelowo `ENABLE ROW LEVEL
SECURITY` na tabelach z `householdId`/`userId` i polityki na
      `current_setting('app.user_id')` ustawiane `SET LOCAL` w transakcji.
      **Stan 7.10.2026:** bez zmian — migracje nie mają żadnej polityki ani
      osobnej roli; izolacja dalej aplikacyjna.
      **Decyzja 7.10.2026 (Rafał): nie teraz.** Izolacja aplikacyjna jest
      spójna i sprawdzona (0 IDOR w 47 trasach i 45 handlerach WS, e2e
      `test/cross-household-idor.e2e-spec.ts` i `test/authz-audit.e2e-spec.ts`),
      a do bazy pisze jeden serwis. RLS to duża zmiana: osobne role (migracje
      vs aplikacja), `SET LOCAL app.user_id` w KAŻDEJ transakcji, w tym
      `runSerializable`, zamkach sesji i wyzwalaczach katalogu, oraz polityki
      dla zapytań przekrojowych (crony, panel admina, eksport katalogu) —
      ryzyko regresji większe niż zysk przy dzisiejszym jednym procesie.
      **Warunek powrotu:** drugi serwis albo skrypt pisze do bazy produkcyjnej
      z własnym kodem dostępu (np. osobny worker, narzędzie zespołu), do kodu
      dochodzi zespół spoza jednej osoby, albo audyt znajdzie choć jeden IDOR.
      Wtedy najpierw minimum: osobna rola aplikacyjna bez DDL (migracje
      osobną rolą), potem RLS na tabelach z `householdId`/`userId`.
- [x] **Zaproszenia przez Universal Links (iOS).** Token zaproszenia idzie
      w `scoffie://invite?token=…` (`SessionStore.swift`), a inna aplikacja
      może zarejestrować ten sam schemat i przejąć token. Potrzeba:
      entitlement `associated-domains` (`applinks:scoffie.app`), plik AASA
      na `scoffie.app` (po naprawie DNS), linki `https://scoffie.app/invite?token=…`,
      schemat jako fallback.
      **Zamknięte 7.10.2026:** link `https://scoffie.app/zaproszenie/#<token>`
      (token we fragmencie), `applinks:scoffie.app` w entitlements, AASA
      z `/zaproszenie/*`. Zostaje schemat jako fallback ze strony — ryzyko
      szczątkowe.
- [x] **Poświadczenia Cookidoo domu.** Każdy domownik może skasować albo
      nadpisać cudze poświadczenia (`cookidoo-integration.service.ts`
      `connect`/`disconnect`). Ograniczyć do `connectedById === userId` albo
      OWNER-a; wymaga zmiany w UI (przycisk „Rozłącz” tylko dla właściciela).
      **Stan 7.10.2026:** bez zmian w kodzie (`connect` robi `upsert` na dom);
      integracja Cookidoo czeka na zgodę Vorwerk i jest schowana flagą
      w klientach — decyzja przy jej odblokowaniu.
      **Zamknięte 7.10.2026:** nadpisać i rozłączyć istniejące połączenie może
      tylko autor (`connectedById`) albo OWNER domu, pierwsze podłączenie —
      każdy; bramka w samym zapisie (warunkowy `updateMany`/`deleteMany`,
      P2002 przy wyścigu), odmowa = istniejący `FORBIDDEN` (403). `status`
      oddaje pełny e-mail tylko autorowi i właścicielowi, reszcie maskę
      `r•••@e•••.com`, plus `canManage` dla UI (przy odblokowaniu integracji
      w iOS: chować „Rozłącz”, gdy `false`). Dowód:
      `src/integrations/cookidoo-integration.service.ts`,
      `test/cookidoo-household-access.e2e-spec.ts`.
- [x] **Obrazek dla prywatnego przepisu bez `imageUrl`** buduje adres
      pollinations.ai z tytułem i opisem w ścieżce (`recipes.service.ts`
      ~473–491) — telefon wysyła treść przepisu do strony trzeciej. Opcja:
      generowany adres tylko dla `isCatalog: true`, dla domu `null`.
      **Stan 7.10.2026:** bez zmian — `resolveRecipeImageUrl` dalej buduje
      adres pollinations dla każdego przepisu bez zdjęcia.
      **Zamknięte 7.10.2026:** generator tylko dla `isCatalog: true`; przepis
      domu bez zdjęcia ma `imageUrl: null` (lista, szczegół, stan domu, kopia,
      publiczne API linku). Klienci znoszą `null` (iOS `String?` → zaślepka,
      Android `String?`, Worker strony → karta marki). Dowód:
      `src/recipes/recipes.service.ts` (`resolveRecipeImageUrl`),
      `test/recipe-sharing.e2e-spec.ts`.

### 2.3. Backend — niskie, do zrobienia przy okazji

- [x] Refresh token ma okno przesuwne 60 dni bez absolutnego kresu sesji
      (`auth.service.ts` ~383–398). Dołożyć twardy limit (np. 180 dni od
      pierwszego logowania rodziny tokenów).
      **Stan 7.10.2026:** bez zmian, świadomie poza rundą domknięcia.
      **Zamknięte 7.10.2026:** `RefreshToken.sessionStartedAt` (logowanie,
      kopiowane przy rotacji i ratunku), po `REFRESH_ABSOLUTE_DAYS` = 180 dni
      `/auth/refresh` = to samo 401 co wygasły token, bez kasowania rodziny.
      Istniejące tokeny: początek = `createdAt` (nikt nie wylatuje po
      wdrożeniu). Dowód: migracja `20261007130000_refresh_kres_sesji`,
      `test/auth-absolute-session.e2e-spec.ts`.
- [x] `GET /ops/health` zdradza pełny SHA commitu bez tokenu. Skrót 7 znaków
      albo pełny tylko w `/ops/metrics`.
      **Zamknięte 7.10.2026:** skrót SHA w `/ops/health` od 12.09
      (`src/observability/ops.controller.ts`).
- [x] `AI_ALLOWED_USERS` dopasowuje po e-mailu bez `emailVerified`, a
      `POST /auth/apple` ma fallback e-maila z DTO, gdy brak claimu
      (`auth.service.ts` ~90–91). Dopasowywać po `id` albo wymagać
      `emailVerified`; rozważyć usunięcie fallbacku.
      **Zamknięte 7.10.2026:** częściowo już wcześniej — fallback e-maila
      z DTO Apple usunięty 21.09; teraz e-mail z listy liczy się tylko przy
      `emailVerified === true`, id bez zmian (`agent-config.service.ts`,
      commit `4c68ac4`).
- [x] `ConsentEvent.householdId` z klienta bez walidacji członkostwa
      (`consents.service.ts` ~62) — `ensureMembership` albo dom z
      najstarszego członkostwa (uwaga: zgoda bywa zapisywana przed
      założeniem domu).
      **Zamknięte 7.10.2026:** dom zapisywany tylko przy członkostwie, inaczej
      `null` — od 12.09 (`src/consents/consents.service.ts`).
- [x] Kolejność 404→403 zdradza istnienie identyfikatorów
      (`households.service.ts` `getHouseholdOrThrow` przed `ensureMembership`,
      `recipes.service.ts` `findById`). Członkostwo pierwsze albo ten sam 404.
      **Zamknięte 7.10.2026:** członkostwo przed odczytem zasobu
      w `households`/`recipes` od 21.09 (dowód `test/authz-audit.e2e-spec.ts`).
- [ ] `weeklyPlans:getByWeek` oddaje `recipe.authorId`, `recipe.householdId`
      i pełne `RecipeIngredient`; `households:findAll/findById` oddają
      `tierOverride` i `createdById`. Ujednolicić z `recipeListSelect` /
      `HouseholdDto`.
      **Stan 7.10.2026:** `tierOverride` już nie wychodzi; `createdById`
      świadomie w `HouseholdDto`; `authorId` w planie zostaje (Android ma go
      jako wymagane pole klienta OpenAPI).
- [x] Eksport RODO: notatki pamięci domu (`createdByUserId`) i karty
      `PLAN_WEEK`/`SWAP` niosą imiona i `participantIds` innych domowników
      (`user-export.ts` ~228–232, 332–346). Redagować do własnego id.
      **Zamknięte 7.10.2026:** notatki pamięci od 12.09 (autor albo osoba,
      której dotyczą); karty PLAN_WEEK/PLAN_DAY w eksporcie mają już tylko
      własne id i porcję, inni jako liczba `otherParticipants`
      (`redactOthersFromCard`, commit `220d986`).
- [ ] `PURCHASE_IDENTITY_PEPPER` pusty na prod = stały fallback z kodu i
      tylko ostrzeżenie (`billing-env-problems.ts`). Przy `BILLING_ENABLED=true`
      traktować jako naruszenie (świadomie łamie zasadę „płatności nie
      blokują startu” — do decyzji).
      **Stan 7.10.2026:** bez zmian (do decyzji); ostrzeżenie widać teraz też
      na Railwayu — host `*.railway.internal` dotąd je uciszał (`e4fed61`).
- [x] `NODE_ENV` inne niż `production` na zdalnej bazie egzekwuje tylko
      sekrety, nie dev-login (`assert-env.ts`). Przy nielokalnej bazie
      `AUTH_DEV_LOGIN_ENABLED=true` też jako naruszenie.
      **Zamknięte 7.10.2026:** dev-login przy nielokalnej bazie = odmowa
      startu, a Railway (`RAILWAY_ENVIRONMENT*`) liczy się jako baza zdalna
      także przy hoście `*.internal` (`assert-env.ts`, commit `e4fed61`).
- [ ] Throttler i limitery WS w pamięci procesu — poprawne dla jednej
      instancji Railway. Przy skalowaniu: `ThrottlerStorageRedis` i wspólny
      licznik WS.
      **Stan 7.10.2026:** bez zmian — jedna instancja, Redis świadomie nie.
- [x] `prisma-migrate-deploy-safe.js` na Windows używa `shell: true` z
      `DATABASE_URL` jako argumentem (tylko dev). `shell: false` + ścieżka
      do `node_modules/.bin`.
      **Zamknięte 7.10.2026:** `migrate diff --from-schema-datasource
prisma/schema.prisma` — URL z env dziecka, nie z argv (sprawdzone na
      jednorazowej bazie; commit `a8e1239`).
- [ ] Opcjonalnie: App Attest na `POST /auth/apple` i wysyłce wiadomości do
      asystenta, gdy asystent stanie się publicznie płatny.
      **Stan 7.10.2026:** bez zmian — opcjonalne.

### 2.4. Cookidoo — niskie

- [ ] Brak pliku blokady zależności (`requirements.txt` przypina tylko 3
      pakiety, transitive idą luzem). `pip-compile --generate-hashes`
      z Pythona 3.12 (jak w Dockerfile) i instalacja `--require-hashes`.
      **Stan 7.10.2026:** bez zmian — `requirements.txt` przypina 3 pakiety,
      bez hashy.
- [x] Sprawdzić, czy serwis nie ma publicznej domeny na Railway (zgadywane
      nazwy dawały 404; ma być tylko `*.railway.internal`).
      **Zamknięte 7.10.2026:** na Railwayu serwis cookidoo nie ma żadnej
      domeny ani proxy TCP.

### 2.5. iOS — do zrobienia na Macu (wymagają builda)

- [ ] `NSAllowsLocalNetworking` w `Scoffie-Info.plist` obowiązuje też w
      Release. `INFOPLIST_PREPROCESS` z `#if DEBUG` albo osobny plist per
      konfiguracja.
      **Stan 7.10.2026:** do zrobienia w skrypcie build phase na Macu.
- [ ] Zdjąć `userId` z payloadów WS (`WebSocketRecipeTransportClient.swift`,
      `WebSocketShoppingListTransportClient.swift`, `SessionStore.swift`) —
      serwer w `strict` bierze tożsamość wyłącznie z tokenu.
      **Stan 7.10.2026:** backend `userId` z payloadu ignoruje — świadomie
      zostaje.
- [ ] Profil, sylwetka, alergeny, dieta i e-mail leżą w `UserDefaults`
      (jawny plist w backupie). Przenieść do pliku JSON z
      `.completeFileProtectionUntilFirstUserAuthentication` i
      `isExcludedFromBackup = true`; e-mail do Keychain.
      **Stan 7.10.2026:** na Maca, razem z migracją istniejących danych.
- [ ] Cache domowników, katalogu, planu i listy zakupów w `Documents` bez
      wykluczenia z backupu. `Application Support` + `isExcludedFromBackup`
      albo `Caches`.
      **Stan 7.10.2026:** na Maca, razem z migracją istniejących plików.
- [ ] Nieznany kod błędu pokazuje surowy komunikat serwera
      (`UserFacingErrorMapper.swift:127`, `ConsentStore.swift:106`) — kopia
      generyczna, szczegóły tylko w DEBUG.
      **Stan 7.10.2026:** `ConsentStore` poprawiony; `UserFacingErrorMapper`
      na Maca.
- [ ] Opcjonalnie: `NSPinnedDomains` dla `api.scoffie.app` (pin na klucz CA
      pośredniego + zapas).
      **Stan 7.10.2026:** rekomendacja — odrzucić.
- [x] CI: akcje przypięte do SHA zamiast tagów; ID klucza App Store Connect
      w `env:` zamiast w nazwie pliku trafiającej do `GITHUB_OUTPUT`.
      **Zamknięte 7.10.2026:** checkout przypięty do SHA (v7.0.1), gitleaks do
      v3.0.0; ID klucza ASC w CI nieaktualne — build robi Xcode Cloud (iOS,
      commit na gałęzi `fix/audyt-ios-ci-zgody`).
- [x] Polityka prywatności i stopka logowania wymieniają Sentry jako
      odbiorcę błędów aplikacji, a aplikacja nie ma SDK Sentry (tylko
      backend) — doprecyzować „błędów serwera”.
      **Zamknięte 7.10.2026 (nieaktualne):** iOS ma SDK Sentry od 23.09,
      teksty są zgodne.

### 2.6. Dokumentacja i higiena

- [ ] `docs/handover/memory/` — zapisać datę rotacji hasła bazy po jej
      wykonaniu (zasada z `docs/ROTACJA-SEKRETOW.md`).
      **Stan 7.10.2026:** czeka na samą rotację (2.1).
- [ ] Node na maszynie Windows to 24, projekt chce 22 (`engines`). Działa,
      ale CI i Docker chodzą na 22 — rozważyć `fnm`/`nvm` na hoście.
      **Stan 7.10.2026:** bez zmian — host dalej na Node 24.
- [x] Port 5432 na Windows trzyma stary kontener `weeklymeals-db`
      (poprzednia nazwa projektu) — `docker compose up db` nie wstanie,
      dopóki on żyje. Usunąć, jeśli niepotrzebny.
      **Zamknięte 7.10.2026:** kontener `weeklymeals-db` usunięty.

## 3. Stan 20 punktów po audycie

| Punkt                         | Stan      | Uwagi                                                                                                                    |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| Hide API keys                 | OK        | Klucze tylko w env; `.env` w gitignore i dockerignore; iOS bez kluczy; fallbacki w kodzie blokuje asercja na prod.       |
| Purge secrets from Git        | OK        | Historia 3 repo bez prawdziwych kluczy; gitleaks w CI; host proxy bazy prod usunięty ze speców (5.09).                   |
| Expose only the public DB key | N/A       | Klient nie rozmawia z bazą; jedyny publiczny adres to bucket R2 ze zdjęciami.                                            |
| Enable row-level security     | BRAK      | Izolacja aplikacyjna, spójna. Decyzja 7.10: nie teraz — uzasadnienie i warunek powrotu w 2.2.                            |
| Encrypt sensitive data        | OK        | AES-256-GCM (Cookidoo), sha256+pepper (refresh), HMAC (tożsamość zakupowa), kopie bazy `age`; tag GCM przypięty.         |
| Enforce server-side auth      | OK        | Każdy kontroler za JWT/ops; WS przez `actorId`; `soft` na prod = odmowa startu (5.09).                                   |
| Lock record access            | OK        | 0 IDOR w 47 trasach i 45 handlerach; tura asystenta z członkostwem (5.09); Cookidoo tylko autor/właściciel (7.10).       |
| Block field tampering         | OK        | whitelist+forbid, `validateDto` na WS, brak spreadów DTO, pola wrażliwe poza DTO.                                        |
| Secure session cookies        | OK        | Bearer w nagłówku, Keychain bez iCloud, rotacja + reuse detection, kres sesji 180 d (7.10); `JWT_EXPIRES_IN` na Railway. |
| Hash passwords                | OK        | Brak haseł użytkowników (Apple); hasło Cookidoo z konieczności odwracalne; tokeny ops w stałym czasie.                   |
| Rate limit login              | OK        | `/auth/*` 20/min/IP, Cookidoo 5/10 min, WS handshake z ostatnim XFF (5.09), webhook Apple 600/min (5.09).                |
| Add bot protection            | CZĘŚCIOWO | Brak App Attest/captcha; hamulce: Apple ID, kwoty AI, budżet dobowy, allowlista. Opcja w 2.3.                            |
| Parameterize queries          | OK        | Prisma; 2 `$queryRaw` parametryzowane; brak `Unsafe`; regexy nie z wejścia.                                              |
| Validate all input            | OK        | Pipe + `validateDto` + `assertUuid`; `imageUrl` https (5.09); MaxLength (5.09); pydantic `max_length` (5.09).            |
| Escape user content           | OK        | Tylko JSON, Swagger niezamontowany; prompt ogrodzony (5.09).                                                             |
| Restrict file uploads         | OK        | Brak uploadu; `/static` bez listingu; serwer nie pobiera adresów użytkownika.                                            |
| Trim API responses            | CZĘŚCIOWO | `users:me`, domownicy, billing przycięte (5.09); cele/makra domowników — świadomy wybór (2.2, 7.10); drobiazgi w 2.3.    |
| Add security headers          | OK        | HSTS 1 rok, nosniff, X-Frame-Options, Referrer-Policy, COOP, CORP, CSP `none` (5.09); CORS bez obcych origin.            |
| Force HTTPS                   | OK        | 301 na krawędzi Railway; ATS bez wyjątków; `COOKIDOO_SERVICE_URL` pilnowany (5.09); DNS `scoffie.app` w 2.1.             |
| Scan dependencies             | OK        | `pnpm audit` 0 (i w CI od 5.09), OSV PyPI/Swift 0, Dependabot w 3 repo, SPM przypięte do wersji (5.09).                  |

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
