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

Koszty stałe ≈ $45/mies. (Railway ~$25–35, Apple Developer $8, domena, R2) —
**do potwierdzenia z rachunkiem Railway**.

| | koszt AI / subskrypcję | wkład | subskrypcji na pokrycie stałych |
|---|---|---|---|
| 39,99 zł, użycie 50 % limitu | $1,72 | $5,71 | **8** |
| 39,99 zł, użycie 100 % limitu | $3,43 | $3,99 | 11 |
| 299,99 zł/rok, użycie 50 % | $1,72 | $2,92 | 15 |
| 299,99 zł/rok, użycie 100 % | $3,43 | $1,21 | 37 |

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
| `AI_MODEL_TOOLS` | brak | `claude-haiku-4-5` | rozmowa i czytanie na Haiku, planowanie zostaje na Sonnecie (handoff `start_planning`); −18 % kosztu miesiąca, −50 % na turze rozmowy |
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
