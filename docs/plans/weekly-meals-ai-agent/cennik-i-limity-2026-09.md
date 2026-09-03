# Cennik, limity i koszty asystenta — audyt przed subskrypcją (3.09.2026)

Rachunek: `cennik_i_limity_2026_09.py` (obok). Wszystkie liczby w tym pliku
pochodzą z tego skryptu, z pomiaru `pnpm agent:measure:tokens` z 3.09.2026
albo z pomiarów tur w `cost-model.md` §13. Realny ruch produkcyjny liczy
`pnpm agent:report:usage` — to on ma zastąpić założenia z §2 po pierwszym
miesiącu.

## 1. Jakich modeli używamy i ile kosztują

| Model | wejście $/MTok | wyjście $/MTok | zapis cache 1 h | odczyt cache | gdzie u nas |
|---|---|---|---|---|---|
| Claude Sonnet 5 | 2 | 10 | 4 (2×) | 0,20 (0,1×) | **wszystko** — `AI_MODEL` domyślnie, `AI_MODEL_TOOLS` nieustawione |
| Claude Haiku 4.5 | 1 | 5 | 2 | 0,10 | nigdzie, dopóki nie ustawisz `AI_MODEL_TOOLS=claude-haiku-4-5` |
| Claude Opus 5 | 5 | 25 | 10 | 0,50 | nigdzie (z wyboru — cost-model.md §12) |

Cennik potwierdzony 3.09.2026 na platform.claude.com; stawka Sonnet 5 $2/$10
została stała (zapowiadana podwyżka do $3/$15 od 1.09 nie weszła). Sonnet 5
używa nowego tokenizera: ~30 % więcej tokenów niż Haiku 4.5 za ten sam tekst.

**Stały prefiks (zmierzony, 147 przepisów, 17 narzędzi):** Sonnet 5 **30 206**
tokenów (digest 17 994 + narzędzia 9 727 + instrukcje 2 485), Haiku 4.5
24 717. Jeden odczyt prefiksu z cache: Sonnet $0,006, Haiku $0,0025 na
wywołanie. Zapis prefiksu do cache (raz na godzinę ruchu, wspólny dla
wszystkich domów): Sonnet $0,12, Haiku $0,05.

Prefiks urósł o 81 % wobec modelu z 31.08 (16 734 → 30 206), bo katalog ma
147 przepisów zamiast 89, a narzędzi jest 17 zamiast 8. Nadal czyta się go po
0,1×, więc to ~4–6 % kosztu tury — nie tu jest pieniądz.

## 2. Ile kosztuje jedna wiadomość

Cache ciepły (prefiks czytany po 0,1×), effort medium:

| rodzaj tury | Sonnet 5 | Haiku 4.5 | zmierzone (Sonnet, cache zimny) |
|---|---|---|---|
| pytanie / rozmowa (2 wywołania) | $0,036 | $0,017 | $0,060 (83 % to zapis cache) |
| podmiana / kilka opcji (4 wywołania) | $0,078 | $0,037 | $0,118 |
| plan dnia / 3 dni | $0,097 | $0,046 | $0,135 |
| plan tygodnia (6 wywołań) | $0,157 | $0,075 | $0,299 |
| ucieczka: 12 rund narzędzi | $0,328 | $0,157 | **$0,996** = sufit `AI_MAX_TURN_COST_USD` |

Wniosek 1: **koszt siedzi w wyjściu modelu (thinking + JSON narzędzi), nie w
prefiksie.** Sonnet vs Haiku to ~2× na turę; katalog 2× większy to +5 %.

Wniosek 2: **ucieczka kosztuje 3–6× tyle co plan tygodnia.** Dzisiejszy sufit
$1,00 jest za wysoki — mierzony plan tygodnia mieści się w $0,30 nawet z zimnym
cache, więc sufit $0,40 nie obetnie żadnej uczciwej tury, a ucieczkę tnie
2,5× taniej.

## 3. Ile daje jedna subskrypcja (VAT 23 %, Apple 15 %, USD/PLN 3,7224 z 3.09)

| cena | netto na miesiąc |
|---|---|
| 29,99 zł/mies. | 20,72 zł = **$5,57** |
| 39,99 zł/mies. | 27,64 zł = **$7,42** |
| 49,99 zł/mies. | 34,55 zł = **$9,28** |
| 249,99 zł/rok | 14,40 zł = $3,87 |
| 299,99 zł/rok | 17,28 zł = $4,64 |
| 349,99 zł/rok | 20,16 zł = $5,41 |

## 4. Miesiąc przy PEŁNYM wykorzystaniu limitu (najbardziej restrykcyjnie)

Założenie: każdy subskrybent zużywa cały limit; z wiadomości 20 % to plany
tygodnia, 20 % podmiany, reszta rozmowa. „Sufit" = każda wiadomość dobija do
`AI_MAX_TURN_COST_USD` (+20 % na ostatnią rundę) — to bariera dla konta
złośliwego, nie prognoza.

| limit | wszystko Sonnet | Haiku rozmowa + Sonnet plany | sufit $0,50 | sufit $1,00 (dziś) |
|---|---|---|---|---|
| **dziś: 200 wiad. / 30 planów** | $12,55 | $10,05 | $120 | **$240** |
| PRO: 60 wiad. / 8 planów | $4,13 | $3,43 | $36 | $72 |
| PRO+: 120 wiad. / 16 planów | $8,25 | $6,87 | $72 | $144 |
| próba: 5 wiad. / 1 plan | $0,34 | $0,29 | $3 | $6 |

Marża przy pełnym wykorzystaniu (Haiku+Sonnet), koszt AI jako % netto:

| limit | 29,99 | 39,99 | 49,99 | 299,99/rok |
|---|---|---|---|---|
| dziś 200/30 | 180 % | 135 % | 108 % | 216 % |
| **PRO 60/8** | 62 % | **46 %** | 37 % | 74 % |
| PRO+ 120/16 | 123 % | 92 % | 74 % | 148 % |

**Dzisiejsze limity (200/30) przynoszą stratę przy każdej cenie**, jeśli ludzie
ich używają. Przy 60/8 i 39,99 zł zostaje 54 % netto na koszty stałe i zysk —
i to przy założeniu, że KAŻDY subskrybent wyczerpuje limit co miesiąc.

Wariant pesymistyczny z liczbami zmierzonymi na zimnym cache (plan $0,30,
podmiana $0,12, rozmowa $0,06 Sonnet / $0,03 Haiku): 60/8 = $6,10 z Haiku
(82 % netto przy 39,99) albo $7,20 z samym Sonnetem (97 %). Czyli **bez
Haiku na rozmowie i bez ciepłego cache 39,99 zł to zero marży** u kogoś, kto
wyciska limit. Dwie rzeczy, które to naprawiają, są poniżej.

## 5. Próba

Jedno gospodarstwo: realnie $0,29, sufit $0,50 × 5 = $3,00 najgorzej.
Koszt prób na jednego płacącego: $0,76 przy konwersji 38 % (mediana Health &
Fitness), $1,43 przy 20 %, $2,86 przy 10 %. To 10–40 % pierwszego miesiąca
netto — akceptowalne, pod warunkiem że próba jest **raz na Apple ID**, nie raz
na gospodarstwo (dziś: usuń konto → nowe → nowa próba).

## 6. Próg rentowności

Koszty stałe **$29,85/mies. = 111 zł** (potwierdzone 3.09.2026): Railway $20
z rachunku Rafała, Apple Developer $8,25 (99 $/rok), domena ~$1,60, Cloudflare
R2 w darmowym progu. Wcześniejsze $45 było moim nieopartym założeniem.

| | koszt AI / subskrypcję | wkład | subskrypcji na pokrycie stałych |
|---|---|---|---|
| użycie 40 % limitu, koszty stałe $29,85 | ~$1,70 | ~$5,70 | **8** |
| użycie 100 % limitu, cache ciepły | ~$3,44 | ~$3,98 | 8 |

## 7. Jak nie zbankrutować w miesiąc — trzy bezpieczniki

1. **Budżet dobowy powiązany z przychodem.** `AI_GLOBAL_DAILY_BUDGET_USD` =
   0,8 × dzienny przychód netto. Przy 10 subskrypcjach × 39,99 zł to $2/dzień
   ($59/mies.), przy 100 — $20/dzień ($594/mies.). Po przekroczeniu asystent
   odpowiada 503 do północy UTC i idzie alert. **Najgorszy możliwy miesiąc to
   marża zero, nigdy strata większa niż koszty stałe.** Aktualizować raz w
   miesiącu razem z liczbą subskrypcji.
2. **Sufit tury $0,40** zamiast $1,00 — tnie ucieczki 2,5×, nie dotyka
   uczciwych tur (plan tygodnia zmierzony: $0,30 na zimno).
3. **Limity dopasowane do ceny** (§8) i jedna tura naraz w domu
   (`AI_MAX_CONCURRENT_TURNS_PER_HOUSEHOLD=1`).

## 8. Rekomendacja

**Cena:** 39,99 zł/mies. Rynek PL: Samsung Food+ 39,99, MyFitnessPal 34,99,
Fitatu Premium+AI 49,99. Rocznej na start nie wprowadzać: przy 299,99 zł
(netto $4,64) pełne użycie zjada 74 %; jeśli musi być — 349,99 zł i dopiero
po pierwszym miesiącu realnych danych.

**PRO (39,99 zł, per gospodarstwo):** 60 wiadomości + 8 zapisów planu na
miesiąc. To 2 wiadomości dziennie i 2 plany tygodnia w tygodniu — więcej, niż
robi rodzina, i 46 % netto w najgorszym pełnym miesiącu. Oglądanie propozycji
bez limitu.

**Próba:** 5 wiadomości + 1 zapis planu, jednorazowo, na Apple ID.

**Zmienne na Railway (kolejność ważna):**

| zmienna | dziś | ustaw | dlaczego |
|---|---|---|---|
| `AI_MODEL_TOOLS` | brak | `claude-haiku-4-5` — **dopiero razem z paywallem** | rozmowa na Haiku, planowanie na Sonnecie; −14 % przy ciepłym cache, ale **+56 % poniżej ~10 domów** (§12) |
| `AI_MAX_TURN_COST_USD` | 1 | `0.4` | sufit ucieczki; plan tygodnia mieści się z zapasem |
| `AI_LIMIT_MESSAGES_PER_MONTH` | 200 | `60` | §4 |
| `AI_LIMIT_PLANS_PER_MONTH` | 30 | `8` | §4 |
| `AI_MAX_CONCURRENT_TURNS_PER_HOUSEHOLD` | 2 | `1` | burst w wielu rozmowach |
| `AI_GLOBAL_DAILY_BUDGET_USD` | 5 | 0,8 × przychód dzienny, min. 5 | §7 |
| `AI_TIER_OVERRIDE` | PRO | puste — **dopiero z paywallem** | włącza próbę dla domów bez subskrypcji |

**Do zrobienia w kodzie, zanim włączysz próbę:** próba raz na Apple ID
(`User.trialConsumedAt`), dzienny limit wiadomości w domu (np. 10 — rozkłada
koszt i tnie boty), osobny licznik tur planujących (handoff) z limitem
miesięcznym (np. 12), weryfikacja transakcji StoreKit po stronie serwera.

**Po pierwszym miesiącu:** `pnpm agent:report:usage` w Railway Shell —
p95 kosztu tury × limit = realny najgorszy miesiąc jednego domu; koszt na
gospodarstwo vs $7,42 = realna marża. Jeśli p95 tury > $0,25, obniż effort na
rozmowie albo limit wiadomości; jeśli średni koszt domu < $1,5, można podnieść
limit do 90 wiadomości bez ruszania ceny.

## 9. Czego ten rachunek nie wie

- Realnego rozkładu tur (ile planów, ile rozmowy) — założenia z §4, do
  podmiany po miesiącu raportem.
- Skuteczności cache w praktyce: przy < 10 subskrypcjach prefiks Sonneta
  będzie zimny częściej niż raz na godzinę (Poisson w cost-model.md §10), czyli
  +$0,12 na każde „przebudzenie"; przy 30+ domach jest ciepły niemal zawsze.
- Rachunku Railway (przyjęto $25–35).
- Zwrotów Apple (Health & Fitness: ~4,7 %) i podatku dochodowego — poza
  rachunkiem marży AI.

---

# Część II — routing modeli i drabina planów (3.09.2026, wieczór)

## 10. Routing: co robi tani model, co robi mocny

**Jednostką decyzji jest FAZA tury, nie tura i nie runda.** Tura ma najwyżej
dwie fazy i przechodzi między nimi dokładnie raz, w jedną stronę:

| faza | model | wysiłek | narzędzia | co tu trafia |
|---|---|---|---|---|
| **CHAT** | `AI_MODEL_TOOLS` (Haiku 4.5) | `AI_EFFORT_TOOLS` = `low`, czyli bez myślenia | czytanie + `start_planning` | rozmowa, „co jest we wtorek", bilans, lista zakupów, pamięć domu, dopytanie, kilka opcji, luka makro |
| **PLANNER** | `AI_MODEL` (Sonnet 5) | `AI_EFFORT` = `medium` | pełna lista | plan tygodnia, plan dnia, podmiana, porcje dla domu, tworzenie i edycja przepisu |

Wyzwalaczem przejścia jest **wywołanie narzędzia `start_planning`**, nic
więcej. Żadnego klasyfikatora, żadnego zgadywania po treści pytania: narzędzia
warstwy `planner` fizycznie nie istnieją na liście modelu fazy CHAT, więc tani
model nie ma jak ułożyć planu — jedyną drogą jest oddanie pałeczki.

„Który mechanizm na jakim modelu" mówi **jedna tabela**:
`AGENT_TOOL_TIERS` w `src/agent/tools/agent-tools.ts`. Przeniesienie narzędzia
między modelami to jedna linia widoczna w git; test pilnuje, żeby nowe
narzędzie nie weszło bez decyzji.

### Dlaczego nie klasyfikator ani eskalacja

Sędziowie ocenili trzy projekty (statyczny, eskalacja po sygnałach złożoności,
klasyfikator na wstępie). Statyczny wygrał 3:0 przy tej samej oszczędności:
klasyfikator dokłada wywołanie i myli się na parach „co jest we wtorek" vs
„wymień wtorek", eskalacja dokłada maszynę stanów i heurystykę ograniczeń.
Oba kosztują tyle samo co mechanizm, który już istnieje.

## 11. Krytyczna poprawka, bez której routingu NIE WOLNO włączyć

Do 3.09.2026 prowajder wysyłał `thinking: {type:'adaptive'}` i
`output_config.effort` do **każdego** modelu. Haiku 4.5 obu tych pól nie
przyjmuje i odpowiada **400**, a 400 jest w naszym kodzie nieponawialny i
**nie zwraca kwoty** — czyli ustawienie `AI_MODEL_TOOLS=claude-haiku-4-5`
na Railway zabiłoby każdą turę i przy okazji spaliło użytkownikom limit
miesięczny.

Naprawione: `src/config/model-capabilities.ts` trzyma, czym da się sterować
w którym modelu (`adaptive` + `effort` vs `budget_tokens`), a
`reasoningParams(model, effort)` w prowajderze buduje żądanie pod model.
Trzy testy pilnują tego na stałe.

## 12. Kiedy routing się opłaca (i kiedy NIE)

Miesiąc 60 wiadomości (36 rozmów, 12 podmian, 12 planów):

| wariant | koszt |
|---|---|
| wszystko na Sonnecie | $4,13 |
| routing, prefiks Sonneta ciepły (30+ domów) | **$3,56 (−14 %)** |
| routing, prefiks Sonneta ZIMNY przy każdym planie (< ~10 domów) | **$6,46 (+56 %)** |

Cache jest **per model**. Dopóki domów jest mało, żadna tura nie zaczyna na
Sonnecie, więc jego prefiks (30 206 tokenów) trzeba zapisywać od nowa przy
prawie każdym planie: +$0,121 za turę. **Routing włączamy razem z paywallem,
nie wcześniej.** Do tego czasu `AI_MODEL_TOOLS` zostaje puste i wszystko
chodzi na Sonnecie — dokładnie jak dziś.

## 13. Plany per wielkość gospodarstwa — odpowiedź na pytanie „1+1 vs rodzina"

**Intuicja jest słuszna co do ZUŻYCIA i błędna co do KOSZTU.**

Dodatkowy domownik kosztuje: +$0,0016 na turze planu przy 6 osobach, czyli
**+$0,05 miesięcznie — 0,7 % przychodu netto z 39,99 zł**. Blok
`<domownicy>` czyta się z cache po 0,1× stawki, a wszystko inne (porcje,
karty podziału) to te same tokeny niezależnie od tego, ile osób je zje.
Model kosztowy zapisał to już 31.08: „a family tier is a pricing, not a cost,
decision".

Co naprawdę rośnie, to **tempo zużycia puli**: 5 osób wyczerpie 60 wiadomości
w dwa tygodnie. Ale pula jest SUFITEM — rodzina nie może kosztować więcej niż
singiel przy tym samym limicie. Czyli duży dom to **szansa sprzedażowa, nie
ryzyko kosztowe**.

### Rekomendacja: drabina nazwana po domu, sprzedawana po limicie

| plan | dla kogo (etykieta) | cena | wiadomości | zapisy planu | koszt przy pełnym użyciu | marża | zł za wiadomość |
|---|---|---|---|---|---|---|---|
| **Solo** | 1 osoba | 29,99 zł | 40 | 6 | $2,38 | **57 %** | 0,75 |
| **Duet** | 2 osoby | 39,99 zł | 60 | 8 | $3,56 | **52 %** | 0,67 |
| **Rodzina** | 3+ osób | 59,99 zł | 100 | 14 | $5,94 | **47 %** | 0,60 |

Zasada, która trzyma to w kupie: **limit jest produktem, liczba osób jest
etykietą.** Backend NIE liczy i NIE pilnuje miejsc. Powody:

1. **Nie ma czego pilnować sprawiedliwie.** „Osoba" ma dwie definicje
   (członkostwo vs zgoda na asystenta), a czteroletnie dziecko liczy się tak
   samo jak dorosły.
2. **Bramka na miejscach jest niebezpieczna.** Jeśli domownik kosztuje, ludzie
   nie dodadzą alergicznego dziecka jako osoby — i twarda bramka alergenowa
   przestanie je widzieć. To ryzyko zdrowotne kupione za 20 zł różnicy.
3. **Egzekwowanie kosztuje 2–3 tygodnie** ponad StoreKit, którego jeszcze nie
   ma: limit członków, `HOUSEHOLD_SEATS_FULL`, subskrypcja własnością płatnika,
   prorata przy zmianie planu, 6. osoba na Duecie, nadanie operatora bez
   miejsc, trzy razy więcej stanów do pokazania recenzentowi Apple.
4. **Egzekwowanie jest zbędne.** Wyczerpana pula egzekwuje się sama: dom
   5-osobowy na Solo skończy wiadomości w tydzień i zobaczy ekran
   „Zwiększ limit" — dokładnie ten sam, który już zbudowaliśmy dla próby.
   To lepszy moment na sprzedaż niż komunikat „nie możesz zaprosić żony".

Rozmowa z klientem jest wtedy uczciwa: *większy dom zużywa więcej, więc
wybierz większy plan* — a nie *policzyliśmy wam głowy*.

### Co z tego wynika technicznie

Trzy produkty w jednej grupie subskrypcji (rangi: Rodzina > Duet > Solo, żeby
Apple robił upgrade natychmiast, a downgrade przy odnowieniu). Limity biorą
się z `productId` przez mapę w `src/config/subscription-products.ts` (jeszcze
nie istnieje) i wchodzą do `resolvePlan()` — reszta łańcucha kwot jest już
gotowa. Na paywallu każdego planu musi stać zdanie z ILOŚCIAMI (App Store
3.1.2(c)), identyczne z `GET /agent/usage` i z komunikatem 429.

Rocznej nie sprzedawać na start: przy 299,99 zł netto wychodzi $4,64, więc
Rodzina rocznie byłaby stratna przy pełnym użyciu.

## 14. Kolejność wdrożenia

1. **Teraz (zrobione):** kształt myślenia per model, trasa faz, księga per
   faza, tabela warstw narzędzi, testy. Domyślne env = zero zmian w działaniu.
2. **Przed paywallem:** weryfikacja transakcji StoreKit na serwerze, mapa
   produktów → limity, próba raz na Apple ID.
3. **Razem z paywallem:** `AI_MODEL_TOOLS=claude-haiku-4-5`,
   `AI_MAX_TURN_COST_USD=0.4`, `AI_EFFORT_TOOLS` domyślne (`low`).
   Wcześniej routing traci pieniądze (§12).
4. **Po pierwszym miesiącu:** `pnpm agent:report:usage` → odsetek tur z
   przekazaniem pałeczki, koszt fazy per model, p95 kosztu tury. Dopiero te
   liczby decydują o przeniesieniu `propose_swap` do warstwy `chat` (jedna
   linia) i o podniesieniu limitów.

## 15. Co znaleźli sceptycy (i co z tego wynika)

Trzy projekty routingu przeszły przez panel sędziów i pięciu sceptyków, których
zadaniem było je OBALIĆ. Cztery zarzuty okazały się prawdziwe i są zamknięte,
jeden fałszywy.

**1. Pytanie o bezpieczeństwo szło na tani model bez myślenia.** „Czy środowy
obiad jest ok dla Zosi, która nie je cebuli i ma alergię na mleko?" to pytanie
o ODCZYT, więc routing nie przełączyłby na planistę — a katalog niesie pięć
najcięższych składników, nie cały skład (na katalogu dev 15 z 65 przepisów
z laktozą nie pokazuje nabiału wśród tych pięciu). Model zgadywałby.
→ Nowe narzędzie `check_plan_conflicts` w warstwie `chat`: konflikty liczy TA
SAMA bramka, która pilnuje zapisu planu, model wyłącznie cytuje wynik. Ta sama
zasada, co przy makrach. Dziura istniała także BEZ routingu.

**2. Sufit kosztu tury płacił z limitu użytkownika.** Gdy tura przekroczyła
`AI_MAX_TURN_COST_USD`, serwer ucinał ją i prosił model o ostatnie słowo — ale
tura kończyła się jako udana, więc wiadomość znikała z puli. Użytkownik płacił
za NASZ bezpiecznik. → Prowajder oddaje osobny powód (`cost_ceiling`), a runner
zwraca wiadomość do puli.

**3. Limit wiadomości nie jest sufitem kosztu.** Tura przerwana timeoutem albo
awarią dostawcy ODDAJE wiadomość (bo użytkownik nic nie dostał), ale pieniądze
poszły. Dom, któremu tury padają w pętli, mógł wydać dowolną kwotę bez ruszenia
licznika 60/8 — a jedynym hamulcem był budżet dobowy WSPÓLNY dla całej
instalacji, więc jeden taki dom wyłączał asystenta wszystkim.
→ `AI_HOUSEHOLD_MONTHLY_COST_USD` (domyślnie 18, czyli 3× modelowy koszt
pełnego miesiąca planu Rodzina): dom po przekroczeniu dostaje 503 i idzie
alert do operatora. Nie dotyka nikogo, kto po prostu intensywnie korzysta.

**4. Tura z przekazaniem pałeczki nigdy nie jest tańsza od tej samej tury na
Sonnecie** — dokłada rundę `start_planning` i zimny prefiks drugiego modelu.
Cała oszczędność siedzi w turach BEZ przekazania, a ich udział jest
NIEZMIERZONY. Do tego routing zwiększa szansę zimnego prefiksu planisty, bo
w tym trybie żadna tura nie zaczyna na Sonnecie.
→ Stąd kolejność z §14 i mocniejszy wniosek: **pierwszym ruchem oszczędnościowym
nie jest routing, tylko `AI_EFFORT=low`.** Analiza wrażliwości z `cost-model.md`
§10 daje na Sonnecie medium→low −31 % (vs −14 % z routingu), przy JEDNEJ puli
cache i bez drugiego prefiksu. Uczciwa uwaga: to NIE jest darmowe — `medium`
wybrano świadomie, a niższy wysiłek dotyka dokładnie tego, na czym zależy
najbardziej, czyli układania planu pod cele i alergeny. Dlatego zmiana wymaga
porównania jakości na kilkunastu prawdziwych turach (`pnpm agent:smoke`), a nie
przestawienia zmiennej w ciemno. Ale kolejność jest jasna: najpierw mierzymy
tę dźwignię, potem sięgamy po routing. Routing ma sens dopiero, gdy raport
z miesiąca pokaże, że tury bez przekazania to większość ruchu.
→ Druga dźwignia z tej samej analizy, warta więcej niż routing: `get_week_plan`
oddaje dziś pełne wiersze składników (25–45 tys. tokenów). Projekcja do
`dzień | posiłek | R## | tytuł | uczestnicy | kcal` (~700 tokenów) obniża KAŻDĄ
turę, także bez routingu — do zrobienia po tym, jak `check_plan_conflicts`
przejmie pytania o skład.

**5. Zarzut fałszywy:** „cennik policzono dla innego modelu niż skonfigurowany".
Sprawdzone: `.env.example`, README i `AI_MODEL_DEFAULT` mówią zgodnie
`claude-sonnet-5`, czyli model, na którym liczony jest cały rachunek.

### Zasada na przyszłość, gdyby subskrypcja miała należeć do płatnika

Licznik kwoty jest dziś przywiązany do GOSPODARSTWA (`AiUsageCounter.scopeId =
householdId`). Gdyby subskrypcja stała się własnością płatnika i „wędrowała"
z nim między domami, jedna opłacona pula dawałaby świeże 60/8 w każdym
odwiedzonym domu (przejście między domami to jedno żądanie, bez cooldownu).
Wtedy `scopeId` MUSI iść za uprawnieniem, nie za domem. Dziś to nie dotyczy
nas: subskrypcja jest przypięta do gospodarstwa.


---

# Część III — limity ustalone na stałe (3.09.2026, decyzja)

## 16. Trzy plany, liczby ostateczne

| plan | dla kogo | cena | wiadomości | zapisy planu | marża przy 100 % i ciepłym cache |
|---|---|---|---|---|---|
| **Solo** | 1 osoba | 29,99 zł | 30 | 8 | 63 % |
| **We dwoje** | 2 osoby | 39,99 zł | 50 | 12 | 54 % |
| **Rodzina** | 3 osoby i więcej | 49,99 zł | 75 | 18 | 44 % |

Te liczby są **obietnicą, nie parametrem**. Podnosić wolno w każdej chwili,
obniżać obecnym subskrybentom nie wolno — to zmiana warunków umowy w trakcie
jej trwania (i wprost sprzeczna z tym, co stoi na paywallu wg App Store
3.1.2(c)). Dlatego są policzone na stan docelowy, nie na dzisiejszy.

## 17. Skąd te liczby

**Od dołu — ile realnie zużywa gospodarstwo** (scenariusze złożone z tur:
plan tygodnia + poprawki + pytania):

| kto | wiadomości / mies. | jego plan | zapas |
|---|---|---|---|
| 1 osoba, plan raz w tygodniu | ~14 | Solo (30) | 2,1× |
| 2 osoby, planują i poprawiają | ~26 | We dwoje (50) | 1,9× |
| 2 osoby, intensywnie | ~40 | We dwoje (50) | 1,25× |
| rodzina 4-osobowa | ~48 | Rodzina (75) | 1,6× |
| rodzina bardzo intensywnie | ~70 | Rodzina (75) | 1,07× |

**Od góry — ile wolno, żeby nigdy nie trzeba było obniżać.** Warunek: przy
pełnym wykorzystaniu limitu i CIEPŁYM cache (stan docelowy) zostaje ≥ 40 %
netto. Stąd 30 / 50 / 75.

**Dlaczego nie liczyłem tego na zimnym cache.** Limit bezpieczny przy zimnym
cache to 17 / 22 / 29 wiadomości — czyli MNIEJ, niż realnie zużywa rodzina.
Taki produkt kończyłby się w połowie miesiąca. Zimny cache to stan przejściowy
kilku pierwszych tygodni i kosztuje kilkanaście dolarów łącznie, a nie na
użytkownika; limit ustawia się na to, co będzie za rok, nie na to, co jest
w pierwszym tygodniu.

**Zapisy planu są hojne, bo nic nie kosztują.** Zatwierdzenie propozycji to
kliknięcie — `agent-proposals.service.ts` nie zna dostawcy modelu i nigdy go
nie woła. Ten licznik jest dźwignią produktową, nie kosztową, więc ustawiony
tak, by nigdy nie skończył się przed wiadomościami (jedna propozycja powstaje
z ~3–4 wiadomości). Test w `subscription-products.spec.ts` tego pilnuje.

## 18. Sufit kosztu nie może odciąć uczciwego klienta

`AI_HOUSEHOLD_MONTHLY_COST_USD` = 18. Najdroższy możliwy miesiąc W RAMACH
obiecanych limitów to $14,22 (Rodzina, 100 % limitu, zimny cache). Sufit ma
więc zapas i zadziała wyłącznie przy awarii albo nadużyciu — nigdy nie
przerwie miesiąca komuś, kto mieści się w tym, co kupił. **Obniżenie tej
wartości poniżej $15 złamałoby obietnicę z paywalla.**

## 19. Próg opłacalności

Przy kosztach stałych $29,85 i realnym zużyciu (40 % limitu) wychodzisz na
plus przy **8 subskrypcjach**. Przy 25 subskrypcjach to około 200 zł
miesięcznie, przy 100 — około 1 700 zł.

Jeden użytkownik spłaca swoje tokeny od pierwszego dnia (przy ćwierci limitu
zostaje 17 zł), ale żaden pojedynczy użytkownik nie pokryje kosztów stałych —
i żadna cena tego nie zmieni. Dźwignią na starcie jest obniżenie tych 111 zł,
nie podnoszenie ceny.
