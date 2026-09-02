---
name: project-cookidoo-integration-plan
description: 'Zatwierdzony plan integracji Cookidoo/Thermomix — 4 fazy, decyzje architektoniczne, plik planu'
metadata:
  node_type: memory
  type: project
  originSessionId: 9442c171-bc93-4ad1-942d-1edb9516f6e6
  modified: 2026-08-26T12:17:43.905Z
---

Zatwierdzony (2026-08-26) plan integracji Cookidoo (TM6) w 4 fazach; pełny plan w `/Users/rafi/.claude/plans/kind-dreaming-fern.md`:

1. Nowe repo `weekly-meals-cookidoo` (FastAPI + cookidoo-api, bezstanowy, `X-Internal-Token`, cache sesji per household).
2. Backend: model `CookidooIntegration` (1:1 z household, AES-256-GCM `v1:<iv>:<tag>:<ct>`), moduł `integrations` po **HTTP z JwtAuthGuard** (nie Socket.IO — gatewaye nie uwierzytelniają), kody `COOKIDOO_*`, ekspozycja `sourceProvider`/`sourceRecipeId` w projekcjach recipes.service (dziś ich tam brak mimo deklaracji w DTO).
3. iOS: sekcja "Integracje" w SettingsView + `CookidooIntegrationSheet` (pierwszy SecureField w apce) + `ThermomixInfoSheet`; pierwszy uwierzytelniony REST (`Networking/Integrations/`).
4. iOS: pola source w Recipe (3 miejsca: CodingKeys/init(from:)/memberwise), bump cache v7→v8, badge+filtr `thermomixOnly`, przycisk "Gotuj w Thermomixie" w RecipeDetail.

Decyzje użytkownika: wysyłka **zawsze na dziś**; auto-sync tygodnia odłożony. Zdalne otwarcie ekranu TM6 niemożliwe (sufit = "Mój tydzień"). Prod: Railway, Python bez publicznej domeny, private networking po IPv6 (socket dual-stack w `run.py`, nie `--host ::` — samo `::` binduje v6-only i docker-proxy/healthcheck po IPv4 nie wchodzą).

**DZIAŁA E2E — potwierdzone przez Rafała na prodzie 2026-08-26** (connect konta, „Gotuj w TM" z telefonu, przepis widoczny na TM6). Odłożone pomysły na przyszłość: auto-sync całego tygodnia do Cookidoo, akcja w context menu kalendarza.

**PRODUKCJA WDROŻONA 2026-08-26:** Railway projekt `soothing-celebration`: serwis `weekly-meals-cookidoo` postawiony przez `railway up` (GitHub app nie miała dostępu do repo — `railway add --repo` dawał Unauthorized; kod też na github.com/rpiechowicz/weekly-meals-cookidoo, main+develop), **PORT=8000 przypięty jawnie** (Railway wstrzykiwał 8080, a COOKIDOO*SERVICE_URL celuje w :8000). API `weakly-meals-backend` deployuje z gałęzi `main`; env-y COOKIDOO*\* ustawione przez `railway variables --skip-deploys` PRZED merge (fail-fast na kluczu). Weryfikacja przez /ops/health po commit SHA (grep po logach łapie historyczne deploye!). Prod DB: import polish-classics-11 (bot „Recipe Import Bot", jedyne gospodarstwo „Home"), nutrition 135 wpisów, recompute 89/89, Leczo 1:1 zweryfikowane. Plik z sekretami usunięty — wartości tylko w Railway Variables. Prod-content-update robi się przez `docker exec -e DATABASE_URL=<DATABASE_PUBLIC_URL z serwisu Postgres> weeklymeals-api npx tsx scripts/...`.

**Status 2026-08-26 — WSZYSTKIE 4 FAZY ZAIMPLEMENTOWANE:** repo `weekly-meals-cookidoo` (develop, efdf9dd; cookidoo-api==0.17.2, auth przez cookies w aiohttp — cache sesji trzyma żywe ClientSession per household); backend `feat/integracja-cookidoo` (38028a1, zweryfikowane curl E2E ze złym hasłem aż do prawdziwego Cookidoo); iOS `feat/integracje-cookidoo` (8b14bc9) i `feat/thermomix-przepisy` (ad8de13, stackowany), oba budują się xcodebuildem. Leczo w dev DB podlinkowane do prawdziwego id **r56899**. Zostało: test E2E z prawdziwymi credsami użytkownika (Ustawienia w apce), PR-y do develop, deploy Railway (kolejność: Python → API → iOS). Powiązane: [[project-weekly-meals-stack]], [[project-branching-develop]], [[project-mac-resources-exhausted]].
