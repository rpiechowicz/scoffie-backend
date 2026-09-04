# Scoffie — backend (NestJS 11 + Prisma 6 + Postgres + Socket.IO)

Ten plik czyta Claude Code na każdej maszynie. Pełny kontekst projektu, decyzje
i historia prac leżą w `docs/handover/` (notatki pamięci + snapshot stanu) i
`docs/plans/scoffie-ai-agent/` (analiza asystenta AI, audyt, plastry A–D).
**Zacznij od `docs/handover/2026-08-28-stan.md`.** Rozmawiamy po polsku, na „ty”.

## Repozytoria i środowisko

- Backend: to repo. iOS (SwiftUI): `rpiechowicz/Weekly-Meals` — buduje się TYLKO na Macu
  (`xcodebuild`). Mikroserwis Cookidoo (Python): `rpiechowicz/scoffie-cookidoo`,
  sklonowany OBOK tego repo (`docker-compose.yml` buduje `../scoffie-cookidoo`).
- Dev: `docker compose up -d --build api` (Postgres `db`, `cookidoo`, `api` na :3000).
  `.env` jest w gitignore — klucze wg `.env.example`; od plastra C sekrety w dev muszą mieć
  ≥ 32 znaki, gdy `NODE_ENV=production` (compose ustawia `development`, więc lokalnie luz).
- Prod: Railway, projekt `soothing-celebration`, serwisy `Backend`, `Postgres`, `Cookidoo`;
  `main` deployuje się automatycznie. `https://scoffie-backend-production.up.railway.app`.

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
- Plan tygodnia: `plannedServings` = porcje ŁĄCZNE; brak = policz z audytorium, nigdy 1.
  Kolejność enuma `MealType` jest znacząca; sloty per gospodarstwo + `suitableMealTypes`.
- WebSocket (od Fazy 0): JWT w handshake (`auth: { token }` lub `Authorization: Bearer`) weryfikuje
  `AuthIoAdapter` (`src/common/ws-auth.adapter.ts`, jeden dla 5 gatewayów); tożsamość w handlerze
  WYŁĄCZNIE przez `actorId(client, payload)` (`src/common/ws-socket.ts`), broadcasty przez
  `broadcastToHousehold` do pokoju `household:<id>` (`src/common/ws-rooms.ts`). `WS_AUTH_MODE=soft`
  (domyślnie) wpuszcza stare buildy bez tokenu jako `legacy` z `payload.userId`; `strict` po adopcji
  buildu iOS (metryki `/ops/metrics.wsAuth`).
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
- Schematy narzędzi asystenta mają DWA limity po stronie API i oba wywracają CAŁĄ turę (400),
  zanim model cokolwiek zobaczy: (1) pól nieobowiązkowych w sumie wszystkich `AGENT_TOOLS`
  najwyżej 24, (2) łączny rozmiar gramatyki skompilowanej z narzędzi ze `strict` („compiled
  grammar is too large”). Dlatego `strict` jest WYBIÓRCZY: zostaje na narzędziach o płaskim
  wejściu, schodzi z tych z zagnieżdżonymi listami obiektów (tam waży najwięcej, a walidacja
  DTO i tak sprawdza to samo). Oba limity pilnują spec-i w `agent-tools.spec.ts`, ale jedyny
  pewny sprawdzian to `pnpm exec tsx scripts/agent-tools-smoke.ts` — jedno żądanie do API za
  grosze. Dostawca `stub` schematów NIE OGLĄDA, więc pełna suita bywa zielona przy schematach,
  które padają u każdego użytkownika.
- Safe-migrate przy starcie: migracje → bootstrap tylko na pustej bazie → jednorazowy loader
  tagów, gdy katalog istnieje, a żaden składnik nie ma tagów (`scripts/lib/bootstrap-decision.js`).
  Puste tagi są dla reguł diet faktem („czysto”), nie brakiem danych.

## Operacje na prod (tylko z jawnym „tak” użytkownika przy zapisie)

- Zmienne: `railway variables --service Backend [--skip-deploys --set K=V]`; `railway variable
delete K --service Backend` NIE wyzwala redeployu. Zmienne wymagane przez nowy kod ustawiać
  PRZED merge (asercja sekretów przy starcie; 28.08 kosztowało to ~10 min przestoju).
- Skrypty jednorazowe: `railway ssh --service Backend -- sh -c 'cd /app && pnpm exec tsx scripts/<x>.ts'`.
- Logi: `railway logs --service Backend -d -n 200`; zdrowie `/ops/health`; metryki `/ops/metrics`
  z nagłówkiem `x-ops-token: $OPS_TOKEN`.
- SQL: `psql "$PROD_DB"` gdzie `PROD_DB` = `DATABASE_PUBLIC_URL` serwisu Postgres trzymany
  TYLKO w `export` w terminalu — nigdy w plikach, notatkach ani commitach.
- Runbooki plastrów: `docs/plans/scoffie-ai-agent/plaster-*/PROD-RUNBOOK.md`.
