# Raport etapu 02 — Serwerowy silnik planowania posiłków

**Data:** 2026-09-26  
**Status:** DONE (2A–2E) po poprawce semantyki celu kcal (Addendum A1, 26.09.2026);
decyzje produktowe/danych — §9  
**Branch:** `claude/admin-crm-planning-b0hmgo` (HEAD kodu: `c2908a6`)  
**Zakres z TASKS.md:** Etap 2 — 2A audyt domeny, 2B planer dnia, 2C planer tygodnia,
2D lokalna zmiana, 2E API dla agenta. Bez płatnych benchmarków, bez zmiany modelu.

## 1. Wynik audytu 2A — model porcji i celów

Odpowiedź na pytanie „czy obecny model danych pozwala poprawnie dobrać porcje i cele
żywieniowe dla wielu osób jedzących ten sam posiłek?” — sprawdzona kodem i testami
(`src/meal-planner/portion-semantics.audit.spec.ts`, 7 testów, oraz e2e
„duplikat przepisu w slocie”):

| Fakt w kodzie | Skąd | Konsekwencja dla planera |
|---|---|---|
| Makra przepisu = CAŁY przepis; porcja = całość / `Recipe.servings` (1..8) | `daily-balance.util`, CLAUDE.md | kcal porcji liczy serwer z sum |
| `PlanItem.plannedServings` = porcje ŁĄCZNE, całkowite 1..12 | schema, `planned-servings.util` | planer dobiera liczbę całkowitą |
| Udział osoby = `plannedServings / liczba jedzących` — RÓWNY dla wszystkich | `servingsPerPerson` (serwer) = `SavedMealPlan.servingsPerPerson` (iOS) | jedno danie = te same kcal dla każdego jedzącego |
| Reguła auto: porcji tyle, ilu jedzących → udział 1 | `autoPlannedServings` | domyślny udział 1 porcji |
| Własne danie wygrywa ze wspólnym w slocie | `visibleToMember` (serwer i iOS) | różne kcal w jednym slocie = RÓŻNE dania |
| Ten sam przepis nie może stać dwa razy w jednym slocie | unikat `(plan, dzień, pora, przepis)`, walidator `PLAN_SLOT_DUPLICATE` | nie da się dać tego samego dania dwóm osobom w różnych porcjach |
| Osoba sama: udział tylko 1, 2, 3… (całkowity) | j.w. | porcją nie da się stroić kcal w domu 1-osobowym — stroi się doborem dania |
| Cele: `calorieGoal` + makra (zapisane albo liczone z sylwetki; bez sylwetki `null`) | `member-context.util` (`targets`) | cel per osoba jest po stronie serwera |
| Alergeny i wykluczenia pilnuje walidator zapisu; **diety NIE** (tylko wyszukiwarka) | `collectPlanViolations` | planer sam egzekwuje diety jako twarde |

**Wniosek:** model danych wystarcza do POPRAWNEGO planera przy semantyce „jedno danie,
równy udział na osobę, porcje łączne całkowite” — i planer z tej semantyki korzysta.
Model **nie wyraża nierównych porcji tego samego dania** dla różnych osób. Przy
rozbieżnych celach we wspólnym posiłku istnieje więc dolna granica odchylenia, której
żaden planer nie przebije bez zmiany danych (liczby w §5). Ponieważ planer z obecną
semantyką jest poprawny i uczciwie zgłasza to ograniczenie (status `PARTIAL`
z powodem), nie było podstaw do zatrzymania etapu; zmiana semantyki (porcje per osoba)
to **decyzja w §9 — bez żadnej migracji w tym etapie**.

## 2. Semantyka porcji w planerze

- Udział na osobę w widełkach **0,75–1,5 porcji** (`PORTION_SHARE_MIN/MAX`), porcje
  łączne całkowite, ≤ 12. Pierwsza opcja zawsze = reguła auto (udział 1), odejście
  kosztuje (`WEIGHTS.portion`).
- Osoba sama zawsze 1 porcja (0,75–1,5 z liczby całkowitej = tylko 1). Dom 2-osobowy:
  2 albo 3 porcje; 4-osobowy: 3–6.
- Karta podmiany w zapisanym planie liczy porcje z audytorium, więc tam planer działa
  w `portionMode: 'auto'` (udział 1), żeby „podobnie kalorycznie” liczyło się tak samo
  jak zapis.

## 3. Architektura

```
src/meal-planner/                       ← CZYSTY silnik (bez bazy, modelu, tożsamości)
  meal-planner.types.ts                 PlanningRequest / PlanningConstraints /
                                        PlanningPreferences / PlanDraft / PlanDiagnostics
  meal-plan-scoring.ts                  filtry twarde, porcje, bilans (reguły z aplikacji),
                                        funkcja celu, wagi, tolerancje
  meal-plan-engine.ts                   planMeals (dzień, tydzień, slot) + evaluatePlan
  portion-semantics.audit.spec.ts       audyt 2A
src/agent/planner/
  agent-meal-planner.service.ts         adapter: członkostwo, profile, pula, sygnały,
                                        stałe pozycje, filtr zgód w wyniku dla modelu
src/agent/tools/                        build_meal_plan, replace_plan_item (executor)
scripts/planner-eval.ts                 bezpłatne metryki na lokalnym katalogu
```

Jeden silnik dla trzech operacji: dzień = tydzień z jednym dniem; podmiana slotu =
plan jednego slotu, a cała reszta tygodnia idzie jako `fixed` (liczy się do bilansu
dnia i do powtórek).

## 4. Hard vs soft

**Twarde** (`hardFilterReason`, PRZED scoringiem — żaden koszt ich nie „kupi”):
przepis aktywny i widoczny dla domu (pula = katalog `isCatalog` + własne domu), pora
(`suitableMealTypes`), alergeny, wykluczone składniki i dieta KAŻDEGO jedzącego (te same
funkcje co walidator i wyszukiwarka — `diet-rules.util`; także domowników bez zgody na
asystenta), dieta / wymagane tagi / „bez X” / wykluczone przepisy z prośby, makra
(bez makr nie da się policzyć celu — przepis odpada z powodem `NO_NUTRITION`).
Po stronie zapisu dalej działa walidator `applyWeekPlan` (drugi niezależny filtr).

**Miękkie** (koszt, nie zakaz): kcal i makro dnia wobec celu, cel kcal slotu
(„podobnie kalorycznie”), powtórki w tygodniu, to samo mięso dzień po dniu w tej samej
porze, ten sam rodzaj dania dwa razy jednego dnia, przepis z zeszłego tygodnia, brak
mile widzianego tagu, przekroczenie podpowiedzi czasu, odejście od udziału 1, ulubione
(premia), popularność (premia), wspólne składniki z innymi daniami tygodnia (premia,
z sufitem 5), ziarno remisów.

## 5. Algorytm, scoring, tolerancje, UNSAT/PARTIAL

**Algorytm** (bez solvera):
1. *Kandydaci* — dla każdej pory filtry twarde, ranking wstępny (kcal porcji wobec
   średniego celu slotu + koszt miękki) i obcięcie do **60 na porę**. Tylko ten krok
   widzi całą pulę; koszt dalszych kroków nie rośnie z katalogiem.
2. *Zachłannie* — dzień po dniu, pory od największego udziału kcal; w slocie wygrywa
   para (przepis, porcje) o najmniejszym koszcie planu z tym, co już wybrane (cel dnia
   liczony z WYPEŁNIONYCH pór).
3. *Lokalna poprawa* — do 3 przejść: każdy slot może zmienić danie/porcje, jeśli obniża
   koszt całego tygodnia (pełne cele dni, relacje między daniami). Test „tydzień to NIE
   suma niezależnych dni” pokazuje różnicę: 7 niezależnych planów dnia powtarza dania,
   tydzień — nie, przy niższej funkcji celu.

**Cel dnia:** ~~`kcalTarget × pokrycie` (pory domu = 80 % celu)~~ — **BŁĄD znaleziony
w review, poprawiony w Addendum A1**: pełny dzień celuje w 100 % celu, a cel osoby
wynika wyłącznie z posiłków, które ona je.

**Funkcja celu** (mniej = lepiej): na osobo-dzień `10·Δkcal² + 3·Δbiałko² + 1,5·Δtł² +
1,5·Δwęgl²` (Δ względne; makra tylko przy znanych celach), średnio po audytorium; +
cel slotu `10·Δ²`; + powtórka 1,0 za każde wystąpienie ponad pierwsze; + monotonia
0,1–0,15; + miękkie pozycji (tag 0,25, czas 0,3 + 0,01/min ≤ 0,6, niedawne 0,15,
porcja 0,2·|udział−1|, ulubione −0,05, popularność ≤ −0,02, wspólne składniki
−0,01/szt. ≤ 5, ziarno ≤ 0,004). Kalibracja: 10 % chybienia kcal = 0,1, 20 % = 0,4;
powtórka = jak ~32 % chybienia jednego osobo-dnia — planer woli nie powtarzać.

**Tolerancje (ustalone przed kodem):** kcal dnia osoby ±10 %, białko ±20 %, tłuszcz
i węglowodany ±25 % (informacyjnie), powtórki: 0 poza wymuszonymi, czas i tagi:
liczone jako niespełnione preferencje.

**Status:** `UNSAT` — żaden slot nie ma dania (np. alergia wyklucza wszystko; powód
`NO_CANDIDATES` z licznikami odrzuceń po powodach); `PARTIAL` — część slotów pusta
albo kcal/białko jakiegoś osobo-dnia poza tolerancją; `OK` — reszta. Diagnostyka zawsze
niesie bilans osobo-dni, statystyki kandydatów i metryki.

## 6. Integracja z AgentProposal i wpływ na tools

- `build_meal_plan` {week_start, days, meal_types, for_user_ids, diet, must_have_tags,
  prefer_tags, avoid_ingredients, max_prep_minutes} → planer → `createDayPlanProposal`
  (jeden dzień) albo `createWeekPlanProposal` (więcej) — ta sama walidacja zapisu,
  karta, odcisk planu i kliknięcie człowieka co dotąd. W zakresie zastępowane jest to,
  co je wyłącznie audytorium (cały dom → cały slot; część domu → jej dania imienne,
  wspólne zostaje). `UNSAT` = bez karty, z powodami dla modelu.
- `replace_plan_item` {week_start, day_of_week, meal_type, proposal_id, similar_kcal, +
  życzenia}: w propozycji PENDING → wybór planera + `reviseProposal` (porcje z planera;
  odczyt propozycji wydzielony do `loadPendingPlanProposal`, wspólny z
  `revise_proposal`), w zapisanym planie → karta podmiany (`proposeSwap`, „przed/po”).
  Slot zawsze w całości; reszta tygodnia bez zmian (test e2e porównuje wszystkie
  pozostałe pozycje).
- Oba: wyłącznie pola wymagane (budżet opcjonalnych dalej **24/24**; „brak” = `[]`,
  `NONE`, `0`), bez `strict`, tier `planner`, kończą turę, tylko w trybie propozycji;
  `build_meal_plan` liczy się do bramki „najwyżej 7 dni na turę”.
- Wynik dla modelu jest zwięzły (status, wypełnienie, odchylenia, średnie kcal osób,
  ≤ 10 powodów) i z filtrem zgód — osoba bez zgody nie pojawia się ani z id, ani z liczbami.
- Prompt: plan dnia/tygodnia = `build_meal_plan`; jedna zmiana = `replace_plan_item`;
  `propose_week_plan`/`propose_day_plan` tylko dla dań podanych przez użytkownika;
  konkretne danie = `propose_swap` / `revise_proposal`. Narzędzi nie usuwałem (Etap 3).
- `find_recipes`/`offer_options` bez zmian („co na kolację?” zostaje ścieżką wyboru).

## 7. Testy

| Komenda | Wynik |
|---|---|
| `pnpm typecheck` | 0 błędów |
| `pnpm lint:check` | 0 błędów, 42 ostrzeżenia (pliki nieruszane w etapie) |
| `pnpm test` | **184/184 suit, 3345/3345** |
| `pnpm exec jest src/meal-planner` | audyt 2A 7/7 + silnik 31/31 (w tym skala: 5100 przepisów) |
| `pnpm exec jest src/agent` | 581 + nowe spec-i planera/propozycji — zielone |
| e2e `meal-planner` (nowy) | **7/7** |
| e2e regresja: `agent`, `agent-tools`, `agent-card-state`, `agent-accounting`, `agent-catalog-boundary`, `apply-week-plan`, `catalog-visibility`, `authz-audit` + `meal-planner` | **173/173** |
| `pnpm openapi:check` | „OpenAPI aktualne” (REST/WS bez zmian) |
| `pnpm planner:eval --runs 3` | metryki w §8 |

Lista obowiązkowa → gdzie:
1. planer dnia trafia w kcal — `meal-plan-engine.spec` „1.” + `planner:eval` (solo 0,7 %);
2. alergia nigdy — engine „2.” (4 ziarna, danie z alergenem idealnie w cel) + e2e profil;
3. dieta nigdy (profil i prośba) — engine „3.” + e2e profil (`satisfiesDiet` na wyniku);
4. nieaktywny przepis — engine „4.”;
5. rozsądne porcje — engine „5.” (solo zawsze 1; rodzina 0,75–1,5) + „porcje nie naprawiają kcal”;
6. UNSAT z diagnostyką — engine „6.” + PARTIAL + e2e UNSAT;
7. bez zbędnych powtórek — engine „7.”, REPEAT_FORCED, „tydzień ≠ suma dni”;
8. zmiana slotu nie rusza reszty — engine „8.” + e2e (porównanie wszystkich pozycji);
9. podobna kaloryczność — engine „9.” (≤ 15 % od zastępowanego, dieta twarda) + e2e;
10. wynik przechodzi walidatory `applyWeekPlan` — e2e (`previewWeekPlan` → 0 naruszeń, zapis 21 pozycji);
11. ten sam seed → ten sam plan — engine „11.”;
12. prywatność/uprawnienia — e2e (cudzy prywatny przepis nigdy, obcy dom = `NOT_HOUSEHOLD_MEMBER`) + `agent-meal-planner.service.spec` (filtr zgód w wyniku dla modelu).
Regresja propozycji: dotychczasowe `agent-proposals.revise.spec` i `agent-card-state.e2e` zielone po wydzieleniu `loadPendingPlanProposal`.

## 8. Pomiary (bez modelu)

> **NIEAKTUALNE (przed poprawką A1):** poniższe odchylenia liczono względem 80 % celu
> dnia, więc NIE są odchyleniem od dziennego `calorieGoal`. Aktualne wyniki — Addendum A1.

`pnpm planner:eval --runs 3` na lokalnym katalogu dev (≈500 przepisów), osoby z sylwetką
(makra liczone), pory domyślne (śniadanie, obiad, kolacja) — **MEASURED**, ostatni przebieg:

| Dom | Operacja | Status | kcal śr./maks. % | białko % | złamań | powt. | ms | zapytań DB |
|---|---|---|---|---|---|---|---|---|
| solo 2000 | tydzień | OK | 1,6 / 3,8 | 2,4 | 0 | 0 | 91 | 12 |
| solo 2000 | dzień | OK | 0,7 / 0,7 | 9,2 | 0 | 0 | 15 | 12 |
| solo 2000 | podmiana śr. kolacji (wege, podobne kcal) | OK | 1,8 | 5,9 | 0 | 0 | 11 | 9 |
| para 1600/2600 | tydzień | PARTIAL | 23,5 / 26,8 | 19,8 | 0 | 0 | 177 | 12 |
| wege + bez glutenu | tydzień | PARTIAL (białko) | 2,6 / 6,8 | 12,4 | 0 | 0 | 34 | 12 |
| wege + bez glutenu | dzień | OK | 0,9 | 7,5 | 0 | 0 | 13 | 12 |
| rodzina 4 (dziecko z orzechami) | tydzień | PARTIAL | 13,8 / 27,4 | 23,6 | 0 | 0 | 332 | 12 |

- **Dolna granica przy wspólnych daniach (CALCULATED):** przy równym udziale kcal
  jest wspólne dla wszystkich jedzących; minimum Σ(k/cel−1)² daje dla pary 1600/2600
  (cele planu 1280/2080) k ≈ 1500 → **śr. 22,5 %, maks. 27,9 %**; dla rodziny
  (1440/2000/1200/1520) k ≈ 1444 → **śr. 13,4 %, maks. 27,8 %**. Planer osiąga
  23,5 / 26,8 i 13,8 / 27,4 — czyli granicę modelu danych, nie słabość algorytmu (§9).
- Skala: syntetyczny katalog **5100 przepisów**, tydzień 21 slotów, 4 osoby — **358 ms**
  (MEASURED, test jednostkowy, laptop Windows). Liczba zapytań DB **stała: 12** na plan,
  9 na podmianę (MEASURED) — pula z indeksu w pamięci, bez N+1.
- Na e2e z profilu wege + bez glutenu (osoba bez sylwetki → makra nieznane): kcal 1,4 %,
  0 złamań, 0 powtórek, 63 kandydatów po filtrach, 50 ms (MEASURED).
- Te same metryki liczy `evaluatePlan` / `AgentMealPlannerService.evaluate` dla
  DOWOLNEGO planu — w Etapie 6 plan ułożony przez model (anchor `22aa63c`) i przez
  planer da się porównać liczbami: odchylenie kcal/makro, złamania twarde, powtórki,
  niespełnione preferencje, funkcja celu.

Czego NIE zmierzyłem: czy model faktycznie wybiera `build_meal_plan` zamiast
`propose_week_plan` i ile to daje w rundach/tokenach/koszcie — to wymaga płatnego
przebiegu (Etap 6). ESTIMATE: wejście `build_meal_plan` to ~100–200 tokenów wyjścia
modelu zamiast ~1,5–3 tys. dla 21 pozycji `propose_week_plan`, i bez rund `find_recipes`.

## 9. Decyzje potrzebne od Rafała

1. **Porcje dla domowników o różnych celach** (wynik audytu 2A). Dziś para 1600/2600 przy
   wspólnych daniach ma ~23 % odchylenia i to jest granica modelu danych. Warianty:
   - **A. Zostaje równy udział** (stan obecny): planer zgłasza `PARTIAL` z liczbami, karta
     `HOUSEHOLD_SPLIT` może podpowiadać sposób podania. Zero zmian.
   - **B. Osobne dania przy dużej rozbieżności** — planer dzieli slot na dania imienne
     (dane już to obsługują: własne danie wygrywa ze wspólnym; iOS rysuje kilka pozycji
     w slocie; lista zakupów sumuje). Tylko backend, bez migracji; koszt: więcej
     gotowania. Wymaga progu („kiedy dzielić”) — decyzja produktowa.
   - **C. Porcje per osoba** — np. udział na uczestnika (`PlanItemParticipant.share`),
     `plannedServings` = suma; zmienia bilans (serwer + iOS `SavedMealPlan`), listę
     zakupów, UI steppera i kontrakt WS; migracja z backfillem równego podziału.
     Duża zmiana cross-repo — nie ruszałem.
   Rekomendacja: B jako następny krok, C tylko jeśli produkt chce „jeden garnek, różne
   talerze” zapisane w planie.
2. **Dieta w walidatorze zapisu** — planer ją egzekwuje, walidator `applyWeekPlan` nie
   (ręczne dodanie mięsa do planu wegetarianina przechodzi). Włączenie zmieniłoby
   zachowanie ręcznych zmian w aplikacji — decyzja produktowa.
3. **Smoke schematów narzędzi przed deployem** (`scripts/agent-tools-smoke.ts`, jedno
   żądanie) — lista narzędzi urosła o dwa (bez `strict`, gramatyka się nie zmienia).

## 10. Ryzyka i rzeczy świadomie pozostawione

- **Nie zmierzone na modelu:** czy model trzyma się nowych instrukcji — Etap 6.
- Udziały pór i wagi są heurystyką (opisane, w jednym pliku, łatwe do strojenia po
  benchmarku); status `PARTIAL` przy białku ±20 % bywa częsty na obecnym katalogu —
  to informacja, nie błąd.
- Przepis bez makr nigdy nie wejdzie z planera (także własny przepis domu bez makr) —
  liczony w diagnostyce jako `NO_NUTRITION`.
- Zachłanny wybór + lokalna poprawa nie gwarantuje optimum globalnego; test pokazuje, że
  tydzień jest lepszy od sumy dni, a pomiary — że planer dochodzi do granicy danych.
- Ścieżka `propose_week_plan` zostaje (dla dań podanych przez użytkownika) i dalej może
  złożyć plan z dietą niezgodną z profilem (walidator diet nie sprawdza — §9.2).
- Świadomie NIE w tym etapie: usunięcie `propose_*`/`apply_week_plan` z listy narzędzi,
  `suggest_meals` (3 opcje bez `find_recipes` — Etap 3), przeniesienie narzędzi planera
  do taniego modelu (tier `chat` — Etap 3/6), sygnał „ostatnio ZJEDZONE” (dziś tylko
  plan zeszłego tygodnia), porcje per osoba (§9.1).
- Migracji brak. Kontrakty REST/WS bez zmian (OpenAPI aktualne); iOS bez zmian (te same
  rodzaje kart). Zmiana listy narzędzi i instrukcji = jednorazowy zapis prefiksu cache
  po deployu.

## 11. Commity

- `1196aa6` — test(planer): audyt 2A — semantyka porcji i celów przypięta testami
- `51e7269` — feat(planer): serwerowy silnik planowania posiłków (dzień, tydzień, slot)
- `c2908a6` — feat(agent): build_meal_plan i replace_plan_item — asystent na serwerowym planerze
- (następny) — docs: raport Etapu 2, STATE.md, CLAUDE.md

## Addendum A1 — 2026-09-26, po review: semantyka celu kcal

### Przyczyny obu błędów

1. **Pełny dzień celował w 80 % celu.** `MEAL_KCAL_SHARE` były sztywnymi udziałami
   (śniadanie 0,25 + obiad 0,35 + kolacja 0,20 = 0,80) i nikt ich nie normalizował.
   Planer uznawał 1600 kcal za trafienie przy `calorieGoal = 2000`. Tymczasem aplikacja
   porównuje dzienną sumę z PEŁNYM celem (`WeeklyPlanView` × `DailyNutritionTargets`,
   cel domownika zawsze pełny — `DailyNutritionTargets.forMember`), a te trzy pory to
   domyślne, obowiązkowe `Household.enabledMealTypes`. Kontraktu „resztę zjesz poza
   planem” nie ma.
2. **Cel osoby rósł od posiłku innej osoby.** `fullTargetTypes()` liczył pokrycie ze
   wszystkich pór pozycji stałych danego dnia, a bilans (`eaterDayNutrition`) poprawnie
   szanował `visibleToMember`. Osobisty obiad Marka podnosił więc cel Ani z 400 do
   1100 kcal, choć w jej bilansie był tylko obiad… którego nie jadła (test czerwony
   na `17c4133`: „Expected 400, Received 1100”).

### Nowe zasady liczenia celu (`assessEaterDay`, `PlanningRequest.scope`)

- **Wagi, nie udziały:** `MEAL_KCAL_WEIGHT` (25 : 10 : 35 : 10 : 20 : 10) dzielą cel
  między pory i zawsze się normalizują. Dla śniadania, obiadu i kolacji daje to
  31,25 / 43,75 / 25 % = 100 %. `calorieGoal` bez zmian.
- **Zakres `FULL_DAY`** — planowane pory są całym dniem. Razem mają dowieźć 100 %
  celu osoby minus to, co osoba je poza nimi (np. ręcznie dodana przekąska).
  Odchylenie liczy się względem PEŁNEGO dziennego celu.
- **Zakres `PARTIAL`** — część dnia:
  `budżet = cel dnia − to, co TA osoba rzeczywiście je poza planowanymi porami`,
  `cel planowanych pór = budżet × waga(planowane) / waga(pory niepokryte)`.
  Pory niepokryte to struktura dnia domu (`enabledMealTypes` ∪ planowane) bez pór,
  które osoba już je. Odchylenie zakresu liczy się względem tego celu.
- **Tylko to, co osoba je:** pozycje stałe wchodzą przez jej budżet (`visibleToMember`),
  a nie przez listę pór dnia. Osobisty posiłek innego domownika na nią nie wpływa.
  Wspólny posiłek wpływa na każdego, kto go je (jego udziałem porcji). Własny osobisty —
  tylko na jej budżet.
- **Kontrakt narzędzi:** `build_meal_plan` z pustym `meal_types` (= pory domu) albo
  z jawną listą obejmującą wszystkie pory domu = `FULL_DAY`; podzbiór pór = `PARTIAL`
  (istniejący kontrakt nie mówi inaczej). `replace_plan_item` = zawsze `PARTIAL`.
- Waga celu slotu („podobnie kalorycznie”) podniesiona z 10 do 20: jawna prośba
  użytkownika ma przeważać nad domykaniem bilansu dnia. Test regresji nie zmierzył
  tu różnicy (najbliższe danie wege stało już w tygodniu i planer słusznie unikał
  powtórki), więc to decyzja projektowa, nie wynik pomiaru.
- Nowa metryka `dayKcalDeviationPct` (cały dzień osoby wobec pełnego celu, w każdym
  zakresie) obok `kcalDeviationPct` (odchylenie zakresu). Przy `PARTIAL` mały budżet
  slotu daje duże procenty zakresu — dzień mówi, jak to wygląda na ekranie aplikacji.

### Testy (dodane / zmienione)

| Test | Wynik |
|---|---|
| czerwony: osobisty obiad Marka a cel Ani (`17c4133`) | Expected 400, Received 1100 → po fixie zielony |
| czerwony: pełne B/L/D → cel 2000 (test „1.” przypinał błędne 1600) | → zielony |
| 1. cel 2000 + pełne B/L/D → cel dnia 2000, dzień w ±10 % | zielony |
| 2. pięć podstawowych pór → 2000, bez podwójnego skalowania | zielony |
| 3. plan częściowy: posiłki osoby odejmują się od celu | zielony (cel = 2000 − śniadanie − obiad) |
| 4. osobisty posiłek innego domownika nie zmienia celu | zielony (500 z i bez obiadu Marka) |
| 5. wspólny stały posiłek wpływa na każdego, kto go je | zielony (1600/2600 − obiad, × 0,20/0,45) |
| 6. osobisty stały posiłek osoby — tylko jej budżet | zielony (Ania pomniejszona, Marek 500) |
| 7. podmiana: reszta dnia bez zmian, cel slotu = rzeczywisty bilans | zielony (cel = 2000 − reszta dnia) |
| 8. regresja „podobnie kalorycznie” | zielony; test porównuje z najbliższym MOŻLIWYM zamiennikiem (wege, bez powtórki), a nie ze sztywnym ±15 % |

Komendy: `pnpm typecheck` — 0 błędów; `pnpm lint:check` — 0 błędów (42 ostrzeżenia
w plikach nieruszanych); `pnpm test` — **184/184, 3353/3353**; e2e `meal-planner`,
`agent`, `agent-card-state`, `apply-week-plan`, `agent-tools`, `agent-accounting` —
zielone (78 + 69); `pnpm openapi:check` — aktualne.

### `planner:eval` przed i po (MEASURED, katalog dev, 3 przebiegi, ostatni)

„Przed” = odchylenie względem 80 % celu (nieważne jako odchylenie od `calorieGoal`).
„Po” = odchylenie względem PEŁNEGO celu (`FULL_DAY`).

| Dom | Operacja | Przed: status, kcal śr./maks. % (vs 80 %) | Po: status, kcal śr./maks. % (vs 100 %) | Po: białko % |
|---|---|---|---|---|
| solo 2000 | tydzień | OK, 1,6 / 3,8 | OK, **1,6 / 3,1** | 3,3 |
| solo 2000 | dzień | OK, 0,7 / 0,7 | OK, **1,3 / 1,3** | 0,5 |
| para 1600/2600 | tydzień | PARTIAL, 23,5 / 26,8 | PARTIAL, **23,0 / 27,2** | 20,4 |
| para 1600/2600 | dzień | PARTIAL, 24,0 / 24,9 | PARTIAL, **22,5 / 27,9** | 20,2 |
| rodzina 4 | tydzień | PARTIAL, 13,8 / 27,4 | PARTIAL, **13,7 / 27,7** | 23,3 |
| rodzina 4 | dzień | PARTIAL, 13,7 / 25,8 | PARTIAL, **13,5 / 26,9** | 23,4 |
| wege + bez glutenu | tydzień | PARTIAL, 2,6 / 6,8 | PARTIAL, **11,2 / 19,0** | 30,4 |
| wege + bez glutenu | dzień | OK, 0,9 | OK, **2,8** | 9,0 |

Podmiana środowej kolacji (wege, podobne kcal), zakres `PARTIAL` — po poprawce:
solo: zakres 0,4 %, dzień 0,1 % (OK); para: zakres 80,9 %, **dzień 21,4 % / 31,6 %**;
wege: zakres 19,9 %, dzień 7,4 %; rodzina: zakres 65,5 %, **dzień 16,0 % / 33,3 %**.
Duże procenty zakresu u pary i rodziny wynikają z tego samego ograniczenia co wyżej.
Ania (1600) po wspólnym śniadaniu i obiedzie ma na kolację mały budżet, a wspólna
kolacja w równym udziale musi też wykarmić Marka (2600).

Wnioski:
- **solo:** trafia w pełne 2000 kcal (1,3–1,6 %).
- **para i rodzina:** wynik się nie zmienił. Ich odchylenie to granica równego podziału
  porcji (CALCULATED, niezależne od skali celu): para śr. 22,5 % / maks. 27,9 %, rodzina
  13,4 % / 27,8 %. Planer do niej dochodzi. Porcje per osoba (wariant C) — osobna
  decyzja architektoniczna, bez zmian w tej poprawce; `plannedServings` dzieli się równo.
- **wege + bez glutenu:** tydzień pogorszył się względem pełnego celu (2,6 → 11,2 %).
  Po filtrach zostały 63 dania na trzy pory, są lżejsze, a osoba jedząca sama dostaje
  zawsze 1 porcję. 80 % celu było osiągalne, 100 % na siedem dni bez powtórek — już
  nie. To prawdziwa luka katalogu/porcji, dotąd ukryta przez błędny cel. Planer zgłasza
  ją jako PARTIAL.

### Status

Testy potwierdzają poprawioną semantykę celu → Etap 2 **DONE**, Etap 3 **READY**.
Porcje per osoba (wariant C) — osobna decyzja architektoniczna.

Commity poprawki:
- `17c4133` — test(planer): cel dnia = 80 % celu i cel zależny od posiłku innej osoby (CZERWONE)
- `6d6bcfc` — fix(planer): cel kcal z jawnego zakresu — pełny dzień 100 %, cel osoby tylko z tego, co ona je
- (następny) — docs: addendum raportu 02, STATE.md
