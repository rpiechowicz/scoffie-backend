# Raport etapu 06.1 — Naprawa regresji z finalnego benchmarku (offline)

**Data:** 2026-09-26  
**Status:** DONE OFFLINE — backend regressions fixed and deterministically verified; final live smoke deferred  
**Branch:** `claude/admin-crm-planning-b0hmgo`  
**Zakres:** 7 regresji z `reports/06-model-evaluation.md` §8, bez nowych wywołań AI

```
LIVE API CALLS DURING 6.1: 0
LIVE API COST: $0.00
```

Każde uruchomienie testów, harnessu i skryptów w tym etapie szło z usuniętym
`ANTHROPIC_API_KEY` (`env -u ANTHROPIC_API_KEY …`; nowy e2e dodatkowo kasuje go w
`beforeAll`). Dostawca w e2e: `stub`; harness scenariuszy: tryb `--dry`.
Materiał diagnostyczny: surowe wyniki Etapu 6 (`benchmark/final-model-eval/`).

## 1. Przyczyny wszystkich 7 przypadków (potwierdzone w kodzie)

| # | Scenariusz | Wynik w Etapie 6 | Przyczyna | Warstwa |
|---|---|---|---|---|
| 1 | `g4-dzien-w-limicie-kcal` | anchor 3/3 → HEAD 0/3 | `build_meal_plan` nie miał pola na limit kcal z ROZMOWY; planer liczył od celu z profilu (2200) → środa 2080 kcal przy „zmieść się w 1800” | kontrakt narzędzia + planer |
| 2 | `g8-podzial-posilku` | 3/3 → 0/3 | (a) routing: model wybierał `suggest_meals`/`propose_swap` zamiast `propose_household_split`; opisy nie rozdzielały tych dróg; `propose_household_split` wymagał listy identyfikatorów osób; (b) weryfikator żądał DWÓCH dań i odrzucał poprawny wynik „jedno danie, porcje osób od serwera” (Haiku zrobił dokładnie to 3/3 i dostał FAIL) | opisy narzędzi + kontrakt + weryfikator |
| 3 | `g9-nierealny-czas` | 3/3 → 1/3 | `max_prep_minutes` w planie był wyłącznie MIĘKKĄ podpowiedzią, a przekroczenie szło jako `PREP_TIME_EXCEEDED` z poziomem `info`, który `plannerResultForModel` wycina — planer oddawał tydzień z daniami po 15–60 min bez słowa o limicie, model pisał „wszystkie do 5 minut” | planer + diagnostyka |
| 4 | `g11-przepis-katalogowy` | 2/3 → 0/3 | opis `update_recipe` SAM kazał: „Przepisów z katalogu nie da się zmienić — zrób własną kopię przez create_recipe”; model więc kopiował przepis (13× `search_ingredients`) albo zmieniał porcje w planie przez `propose_day_plan`, a zdanie serwera propozycji przykrywało wyjaśnienie | kontrakt narzędzia + odpowiedź kończąca |
| 5 | `g10-luka-makro` | 1/3 → 0/3 | weryfikator wymagał przepisania liczby z karty w zdaniu; karta i wynik narzędzia były zgodne | weryfikator |
| 6 | `g13-pokaz-inne` | 0/3 i 0/3 | `suggest_meals` nie pamiętał pokazanych dań — ta sama prośba = te same 3 dania | narzędzie |
| 7 | `g13-zmiana-w-propozycji` | 0/3 i 0/3 | **backend był poprawny**: `replace_plan_item` z `diet: VEGETARIAN` dawał „Burgery z czerwonej fasoli” (brak MEAT/FISH/CRUSTACEAN) i nie ruszał B1/L1 — identycznie dla trzech modeli. Weryfikator (dopisany w Etapie 6) szukał etykiety `VEGETARIAN` w `dietTags`, które są KATEGORIAMI składników (MEAT, DAIRY, LEGUME…) | weryfikator |

## 2. Testy FAIL przed poprawką

Zapis wyjść: `benchmark/regression-6-1/tests-before-fix.txt`.

| Test | Przed poprawką | Jak sprawdzone |
|---|---|---|
| `test/regression-6-1.e2e-spec.ts` › g4 | FAIL: `avgTargetKcal` 2200 zamiast 1800 | kod sprzed zmian |
| › g8 | FAIL: `VALIDATION_ERROR Podaj, kto je to danie` przy `portions: []` | kod sprzed zmian |
| › g9 | FAIL: 7 dni zaplanowanych, `issues` tylko KCAL_OUT_OF_TOLERANCE — zero słowa o czasie | kod sprzed zmian |
| › g11 | FAIL: `update_recipe` = błąd, nie wynik „tylko do odczytu” kończący turę | kod sprzed zmian |
| › g13-pokaz-inne | FAIL: druga karta = te same dania | kod sprzed zmian |
| › g13-zmiana | **PASS od razu** — dowód, że backend był poprawny | kod sprzed zmian |
| `src/agent/benchmark-verifiers.spec.ts` (7) | 4 FAIL (g10 ×2, g13-zmiana, g8) | weryfikatory sprzed zmian |
| `src/agent/tools/tool-routing-6-1.spec.ts` (5) | 5 FAIL | spec uruchomiony na `agent-tools.ts` z HEAD (kopia zapasowa, przywrócona) |
| `src/meal-planner/hard-prep-limit.spec.ts` (2) | 2 FAIL | spec uruchomiony na plikach silnika z HEAD (kopia zapasowa, przywrócona) |

## 3. Implementacja

**Planer (`src/meal-planner/`, `agent-meal-planner.service.ts`)**
- `PlanningConstraints.maxPrepMinutes` (opcjonalne) — TWARDY filtr `PREP_TIME` w
  `hardFilterReason`; pora bez takich dań = `NO_CANDIDATES` (severity `error`, więc
  model go widzi) z powodem słowami: „PREP_TIME (czas przygotowania ponad limit)×N”.
- `build` i `replace` przekazują limit jako twardy (`constraintsOf(…, { hardPrep })`),
  a miękka podpowiedź w preferencjach jest wtedy wyłączona; `suggest` zostaje
  miękki (tam poluzowanie jest jawne w `relaxed`).
- `PlannerWishes.dayKcalTarget` + `withDayKcalTarget`: cel dnia z prośby nadpisuje
  cel osoby PYTAJĄCEJ tylko w tym planie (makro skalowane proporcjonalnie). Profil
  i inne ścieżki bez zmian.
- `SuggestInput.excludeRecipeIds` — dodatkowe wykluczenia z historii rozmowy.

**Executor (`agent-tool-executor.ts`)**
- `wishesOf`: `day_kcal_target` (0 = profil; 800–6000, inaczej `VALIDATION_ERROR`).
- `updateRecipe`: przepis z katalogu → `{ updated: false, readOnly: true, reason:
  'CATALOG_RECIPE_READ_ONLY', recipe }`, `endsTurn` + zdanie serwera (`turnTextFor`):
  „„X” to przepis z katalogu Scoffie — takich przepisów nie da się edytować, więc go nie
  zmieniłem. Mogę zmienić liczbę porcji tego posiłku w planie albo przygotować Twoją
  własną wersję przepisu — powiedz, co wolisz.” `recipe_id` przyjmuje też indeks `R07`.
- `propose_household_split`: `portions: []` = cały dom (domownicy ze zgodą); porcje
  (kcal) każdej osoby liczy jak dotąd serwer z jej celu.
- `suggest_meals`: odczyt dań z ostatnich 5 kart OPTIONS rozmowy dla TEGO posiłku
  (etykieta slotu) → `excludeRecipeIds`; gdy bez nich zostaje < 2 dań — pełna pula
  i `repeatedShown: true`; w wyniku `skippedShown: N`. Model nie przenosi id.

**Stub (`stub-agent.provider.ts`)**: `[[build:<data>:<DNI>(:kcal=N)?(:prep=N)?]]`,
`[[update-recipe:<id>:<porcje>]]` (kończy turę zdaniem serwera jak prawdziwy dostawca).

**Harness (`scripts/agent-scenarios.ts`)**: wiadomości USER/ASSISTANT (z kartą)
zapisywane w bazie jak w runnerze — narzędzia czytające historię („pokaż inne”) widzą to,
co w produkcji; do werdyktu dochodzą karty propozycji (`proposalCards`).

## 4. Testy PASS po poprawce

| Test | Wynik |
|---|---|
| `test/regression-6-1.e2e-spec.ts` | **6/6** |
| `src/agent/benchmark-verifiers.spec.ts` | **7/7** |
| `src/agent/tools/tool-routing-6-1.spec.ts` | **5/5** |
| `src/meal-planner/hard-prep-limit.spec.ts` | **2/2** |

Deterministyczne dowody z polecenia:
- **g4:** `day_kcal_target: 1800` → `avgTargetKcal` 1800, plan w ±15%; bez pola → 2200;
  `UserPreference.calorieGoal` nadal 2200.
- **g8:** para 1800/2600, `portions: []` → propozycja `HOUSEHOLD_SPLIT`, JEDEN `recipeId`
  w czwartkowej kolacji, porcje obu osób w karcie, osoba z celem 2600 dostaje więcej
  kcal. Ani stub, ani test nie podają liczb porcji ani identyfikatorów osób.
- **g9:** tydzień z `max_prep_minutes: 5` → status ≠ OK, `issues` z „czas przygotowania
  ponad limit”, żadne danie w propozycji > 5 min.
- **g11:** `update_recipe` na katalogu → wynik „tylko do odczytu”; pełna tura (stub):
  jedno narzędzie (`update_recipe`), odpowiedź = wyjaśnienie serwera, przepis bez zmian,
  zero przepisów domu, zero propozycji.
- **g10:** weryfikator: karta = wynik narzędzia, zdanie bez liczb → PASS; liczba kcal
  spoza wyników narzędzi → FAIL (zmyślona).
- **g13-pokaz-inne:** dwie tury stubem na ten sam posiłek → druga karta rozłączna
  z pierwszą.
- **g13-zmiana:** B1 L1 D1 → „wegetariańska kolacja” → B1 L1 D2, D2 spełnia
  `satisfiesDiet(VEGETARIAN)`, D2 ≠ D1.

## 5. Pełny zestaw offline

| Komenda | Wynik |
|---|---|
| `pnpm test` | **195/195 suites, 3486/3486** |
| `pnpm typecheck` / `pnpm lint:check` / `pnpm openapi:check` | OK / 0 błędów (42 ostrzeżenia sprzed etapu) / OK (kontrakt HTTP/WS bez zmian) |
| e2e asystenta, trwałe tury, planer, katalog (15 suit: regression-6-1, durable-turns, agent, agent-tools, agent-thinning, agent-card-state, agent-choice-portions, meal-planner, per-user-portions, apply-week-plan, agent-accounting, agent-catalog-boundary, weekly-balance, hot-paths, catalog-sync) | **217/217** (po aktualizacji jednego testu kontraktu — §6) |
| `pnpm agent:scenarios -- --dry --cards strict` | **44/44** sprawny harness (`benchmark/regression-6-1/dry-44.json`) |
| `pnpm planner:eval` | bez zmian względem Etapu 2.2 (solo 1,6%/3,1%, para 23%, wege 11,2%, rodzina 13,7%; 0 złamań) |
| pełne e2e | §5a |

### 5a. Pełne e2e

`pnpm test:e2e` offline (stub, bez klucza): **52/55 suites, 619/624 testów**. Czerwone te
same 3 suity środowiskowe co w Etapach 4–6 (`admin-assistant`, `admin-revenue`,
`admin-integrations` — lokalne `FxRate`/klucze), niezwiązane z 6.1.

## 6. Zmiany w kontraktach narzędzi

| Narzędzie | Zmiana |
|---|---|
| `build_meal_plan` | nowe pole WYMAGANE `day_kcal_target` (integer, 0 = profil) — wymagane, żeby nie ruszać budżetu pól nieobowiązkowych (14 → 14; limit spec 24) |
| `build_meal_plan`, `replace_plan_item` | `max_prep_minutes` = limit TWARDY (opis wspólnego pola mówi, gdzie twardy, a gdzie miękki) |
| `suggest_meals` | opis: „Pokaż inne” = to samo narzędzie; NIE do rozdzielania posiłku ani zmiany dania |
| `propose_household_split` | opis obejmuje rozdzielenie zaplanowanego posiłku między osoby o różnych celach; `portions: []` = cały dom; porcje liczy serwer |
| `update_recipe` | opis: katalog tylko do odczytu, serwer wyjaśnia, nie kopiuj i nie zmieniaj planu bez prośby; `recipe_id` przyjmuje indeks; wynik „tylko do odczytu” zamiast błędu (test `agent-tools.e2e` › edycja katalogu zaktualizowany do nowego kontraktu — katalog dalej nietknięty) |

Bez haków pod dosłowne zdania benchmarku: opisy mówią o KLASIE sytuacji (różne cele,
rozdzielenie posiłku, tylko do odczytu), nie o konkretnych słowach.

## 7. Zmiany w plannerze

Twardy `PREP_TIME` w planie i podmianie; cel dnia z prośby dla pytającego;
wykluczenia w sugestiach. Eval planera bez regresji (§5).

## 8. Zmiany w odpowiedziach kończących turę

`update_recipe` dla przepisu z katalogu kończy turę zdaniem serwera
(`tool_ended_turn`, bez kolejnej rundy modelu) — to drugi po kartach przypadek
autorytatywnej odpowiedzi serwera. Karty bez zmian: terminal card dalej kończy turę bez
dodatkowej rundy (e2e `agent-thinning` zielone).

## 9. Zmiany weryfikatorów benchmarku

- `g10-luka-makro`: źródłem prawdy karta + wynik narzędzia; zamiast wymogu cytatu —
  każda liczba „N kcal” w zdaniu musi pochodzić z wyników narzędzi (inaczej: zmyślona).
- `g13-zmiana-w-propozycji`: wegetariańskość przez `satisfiesDiet` (ta sama reguła co
  planer), nie przez szukanie etykiety w `dietTags`.
- `g8-podzial-posilku`: rozdzielenie = dwa dania z audytorium ALBO jedno danie z kartą
  `HOUSEHOLD_SPLIT` dla tego slotu i różnymi porcjami osób od serwera.

Uwaga: to zmienia ocenę części przebiegów Etapu 6 wstecz (g8 u Haiku, g13-zmiana
u wszystkich), ale surowe rekordy Etapu 6 nie zawierają pełnych wyników narzędzi,
więc ponownej oceny offline nie da się zrobić uczciwie — robi to dopiero przyszły
przebieg live (§11).

## 10. Wpływ strukturalny (MEASURED offline, `scripts/agent-structure-metrics.ts`)

| Metryka | Przed 6.1 | Po 6.1 | Uwagi |
|---|---:|---:|---|
| narzędzia widoczne dla modelu | 24 | 24 | bez zmian |
| schematy narzędzi, znaki | 34 718 | 36 038 | +3,8% |
| schematy, tokeny (ESTIMATE, 3,6 zn./tok.) | ~9 644 | ~10 011 | +~370 tokenów prefiksu (cache read: ~$0,00007 na wywołanie Sonneta) |
| instrukcje, znaki | 9 275 | 9 275 | bez zmian |
| pola nieobowiązkowe (wszystkie narzędzia) | 14 | 14 | bez zmian |
| kroki deterministycznego przepływu (stub) | — | g11: 1 narzędzie, 0 dodatkowych rund; pokaż inne: 1 narzędzie/turę; poprawka propozycji: 1 narzędzie | |
| `suggest_meals` → `find_recipes`? | nie | nie | opis i test kontraktu |
| `build_meal_plan` → ręczne sloty? | nie | nie | |
| `replace_plan_item` zmienia jeden slot | tak | tak | e2e g13-zmiana: B1/L1 nietknięte |

Wzrost prefiksu uzasadniony: nowe pole z opisem (cel dnia) i reguły routingu w opisach
trzech narzędzi, które w Etapie 6 myliły model. Pliki: `benchmark/regression-6-1/structure-{before,after}.json`.

## 11. Co wymaga kiedyś walidacji live

- Czy model faktycznie wypełnia `day_kcal_target` z „zmieść się w 1800” (kontrakt jest,
  zachowanie modelu niezmierzone).
- Czy model wybiera `propose_household_split` dla „rozdziel posiłek” zamiast
  `suggest_meals`/`propose_swap` (opisy poprawione; routing modelu niezmierzony).
- Czy przy „każde danie najwyżej 5 minut” model przekazuje `max_prep_minutes: 5`.
- Czy model woła `update_recipe` dla przepisu katalogowego, zamiast od razu robić kopię.
- „Pokaż inne” i poprawka w propozycji na żywym modelu (harness zapisuje już historię
  jak runner).
- Ponowny pomiar before/after i jakości tekstu po 6.1 — koszt ESTIMATE ~$4–5
  (44 scenariusze × 1 + decydujące × 2, Sonnet).

**Final effort decision: DEFERRED.**  
**Current production: medium.**  
**Candidate for future validation: low.**  
Etap 6 pokazał, że `low` jest kandydatem (równa jakość i koszt, szybsze wywołanie), ale
bez ponownego pomiaru live po 6.1 produkcji nie zmieniamy.

## Commity

- `8986b15` — fix(asystent): regresje z finalnego benchmarku naprawione deterministycznie (Etap 6.1)
- commit raportu i STATE — następny po `8986b15`
