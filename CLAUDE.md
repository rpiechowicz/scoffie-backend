# Scoffie — backend (NestJS 11 + Prisma 6 + Postgres + Socket.IO)

Ten plik czyta Claude Code na każdej maszynie. Pełny kontekst projektu, decyzje
i historia prac leżą w `docs/handover/` (notatki pamięci + snapshot stanu) i
`docs/plans/scoffie-ai-agent/` (analiza asystenta AI, audyt, plastry A–D).
**Zacznij od `docs/handover/2026-08-28-stan.md`.** Rozmawiamy po polsku, na „ty”.

## Repozytoria i środowisko

- Backend: to repo. iOS (SwiftUI): `rpiechowicz/scoffie-ios` — buduje się TYLKO na Macu
  (`xcodebuild`). Mikroserwis Cookidoo (Python): `rpiechowicz/scoffie-cookidoo`,
  sklonowany OBOK tego repo (`docker-compose.yml` buduje `../scoffie-cookidoo`).
- Dev: `docker compose up -d --build api` (Postgres `db`, `cookidoo`, `api` na :3000).
  `.env` jest w gitignore — klucze wg `.env.example`; od plastra C sekrety w dev muszą mieć
  ≥ 32 znaki, gdy `NODE_ENV=production` (compose ustawia `development`, więc lokalnie luz).
- Prod: Railway, projekt `scoffie`, środowisko `production`, serwisy `scoffie-backend`
  (domena `api.scoffie.app`), `Postgres`, `Postgres-PITR`, `scoffie-cookidoo`;
  `main` deployuje się automatycznie. Nazwy sprzed rebrandingu (`soothing-celebration`,
  serwis `Backend`) są NIEAKTUALNE — komenda z nimi kończy się „service not found".

## Git

- Gałęzie z `develop` po `git fetch --prune`; PR → `develop` → `main` (= prod).
- **Nową gałąź od razu `git push -u origin <gałąź>`** — gałąź utworzona z `origin/develop`
  dziedziczy upstream=develop i „Sync” w VS Code wypycha commity prosto na develop.
- Commity po polsku, prefiks conventional (`feat(zakres):`, `fix(…)`, `chore(…)`, `docs(…)`),
  treść wyjaśnia DLACZEGO; `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Hooki husky bywają wolne — `git -c core.hooksPath=/dev/null commit --no-verify` jest OK,
  bo CI i tak robi lint/typecheck/test.

## Weryfikacja (co robi CI: `pnpm lint:check`, `pnpm typecheck`, `pnpm build`, `pnpm test`, e2e)

- `pnpm test` (jest z `NODE_OPTIONS=--experimental-vm-modules` — bez tej flagi
  `apple-identity` pada na dynamicznym `import('jose')`).
- `pnpm typecheck` = `tsc -p tsconfig.typecheck.json` (obejmuje src, test, scripts, seed).
- e2e: `pnpm test:e2e:ci` z działającą bazą, `AUTH_DEV_LOGIN_ENABLED=true OPS_TOKEN=ci-ops-token`.
- Nie odpalaj lintera po każdej zmianie — tylko na koniec albo na życzenie.
- Windows (od 28.08.2026, Git Bash): `pnpm install` + `pnpm prisma:generate` na hoście, potem
  `pnpm test` (~1 min, `cross-env` ustawia `NODE_OPTIONS`), `pnpm typecheck`, `pnpm lint:check`
  (~1 min) działają bez kontenera. SQL do dev: `docker compose exec -T db psql -U scoffie
-d scoffie -At -c "…"`. LF wymusza `.gitattributes` (`* text=auto eol=lf`); ta maszyna ma dodatkowo lokalnie `core.autocrlf=false`. Brak `gh` i `railway`
  CLI na tej maszynie — PR-y i prod robi Rafał (telefon/Mac).
- Po zmianie `prisma/schema.prisma`: `pnpm prisma:generate` (lokalny klient bywa przestarzały).
- Alternatywa (używana na Macu z wyczerpanymi zasobami): kopiować `src test scripts prisma`
  do kontenera `scoffie-api` (`rm -rf` celu przed `docker cp`, potem
  `docker exec -u root … chown -R node:node`), dołożyć `jest.config.js`, `.prettierrc`,
  `eslint.config.mjs` (obraz ich nie ma) i uruchamiać `npx jest` / `npx tsc` w środku.

## Konwencje domenowe (szczegóły w docs/handover/memory)

- Błędy: `AppException(code, message, status, details?)`, kody w `src/common/app-error-code.ts`;
  HTTP i WS oddają `{code, message, details?, requestId}` — iOS mapuje po `code`
  (`UserFacingErrorMapper`), więc nowy kod = nowa kopia po stronie klienta.
- Alergeny: id w `src/common/allergens.ts` = `enum Allergen` w iOS; nowa wartość NAJPIERW na prod.
  Tagi składników: `prisma/catalog/ingredient-tags-pl-v1.json` → `pnpm catalog:ingredients:tags`
  (idempotentny, przelicza `Recipe.allergens/dietTags`); reguły diet w
  `src/recipes/diet-rules.util.ts` mają parytet 1:1 z iOS — walidator asystenta czyta JE.
- Katalog przepisów: `prisma/catalog/recipes-catalog-full-v2.json` = źródło prawdy; zmiana
  w JSON = import na prod. Makro = cały przepis, węgle bez błonnika, liczone ze składników.
  `servings` 1..8 (nie „zawsze 2”). Składnik: `name` po polsku, `normalizedName` ASCII = klucz.
- Widoczność przepisów (od Fazy 0, krok 3): `Recipe.isCatalog` rozdziela WSPÓLNY katalog od
  przepisów gospodarstwa. Katalog tworzy WYŁĄCZNIE import (`recipes:import:json`); `recipes:create`
  zawsze daje `isCatalog: false`. Każdy odczyt przepisów MUSI filtrować przez
  `OR: [{ isCatalog: true }, { householdId }]` — `findAll` (bez `householdId` widać sam katalog),
  `findById` (cudzy przepis = 404, nie 403) i `ensureRecipeForHousehold` (bramka wstawiania do
  planu). Klucz cache listy niesie `householdId`, bo wynik zależy od pytającego. Dowód na żywej
  bazie: `test/catalog-visibility.e2e-spec.ts`.
- Operacja wsadowa na tydzień (od Fazy 1): `weeklyPlans:applyWeekPlan` przyjmuje STAN DOCELOWY
  (`slots[]`, czego nie ma na liście — tego nie ma w planie) i liczy różnicę wobec bazy w jednej
  transakcji `runSerializable`, z JEDNYM broadcastem. Nie `clearWeekPlan` + zapis od nowa, bo clear
  kasuje archiwa list zakupów. Naruszenia wracają LISTĄ (`violations[]` z `index` w `slots`), a nie
  wyjątkiem, i przy jakimkolwiek naruszeniu NIC się nie zapisuje — także bez `dryRun`. Limity liczą
  się od stanu docelowego. `dryRun: true` = policz i sprawdź, nie zapisuj (właściwy tryb dla asystenta).
- Zamek zapisu tygodnia (od 21.09.2026): KAŻDA transakcja zmieniająca `PlanItem` woła najpierw
  `lockWeekForWrite(tx, weeklyPlanId)` (`src/weekly-plans/utils/week-write-lock.util.ts`; zmiana składu
  domu: `lockWeeksForWriteFrom`) — `UPDATE` wiersza `WeeklyPlan`, który szereguje piszących, a w
  SERIALIZABLE wymusza ponowienie na świeżej migawce. Nowa ścieżka zapisu bez zamka = dziura w
  „Cofnij". KOLEJNOŚĆ BLOKAD jest jedna dla wszystkich: zamek tygodnia (pierwsza blokada
  transakcji) → `ShoppingListArchiveState` → `PlanItem` → `ShoppingItemCheck`/`ShoppingList` →
  `ShoppingListArchive`. Odwrócenie kończy się `40P01 deadlock detected`, którego Prisma NIE mapuje
  na P2034, więc `runSerializable` go nie ponowi i wychodzi 500 (`test/week-lock-order.e2e-spec.ts`). Warunek albo rozliczenie, które musi zapaść RAZEM z zapisem planu, idzie przez haki
  `applyWeekPlan(…, { guard, settle })` — biegną w transakcji, w każdej jej próbie, więc tylko baza
  przez `tx`, żadnych efektów zewnętrznych. Tak działa `AgentProposalsService.undo`: przejęcie
  propozycji (status + `appliedAt`), odcisk, plan, zwrot kwoty i wiadomość w jednej transakcji.
- Kontrole dostępu a współbieżność (audyt autoryzacji 21.09.2026, dowód: `test/authz-audit.e2e-spec.ts`):
  (1) bramka członkostwa idzie PRZED odczytem zasobu — obcy dostaje `NOT_HOUSEHOLD_MEMBER` tak samo dla
  domu/przepisu istniejącego i nieistniejącego (odwrotna kolejność = wyrocznia istnienia); (2) zapis oparty
  na tym, KTO jest właścicielem (degradacja, `removeMember`, rozliczenie domu po wyjściu), bierze
  `lockHouseholdRoster(tx, householdId)` i liczy `ensureOwnerInTx`/właścicieli W transakcji — zamek składu
  idzie PRZED zamkiem tygodnia, a kto trzyma zamek tygodnia, nie sięga po ten; (3) transakcje zapisu planu
  wołają po `lockWeekForWrite` jeszcze `ensureMembershipInTx(tx, userId, householdId, participantIds)`;
  (4) `removeMember` gasi WSZYSTKIE otwarte zaproszenia domu (`revokeOpenInvitationsOf`) — wyrzucony zna
  też cudze linki; `leave` tego nie robi; (5) `acceptInvitation` ma ważność i `declinedAt` w warunku
  samego `updateMany`, nie tylko w kontroli przed transakcją.
- Trasy `/ops/*` (poza `/ops/health`): `OpsTokenGuard` jest fail-closed — pusty `OPS_TOKEN` = 403 w KAŻDYM
  środowisku (dev, staging, prod); jedyny wyjątek to dokładnie `NODE_ENV=test`. Tokenu nie logujemy.
- Apple sign-in: adres e-mail i `emailVerified` idą WYŁĄCZNIE z claimów zweryfikowanego identity tokenu;
  `dto.email` zostaje w kontrakcie, ale niczego nie zapisuje (rozjazd = ostrzeżenie bez adresów w logu).
- Plan tygodnia: `plannedServings` = porcje ŁĄCZNE; brak = policz z audytorium, nigdy 1.
  Kolejność enuma `MealType` jest znacząca; sloty per gospodarstwo + `suitableMealTypes`.
- WebSocket (od Fazy 0): JWT w handshake (`auth: { token }` lub `Authorization: Bearer`) weryfikuje
  `AuthIoAdapter` (`src/common/ws-auth.adapter.ts`, jeden dla 5 gatewayów); tożsamość w handlerze
  WYŁĄCZNIE przez `actorId(client, payload)` (`src/common/ws-socket.ts`), broadcasty przez
  `broadcastToHousehold` do pokoju `household:<id>` (`src/common/ws-rooms.ts`). Produkcja chodzi w
  `strict` (domyślne przy braku `WS_AUTH_MODE`, a jawne `soft` z `NODE_ENV=production` to odmowa
  startu — audyt 5.09.2026). `soft` zostaje TYLKO poza produkcją dla `pnpm ws:smoke`: socket bez
  tokenu wchodzi jako `legacy` z `payload.userId`, czyli podszywa się pod kogo chce.
- Walidacja wejścia (od Fazy 0, krok 2): globalny `ValidationPipe` obejmuje TYLKO HTTP, a pipe na
  WS omijałby ack — dlatego JAWNIE: serwis waliduje DTO na wejściu (`dto = await validateDto(XDto, dto)`,
  `src/common/validate-dto.ts`; ten sam pipe i format `details`, co HTTP; chroni też narzędzia
  asystenta wołające serwisy in-process), handler WS waliduje kopertę (`await validateWsPayload(XPayload,
payload)` PO `actorId`), skalarne id przez `assertUuid` (`src/common/uuid.ts`) w bramkach
  (`ensureMembership`, `getHouseholdOrThrow`, …). Każde pole koperty MUSI mieć dekorator (whitelist
  wycina resztę). Nowy handler bez wpisu w `src/common/ws-payload-fixtures.spec-helper.ts`
  (VALID_PAYLOADS/INVALID_PAYLOADS per zdarzenie) = czerwony `ws-handlers-validation.spec.ts`.
- Limity żądań (od Fazy 0, krok 3): HTTP przez globalny `AppThrottlerGuard`
  (`src/common/throttle/`) — tracker `user:<sub>` z ZWERYFIKOWANEGO tokenu, inaczej `ip:<adres>`;
  limity to funkcje czytające `THROTTLE_*` z env PER ŻĄDANIE (`readThrottleLimit`), więc nowy
  limit nie wymaga builda. Nowy kontroler ostrzejszy niż domyślny = `@Throttle({ default: { limit:
() => readThrottleLimit('…') } })`; sondy = `@SkipThrottle({ default: true, ip: true })`.
  WebSocket ma własny limiter (`checkWsRateLimit` w `actorId`), bo guard omija ack.
- Zaproszenia: w bazie leży tylko `Invitation.tokenHash` (sha256 hex, bez peppera); surowy token
  istnieje wyłącznie w odpowiedzi `households:createInvitation`. Skrzynka oddaje w polu `token`
  uchwyt `inv_<id>`, ważny tylko dla adresata (`invitationLookup`). Kolumna `token` jest WYCOFYWANA
  — nie czytać, nie zapisywać; plan kroku 2: `docs/ZAPROSZENIA-HASZ-TOKENU.md`.
- Asystent AI (`src/agent/`, od Fazy 0, krok 3): moduł JEDNOKIERUNKOWY — wolno mu wołać domenę
  i obserwowalność, nic w aplikacji nie importuje `src/agent/` (pilnuje `no-restricted-imports`;
  wyjątek: `AppModule`). W `src/agent/**` reguły `no-unsafe-*` są BŁĘDEM, nie ostrzeżeniem.
  Konfiguracja przez `AgentConfigService.assertEnabled()` (czyta env per wywołanie; `AI_ENABLED=false`
  = 503 `AI_DISABLED`). Kontrakt: `POST /agent/conversations/:id/messages` → 202 `{turnId,…}` +
  `Location`, klient odpytuje `GET /agent/turns/:id`. Kolejność odmów jest częścią kontraktu
  (disabled → 404 → walidacja → idempotencja po `clientMessageId` → bezpiecznik → budżet →
  [tx: lease 409 → kwota 429 → zapis]); kwota schodzi NA STARCIE tury i wraca przy porażce.
  `AgentTurnRunner.run` nie rzuca nigdy i domyka turę warunkowo (`updateMany` po `status: 'RUNNING'`).
  W logach asystenta nie ma treści wiadomości — tylko `turnId`, `requestId` i kod.
- Karty i propozycje (E2): `AgentMessage.kind` + `card Json` to KONTRAKT z telefonem — karta
  jest DODATKIEM do `text` (nieznany `kind` = klient rysuje sam tekst). Encja `AgentProposal`
  rozdziela INTENCJĘ (`action`, nigdy nie idzie na drut) od WIDOKU (`card`); klient przysyła
  sam `proposalId`. Stan karty (`canApply`/`canUndo`) liczy się PRZY ODCZYCIE, nigdy nie jest
  zapisywany. Zapis planu przenosi się z tury do `POST /agent/proposals/:id/apply` (i `/undo`) —
  bez modelu, czyli za darmo; tam też schodzi kwota `plans`. Tryb: `AI_CARDS_MODE=off|soft|strict`
  - `clientCapabilities: ["cards.v1"]` w `PostMessageDto` → `resolveProposalMode`. **Lista narzędzi
    jest IDENTYCZNA w obu trybach** (liczy się do prefiksu cache, ~8 tys. tokenów); tryb przełącza
    akapit `modeBlock` w bloku gospodarstwa, a bramką jest kod (`refuseOutOfMode` → `AI_TOOL_NOT_IN_MODE`
    jako DANE dla modelu). e2e bez modelu: marker `[[propose:<recipeId>:<YYYY-MM-DD>]]` w stubie.
- Postęp tury (`AgentTurn.progress`, `src/agent/agent-progress.ts`): kroki narzędzi plus kroki
  PRZEJŚCIOWE (`transient: true`) — `read` (start tury), `reason` (blok myślenia w strumieniu),
  `write` (pierwszy fragment tekstu), `think` (cisza po narzędziach). Dostawca melduje je przez
  `onActivity`/`onThinking`, telefon pokazuje na żywo obok tykającego czasu, a przy domknięciu tury
  `settledProgress` zdejmuje je z zapisu — po turze zostają narzędzia i zapis (e2e liczy na to).
- Schematy narzędzi asystenta mają DWA limity po stronie API i oba wywracają CAŁĄ turę (400),
  zanim model cokolwiek zobaczy: (1) pól nieobowiązkowych w sumie wszystkich `AGENT_TOOLS`
  najwyżej 24, (2) łączny rozmiar gramatyki skompilowanej z narzędzi ze `strict` („compiled
  grammar is too large”). Dlatego `strict` jest WYBIÓRCZY: zostaje na narzędziach o płaskim
  wejściu, schodzi z tych z zagnieżdżonymi listami obiektów (tam waży najwięcej, a walidacja
  DTO i tak sprawdza to samo). Oba limity pilnują spec-i w `agent-tools.spec.ts`, ale jedyny
  pewny sprawdzian to `pnpm exec tsx scripts/agent-tools-smoke.ts` — jedno żądanie do API za
  grosze. Dostawca `stub` schematów NIE OGLĄDA, więc pełna suita bywa zielona przy schematach,
  które padają u każdego użytkownika. **Budżet pól nieobowiązkowych jest WYCZERPANY: 24/24**
  (stan 18.09.2026), więc nowe narzędzie może mieć wyłącznie pola wymagane — albo trzeba
  najpierw zwolnić miejsce w istniejących. Jak liczyć: spec „pól nieobowiązkowych mieści się
  w limicie (24)” w `agent-tools.spec.ts`.
- Safe-migrate przy starcie: migracje → bootstrap tylko na pustej bazie → jednorazowy loader
  tagów, gdy katalog istnieje, a żaden składnik nie ma tagów (`scripts/lib/bootstrap-decision.js`).
  Puste tagi są dla reguł diet faktem („czysto”), nie brakiem danych.

## Operacje na prod (tylko z jawnym „tak” użytkownika przy zapisie)

- Zmienne: `railway variables --service scoffie-backend [--skip-deploys --set K=V]`; `railway variable
delete K --service scoffie-backend` NIE wyzwala redeployu. Zmienne wymagane przez nowy kod ustawiać
  PRZED merge (asercja sekretów przy starcie; 28.08 kosztowało to ~10 min przestoju).
- Skrypty jednorazowe: `railway ssh --service scoffie-backend -- sh -c 'cd /app && pnpm exec tsx scripts/<x>.ts'`.
- Logi: `railway logs --service scoffie-backend -d -n 200`; zdrowie `/ops/health`; metryki `/ops/metrics`
  z nagłówkiem `x-ops-token: $OPS_TOKEN`.
- SQL: `psql "$PROD_DB"` gdzie `PROD_DB` = `DATABASE_PUBLIC_URL` serwisu Postgres trzymany
  TYLKO w `export` w terminalu — nigdy w plikach, notatkach ani commitach.
- Runbooki plastrów: `docs/plans/scoffie-ai-agent/plaster-*/PROD-RUNBOOK.md`.
