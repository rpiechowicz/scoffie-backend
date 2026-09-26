# Raport etapu 00 — Baseline nowego przepływu

**Data:** 2026-09-26  
**Status:** PARTIAL — wszystko poza płatnym przebiegiem na żywym modelu  
**Branch:** `claude/admin-crm-planning-b0hmgo` (HEAD pomiarów: `22aa63c`, czyste drzewo)  
**Zakres z TASKS.md:** Etap 0 — baseline nowego przepływu

## 1. Co zostało zrobione

Fakty:
- Przeczytałem `README.md`, `STATE.md`, `TASKS.md`, `REPORT_TEMPLATE.md`
  i dokumenty kontekstu; sprawdziłem kod harnessu scenariuszy
  (`scripts/agent-scenarios.ts`, `scripts/lib/agent-benchmark-scenarios.ts`),
  runner tury, dostawcę i narzędzia asystenta.
- Znalazłem i naprawiłem trzy rozjazdy harnessu z produkcją (§8) — bez tego
  płatny baseline mierzyłby inną ścieżkę niż ta, którą chodzą użytkownicy.
- Uruchomiłem **wszystkie 40 scenariuszy na sucho** (bez modelu, $0) w trybie
  produkcyjnym: `catalogMode=search`, `cardsMode=strict`, katalog 500 przepisów:
  40/40 ma sprawny harness; `find_recipes` działa w świecie każdego scenariusza.
- Zmierzyłem lokalnie liczbę zapytań DB i czas na ścieżkach asystenta nową
  sondą `scripts/agent-db-probe.ts` (§6).
- Oznaczyłem stare wyniki jako pomiary trybu digest (`benchmark/README.md`)
  i wypisałem z nich wartości referencyjne (§5).

Nie zrobione: **płatny przebieg `pnpm agent:scenarios` — brak zgody**
(zgodnie z poleceniem). Żadna liczba o zachowaniu modelu w nowym przepływie
(rundy, tokeny, koszt, czas, poprawność) nie jest więc zmierzona.

## 2. Zmiany w kodzie

| Plik / moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `scripts/agent-scenarios.ts` | kontekst narzędzi jak w `AgentTurnRunner`: `planScope` (nowy na turę) i `dates` | harness omijał bramkę „najwyżej tydzień na prośbę”, a `find_recipes` rankingował bez planu tygodnia — inna ścieżka niż produkcja |
| j.w. | `--dry` nie wymaga `ANTHROPIC_API_KEY`; na sucho woła też `find_recipes`; odmowa narzędzia na sucho = błąd harnessu | harness da się sprawdzić za darmo i bez sekretów; cicha odmowa narzędzia ukrywałaby zepsuty świat |
| j.w. | metadane przebiegu w JSON (`commit`, `worktreeDirty`, `catalogMode`, `catalogSize`, `cacheWarmHours`); `stopReasons[]` per tura; `--dry --out` zapisuje JSON | bez tego wyników przed/po nie da się uczciwie porównać |
| `scripts/agent-db-probe.ts` (nowy) | lokalna sonda zapytań DB: prompt (search/digest), `find_recipes`, `start_planning`, `getTurn` | baseline DB, powtarzalny tym samym narzędziem po Etapach 3–4 |
| `benchmark/README.md` (nowy) | opis starych wyników jako trybu digest + nowe metadane | żeby nie mieszać pomiarów starego i nowego przepływu |

Kod aplikacji (`src/`) — **bez zmian**. Migracji brak.

## 3. Kontrakty i kompatybilność

- REST / WebSocket / OpenAPI: bez zmian.
- iOS: bez zmian.
- Zmienne środowiskowe: bez zmian (harness czyta istniejące `AI_CATALOG_MODE`,
  `AI_CACHE_WARM_HOURS`).
- Kompatybilność wsteczna: stare pliki JSON nie mają nowych pól — opisane
  w `benchmark/README.md`.

## 4. Testy

Środowisko: lokalny Postgres 16 z pełnym katalogiem (500 przepisów, import
z `recipes-catalog-full-v2.json` przez `pnpm prisma:migrate:deploy`), zmienne
jak w CI (`DATABASE_URL`, `JWT_SECRET`, `AUTH_DEV_LOGIN_ENABLED=true`, …),
**bez** `ANTHROPIC_API_KEY`.

| Test / komenda | Wynik |
|---|---|
| `pnpm typecheck` | exit 0, 0 błędów |
| `pnpm lint:check` | 0 błędów (42 ostrzeżenia, wszystkie istniejące wcześniej, żadne w zmienionych plikach) |
| `pnpm test -- src/agent` | 42 suity, 516 testów — przeszły |
| `pnpm agent:scenarios -- --list` | 40 scenariuszy, 12 grup |
| `AI_PROVIDER=anthropic AI_ENABLED=true pnpm agent:scenarios -- --dry --label dry-etap0 --out <scratch>/dry-etap0.json` | **40/40 sprawny harness**, 0 wywołań modelu, koszt 0; metadane: `commit=22aa63c`, `worktreeDirty=false`, `catalogMode=search`, `catalogSize=500`, `cacheWarmHours=0`, `cardsMode=strict`; w każdym scenariuszu `get_household_context` i `find_recipes` zakończone sukcesem |
| `pnpm exec ts-node -r tsconfig-paths/register scripts/agent-db-probe.ts --runs 5 --out <scratch>/db-probe-etap0.json` | wyniki w §6 |

Na sucho `verify` scenariuszy zgłasza oczekiwane zastrzeżenia („nie użył
offer_options”, „zapisano 0 pozycji z 21”) — nikt nie ułożył planu, bo model
nie był wołany. Istotne: w `g7-domownik-bez-zgody` na sucho **brak** zastrzeżeń
o wycieku imienia/identyfikatora osoby bez zgody przez wynik `find_recipes`
(MEASURED na sucho — sprawdza serwerową część przepływu, nie zachowanie modelu).

## 5. Pomiary przed / po

Nowego przepływu na żywym modelu **nie zmierzono** — kolumna „Po” jest pusta
do czasu płatnego przebiegu. Poniżej wartości referencyjne STAREGO trybu
(digest) z ostatniego pomiaru, jaki mamy.

### 5.1 Referencja: `benchmark/tempo-A-plan-w-prompcie.json` (24.09, digest, Sonnet 5/medium, strict, 12 scenariuszy × 1)

| Scenariusz | Wywołania | Czas | Wyjście tok. | Koszt | Pass | Źródło |
|---|---:|---:|---:|---:|---|---|
| g1-kcal-sroda | 1 | 3,3 s | 126 | $0,032 | ✗ | MEASURED (stary tryb) |
| g1-wtorek-obiad | 1 | 3,6 s | 34 | $0,340* | ✓ | MEASURED (stary tryb) |
| g2-co-na-kolacje | 2 | 8,5 s | 236 | $0,043 | ✓ | MEASURED (stary tryb) |
| g2-cos-szybkiego | 2 | 10,0 s | 584 | $0,048 | ✓ | MEASURED (stary tryb) |
| g3-bez-ryby | 2 | 10,5 s | 764 | $0,059 | ✓ | MEASURED (stary tryb) |
| g3-podmien-kolacje | 2 | 6,4 s | 339 | $0,053 | ✓ | MEASURED (stary tryb) |
| g4-zaplanuj-piatek | 2 | 32,8 s | 990 | $0,061 | ✓ | MEASURED (stary tryb) |
| g5-trzy-dni | 3 | 20,2 s | 1 466 | $0,079 | ✓ | MEASURED (stary tryb) |
| g6-pelny-tydzien | 2 | 49,8 s | 4 520 | $0,104 | ✓ | MEASURED (stary tryb) |
| g8-podzial-posilku | 2 | 13,8 s | 971 | $0,063 | ✓ | MEASURED (stary tryb) |
| g10-lista-zakupow | 2 | 5,2 s | 99 | $0,050 | ✓ | MEASURED (stary tryb) |
| g12-poza-dziedzina | 1 | 5,1 s | 154 | $0,025 | ✓ | MEASURED (stary tryb) |
| **Suma** | **22** | **169,3 s** | **10 283** | **$0,955** | 11/12 | MEASURED (stary tryb) |

\* pierwszy scenariusz przebiegu płaci zapis całego prefiksu do cache
(`cacheWriteTokens` 84 891); bez tego ~$0,03.

W starym trybie każde wywołanie czytało z cache ~81 tys. tokenów prefiksu
(`cacheReadTokens` 81 301 na turach jednego wywołania — MEASURED). `stopReason`
zawsze `end_turn` (mechanizmu `tool_ended_turn` jeszcze nie było).

### 5.2 Rozmiar promptu (nowy vs stary tryb)

| Metryka | Stary (digest) | Nowy (search) | Źródło |
|---|---:|---:|---|
| system prompt tury (instrukcje + katalog + blok domu), znaki | 112 882 | 15 252 | MEASURED (sonda, dom 2 osoby, 4 pozycje planu) |
| blok katalogu, znaki | 99 418 | 1 788 | MEASURED |
| schematy narzędzi (23 narzędzia), znaki | 28 179 | 28 179 | MEASURED |
| instrukcje, znaki | 9 384 | 9 384 | MEASURED |
| stały prefiks (narzędzia + instrukcje + katalog), znaki | ~137 000 | ~39 400 | CALCULATED |
| stały prefiks, tokeny | ~81 tys. (MEASURED z `cacheReadTokens`) | ~25 tys. | ESTIMATE (nie zmierzone — wymaga `count_tokens` z kluczem) |

## 6. Wydajność bazy / API

`scripts/agent-db-probe.ts`, lokalny Postgres, dom 2 osób (jedna bez zgody),
4 pozycje planu, 5 powtórzeń, mediany. **MEASURED lokalnie** — produkcja ma inne
opóźnienia sieciowe; liczby zapytań są przenośne, czasy nie.

| Ścieżka | Zapytań | DB ms | Ściana ms |
|---|---:|---:|---:|
| zimny indeks katalogu (`AgentCatalogService.snapshot`, 1×) | 5 | 22 | 288 |
| `prompt.build` (search) | 15 | 7 | 16 |
| `prompt.build` (digest) | 15 | 3 | 12 |
| `find_recipes` (jedno wywołanie) | 11 | 3 | 14 |
| `start_planning` (kandydaci na 3 pory) | 30 | 24 | 23 |
| `getTurn` RUNNING (serwis) | 3 | 0 | 3 |
| `getTurn` DONE (serwis) | 4 | 0 | 4 |

Uwagi:
- `getTurn` zmierzony na poziomie serwisu; strażnik JWT dokłada odczyt konta
  (`access-token.service.ts`) — **+1 zapytanie na odpytanie (CALCULATED z kodu)**.
  Telefon odpytuje co 1 s przez całą turę.
- `find_recipes` = 11 zapytań (MEASURED). Z kodu wynika m.in.: 2 × odcisk
  wersji katalogu (`aggregate` na `Recipe` i `RecipeIngredient`), 2 × członkostwo
  (kontekst zgód + audytorium), zgody, przepisy domu, plan (2 tygodnie),
  ulubione; reszty nie rozpisywałem zapytanie po zapytaniu (Etap 3/4).
- `start_planning` powtarza cały zestaw na każdą porę (3 × `search`) — 30 zapytań.
- Brak EXPLAIN — przy 500 przepisach i pustej bazie lokalnej plany zapytań nie
  mówią nic o produkcji; to zakres Etapu 4D.

## 7. Ryzyka i regresje

- Nowe ryzyka: brak zmian w kodzie aplikacji. Zmiana harnessu (planScope/dates)
  sprawia, że **nowe wyniki scenariuszy nie są 1:1 porównywalne ze starymi**
  także z tego powodu (obok trybu katalogu) — opisane w `benchmark/README.md`.
- Znane ryzyka pozostawione: nowy przepływ (mapa + `find_recipes` +
  `tool_ended_turn`) działa na produkcji bez pomiaru na żywym modelu
  (domyślnie od commita `19f0aba`); cofnięcie: panel → `AI_CATALOG_MODE=digest`.
- Edge cases: pierwszy scenariusz przebiegu płaci zimny cache (§5.1) — przy
  porównaniach patrzeć na `cacheWriteTokens` albo pomijać pierwszą turę.

## 8. Odstępstwa od planu i rozjazdy plan ↔ kod

1. **Płatny przebieg nie wykonany** (brak zgody) → status PARTIAL. Surowych
   wyników per scenariusz dla nowego przepływu brak.
2. **Harness ≠ produkcja (naprawione, `8c61a00`):** brak `planScope`/`dates`
   w kontekście narzędzi; `--dry` wymagał klucza API; brak metadanych przebiegu.
3. **Zestaw scenariuszy ma lukę na przyszłe etapy:** jest tylko jeden scenariusz
   wieloturowy (`g12-dluga-rozmowa`, 15 tur) i **żaden** nie sprawdza
   kontynuacji po karcie („Wybieram: …”, „Zamień w tej propozycji …”) — czyli
   dokładnie problemu z Etapu 1. Scenariusze do dopisania w Etapie 1 (przed
   zmianą), żeby mieć „przed”.
4. **Brak metryki odchylenia kcal/makro w harnessie.** Tolerancje są tylko
   w `verify` kilku scenariuszy (g4: 15 %, g5: ±35 %) jako pass/fail; rekord
   nie zapisuje odchylenia od celu per osoba/dzień. Potrzebne przed Etapem 2
   (planer), inaczej „trafienie w cele” nie będzie porównywalne.
5. **TASKS Etap 1 — „jawnie wymagać `isCatalog: true`”:** potwierdzone w kodzie —
   indeks katalogu buduje się po `householdId = RECIPE_IMPORT_HOUSEHOLD_ID`
   i `isActive`, bez `isCatalog` (`agent-catalog.service.ts`, `build`), tak samo
   jak dawny digest (`loadDigestRecipes`). Nie naprawiam (Etap 1).
6. **TASKS Etap 4B — popularność „per przepis”:** kod robi JEDNO `groupBy` po
   wszystkich `PlanItem` bez filtra (co 30 min, w trakcie czyjegoś
   `find_recipes`) — problemem jest pełny skan w ścieżce użytkownika, nie N
   zapytań. Opis w TASKS warto doprecyzować.
7. **Liczba narzędzi:** 23 w `AGENT_TOOLS` (+ `start_planning` w trybie
   przekazania; 14 w warstwie rozmowy) — dokumenty mówią „~24”. Drobne.
8. **Stare scenariusze a nowy tryb:** kontrakty (`maxRounds`, `expectedTools`)
   są zgodne z nowym przepływem — „co na kolację” to `find_recipes` +
   `offer_options` (2 wywołania, sufit 3); pytania o plan nie potrzebują
   wyszukiwania. Komentarze o „digeście” w scenariuszach g11 dalej są prawdziwe
   w sensie „własny przepis poza planem jest nieosiągalny” (teraz też przez
   `find_recipes` z przepisami domu — do weryfikacji w płatnym przebiegu).

## 9. Decyzje potrzebne od Rafała

1. **Zgoda na płatny baseline** — propozycja (koszty ESTIMATE):
   - wariant minimalny, porównywalny ze starym pomiarem — te same 12 scenariuszy
     co `tempo-A-plan-w-prompcie`, konfiguracja A, **3 przebiegi**:
     ```
     pnpm agent:scenarios -- --only g1-kcal-sroda,g1-wtorek-obiad,g2-co-na-kolacje,g2-cos-szybkiego,g3-bez-ryby,g3-podmien-kolacje,g4-zaplanuj-piatek,g5-trzy-dni,g6-pelny-tydzien,g8-podzial-posilku,g10-lista-zakupow,g12-poza-dziedzina --config A --runs 3 --label etap0-search
     ```
     szacunek **$2–3** (stary tryb: $0,96 za 1 przebieg; nowy prefiks mniejszy,
     ale `find_recipes` dokłada rundy — stąd widełki);
   - wariant pełny — 40 scenariuszy × 1 (`--config A --label etap0-search-full`),
     szacunek **$3–6** (stary tryb `off`: ~$5,2 za 40 scenariuszy).
   Wymaga `ANTHROPIC_API_KEY` i bazy z katalogiem (dev albo lokalna).
2. Czy Etap 1 może ruszyć bez płatnego baseline'u (świadomie tracimy „przed”
   dla rund i kosztu), czy najpierw baseline.

## 10. Co proponujesz dalej

1. Wykonać wariant minimalny płatnego baseline'u (po zgodzie) i dopisać wyniki
   do tego raportu (§5, kolumna „Po”).
2. Na starcie Etapu 1 (przed zmianami): dopisać scenariusze kontynuacji po
   karcie („Wybieram: …”, „Zamień w tej propozycji wtorek…”) i puścić je jako
   „przed”.
3. Przed Etapem 2: metryka odchylenia kcal/makro per osoba/dzień w rekordzie
   harnessu.

## 11. Commity

- `8c61a00` — fix(benchmark): harness scenariuszy jak runner produkcyjny i darmowy przebieg na sucho
- `22aa63c` — chore(benchmark): sonda zapytań DB asystenta i opis starych wyników
- (ten raport + `STATE.md`) — commit dokumentacji Etapu 0
