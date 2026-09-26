# Roadmapa asystenta — 18.09.2026

Dwa tory. **Tor A — do premiery:** asystent ma być możliwie najlepszy w tym,
co już robi; żadnych nowych obszarów. **Tor B — po premierze:** nowe obszary
(zdjęcia, proaktywność, spiżarnia, gotowanie z głosem), po jednym na wydanie.
Build i TestFlight robi Rafał przez Xcode Cloud z `main` — tym plan się nie
przejmuje.

Stan wyjściowy (po PR-ach z 18.09): 24 narzędzia w dwóch warstwach (chat /
planista), propozycje z kartami i cofnięciem, pamięć domu za zgodą, wskaźnik
myślenia „Cicha linia”, streaming odpowiedzi przez szkic w turze, nowa
rozmowa po przerwie, powitanie z kalendarza, benchmark na żywym modelu
(`pnpm agent:scenarios`, grupy g1–g7).

## Zasady, których plan nie łamie

1. **Nic nie zapisuje się samo.** Każda zmiana danych domu idzie przez
   propozycję i kartę albo jest trywialnie odwracalna tym samym zdaniem
   (odhaczenie). Nowa funkcja, która tego nie spełnia, nie wchodzi.
2. **Serwer liczy, model cytuje.** Alergeny, bilans, lista zakupów, skład —
   zawsze z domeny. Model nigdy nie jest źródłem liczby ani faktu o składzie.
3. **Budżet schematów jest wyczerpany: 24/24 pól nieobowiązkowych.** Każde
   nowe narzędzie ma WYŁĄCZNIE pola wymagane — albo najpierw zwalniamy miejsce
   (patrz A6). Sprawdzian: `pnpm exec tsx scripts/agent-tools-smoke.ts`.
4. **Prefiks promptu jest wspólny i w cache.** Zmiana instrukcji to koszt
   jednorazowy dla całej instalacji; zmiana na turę (kontekst domu) idzie do
   bloku gospodarstwa. Nie mieszać.
5. **Dane o zdrowiu nie idą do modelu bez zgody**, a zdjęcia (Tor B) nie są
   przechowywane dłużej niż tura.
6. **Każda zmiana zachowania modelu przechodzi przez benchmark** przed i po
   (`agent:scenarios`, JSON do porównania). Bez tego „poprawa promptu” jest
   opinią.

---

## Tor A — do premiery

Kolejność = waga wobec celu „najlepszy w tym, co robi”. Każdy punkt ma
powód, zakres i sprawdzian. Punkty A1–A3 są ważniejsze od wszystkiego niżej.

### A1. Benchmark jako brama jakości (fundament reszty toru)

**Powód.** Bez zmierzonej linii bazowej każde ulepszenie promptu to zgadywanie,
a regresja (model przestaje wołać `check_plan_conflicts`, zaczyna wypisywać
plan w tekście) jest niewidoczna do skargi użytkownika.

**Zakres.**
- Dopisać scenariusze dla narzędzi z 18.09: `get_recipe_details` („jak to
  ugotować”, „czy jest w tym masło” — model NIE może odpowiadać z pamięci),
  `search_recipes_by_ingredient` (od 26.09.2026 `find_recipes` z
  `include_ingredients`), `propose_remove_meal` (nie przez
  `apply_week_plan`), `mark_meal_eaten`, `check_shopping_items` (w tym
  wieloznaczne „ser” → dopytanie, nie zgadywanie).
- Nowe metryki w JSON-ie: czas do pierwszego znaku szkicu (streaming),
  liczba kroków `think`, długość odpowiedzi w trybie propozycji (ma być
  ≤ 2 zdania).
- Scenariusze adwersaryjne: wstrzyknięcie w tytule przepisu domu, prośba
  o dane o zdrowiu domownika bez zgody, „zapisz sam, nie proponuj”.
- Próg: PASS ≥ 95 % na g1–g7, 100 % na adwersaryjnych. Wynik BEFORE
  zapisany w `docs/plans/scoffie-ai-agent/benchmark/` przy każdej zmianie
  promptu.

**Sprawdzian.** `pnpm agent:scenarios` z porównaniem BEFORE/AFTER; koszt
jednego przebiegu w dokumencie (żeby wiadomo było, ile kosztuje odpalenie).

### A2. Prompt i opisy narzędzi — jedna runda strojenia z pomiarem

**Powód.** Model wołał `search_ingredients` osiem razy pod rząd, przepisywał
plan w tekście, mówił o kaloriach z pamięci. Część tego jest już zamknięta
kodem, resztę da się domknąć opisami — ale tylko z A1 w ręku.

**Zakres.**
- Audyt `AGENT_INSTRUCTIONS` i `modeBlock` pod kątem nadmiaru: instrukcje
  pisane dla starszych modeli (zakazy, powtórzenia) bywają dziś przeciwskuteczne.
- Rozstrzygnąć wysiłek modeli (`effort`) per faza na danych z benchmarku
  (koszt × jakość), nie z przeczucia.
- Etykiety `think` i postępu — po tygodniu produkcji przejrzeć, które
  sformułowania mylą (log `progress` jest w turze).

**Sprawdzian.** A1 przed/po; koszt tury nie rośnie.

### A3. Kontekst wejścia z ekranu (największa dźwignia UX bez nowych narzędzi)

**Powód.** Dziś asystent zaczyna od zera także wtedy, gdy użytkownik przyszedł
z konkretnego miejsca: z przepisu, z pustego wtorku w planie, z listy zakupów.
Wzorce ChatGPT/Claude: kontekst wchodzi razem z pytaniem.

**Zakres (iOS + `PostMessageDto`).**
- Wejście do asystenta z ekranu przepisu: chipy „Wstaw w plan”, „Skaluj na
  N osób”, „Zamień składnik”; wiadomość niesie `context: { recipeId }` — w
  bloku gospodarstwa (nie w prefiksie) pojawia się jedno zdanie „użytkownik
  patrzy na przepis R07”.
- Z pustego slotu w Planie/Kalendarzu: „Co na wtorkowy obiad?” z
  `context: { weekStart, dayOfWeek, mealType }`.
- Z listy zakupów: „Co mogę pominąć?” z `context: { weekStart }`.
- Powitanie (`AssistantWelcome`) dostaje ten sam kontekst, więc podpowiedzi
  zgadzają się z miejscem, z którego ktoś przyszedł.

**Sprawdzian.** Scenariusze A1 z kontekstem; ręcznie: trzy wejścia, trzy
pierwsze chipy.

### A4. Streaming — dopracowanie po pierwszym tygodniu

**Powód.** Wersja z 18.09 działa przez odpytywanie co sekundę; jest dobra,
ale ma dwie rzeczy do zmierzenia na produkcji.

**Zakres.**
- Adaptacyjne odpytywanie: 0,5 s, gdy szkic rośnie; 1 s w ciszy; 2 s po
  minucie w tle (oszczędność baterii i żądań).
- Kursor na końcu szkicu (kropka w terakocie) — dopiero po obejrzeniu na
  telefonie, czy odsłanianie znak po znaku nie wystarcza.
- Jeśli p95 „czas do pierwszego znaku” > 3 s po `think`: rozważyć SSE jako
  DODATEK do odpytywania, nie zamiennik (odpytywanie zostaje źródłem prawdy).

**Sprawdzian.** Metryka z A1 + `/ops/metrics`.

### A5. Obserwowalność i alarmy, które mówią zdaniem

**Powód.** Dziś wiadomo, że coś jest źle, gdy Rafał to zobaczy w aplikacji.
Cztery liczby zmieniają to w wiadomość na telefon.

**Zakres.**
- Dzienny raport (istnieje `agent-usage-report.ts`) rozszerzyć o: udział tur
  z `refusal`, udział 400 z API (gramatyka / schemat — to jest awaria dla
  WSZYSTKICH), p50/p95 czasu tury, liczbę `recovered COLD` z sesji, koszt na
  dom. Wysyłka mailem przez istniejącą skrzynkę nadawczą.
- Alarm natychmiastowy na: 400 z API w dwóch turach pod rząd, bezpiecznik
  upstream otwarty > 5 min, kwota planów wyczerpana u > 30 % domów.

**Sprawdzian.** Raport przychodzi codziennie; jeden sztuczny 400 (schemat z
`minimum`) uruchamia alarm w staging.

### A6. Zwolnienie budżetu schematów (wymóg dla całego Toru B)

**Powód.** 24/24. Każde narzędzie z Toru B (zdjęcie, spiżarnia) będzie chciało
pól opcjonalnych. Bez tego Tor B zaczyna się od ściany.

**Zakres (wybrać jedno; kolejność preferencji).**
1. `tool_search` z `defer_loading` na narzędziach planisty: do prefiksu idzie
   krótsza lista, model dociąga resztę. Zmienia prefiks cache (jednorazowo)
   i wymaga sprawdzenia, czy limit 24 liczy się od narzędzi ZAŁADOWANYCH
   (`agent-tools-smoke.ts` odpowie w jednym żądaniu).
2. Konsolidacja: `propose_day_plan` jako `propose_week_plan` z `day_of_week`
   wymaganym; `update_recipe` z podziałem na dwa narzędzia o polach
   wymaganych. Zysk ~6 pól, koszt: opisy i benchmark.
3. Rezerwa: przenieść opcjonalność do opisu („0 = brak”), jak w nowych
   narzędziach.

**Sprawdzian.** `agent-tools-smoke.ts` zielony; A1 bez regresji.

### A7. Odporność i CI

**Powód.** Jedyna automatyczna kontrola po stronie iOS to skrypt, który trzeba
odpalić ręcznie; e2e propozycji nie obejmuje `undo` po ręcznej zmianie planu.

**Zakres.**
- `Scripts/card-contract-check.sh` w Xcode Cloud jako `ci_scripts/ci_post_clone.sh`
  (kompiluje DTO z wzorcem — 20 s).
- e2e: apply → ręczna zmiana planu → undo (STALE), apply przy wyczerpanej
  kwocie, `propose_remove_meal` dla jednej osoby przy wspólnym slocie.
- Test kontraktu `TurnView` (pola `draftText`, `stopRequested`,
  `suggestions`) jako snapshot — iOS czyta je pobłażliwie, więc rozjazd
  jest cichy.

### A8. Ekran możliwości i onboarding = prawda o narzędziach

**Powód.** Ekran „co potrafi” powstał ręcznie; po każdym narzędziu rozjeżdża
się z rzeczywistością (18.09 dopisano cztery wpisy ręcznie).

**Zakres.** Jedno źródło prawdy po stronie serwera: `GET /agent/capabilities`
oddaje listę wpisów (id, tytuł, opis, przykład, przykładowa odpowiedź) z
kodu narzędzi; iOS renderuje, a stare wpisy zostają jako fallback dla
starszego serwera. Przykłady odpowiedzi z benchmarku (A1), nie wymyślone.

### A9. Proaktywność „light” — jedno powiadomienie, zero nowej infrastruktury

**Powód.** To jedyna rzecz z Toru B, która jest na tyle tania, że opłaca się
przed premierą: lokalne powiadomienie w niedzielę 18:00, gdy przyszły
tydzień jest pusty („Przyszły tydzień jest pusty — ułożyć?”), stuknięcie
otwiera asystenta z gotowym pytaniem (A3 daje kontekst).

**Zakres.** iOS: `rescheduleMealReminders` już liczy plan; dochodzi jedna
reguła i jeden identyfikator powiadomienia. Bez serwera.

---

## Tor B — po premierze (po jednym obszarze na wydanie)

Kolejność wynika z zależności i z tego, co „sprzedaje” na zrzutach ekranu.

### B1. Zdjęcie jako wejście (wydanie 1.1)

**Co użytkownik dostaje.** „Zapisz ten przepis” + zdjęcie strony z książki /
screenshot; „co z tego ugotować?” + zdjęcie lodówki albo zakupów.

**Projekt.**
- iOS: załącznik w composerze (aparat/galeria), kompresja do ≤ 1 MB, podgląd
  w dymku użytkownika.
- Backend: `POST /agent/conversations/:id/messages` przyjmuje `imageIds[]`
  z `POST /agent/uploads` (R2, TTL 24 h, kasowane po domknięciu tury);
  blok obrazu w wiadomości użytkownika do modelu; ZERO trwałego
  przechowywania i zero obrazów w historii rozmowy (w `AgentMessage`
  zostaje miniatura 64 px albo nic).
- Narzędzia (pola wymagane, A6 wcześniej): `import_recipe_from_image` →
  `create_recipe` po `search_ingredients` (istniejąca ścieżka planisty);
  `recognize_ingredients` → lista nazw → `find_recipes` (`include_ingredients`).
- Prywatność: zdjęcie lodówki może zawierać twarze/etykiety leków —
  instrukcja modelowi: opisuj wyłącznie jedzenie; test adwersaryjny w A1.

**Zależności.** A6 (budżet), A1 (scenariusze z obrazem — koszt!).

### B2. Proaktywność z serwera (wydanie 1.2)

**Co użytkownik dostaje.** Niedziela: push z GOTOWĄ propozycją tygodnia
(kartą) do jednego kliknięcia. Czwartek: „jutro w planie pusto”.

**Projekt.** Harmonogram w backendzie (istniejący `notifications` +
`AgentTurnRunner` w trybie „bez pytania użytkownika”, z osobną kwotą
`proactive`), propozycja zapisana jak każda inna, push z `proposalId`,
tura księgowana jak zwykła, opt-out per dom w ustawieniach asystenta.
Ryzyko: koszt — dlatego osobna kwota i tylko dla domów aktywnych w
ostatnich 14 dniach.

**Zależności.** A5 (alarmy kosztowe), A9 jako wersja próbna.

### B3. Uczenie się z tego, co jesz (wydanie 1.2–1.3)

**Co użytkownik dostaje.** „W środy zawsze pomijasz kolację — planować
lżej?”; „trzeci raz podmieniasz rybę — zapamiętać, że nie?”

**Projekt.** Cotygodniowy job liczy sygnały (odhaczone / pominięte /
podmienione per slot i per danie) i proponuje NOTATKĘ do pamięci domu przez
kartę „zapamiętać?” (nic nie zapisuje się samo — zasada 1). Model dostaje
sygnały jako liczby w bloku gospodarstwa, nie surowe zdarzenia.

**Zależności.** B2 (kanał dostarczania), zgody (dane o jedzeniu jednej
osoby nie idą do notatki domu bez jej zgody — istniejąca reguła).

### B4. Spiżarnia (wydanie 1.3–1.4, osobny miesiąc)

**Co użytkownik dostaje.** „Co mam” — ręcznie, ze zdjęcia (B1) i z
odhaczonych zakupów (automatycznie); lista zakupów odejmuje to, co jest;
asystent planuje „z tego, co masz” i pilnuje resztek.

**Projekt.**
- Model danych: `PantryItem { householdId, ingredientId, amount?, unit?,
  addedAt, expiresAt?, source: MANUAL|SHOPPING|PHOTO }`; zdarzenia WS
  `pantry:changed`; ekran w Planie obok listy zakupów (nie nowa zakładka —
  menu jest pełne).
- Zakupy → spiżarnia: odhaczenie pozycji dodaje ją; użycie w planie (dzień
  odhaczony jako zjedzony) odejmuje szacunkowo. Szacunki są jawnie
  „mniej więcej” w UI.
- Narzędzia: `get_pantry`, `propose_use_up` (danie z tego, co się kończy),
  lista zakupów liczona jako plan − spiżarnia.
- To jest największa pozycja planu; wchodzi dopiero, gdy B1 pokaże, że
  ludzie w ogóle mówią asystentowi, co mają.

**Zależności.** B1 (zdjęcie jako najwygodniejsze wejście), A6.

### B5. Tryb gotowania i głos (wydanie 1.4+)

**Co użytkownik dostaje.** „Prowadź mnie”: krok po kroku na pełnym ekranie,
timery z przepisu jako Live Activity, pytania w trakcie bez wychodzenia
z kroku; odpowiedzi czytane na głos, pytania z dyktowania.

**Projekt.** iOS: `get_recipe_details` już daje kroki; ekran kroków +
`ActivityKit`; STT systemowe (dyktowanie), TTS `AVSpeechSynthesizer` po
polsku; tryb „głośno” w ustawieniach asystenta. Backend: tryb odpowiedzi
„krótko, do przeczytania na głos” jako kontekst wejścia (A3).

**Zależności.** A3 (kontekst z ekranu przepisu).

### B6. Import z URL i goście (wydanie 1.5)

Import z linku (bloga, YouTube-a) do przepisu domu przez istniejącą ścieżkę
`create_recipe`; „goście w sobotę, jeden wegetarianin” jako profil na jeden
posiłek (nie w pamięci domu). Budżet („do 350 zł”) dopiero, gdy będą ceny —
nie planować przed.

---

## Zależności w jednym miejscu

```
A1 ─┬─ A2 ─ A3 ─ A9
    ├─ A4
    ├─ A5 ─────────── B2 ─ B3
    └─ A6 ─┬─ B1 ─┬─ B4
           │      └─ (B5 korzysta z A3)
           └─ B6
A7, A8 — równolegle, bez zależności
```

## Czego świadomie NIE ma w planie

- Osobnej zakładki dla czegokolwiek — menu jest pełne (pięć miejsc).
- Zamiany odpytywania na socket dla asystenta — tura ma przeżyć telefon
  w tle; streaming jest dodatkiem do odpytywania.
- Własnego katalogu przepisów generowanego przez model — katalog jest
  sprawdzony, przepisy modelu są przepisami domu.
- Wielu asystentów / person — jeden głos, jedna pamięć domu.

## Jak czytać ten plan za miesiąc

Każdy punkt A ma sprawdzian; jeśli nie da się go wykonać, punkt nie jest
skończony. Każdy punkt B ma wyraźne „co użytkownik dostaje” — jeśli po
wdrożeniu nie da się tego pokazać na jednym zrzucie ekranu, zakres był zły.
