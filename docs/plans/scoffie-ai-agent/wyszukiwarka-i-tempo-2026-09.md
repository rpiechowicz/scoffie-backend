# Wyszukiwarka przepisów i tempo asystenta — 26.09.2026

Status: **wdrożone w kodzie (gałąź `claude/admin-crm-planning-b0hmgo`), bez
benchmarku na żywym modelu** — decyzja Rafała: „zrób wszystkie kroki bez
benchmarków, nie testuj na moich tokenach". Wszystko jest za przełącznikami
w panelu (Sterowanie), więc powrót do starego zachowania nie wymaga deployu.

## 1. Problem

Do 26.09 asystent NIE wyszukiwał przepisów — czytał cały katalog przy każdym
wywołaniu API. `catalog-digest.ts` ściskał katalog do linii na przepis (tytuł,
pory, makro, czas, alergeny, diety, 5 składników) i ta lista jechała w
prefiksie promptu. Przy 89 przepisach to była dobra decyzja (komentarz w kodzie
to mówił: „wyszukiwarka dokłada się, gdy katalog urośnie").

Katalog urósł do **500 przepisów**:

| | 500 (dziś) | 1 000 | 5 000 | 10 000 |
|---|---|---|---|---|
| digest w prefiksie | ~60 tys. tok. (99 418 znaków) | ~120 tys. | ~600 tys. | nie mieści się w 1M |
| odczyt prefiksu z cache / wywołanie (Sonnet 5) | ~$0,017 | ~$0,029 | ~$0,12 | — |

Do tego zapis cache co godzinę ciszy ($4/MTok) i jakość: wybór z 500 linii
to więcej pomyłek („zgubione w środku") niż wybór z 8 dobrze dobranych.

Pomiar 24.09 (`tempo-2026-09-24.md`): czas tury to w 36 % czekanie na pierwszy
blok (~2,1 s na wywołanie), 41 % myślenie, 22 % pisanie; nasze narzędzia 0 %.

## 2. Jak to robią duzi (i co z tego bierzemy)

- **Wyszukanie po kluczu** (Gmail: „czy ten e-mail istnieje"): indeks B-drzewa
  albo hash, O(log n) — przy miliardzie ~30 porównań; sharding po haszu klucza;
  filtr Blooma („na pewno nie ma" bez dysku). U nas to samo robi Postgres na
  `id`/`email` — to nie był nasz problem.
- **Indeks odwrócony** (Google, Allegro): wartość → lista dokumentów; „bez
  glutenu I obiad I kurczak" = przecięcie list. Postgres już ma GIN na
  `allergens`, `dietTags`, `suitableMealTypes`.
- **Dwa etapy** (YouTube, Spotify, Netflix): tanie filtry zawężają do setek →
  ranking → dywersyfikacja. **To wzięliśmy** (§3).
- **Embeddingi / hybryda** (wyszukiwanie po znaczeniu). **Jeszcze nie** (§6).
- **Agent LLM = wyszukiwanie jako narzędzie** (RAG): model tłumaczy prośbę na
  kryteria, silnik zwraca top-k, model wybiera i tłumaczy. **To wzięliśmy.**

Skala: 10 tys. przepisów to kilkadziesiąt MB w pamięci jednego procesu.
Osobny silnik (Elasticsearch, Meilisearch) nie jest potrzebny — wąskim
gardłem były TOKENY, nie baza.

## 3. Co jest zrobione

### 3.1 Tagi przepisu po stronie serwera — `src/recipes/recipe-facets.util.ts`

Katalog nie niesie tagów (`sourceCategory/Cuisine/Tags` puste w 500/500).
Tagi liczą się z nazwy i składników — tymi samymi regułami, co filtry kategorii
w iOS (`RecipeCategoryFacets.swift`, sprawdzone na 495 przepisach), z jednym
słownikiem zamiast czterech arkuszy:

- rodzaj dania: `soup salad pasta grains potatoes dumplings stew porridge eggs
  sandwich pancakes yogurt bake cake dessert crunchy bites dip drink`
- mięso: `poultry pork beef fish meatless`; smak: `sweet savory`
- cechy z makro: `quick` (≤ 20 min), `light` (≤ 400 kcal/porcję),
  `high_protein` (≥ 25 g białka/porcję)

Pokrycie na katalogu 500: rodzaj dania ma 471 przepisów (29 bez — głównie
„mięso + warzywa z pieca", np. „Kurczak pieczony z batatem"; wypadają tylko
przy zawężeniu po rodzaju).

### 3.2 Indeks w pamięci — `src/agent/search/agent-catalog.service.ts`

- Budowa raz na wersję katalogu (~450 ms dla 500 przepisów), potem z pamięci.
  Wersja = tani odcisk (`count` + `max(updatedAt)` przepisów i ich składników),
  sprawdzany przy każdej turze; sufit życia 10 min (zmiany samego składnika).
- Numeracja `R001…` identyczna jak w digeście (tytuł, id) — plan w prompcie,
  e2e i skrypty dalej mówią tym samym językiem.
- Przepisy domu (`isCatalog=false`) doczytywane przy każdym szukaniu (jest ich
  kilka), referencja = UUID, znacznik `household: true`.

### 3.3 Narzędzie `find_recipes` (zastępuje `search_recipes_by_ingredient`)

Wszystkie pola WYMAGANE (budżet pól nieobowiązkowych dalej 24/24; „bez
ograniczenia" = `""`, `[]`, `0`, `ANY`): `query`, `meal_type`, `tags`,
`include_ingredients`, `exclude_ingredients`, `max_prep_minutes`,
`max_kcal_per_serving`, `min_protein_per_serving`, `for_user_ids`, `sort`
(`BEST_FIT|QUICKEST|HIGH_PROTEIN|LIGHTEST`), `limit` (1–15). Bez `strict` —
walidację robi executor (nieznany tag = `VALIDATION_ERROR` jako dane).

Pipeline (`src/agent/search/catalog-search.ts`, czyste funkcje):

1. **Filtry twarde jedzących** — alergeny, wykluczone składniki, dieta —
   `conflictingAllergens` i `satisfiesDiet` z `diet-rules.util`, czyli te same
   reguły co walidator planu. Obejmują WSZYSTKICH jedzących, także bez zgody na
   asystenta (ich alergeny i tak pilnuje zapis); imiona i szczegóły idą do
   modelu tylko przy osobach ze zgodą (`appliedForAudience`).
2. **Kryteria z prośby** — pora (`suitableMealTypes`), tagi (w grupie LUB,
   między grupami I), składniki (po nazwie, z polską odmianą: rdzeń od
   początku wyrazu), czas (0 min = „nie wiemy" nie przechodzi limitu), kcal
   i białko NA PORCJĘ.
3. **Tekst** — rdzenie słów (tytuł ×3, tag/składnik ×2, opis ×1); słowo po
   „bez" wypada („bez mięsa" nie promuje mięsa); tagi mają synonimy
   („lekkiego" → `light`). Tekst, który w nic nie trafia, jest pomijany
   JAWNIE (`textIgnored: true`), żeby model sięgnął po tagi.
4. **Ranking** — ulubione domu +1,5; już w planie tego tygodnia −3; w zeszłym
   −1,5; składniki wspólne z planem tygodnia (bez przypraw i olejów) +0,5
   za każdy do +1,5 — „i tak będą na liście zakupów"; popularność w planach
   wszystkich domów do +1.
5. **Dywersyfikacja** — kara za powtórzony rodzaj dania (nie pięć zup).
6. **Zero wyników** — `relaxations`: ile dań byłoby bez każdego z kryteriów
   prośby (nigdy bez alergenów i diety).

Trafienie: referencja, tytuł, pory, kcal/B/T/W na porcję, czas, porcje,
alergeny, diety, tagi, 5 głównych składników, `why` („wspólne z planem
tygodnia: por, papryka", „ulubione domu", „JUŻ jest w planie"). 8 trafień to
~3,2 tys. znaków (~1 tys. tokenów). Czas: 1–25 ms na 500 przepisach.

### 3.4 Mapa katalogu zamiast digestu — `AI_CATALOG_MODE`

- `search` (domyślnie): w prefiksie **mapa** — liczba dań na pory i tagi
  z liczbami, zasady referencji i filtrów. 1 788 znaków zamiast 99 418 (~55×
  mniej), rozmiar nie rośnie z katalogiem. Szacunkowy prefiks: ~83 tys. →
  ~25 tys. tokenów (dokładnie: `pnpm agent:measure:tokens`, liczy teraz też mapę).
- `digest`: stary blok, bez zmian — **awaryjny powrót z panelu** (Sterowanie →
  „Katalog w prompcie asystenta"). Lista narzędzi jest w obu trybach ta sama
  (prefiks cache), `find_recipes` działa też przy digeście.
- Instrukcje (`AGENT_INSTRUCTIONS`) są wspólne dla obu trybów: „przy mapie
  dania bierzesz WYŁĄCZNIE z find_recipes; do wyboru na porę — jedno
  find_recipes + offer_options; plan kilku pór — find_recipes dla każdej pory
  RÓWNOLEGLE w jednej rundzie".

### 3.5 Kandydaci przy `start_planning`

Gdy działa przekazanie pałeczki (`AI_MODEL_TOOLS`), wynik `start_planning`
niesie po 6 kandydatów na każdą porę domu (dla całego domu, po rankingu) —
planista zaczyna od nich, zamiast od rundy szukania.

### 3.6 Koniec tury bez ostatniej rundy

`TURN_ENDING_TOOLS` = `ask_clarifying_question`, `offer_options`, `propose_*`.
Gdy KAŻDE narzędzie rundy jest takie i się udało (propozycja powstała —
`proposed !== false`), a model napisał zdanie w tej samej wiadomości, dostawca
kończy turę bez kolejnego wywołania (`stopReason: tool_ended_turn` w
`AiUsage`). Bez tekstu albo przy odmowie — pętla jak dawniej. Instrukcja:
„odpowiedź piszesz w tej samej wiadomości, przed wywołaniem". Pomiar 24.09:
ta runda to do 18 % czasu tury.

Efekt uboczny, który się sumuje: „co na kolację?" było dotąd `offer_options` +
runda na zdanie = 2 wywołania; teraz `find_recipes` + `offer_options` z
tekstem = też 2 — wyszukiwarka nie dokłada rundy w najczęstszym przypadku.

### 3.7 Podgrzewanie cache — `AgentCacheWarmer`, `AI_CACHE_WARM_HOURS`

Co 55 min jedno żądanie z tym samym prefiksem (`system` + `tools`, 1 token
wyjścia), tylko gdy ostatnia tura była ≤ `AI_CACHE_WARM_HOURS` godzin temu.
**Domyślnie `0` = wyłączone** (decyzja 26.09: bez subskrybentów to wydatek bez
zysku; prefiks jest wspólny dla wszystkich, więc przy dużym ruchu tury same
trzymają cache ciepłym). Włączenie: panel → Sterowanie, np. `3`. Przy przekazaniu pałeczki
podgrzewa oba prefiksy. Koszt → `AiUsage` (`stopReason: cache_warm`, bez osoby
i domu) i budżet dobowy. Przy prefiksie ~25 tys. to ~$0,005 za ping, najwyżej
~$0,15 na dobę pełnego ruchu; w nocy bez rozmów — zero.

## 4. Czego się spodziewać (bez pomiaru — szacunki)

| | przed | po | pewność |
|---|---|---|---|
| prefiks | ~83 tys. tok. | ~25 tys. | wysoka (znaki) |
| odczyt prefiksu / wywołanie | ~$0,017 | ~$0,005 | wysoka |
| koszt średniej tury | ~$0,08 | ~$0,05–0,06 | średnia |
| pierwsza tura po ciszy | +5 s, +$0,31 | ~+2 s, ~$0,10 (mniejszy prefiks; podgrzewanie wyłączone) | średnia |
| tura z kartą (propozycja, wybór) | N rund | N−1 | wysoka, gdy model napisze zdanie przed wywołaniem |
| czekanie na pierwszy blok | ~2,1 s | mniej, ile — nie wiadomo | niska |
| myślenie przy planowaniu | ~20 s | może mniej (krótka lista zamiast 500 linii) | niska |
| proste pytania o danie z katalogu | 1 runda | +1 runda (`find_recipes`), −1 (koniec po karcie) | średnia |
| koszt i czas vs wielkość katalogu | liniowo | stałe | wysoka |

## 5. Co sprawdzić, gdy będzie budżet na pomiar

1. `pnpm agent:measure:tokens` — prawdziwe tokeny mapy i prefiksu (count_tokens
   jest darmowe, ale wymaga klucza).
2. `pnpm agent:scenarios` na obu trybach (`AI_CATALOG_MODE=search|digest`),
   ≥ 3 przebiegi (~$3 za konfigurację): koszt, czas, rundy, `tool_ended_turn`,
   zero naruszeń alergenów.
3. Na produkcji: `grep agent-timing` + w panelu udział `stopReason =
   tool_ended_turn` i `cache_warm` w `AiUsage`.
4. Test trafności wyszukiwarki: 30 próśb i dania, które MAJĄ być w top 10 —
   bez modelu, na samej `searchRecipes` (jak `catalog-search.spec.ts`).

Gdy coś pójdzie źle na produkcji: panel → Sterowanie → `AI_CATALOG_MODE=digest`
(wraca stary katalog w prompcie), `AI_CACHE_WARM_HOURS=0` (bez pingów).
Koniec tury po karcie nie ma przełącznika — gdy model przestanie pisać zdanie
przed wywołaniem, pętla sama wraca do starego zachowania (runda na zdanie).

## 6. Czego świadomie NIE zrobiłem (następne kroki)

- **Embeddingi (pgvector, Voyage) i hybryda** — dopiero, gdy test trafności
  pokaże, że tagi i słowa nie łapią nieostrych próśb. Dziś „coś
  rozgrzewającego" trafia przez opisy, „lekkie" przez synonim tagu. Nowy
  dostawca = nowa umowa powierzenia (RODO) i nowy koszt na zapytanie.
- **Tagowanie przez model (Haiku)** — kosztuje tokeny, a reguły dają 471/500
  rodzajów dania. Lepszy krok: pole tagów w panelu (Katalog), żeby 29 dań bez
  rodzaju dało się otagować ręcznie.
- **Kolumna `shortId`** (stały krótki identyfikator zamiast `R001` z pozycji) —
  niepotrzebna: indeks liczy się raz na turę, a historia rozmowy wraca do
  modelu jako sam tekst, bez referencji. Przy mapie numeracja nie jest już
  częścią prefiksu — zmiana katalogu rusza w nim tylko liczby dań w mapie.
- **Tabela `RecipeSearchDoc` w bazie** — indeks w pamięci wystarcza do dziesiątek
  tysięcy przepisów i nie ma czego synchronizować przy imporcie/panelu.
- **Jeden słownik tagów dla iOS i serwera** — iOS liczy aspekty sam
  (`RecipeCategoryFacets`); gdy serwer zacznie oddawać `tags` w API przepisów,
  filtry w aplikacji i asystent będą czytały to samo (zmiana w 2 repo).
- **`AI_EFFORT=low`** (−33 % czasu z pomiaru 24.09) — decyzja produktowa
  (ryzyko gorszego trafiania w kalorie), nie ruszana.
- **Luka makro w rankingu** (dopasowanie kcal do tego, czego brakuje w dniu
  osoby) — dziś model podaje `max_kcal_per_serving` sam z `get_week_balance`;
  ranking mógłby to robić po stronie serwera.
