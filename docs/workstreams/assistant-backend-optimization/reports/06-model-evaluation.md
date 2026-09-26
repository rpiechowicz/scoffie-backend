# Raport etapu 06 — Finalny benchmark: before/after, model, effort, routing

**Data:** 2026-09-26  
**Status:** DONE (pomiar wiarygodny; bez zmian w kodzie aplikacji i na produkcji)  
**Branch:** `claude/admin-crm-planning-b0hmgo`  
**Porównanie:** anchor `22aa63c` (przed workstreamem) ↔ HEAD `92e837c` (kod aplikacji = `45ddb61`, Etap 5 po A1; `92e837c` zmienia tylko `scripts/` i `benchmark/`)

Oznaczenia: **MEASURED** — zmierzone na żywym API Anthropic tego dnia; **CALCULATED** —
wyliczone z surowych danych; **ESTIMATE** — szacunek. Liczby n=1 na scenariusz są
szumem na poziomie pojedynczego scenariusza — wnioski o regresjach opieram na 3
przebiegach (§8).

## 1. Freeze benchmarku

Plik: `benchmark/final-model-eval/freeze.json` (zapisany przed pierwszym płatnym wywołaniem).

| Pole | Wartość |
|---|---|
| provider | Anthropic, `AnthropicAgentProvider` wprost (bez runnera tury) — ten sam na obu commitach |
| model / effort (baseline A) | `claude-sonnet-5` / `medium` (`AI_EFFORT_TOOLS=low`, bez `AI_MODEL_TOOLS`) |
| cards mode | `strict` (flaga harnessu `--cards strict`, oba commity) |
| catalog mode | `search` (domyślny na obu commitach) |
| AI_* w env | brak w `.env` — wszystkie domyślne; `AI_TIER_OVERRIDE=PRO` ustawia harness w swoim procesie; `AI_CACHE_WARM_HOURS=0` |
| concurrency | 1 (sekwencyjnie, jeden scenariusz = jeden proces) |
| limit czasu | 300 s na scenariusz, bez `maxTurnCostUsd` |
| katalog / fixture | lokalny Postgres 16, 500 przepisów katalogu, 476 składników; syntetyczne gospodarstwa tworzone i kasowane per scenariusz; tydzień 2026-10-05 |
| ceny | `src/config/model-prices.ts` — identyczne na obu commitach (sonnet-5 $2/$10, haiku-4-5 $1/$5 za MTok); koszt z tokenów zgadza się z kosztem dostawcy co do µ$ |
| produkcja w chwili pomiaru | Rafał przestawił w trakcie etapu `AI_EFFORT` na Railwayu z `low` na `medium` — **do dziś produkcja chodziła na `low`**; benchmark nie czyta env Railwaya |

## 2. Metodologia

- **Ten sam harness na obu commitach.** `scripts/agent-scenarios.ts` +
  `scripts/lib/agent-benchmark-scenarios.ts` z HEAD skopiowane do worktree anchora
  (jedyna różnica drzewa anchora). Moduły, których anchor nie ma — pamięć tury
  (Etap 3) i historia rozmowy z kartami (`history-cards`) — ładują się opcjonalnie,
  więc KAŻDY commit dostaje swoją produkcyjną ścieżkę (anchor: historia samym
  tekstem, jak jego runner). Treść scenariuszy i kryteria sukcesu identyczne; w
  `expectedTools` HEAD wymienia też nowe narzędzia (anchor ich nie ma — kryterium
  „co najmniej jedno z” nie zmienia się dla anchora).
- **Zmiany harnessu (commit `92e837c`):** jedna tura = jeden `turnId` (jak runner),
  karta tury w historii kolejnej tury, twardy `--max-cost-usd`, rekord z rundami na
  turę, statusem planera, stanem docelowym (do odchylenia kcal) i celami domowników,
  konfiguracja E. Na sucho: 44/44 scenariuszy sprawne na obu commitach.
- **Scenariusze:** 40 istniejących + 4 nowe z polecenia (kategorie C i E, których
  zestaw nie miał): `g13-mam-kurczaka`, `g13-wybieram-druga`, `g13-pokaz-inne`,
  `g13-zmiana-w-propozycji`. Mapowanie na kategorie A–F z polecenia —
  `summarize.js` (`LETTER`), koszyki rozkładu (`CATEGORY`): chat/discovery (g1, g10,
  g12 bez długiej rozmowy), suggestion (g2, kurczak, „pokaż inne”), planning (g4–g9),
  editing (g3, g11), follow-up (wybieram drugą, zmiana w propozycji, długa rozmowa).
- **Kolejność:** before i after na przemian, scenariusz po scenariuszu (drift dostawcy
  minimalny; cache prefiksu po stronie dostawcy przeżywa restart procesu).
- **Pass/fail:** `verify` scenariusza (skutek w BAZIE: plan/propozycja/notatki) +
  kontrakt narzędziowy (`expectedTools`/`forbiddenTools`/`maxRounds`). Dodatkowo
  ręczny przegląd wszystkich odpowiedzi tekstowych modelu (§12) — `verify` nie
  ocenia języka.
- **Jakość planów:** odchylenie kcal dnia na osobę liczone offline z celu propozycji
  (kcal/porcja z katalogu × udział osoby) dla dni PEŁNYCH (wszystkie włączone pory) —
  ta sama miara dla obu commitów, niezależna od tego, co model napisał.

## 3. Koszt eksperymentu

| Faza | Przebiegi | Koszt (MEASURED) |
|---|---:|---:|
| 1 before/after, 44 scen. × 2 commity × 1 | 88 | $4,07 |
| 1b powtórzenia, 18 scen. × 2 commity × 2 | 72 | $3,11 |
| 2 screening B/E/D, 12 scen. × 1 | 36 | $0,64 |
| 3 pełny zestaw B/E, 32 pozostałe scen. × 1 | 64 | $1,69 |
| 4 powtórzenia finalistów B/E, 18 scen. × 2 | 72 | $1,38 |
| **Razem** | **332** | **$10,89** (szacunek $23,5, twardy limit $40) |

Faza 5 (ponowny benchmark po zmianie konfiguracji) nie była potrzebna: nie zmieniłem
kodu, a rekomendowana konfiguracja (B) jest już zmierzona na finalnym HEAD (pełny
zestaw + 3 przebiegi decydujących scenariuszy).

## 4. Before vs after (anchor `22aa63c` ↔ HEAD, Sonnet 5 / medium, 44 scenariusze × 1)

| Metryka | Before | After | Delta |
|---|---:|---:|---:|
| pass rate | 90,9% (40/44) | 84,1% (37/44) | **−6,8 pp** |
| successful tasks | 40 | 37 | −3 |
| avg cost/task | $0,0626 | $0,0299 | −52% |
| **cost/successful task** | **$0,0689** | **$0,0355** | **−48%** |
| median cost | $0,0418 | $0,0239 | −43% |
| p50 latency (scenariusz) | 13,6 s | 7,0 s | −49% |
| p95 latency (scenariusz) | 45,9 s | 17,5 s | −62% |
| p50 / p95 latency wywołania API | 4,7 s / 15,2 s | 4,4 s / 9,1 s | −6% / −40% |
| avg provider calls (scenariusz) | 3,18 | 1,98 | −38% |
| avg model rounds na turę | 2,30 | 1,43 | −38% |
| avg tool calls | 3,27 | 1,41 | −57% |
| input tokens (bez cache), średnio | 6,4 | 4,0 | — (pomijalne) |
| output tokens, średnio | 1 726 | 600 | −65% |
| cache read, średnio | 71 580 | 48 779 | −32% |
| cache write, średnio | 7 761 | 3 530 | −55% |

Wszystko MEASURED (surowe: `before/*.r1.json`, `after/*.r1.json`, `summary.json`).

**Wniosek:** koszt na udane zadanie spadł o połowę, latency o połowę (p95 o 62%),
rundy o 38%. **Jakość NIE utrzymała się w całości**: −3 scenariusze w pełnym zestawie,
potwierdzone w powtórzeniach (§8) — pięć stabilnych regresji, dwa stabilne zyski.

## 5. Wyniki per kategoria (44 × 1, Sonnet 5 / medium)

| Kategoria | n | pass B→A | cost/success B→A | p50 B→A | p95 B→A | wywołań B→A |
|---|---:|---|---|---|---|---|
| chat/discovery (proste pytania, rozmowa) | 11 | 11 → 10 | $0,030 → $0,033 | 6,2 → 5,6 s | 22,9 → 17,5 s | 1,64 → 1,55 |
| suggestion | 5 | 4 → 4 | $0,043 → **$0,022** | 8,7 → 4,2 s | 20,8 → 8,2 s | 2,40 → **1,20** |
| planning (+ ograniczenia) | 19 | 18 → 16 | $0,071 → **$0,030** | 22,4 → **8,9 s** | 78,2 → **15,6 s** | 2,58 → 1,58 |
| editing | 6 | 6 → 5 | $0,053 → $0,044 | 12,5 → 10,1 s | 41,1 → 20,4 s | 3,17 → 2,50 |
| follow-up | 3 | 1 → 2 | $0,654 → $0,101 | 45,9 → 9,0 s | 192 → 71 s | 14,0 → 6,33 |

(B = before, A = after.) Regresja, której nie chowam za średnią: **prosty chat nie
staniał** — koszt na zadanie praktycznie bez zmian ($0,0300 → $0,0303), bo prefiks
promptu na wywołanie URÓSŁ o ~7% (23,8 → 25,4 tys. tokenów, nowe narzędzia i
instrukcje) i zjada zysk z mniejszej liczby wywołań; koszt na sukces w tej kategorii
wzrósł przez jedną porażkę (`g10-luka-makro`). Zysk jest w sugestiach, planowaniu i
rozmowach wieloturowych.

## 6. Screening model/effort (tylko finalny HEAD)

Modele w kodzie/cenniku: `claude-sonnet-5`, `claude-haiku-4-5`, `claude-opus-5`
(Opus nie testowany — polecenie §6.7). Haiku 4.5 nie ma `effort`: `medium` = myślenie z
budżetem 2048 tokenów, `low` = bez myślenia.

Runda 1 — 12 reprezentatywnych scenariuszy × 1:

| Konfiguracja | pass | cost/success | p50 / p95 | wywołań | Decyzja |
|---|---:|---:|---|---:|---|
| A Sonnet 5 / medium (baseline) | 10/12 | $0,035 | 5,3 / 17,5 s | 1,42 | — |
| B Sonnet 5 / low | 10/12 | $0,034 | 4,7 / 8,8 s | 1,42 | → runda 2 |
| E Haiku 4.5 / medium | 11/12 | $0,017 | 10,2 / 53,0 s | 1,42 | → runda 2 |
| D Haiku 4.5 / low | 9/12 | $0,012 | 3,9 / 9,0 s | 1,50 | **odrzucony**: tydzień dla pary bez żadnego narzędzia (pusty plan), dodatkowe wywołanie w prostym pytaniu |

## 7. Pełne wyniki finalistów (44 × 1, finalny HEAD)

| Metryka | A Sonnet/medium | B Sonnet/low | E Haiku/medium |
|---|---:|---:|---:|
| pass rate | 84,1% (37) | 84,1% (37) | 93,2% (41) |
| cost/success | $0,0355 | $0,0387 | $0,0194 |
| avg cost/task | $0,0299 | $0,0325 | $0,0181 |
| p50 / p95 scenariusz | 7,0 / 17,5 s | 5,6 / 23,7 s | 12,0 / 43,4 s |
| p50 / p95 wywołanie API | 4,4 / 9,1 s | **3,8 / 6,2 s** | 6,5 / 21,7 s |
| avg wywołań / rund na turę | 1,98 / 1,43 | 2,20 / 1,59 | 2,05 / 1,48 |
| output tokens średnio | 600 | 555 | 1 217 |
| odchylenie kcal dnia (śr. / p95) | 8,3% / 29% | 8,3% / 29% | 10,2% / 46% |
| hard violations (alergeny, dieta, wykluczenia) | 0 | 0 | 0 |

## 8. Stabilność / powtórzenia (18 scenariuszy decydujących × 3 przebiegi)

| Scenariusz | Before | A | B | E |
|---|---|---|---|---|
| g1-wtorek-obiad, g12-poza-dziedzina, g2-cos-szybkiego, g13-mam-kurczaka, g4-zaplanuj-piatek, g6-pelny-tydzien, g6-tydzien-dwa-cele, g3-podmien-kolacje, g7-jedna-alergia | 3/3 każdy | 3/3 każdy | 3/3 każdy | 3/3 każdy |
| g13-wybieram-druga | 0/3 | **3/3** | **3/3** | 2/3 |
| g9-uboga-pula-wegan | 0/3 | **2/3** | 0/3 | 2/3 |
| g9-nierealny-czas | 3/3 | **1/3** | 1/3 | 3/3 |
| g10-luka-makro | 1/3 | **0/3** | 0/3 | 3/3 |
| g11-przepis-katalogowy | 2/3 | **0/3** | 3/3 | 1/3 |
| g4-dzien-w-limicie-kcal | 3/3 | **0/3** | 0/3 | 1/3 |
| g8-podzial-posilku | 3/3 | **0/3** | 0/3 | 0/3 |
| g13-pokaz-inne | 0/3 | 0/3 | 0/3 | 0/3 |
| g13-zmiana-w-propozycji | 0/3 | 0/3 | 0/3 | 0/3 |
| **Razem (54)** | 39 | 33 | 34 | 39 |
| cost/success | $0,087 | $0,044 | $0,040 | $0,022 |
| p50 / p95 | 19,5 / 55,7 s | 7,9 / 11,9 s | 5,6 / 11,8 s | 12,2 / 43,4 s |

(Zestaw celowo przeważony scenariuszami, które choć raz padły — to nie jest pass rate
produktu, tylko test stabilności różnic.)

**Stabilne regresje HEAD vs anchor (przyczyny z analizy przebiegów):**
1. `g4-dzien-w-limicie-kcal` 3/3 → 0/3 — `build_meal_plan` nie ma pola na limit kcal
   podany w ROZMOWIE; planer liczy od celu z profilu (2200), środa 2080 kcal przy
   „zmieść się w 1800”. Luka w kontrakcie narzędzia, nie w modelu.
2. `g8-podzial-posilku` 3/3 → 0/3 — „jedno danie, dwa talerze” trafia w `suggest_meals`
   (A) / `propose_swap`+`replace_plan_item` (B) zamiast `propose_household_split`.
   Regres routingu po odchudzeniu listy narzędzi (Etap 3).
3. `g9-nierealny-czas` 3/3 → 1/3 — planer oddaje PARTIAL z daniami ponad 5 min, a model
   pisze „wszystkie do 5 minut przygotowania” (nieprawda o skutku). `max_prep_minutes`
   działa w planerze jak życzenie, a model nie widzi, że je złamano.
4. `g11-przepis-katalogowy` 2/3 → 0/3 (A) — model układa `propose_day_plan`, a
   autorytatywne zdanie serwera z Etapu 3 („Propozycja czeka na zatwierdzenie.”)
   zastępuje wyjaśnienie, dlaczego przepisu katalogowego nie da się edytować.
   Na `low` (B) model w ogóle nie stawia karty i wyjaśnia — 3/3.
5. `g10-luka-makro` 1/3 → 0/3 — karta luki makro kończy turę, a zdanie nie cytuje liczb
   karty wymaganych przez scenariusz (wymóg częściowo formalny — liczba „293 kcal”
   pojawia się, ale nie ta z karty).

**Stabilne zyski:** `g13-wybieram-druga` 0/3 → 3/3 (historia z kartami, Etap 1),
`g9-uboga-pula-wegan` 0/3 → 2/3 (planer mówi PARTIAL).
**Oba commity padają:** `g13-pokaz-inne` (drugie `suggest_meals` zwraca te same dania —
narzędzie nie wyklucza pokazanych), `g13-zmiana-w-propozycji` (poprawka nie daje dania
wegetariańskiego).

## 9. Cost per successful task

`suma kosztu wszystkich prób / liczba udanych zadań` (MEASURED):

| | pełny zestaw 44×1 | decydujące 18×3 |
|---|---:|---:|
| Before (anchor) Sonnet/medium | $0,0689 | $0,0869 |
| A HEAD Sonnet/medium | $0,0355 | $0,0438 |
| B HEAD Sonnet/low | $0,0387 | $0,0404 |
| E HEAD Haiku/medium | $0,0194 | $0,0224 |
| D HEAD Haiku/low (12×1) | $0,0122 | — (odrzucony) |

A i B są w granicach szumu (±10% w zależności od zestawu). E jest ~2× tańszy na sukces
— ale patrz §12: jego „sukcesy” mają gorszą treść.

## 10. Latency p50/p95

Scenariusz (cała rozmowa) i pojedyncze wywołanie API — §4 i §7. Najważniejsze:
HEAD skrócił ogon z 45,9 s do 17,5 s (p95 scenariusza) głównie przez planowanie
(78 → 16 s). `low` skraca wywołanie API (p50 4,4 → 3,8 s, p95 9,1 → 6,2 s). Haiku z
myśleniem jest WOLNIEJSZY od Sonneta (p95 wywołania 21,7 s).

## 11. Tool routing (MEASURED, 44×1)

| Sprawdzenie | Before | After (A) | B | E |
|---|---:|---:|---:|---:|
| sugestie przez `suggest_meals` | 0% (find_recipes 100%) | **100%** (find_recipes 0%) | 100% | 100% |
| wywołań w sugestii | 2,0 | **1,0** | 1,0 | 1,0 |
| planowanie przez `build_meal_plan` | 0% (ręczne propose 100%) | **100%** (ręczne 0%) | 100% | 100% |
| wywołań w planowaniu | 2,6 | 1,5 | 1,4 | 1,5 |
| lokalna zmiana przez `replace_plan_item` | 0% | **100%** | 100% | 67% |
| tury zakończone kartą bez ostatniej rundy (`tool_ended_turn`) | 36% | **54%** | 44% | 38% |
| przejście na planistę (`start_planning`) | 0% | 0% | 0% | 0% |

Model nie wraca do ręcznego składania 21 slotów — ani razu w 332 przebiegach na HEAD.
Wyjątek: `g8-podzial-posilku` (§8.2).

## 12. Jakość planów i odpowiedzi

**Plany (dane serwera, dni pełne, 44×1):** średnie |odchylenie kcal dnia| 16,4% → 8,3%,
p95 51,5% → 29,1%, dni w ±10%: 37% → 79% (before → after, 19 dni). Statusy planera
na HEAD: OK 6 / PARTIAL 4 (PARTIAL uzasadnione: limit 5 min, uboga pula wegańska,
wspólne danie dla bardzo różnych celów bez porcji per osoba — flaga wyłączona).

**Odpowiedzi tekstowe (ręczny przegląd 81 odpowiedzi A i E + 43 B):**
- A i B: poprawna polszczyzna, liczby z kart/serwera. Jedyny powtarzalny fałsz — §8.3
  (`g9-nierealny-czas`).
- E (Haiku): ~1/3 odpowiedzi pisanych przez model ma błędy językowe albo zmyślenia —
  „brakuje **White Rabbit** na kilka dni”, „Obiad zawsze o **13:37**?”, „W trybie
  PROPOZYCJA nie mogę zapisać planu” (wyciek żargonu instrukcji), „Calorically serwer
  podał”, „kaloryjnego”, „Gotowo”, „Karta pokażę”; w `g11` zamiast odmowy tworzy
  własny przepis po 13 wywołaniach `search_ingredients`; liczy sam („379 kcal na
  dzień”). Wyższy pass rate E wynika z tego, że `verify` sprawdza skutek w bazie, nie
  zdania — **E nie przechodzi bramki jakości**.
- Server-first: A/B nie liczą kcal ani porcji sami — cytują kartę/wynik planera.

## 13. Weryfikacja hipotez Etapów 0–5

| Hipoteza | Wynik | Dowód |
|---|---|---|
| Etap 0: prompt ~25 tys. zamiast ~81 tys. | **CONFIRMED** | tury jednorundowe: HEAD mediana 25 441 tokenów wejścia/wywołanie, anchor 23 846 (tryb search był już przed anchorem; 81 tys. = stary digest). HEAD +7% przez nowe narzędzia/instrukcje |
| Etap 3: sugestia 2–3 rundy → 1, przez `suggest_meals` | **CONFIRMED** | 2,0/2,4 → 1,0/1,2 wywołania; `suggest_meals` 100%, `find_recipes` 0% |
| Etap 3: karta kończy turę bez ostatniej rundy | **CONFIRMED** | `tool_ended_turn` 36% → 54% tur; planowanie 2,58 → 1,58 wywołania |
| Etap 2: model nie składa planu ręcznie, używa `build_meal_plan` | **CONFIRMED** | 100% przebiegów planistycznych; odchylenie kcal 16,4% → 8,3% |
| Etap 1: kontynuacja po karcie („Wybieram drugą”) | **CONFIRMED** | 0/3 → 3/3 |
| Etap 4: katalog nie wpływa liniowo na prompt | **PARTIALLY CONFIRMED** | na żywo tylko katalog 500: prefiks stały ±2 tys. (blok domu), niezależny od scenariusza; skalowanie 5k/10k potwierdzone offline w Etapie 4, na żywo — DEFERRED |
| Etap 3: model nie liczy kcal/porcji | **CONFIRMED dla Sonneta**, NOT CONFIRMED dla Haiku | §12 |

## 14. Wybrana konfiguracja

### RECOMMENDED DEFAULT
- model: **`claude-sonnet-5`**
- effort: **`low`**

### ROUTING
**Brak.** Ani effort routing (medium nie jest lepsze na trudnych przypadkach: 33/54 vs
34/54, te same porażki), ani model routing (Haiku odpada na jakości tekstu; sugestie
na Sonnecie kosztują już $0,017, oszczędność ~$0,006 na turę nie uzasadnia drugiego
modelu i wolniejszego Haiku z myśleniem).

### FALLBACK
Brak mocniejszego modelu: żaden przypadek nie padł z powodu „za słabego” modelu —
porażki HEAD mają przyczyny w kontraktach narzędzi i regule zdania serwera (§8), nie
w zdolności Sonneta. Opus nie ma tu czego naprawić.

### EXPECTED COST
~**$0,035–0,040 na udane zadanie** (B: $0,0387 pełny zestaw, $0,0404 decydujące).

### EXPECTED LATENCY
scenariusz p50 **~5,6 s**, p95 **~12–24 s** (zależnie od zestawu); wywołanie API
p50 3,8 s / p95 6,2 s.

### QUALITY
pass rate 84% pełnego zestawu (jak medium), 0 naruszeń twardych ograniczeń, czysta
polszczyzna. Ograniczenia: pięć regresji z §8 (niezależne od effortu), `pokaż inne` i
poprawka w propozycji — do naprawy w kodzie, nie konfiguracją.

### WHY
`low` = ta sama jakość i koszt co `medium` (różnice w szumie), a szybsze wywołanie
(p50 −14%, p95 −32%) i w `g11` lepsze zachowanie (wyjaśnia zamiast stawiać kartę).
To wartość, na której produkcja chodziła do dziś. Haiku tańszy 2×, ale ~1/3 jego
odpowiedzi ma błędy albo zmyślenia i ma 2,5× dłuższy ogon latencji.

## 15. Routing — decyzja

Nie implementuję routingu (§14). Router deterministyczny nie ma czego rozdzielać:
tanie tury (sugestie, proste pytania) już kończą się jednym wywołaniem, a drogie
(planowanie) nie zyskują na wyższym effort.

## 16. Finalny benchmark wybranej konfiguracji

B (Sonnet 5 / low) zmierzony na finalnym HEAD: pełny zestaw 44×1 (§7) + 18 scenariuszy
decydujących ×3 (§8). Kod nie był zmieniany, więc to są wyniki finalnego kodu.

## 17. Rekomendowane ENV

| ENV (nazwy z kodu) | dziś | rekomendacja | zmieniać teraz? |
|---|---|---|---|
| `AI_MODEL` | domyślne `claude-sonnet-5` (nie odczytywałem Railwaya) | `claude-sonnet-5` | NIE (bez zmian) |
| `AI_MODEL_TOOLS` (odpowiednik „AI_MODEL_PLANNER”) | nieustawione (brak przekazania) | nieustawione | NIE |
| `AI_EFFORT` | `medium` (od dziś; wcześniej `low`) | **`low`** | **po Twojej decyzji** — dane: równa jakość i koszt, szybciej |
| `AI_EFFORT_TOOLS` | domyślne `low` (działa tylko z `AI_MODEL_TOOLS`) | bez zmian | NIE |
| `AI_CATALOG_MODE` | domyślne `search` | `search` | NIE |
| `AI_CARDS_MODE` | (nie odczytywałem) — benchmark: `strict` | `strict` | NIE |
| `AI_PLANNER_PER_USER_PORTIONS` | `false` | `false` do rolloutu iOS | **NIE** |

„AI_MODEL_CHAT” i „AI_MODEL_PLANNER” nie istnieją w kodzie — nie dodaję nowych env.

## 18. Znane ryzyka

- Jakość: −3 scenariusze vs anchor (§8) — realne regresje zachowania, niezależne od
  modelu/effortu; najpoważniejsza — fałszywe „wszystkie do 5 minut” przy planie PARTIAL.
- Harness woła dostawcę wprost (bez runnera): latency nie obejmuje kolejki tury,
  odpytywania ani zapisu odpowiedzi (Etap 5) — to kilkadziesiąt ms (ESTIMATE).
- n=1 w pełnym zestawie; różnice na pojedynczych scenariuszach spoza §8 to szum.
- Katalog 500 — zachowanie przy większym katalogu na żywo niezmierzone.
- `verify` nie ocenia języka — przegląd ręczny (§12) jest jakościowy, nie metryką.

## 19. DEFERRED

- Naprawy regresji z §8 (limit kcal w `build_meal_plan`, routing podziału dania,
  twardy/ujawniony limit czasu planera, zdanie serwera vs wyjaśnienie modelu,
  wykluczanie pokazanych dań w `suggest_meals`) — **nowy etap po Twojej decyzji**.
- Zmiana `AI_EFFORT` na produkcji — po Twoim zatwierdzeniu.
- Pomiar na żywo przy katalogu 5k/10k.
- Opus — nie testowany (brak przypadku, który by go uzasadniał).

## 20. Surowe pliki

`benchmark/final-model-eval/`:
- `freeze.json` — zamrożenie, budżet, reguła STOP;
- `run.sh` — przebieg (przeplot before/after, kandydaci, limit kosztu);
- `summarize.js` — agregacja (koszt z tokenów, kategorie, routing, odchylenie kcal);
- `before/*.r1.json`, `before/*.r2.json` — anchor `22aa63c`;
- `after/*.r1.json`, `after/*.r2.json` — HEAD;
- `candidates/{B,D,E}/*.json` — kandydaci na HEAD;
- `summary.json` (44×1, before/after/B/E), `summary-before-after.json` (z powtórzeniami),
  `summary-phase1.json`, `summary-full-r1.json`.

Każdy rekord: scenariusz, commit, model, effort, pass/issues, narzędzia, rundy na turę,
tokeny (w tym cache), koszt, latency i czasy wywołań, status planera, stan docelowy,
cele domowników, ostatnia odpowiedź. Fixture syntetyczny, bez sekretów i danych
użytkowników.

## Commity

- `92e837c` — chore(benchmark): harness Etapu 6 — jeden plik dla anchora i HEAD, budżet, 4 scenariusze kontynuacji
- commit wyników i raportu — następny po `92e837c`
