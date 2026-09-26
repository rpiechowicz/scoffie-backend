# Scoffie — backend (NestJS 11 + Prisma 6 + Postgres + Socket.IO)

Ten plik czyta Claude Code na każdej maszynie. Pełny kontekst projektu, decyzje
i historia prac leżą w `docs/handover/` (notatki pamięci + snapshot stanu) i
`docs/plans/scoffie-ai-agent/` (analiza asystenta AI, audyt, plastry A–D).
**Zacznij od `docs/handover/2026-08-28-stan.md`.** Rozmawiamy po polsku, na „ty”.

## Aktywny workstream: backend + asystent server-first (26.09.2026)

Dla prac nad wydajnością bazy, katalogu i asystenta AI źródłem prawdy jest
`docs/workstreams/assistant-backend-optimization/`.

**Zanim zaczniesz taki zakres:** przeczytaj kolejno `README.md`, `STATE.md` i
`TASKS.md` z tego folderu. Wykonuj wyłącznie etap oznaczony w `STATE.md` jako
aktywny i zatwierdzony. Po zakończeniu etapu zapisz raport wg
`REPORT_TEMPLATE.md`, zaktualizuj `STATE.md` i **zatrzymaj się** — nie zaczynaj
następnego etapu bez akceptacji Rafała. To ma umożliwić niezależny review między
etapami i mierzenie efektu zmian.

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
- OpenAPI (od 25.09.2026): `openapi/openapi.json` + `openapi/SOCKET-EVENTS.md` są GENEROWANE
  (`pnpm openapi`, ~20 s, bez bazy i sekretów — `AppModule` w trybie `preview`); CI robi
  `pnpm openapi:check`. Zmiana kształtu odpowiedzi REST/acku WS/DTO = regeneruj i commituj razem.
  Wejście opisuje wtyczka `@nestjs/swagger` (uruchamiana w skrypcie, NIE w `nest-cli.json`),
  wyjście — typy TS zwracane przez metody (`typescript-json-schema`), więc ręczne `@ApiOkResponse`
  są zbędne. Swagger UI nie jest wystawiany nigdzie. Kontrolery spoza API aplikacji (panel,
  `/ops`, webhooki) mają `@ApiExcludeController()`.
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
- Katalog przepisów (D1, od 25.09.2026): źródłem prawdy jest BAZA, a
  `prisma/catalog/recipes-catalog-full-v2.json` jej eksportem (`pnpm catalog:export`; co noc
  serwis `catalog-sync` otwiera PR `chore/katalog-z-bazy-<data>` do `develop`). Przepis zmienia
  się w panelu (`PUT /admin/catalog/recipes/:id`), NIE w pliku. Import i panel liczą kolumny
  jedną ścieżką (`src/recipes/catalog/`), więc plik → import → eksport = ten sam plik bajt
  w bajt (`test/catalog-export.e2e-spec.ts`); plik ma układ kanoniczny (pora → tytuł, `id`
  pierwsze, pełne `suitableMealTypes`, `"isActive": false` dla wycofanych) — ręcznie go nie
  formatuj. `recipes:import:json` na NIEPUSTYM katalogu odmawia, gdy baza ma zmiany, których
  plik nie ma (`RECIPE_IMPORT_FROM_JSON_CONFIRM=<dzisiejsza data>` = świadome nadpisanie);
  bootstrap pustej bazy działa bez zmian. Kolejność składników = `[createdAt, id]` (zapis nadaje
  rosnący `createdAt`). Makro = cały przepis, węgle bez błonnika, liczone ze składników.
  `servings` 1..8 (nie „zawsze 2”). Składnik: `name` po polsku, `normalizedName` ASCII = klucz.
- Widoczność przepisów (od Fazy 0, krok 3): `Recipe.isCatalog` rozdziela WSPÓLNY katalog od
  przepisów gospodarstwa. Katalog tworzy WYŁĄCZNIE import (`recipes:import:json`), a zmienia import i panel
  admina; `recipes:create` zawsze daje `isCatalog: false`. Każdy odczyt przepisów MUSI filtrować przez
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
  transakcji) → `ShoppingListArchiveState` → `PlanItem` → `ShoppingListExtra` →
  `ShoppingItemCheck`/`ShoppingList` → `ShoppingListArchive`. Odwrócenie kończy się `40P01 deadlock detected`, którego Prisma NIE mapuje
  na P2034, więc `runSerializable` go nie ponowi i wychodzi 500 (`test/week-lock-order.e2e-spec.ts`). Warunek albo rozliczenie, które musi zapaść RAZEM z zapisem planu, idzie przez haki
  `applyWeekPlan(…, { guard, settle })` — biegną w transakcji, w każdej jej próbie, więc tylko baza
  przez `tx`, żadnych efektów zewnętrznych. Tak działa `AgentProposalsService.undo`: przejęcie
  propozycji (status + `appliedAt`), odcisk, plan, zwrot kwoty i wiadomość w jednej transakcji.
  I tak samo `apply` (od 21.09.2026): przejęcie ze statusu sprzed kliknięcia, ukryte pytanie
  (`editMessage`) = odmowa także z `force`, odcisk spod zamka, plan, `tryConsume` na `tx` (tylko
  gdy są zmiany), wiadomość APPLIED i `appliedHash` — razem albo wcale; poza transakcją zostaje
  wyłącznie WARUNKOWE oznaczenie STALE/FAILED/EXPIRED po odmowie i mail o kwocie. STALE bez
  `force` = 409 `reason:STALE`. Dowód: `test/agent.e2e-spec.ts` › „zapis pod współbieżnością”.
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
- Google sign-in (Android, od 25.09.2026): `POST /auth/google` `{idToken, nonce?, platform?}` → ta sama koperta
  co `/auth/apple`. Weryfikacja `google-auth-library` (`aud` ∈ `GOOGLE_OAUTH_CLIENT_IDS`, czytane per żądanie;
  pusto = 503 `SERVICE_UNAVAILABLE`), zły token = 401 `APPLE_IDENTITY_INVALID` (ten sam kod co Apple). Konto:
  po `googleId`, potem ŁĄCZENIE PO ADRESIE — tylko `email_verified === true` w tokenie i DOKŁADNIE jedno konto
  z tym adresem, `emailVerified` i bez `googleId`; dopisuje się wyłącznie `googleId` (`authProvider`, `appleSub`,
  `identityHash` bez zmian — próba i subskrypcja zostają). Inaczej nowe konto `GOOGLE`. Testy e2e bez sieci:
  `GoogleIdentityService._overrideCerts` + `src/auth/google-id-token.spec-helper.ts`.
- Sesje (audyt 21.09.2026, dowód: `test/auth-session-audit.e2e-spec.ts`): każda transakcja, która WYDAJE albo
  UNIEWAŻNIA refresh tokeny osoby, bierze najpierw `lockUserSessions` (`SELECT … FROM "User" … FOR NO KEY UPDATE`)
  — bez tego unieważnienie nie widziało tokenu wstawianego równolegle i sesja je przeżywała. Token dostępu
  z rotacji/ratunku niesie `tokenVersion` odczytane W tej transakcji. Kasowanie rodziny i `logoutEverywhere`
  (`retireAllUserTokens`) przepisują też powód starych ROTATED/RECOVERED, więc stara kopia kasuje rodzinę RAZ,
  a nie przy każdym użyciu. Następca zgaszony wylogowaniem nie jest dowodem kopii (401 bez kasowania), chyba że
  poprzednik był ratowany (RECOVERED — istnieje para spoza łańcucha). `POST /auth/logout-everywhere`: Bearer
  access token, bez ciała, 200 `{revokedSessions}`.
- Lista zakupów ma DWA źródła (od 21.09.2026): `PlanItem` i `ShoppingListExtra` — „brakuje mi"
  ze szczegółu przepisu (`weeklyPlans:addRecipeExtras` / `removeShoppingExtra`). Telefon wysyła
  tylko `recipeId`, `servings` i id `RecipeIngredient`; ilość, jednostkę i klucz liczy serwer tak
  samo jak dla planu, więc oba źródła sumują się pod jednym `productKey`. Klucz dopisanego to
  `(dom, tydzień, przepis, productKey)` — ponowne dopisanie PODMIENIA ilość. Dopisanie odznacza
  kupione i odsłania listę schowaną po wyczyszczeniu historii. To NIE jest spiżarnia (aplikacja
  dalej nie wie, co stoi w szafce). Pozycje z `getShoppingListState` niosą `addedFrom` (tytuły
  przepisów); archiwa nie. Dowód: `test/shopping-extras.e2e-spec.ts`.
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
  `/auth/refresh` (od 26.09.2026) liczy się per SESJA — hasz przedstawionego refresh tokenu
  (`refreshTokenTracker`, `THROTTLE_AUTH_REFRESH_LIMIT`=10) — z luźną siatką `ip` tylko dla tej trasy
  (`THROTTLE_AUTH_REFRESH_IP_LIMIT`=600); logowanie zostaje 20/min po IP. Uwaga: domyślny
  `generateKey` throttlera ma w kluczu klasę i handler, więc każdy licznik jest PER TRASA.
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
  (disabled → 404 → walidacja → idempotencja po `clientMessageId` → bezpiecznik i zamykany proces
  [503 `AI_UPSTREAM_PAUSED`] → sufity domu z samych wydanych [503] → budżet instalacji z rezerwacją
  [503, NIEATOMOWO] → [tx SERIALIZABLE: lease 409 → semafor domu 409 → sufity domu z rezerwacją
  503 → kwota 429 → zapis]); kwota schodzi NA STARCIE tury i wraca WYŁĄCZNIE za turę, która nic nie
  kosztowała — na każdej ścieżce domknięcia (`AgentUsageLedger.refundIfFree`, warunek
  `costMicroUsd: 0` w samym `updateMany`). `AgentTurnRunner.run` nie rzuca nigdy i domyka turę
  warunkowo (`updateMany` po `status: 'RUNNING'`). W logach asystenta nie ma treści wiadomości —
  tylko `turnId`, `requestId` i kod.
- Księga kosztu asystenta (od 26.09.2026, workstream Etap 1): wiersz `AiUsage` na KAŻDE wywołanie
  dostawcy, zapisany zaraz po nim przez `onUsage` → `AgentUsageLedger.record` (klucz idempotencji
  `(turnId, callIndex)`, jedna transakcja: wiersz + przyrost tokenów/kosztu tury BEZ względu na
  status + liczniki sufitów + cofnięcie zwrotu, gdy koszt dojechał do tury już zwróconej).
  `finishDone`/`finishFailed` NIE piszą już kosztu ani liczników. Nowy dostawca MUSI meldować
  wywołania (`onUsage`), inaczej runner zapisze jeden zbiorczy wiersz po turze i przerwanie z
  zewnątrz zgubi koszt. Raporty liczą tury przez `COUNT(DISTINCT turnId)`, nie wiersze. Werdykt
  księgi (`budgetExceeded`) kończy pętlę narzędzi ostatnim słowem (`stopReason: budget_ceiling`).
  Rezerwacja przy przyjęciu tury: `AI_TURN_COST_RESERVE_USD` (0,25) × inne ŻYWE tury.
- Życie tury (`src/agent/agent-turn-liveness.ts`): runner odświeża `AgentTurn.updatedAt` co 15 s;
  tura RUNNING bez znaku życia od 60 s = osierocona (`AI_PROVIDER_ERROR`), po czasie tury +
  margines = `AI_TIMEOUT`. Jedna definicja dla lease, semafora, leniwego timeoutu i
  `AgentTurnSweeper` (start procesu + co minutę). Tura z mapy TEGO procesu nie jest osierocona
  z powodu ciszy. SIGTERM (`beforeApplicationShutdown`): nowe tury 503, biegnące mają
  `AI_SHUTDOWN_GRACE_MS` (8 s), potem przerwanie bez bezpiecznika — działa TYLKO z
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` > 0 (domyślnie 0 = SIGKILL od razu).
- Karty i propozycje (E2): `AgentMessage.kind` + `card Json` to KONTRAKT z telefonem — karta
  jest DODATKIEM do `text` (nieznany `kind` = klient rysuje sam tekst). Encja `AgentProposal`
  rozdziela INTENCJĘ (`action`, nigdy nie idzie na drut) od WIDOKU (`card`); klient przysyła
  sam `proposalId`. Stan karty (`canApply`/`canUndo`) liczy się PRZY ODCZYCIE, nigdy nie jest
  zapisywany. Zapis planu przenosi się z tury do `POST /agent/proposals/:id/apply` (i `/undo`) —
  bez modelu, czyli za darmo; tam też schodzi kwota `plans`. Tryb: `AI_CARDS_MODE=off|soft|strict`
  - `clientCapabilities: ["cards.v1"]` w `PostMessageDto` → `resolveProposalMode`. **Lista narzędzi
    jest IDENTYCZNA w obu trybach** (liczy się do prefiksu cache, ~8 tys. tokenów); tryb przełącza
    akapit `modeBlock` w bloku gospodarstwa, a bramką jest kod (`refuseOutOfMode` → `AI_TOOL_NOT_IN_MODE`
    jako DANE dla modelu). e2e bez modelu: marker `[[propose:<recipeId>:<YYYY-MM-DD>]]` w stubie
    (kilka markerów = kolejne dni), `[[options:<id>,<id>]]`, `[[revise:<proposalId>:<DZIEŃ>:<PORA>:<id>]]`,
    `[[cost:<µ$>]]` (koszt wywołania 0 przed `AI_STUB_DELAY_MS`).
  - Historia dla modelu niesie karty z poprzednich tur jako zwięzły dopisek (`history-cards.ts`):
    OPTIONS „1) R012 Tytuł; …", najnowsza propozycja planu z id, statusem Z BAZY i pozycjami,
    starsze jedną linią. Poprawka jednej pozycji propozycji PENDING = `revise_proposal` (serwer bierze
    `action.slots`, podmienia cały slot, liczy nową propozycję; starej nie oznacza).
- Katalog dla asystenta (od 26.09.2026, `docs/plans/scoffie-ai-agent/wyszukiwarka-i-tempo-2026-09.md`):
  w prefiksie jest MAPA katalogu (liczby dań na pory i tagi, stały rozmiar), a dania model bierze
  z `find_recipes` (`src/agent/search/`): filtry twarde jedzących tymi samymi funkcjami co walidator
  planu (`diet-rules.util`), kryteria z prośby, ranking (plan tygodnia, ulubione, składniki wspólne
  z planem, popularność), dywersyfikacja. Indeks żyje w pamięci (`AgentCatalogService`, odcisk
  wersji + 10 min), numeracja `R001` = ta sama co digestu. Tagi (rodzaj dania, mięso, smak,
  quick/light/high_protein) liczy `src/recipes/recipe-facets.util.ts` regułami z iOS.
  `AI_CATALOG_MODE=digest` (panel → Sterowanie) wraca do całego katalogu w prompcie bez deployu.
  Karta kończy turę bez ostatniej rundy (`TURN_ENDING_TOOLS`, `stopReason: tool_ended_turn`), gdy
  model napisał zdanie w tej samej wiadomości; `AgentCacheWarmer` pinguje prefiks co 55 min przy
  ruchu w ostatnich `AI_CACHE_WARM_HOURS` (domyślnie 0 = wyłączone; koszt w `AiUsage` jako `cache_warm`).
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
- SQL: Postgres NIE ma publicznego proxy TCP (zdjęty po audycie 12.09.2026) — `DATABASE_PUBLIC_URL`
  nie działa. Do SQL: tymczasowy proxy TCP w panelu serwisu Postgres (Settings → Networking), zdjęty
  zaraz po robocie; skrypty `tsx` przez `railway ssh` idą siecią prywatną (obraz API nie ma `psql`).
  Adresu nigdy w plikach.
- Nocna kopia bazy: serwis cron `db-backup` na Railwayu (`ops/db-backup/`, 03:15 UTC, R2 + age,
  z próbą odtworzenia). NIE GitHub Actions — tam szła przez publiczny proxy i padała od 12.09.
- Nocny eksport katalogu: serwis cron `catalog-sync` (`ops/catalog-sync/`, 03:45 UTC): klon
  `develop`, `pnpm catalog:export` siecią prywatną, przy różnicy commit bota + PR do `develop`
  (otwarty PR bota = aktualizacja jego gałęzi). `CATALOG_SYNC_DRY_RUN=true` = bez pusha.
- Runbooki plastrów: `docs/plans/scoffie-ai-agent/plaster-*/PROD-RUNBOOK.md`.
