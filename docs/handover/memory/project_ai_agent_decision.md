---
name: project-ai-agent-decision
description: Stan projektu agenta AI dla Scoffie — analiza z 27.08.2026, plastry A i B na prod, plaster C na prod 28.08 (incydent: merge przed zmiennymi Railway), plaster D (tagi składników) gotowy na fix/fundamenty-d — ostatni przed Fazą 0; trzy decyzje czekają na Rafała.
metadata: 
  node_type: memory
  type: project
  originSessionId: 75609ba4-f8b7-4867-95a1-9fa00f42c5f0
  modified: 2026-08-28T08:24:59.684Z
---

Rafi buduje asystenta AI (czat w miejscu zakładki „Produkty”, planowanie tygodnia,
„mam 3 kg kurczaka…”, podgląd → akceptacja → zapis). Docelowo płatna subskrypcja.

**27.08.2026 — analiza gotowa, kodowanie jeszcze nie ruszyło.** Pełny plan:
artefakt https://claude.ai/code/artifact/fe880174-783b-493c-9017-d014063bca77
(kopia HTML + `unit_econ.py` + model kosztów + briefing API + research rynku w
`/Users/rafi/.claude/plans/scoffie-ai-agent/`). Plan przeszedł 4 niezależne
weryfikacje (kod, API, arytmetyka, spójność) — poprawki wniesione.

Rekomendacje (do potwierdzenia przez Rafała):

- Koncepcja: „kreślarz planu”, nie chatbot — każda rozmowa kończy się `PlanProposal`;
  edycja lokalna bez tokenów; zapis dopiero po „Zastosuj”. Lista zakupów → arkusz
  z ikony koszyka w nagłówkach Planu/Kalendarza.
- Model: **Sonnet 5, effort medium, jeden model na rozmowę** (cel: koszt API ≤30% netto;
  Opus 5 = 65% netto u lekkiego użytkownika przy 29,99 zł). Ewaluacja 20 promptów
  rozstrzyga (Sonnet low/medium/high, Opus low). Haiku 4.5 tylko jako osobna ścieżka
  czatu, nigdy naprzemiennie (cache per model). Cena Haiku spoza dokumentacji.
- Architektura: moduł `src/agent/` w Neście (podtrzymane), REST+JWT+**202 i polling**
  (nie Socket.IO — gatewaye bez auth; nie SSE w v1 — iOS nie ma streamingu).
  6 narzędzi (get_household_context, find_recipes, get_recipe_details, get_week_plan,
  propose_plan, ask_user), brak narzędzia zapisu. Nowe `WeeklyPlansService.applyProposal`
  (jedna transakcja, fingerprint planu, broadcast przez wspólny licznik changeVersion,
  synchronizacja z `SharedMealPlanItem` — bo `saveSharedMealPlan` przycina PlanItemy
  spoza puli). Dwie granice cache: jawna na digeście katalogu (1h) + top-level na ogonie.
- Płatności: RevenueCat; entitlement per user (Apple ID), Pro per gospodarstwo, limity
  per gospodarstwo; dwa liczniki (plany + wiadomości), nigdy tokeny; limit → 429 + karta,
  bez zmiany effort w środku rozmowy. Propozycja: 29,99 zł/mies. + 199,99 zł/rok
  (8 planów + 40 wiadomości) albo 39,99 + 249,99/299,99 (10 + 60). Trial w generacjach.
- Blokery płatnego startu: otwarte `POST /auth/google`, dev-login domyślnie włączony,
  JWT 30d bez odświeżania w iOS (refresh token leży nieużywany), zgoda 5.1.2(i) z nazwą
  Anthropic per domownik, RODO art. 9 (alergeny obojga), auth WS (większy temat, osobno).

**Audyt fundamentów (27.08.2026, przed Fazą 0)** — sekcja „Przed Fazą 0” w artefakcie:
3 plastry (~5–7 dni) + kuracja tagów alergenów równolegle. Najważniejsze, potwierdzone w źródle:
lista zakupów przepisuje nazwy regexami (`/sol/` → fasola = „Sól”, department-classifier.util.ts:142);
9 przepisów to partie na 4 porcje z wymuszonym servings=2 (950–1290 kcal/„porcję”) — konwencja
„cały katalog ma 2” z [[project-planned-servings-semantics]] jest do zmiany na 1..8;
iOS gubi składniki „szczypta” (BackendRecipeDTOs.swift:170-172, 69/89 przepisów);
JWT_SECRET ma publiczny fallback bez asercji na prod; SAFE_MIGRATE_REBUILD_DB dropuje schemat
przy każdym starcie; households.service.spec testuje stub (pliki w iCloud jako dataless);
ts-jest bez type-checku (isolatedModules). Rafał chce te rzeczy naprawić PRZED Fazą 0.

**Plaster A ZROBIONY I WDROŻONY 28.08.2026** (backend 6b8a0f9/3e938ef/183fb17 na `main`,
prod = d621ef0, migracja zastosowana; iOS 1d4db6d/a0c848f na `main`; docs 1ad8eaf na `develop`).
Prod: import katalogu z RETITLE (jogurt → wersja z truskawkami, 7 przepisów servings=4),
15 list zakupów oznaczonych isStale. Zweryfikowane:
jest w kontenerze 118/118, xcodebuild exit 0, re-import na dev (7 przepisów servings=4,
klasyfikator nie dodał slotów), ws-smoke: „Filet z kurczaka”/„Filet z indyka” osobno,
niedzielny weekStart → VALIDATION_ERROR. Gospodarstwo katalogu na dev:
`f23f827f-1ecb-4e07-8c91-9adbf6127ead` (w `.env` jako RECIPE_IMPORT_HOUSEHOLD_ID).
Zostało: TestFlight z main (cache katalogu v11) + ręczne sprawdzenie na iPhonie; rotacja hasła
bazy prod (trafiło do transkryptu). Szczegóły operacyjne: [[project-railway-prod-ops]].
Uwaga: `ws:smoke` przez `pnpm` na hoście trwa >2 min — odpalać w kontenerze
(`docker exec -e WS_URL=http://localhost:3000 scoffie-api pnpm exec tsx scripts/ws-smoke.ts …`).
**Plaster B WDROŻONY NA PROD 28.08.2026** — backend `main` = `1ef311a` (PR #32, Railway 10:19),
iOS `main` = `6f4112b` (PR #64; TestFlight po stronie Rafała). Dane prod: diagnostyka czysta (0 duchów
w przyszłości, 0 śmieci w alergenach, 0 przepisów spoza importera, listy już isStale); jedyny zapis =
DELETE puli (2 pule / 5 pozycji), backup CSV w `~/prod_backup_plaster_b_20260828/` (pg_dump lokalny to
PG16 vs prod PG17 — używać `\copy`). Szczegóły implementacji: gałęzie `fix/fundamenty-b`
(backend `7a5ffc7…ccfab53`: replaceRecipeId, wycofanie puli ze stubem `getSavedPlan`, hooki
składu domu `plan-roster.util.ts`, jeden `normalizeText` w `src/common`, makro liczone przy
`recipes:create`, whitelist alergenów `src/common/allergens.ts`; iOS `b742e53…18bc95f`:
replaceRecipeId, pula usunięta, unia alergenów). Zweryfikowane na dev: jest 338/341 (3 stare
porażki `auth/apple-identity` niezależne), tsc build czysty, xcodebuild OK, ws-smoke wszystkich
punktów OK, pula na dev skasowana (backup w scratchpadzie sesji). Runbook prod:
`~/.claude/plans/scoffie-ai-agent/plaster-b/PROD-RUNBOOK.md` — kolejność backend → SQL → iOS
jest nośna. E2E (`npx jest --config ./test/jest-e2e.json --runInBand` w kontenerze) przechodzi 3/3
tylko z `docker exec -e AUTH_DEV_LOGIN_ENABLED=true …` — obraz ma `false` i dev-login odpowiada 403;
`docker cp test …:/app/test` na istniejący katalog tworzy `/app/test/test` (najpierw `rm -rf`).
Follow-up następnego wydania: usunąć stub getSavedPlan, DROP TABLE SharedMealPlan\*, gałąź SAVE_PLAN
w iOS, kolumna `servingsMode`. Smoke `households:removeMember` na dev zdjął uczestnictwa
„Test Domownika” (`00000000-…dead`) z bieżącego tygodnia i przeliczył wspólne 2→1 (wrócono
SQL-em do 2; członkostwo wstawione z powrotem SQL-em).
**Plaster C WDROŻONY NA PROD 28.08.2026** (backend `main` = `60e3339`, deployment `78cb5bf4` SUCCESS 10:50;
iOS `main` = `2a86c3f`, TestFlight po stronie Rafała). **Incydent**: Rafał zmergował PRZED ustawieniem zmiennych
Railway → deploy 10:39 padł na asercji sekretów i prod nie odpowiadał (timeout, nie 502) ~10 min, aż
ustawiłem `REFRESH_TOKEN_PEPPER` (44 zn.) i `OPS_TOKEN` (32 zn.) i skasowałem `SAFE_MIGRATE_BACKFILL_R2_IMAGE_URLS`.
Wniosek: Railway przełącza ruch na nowy kontener zanim ten jest zdrowy — dodać `healthcheckPath: /ops/health`
w `railway.json` (follow-up). Railway startuje serwis własną komendą `pnpm start:prod` (nie CMD z Dockerfile).
Zweryfikowane na prod: `/ops/metrics` 403/200, `POST /auth/google` 404, `DEV_LOGIN_DISABLED`, `VALIDATION_ERROR`+details,
`x-request-id`, WS `NOT_HOUSEHOLD_MEMBER` z requestId, `users:findAll` bez ACK, `wsErrors.byCode` liczy.
Historia: backend `fix/fundamenty-c`
(`a0ea2f4` C2 … `42c74e1` C5 + `5da64d5` fix corepack dla USER node, 10 commitów z `develop`@ccfab53), iOS `fix/fundamenty-c`
(`f2574d6` C5 kontrakt, `49d8682` C9 cache). Zakres: sekrety fail-fast na NODE_ENV=production
(`src/config/assert-env.ts`), usunięte `users:findAll/findById/create` i `POST /auth/google`,
dev-login opt-in (`AUTH_DEV_LOGIN_ENABLED === 'true'`), strażnik rebuildu (`scripts/lib/rebuild-guard.js`:
CONFIRM = dzisiejsza data UTC, na prod + host z DATABASE_URL), obraz Node 22 + HEALTHCHECK + USER node,
jeden kontrakt błędów `{code, message, details?, requestId}` (HTTP filtr + wsRespond; iOS mapuje po kodzie
w `UserFacingErrorMapper`), prawdziwy spec HouseholdsService (stub i jest-mapper usunięte), `pnpm typecheck`
w CI (spec-i type-checkowane), `configureApp` wspólne z e2e, `OpsTokenGuard` na `/ops/metrics`.
Zweryfikowane w kontenerze: jest 492/492, typecheck 0 błędów, e2e 5/5, xcodebuild OK; dev obraz przebudowany:
healthy, Node 22.23.2, uid 1000, ws-smoke daje HOUSEHOLD_ALREADY_MEMBER/NOT_HOUSEHOLD_MEMBER/INVITATION_NOT_FOUND
z requestId, `users:findAll` bez ACK. Pułapka C4: `corepack prepare` jako root + `USER node` = pusty cache
corepacka → pobieranie najnowszego pnpm przy starcie; rozwiązane wspólnym COREPACK_HOME (Dockerfile). Dev `.env` ma już
nowe sekrety (32 B) + OPS_TOKEN. **Wdrożenie wymaga kolejności**: NAJPIERW zmienne Railway
(`REFRESH_TOKEN_PEPPER` ≥32 — dziś 10 znaków, nowy `OPS_TOKEN`, usunąć `SAFE_MIGRATE_BACKFILL_R2_IMAGE_URLS`),
POTEM merge backendu — inaczej crash-loop na asercji. Runbook:
`~/.claude/plans/scoffie-ai-agent/plaster-c/PROD-RUNBOOK.md`. Bez SQL. iOS niezależnie
(kompatybilność w obie strony). Hasło bazy prod nadal nierotowane.
**Plaster D (tagi składników) WDROŻONY NA PROD 28.08.2026** — backend `main` = `090d10d` (deployment 19884edf 12:06,
migracja tagów zastosowana), loader tagów puszczony na prod przez `railway ssh` 12:20 (403 składniki, 89 przepisów; Żurek
→ celery/eggs/gluten/lactose), iOS `main` = `bbc220e` (Rafał sprawdził na apce prod). WSZYSTKIE plastry A–D zamknięte.
Szczegóły D: — zamyka ostatnie
„przed Fazą 0" z audytu (A1 P0, A2 P0, A3, D6). Backend `fix/fundamenty-d` (`f4b9f24`, po rebase na develop@1355f43 = PR #34 Rafała `decideBootstrap`; wypchnięte, upstream na siebie): plik
`prisma/catalog/ingredient-tags-pl-v1.json` (403 wpisy, klucz normalizedName, allergens[] + dietTags[]),
`src/common/allergens.ts` + celery/mustard/sesame, `src/common/diet-tags.ts` (DIET_TAG_IDS, deriveRecipeTags,
validateIngredientTagEntry), `src/recipes/diet-rules.util.ts` (satisfiesDiet — parytet 1:1 z iOS; walidator
Fazy 0 ma czytać TE funkcje), migracja `20260828150000_tagi_skladnikow_i_przepisow` (Ingredient/Recipe
.allergens/.dietTags TEXT[], GIN), unia w imporcie/recipes:create/`scripts/load-ingredient-tags.ts`
(`pnpm catalog:ingredients:tags`, idempotentny, w bootstrapie po nutrition przed importem),
`getPreferencesForUsers`. iOS `fix/fundamenty-d` (`7bd2949`): Recipe/DTO `allergens?/dietTags?` (nil = brak
z serwera → heurystyka, [] = fakt), `RecipeDietProfile.fromServerTags`, Allergen + 3 case'y, cache v12.
Osobna gałąź backend `fix/railway-healthcheck` (`393faab`, wypchnięta): railway.json healthcheckPath=/ops/health.
iOS D (`7bd2949`) jest JUŻ na `origin/develop` — VS Code „Sync Changes” wypchnął gałąź na jej upstream (develop); main nietknięty.
Lekcja: gałęzie tworzone z `origin/develop` dziedziczą upstream=develop → zawsze `git push -u origin <branch>` zaraz po utworzeniu,
inaczej „Sync” w VS Code pcha commity prosto na develop.
Kuracja: workflow 6 klasyfikatorów + 3 weryfikatorów; parytet z audytem — liczności diet z unii tagów
identyczne z portem Swift (44/1/52/7/6/48), gluten 54 vs 50 = A2. **Kolejność wdrożenia nośna**: backend
→ `pnpm catalog:ingredients:tags` na prod (kolumny puste do pierwszego przebiegu; nowy iOS traktuje [] jako
fakt) → iOS. Runbook: `~/.claude/plans/scoffie-ai-agent/plaster-d/PROD-RUNBOOK.md`.
Pułapki kontenera po C4 (USER node): `docker cp` zostawia pliki roota → `docker exec -u root chown -R node:node`;
obraz nie ma `jest.config.js`, `.prettierrc`, `eslint.config.mjs` — kopiować przed testami/lintem.
Następne: **Faza 0** (auth: refresh tokenu w iOS, auth WS/JWT, throttler, `src/agent` szkielet z AI_ENABLED=false,
pomiar digestu przez count_tokens) + trzy decyzje produktowe Rafała + rotacja hasła bazy prod + miejsce na dysku Maca.

**Trzy decyzje czekają na Rafała:** (1) subskrypcja per dom czy per osoba,
(2) tylko katalog czy generowanie dań, (3) freemium + jaki przydział na paywallu.

Ustalenia z 20.08 nadal obowiązują: model do języka i gustu, kod do liczb i twardych
ograniczeń; Python tylko jako narzędzie (solver), nigdy jako host.

Stack: [[scoffie-stack]]. Powiązane: [[project-meal-slots-architecture]],
[[project-planned-servings-semantics]], [[project-mac-resources-exhausted]].
