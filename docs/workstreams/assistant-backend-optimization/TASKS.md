# Zadania — backend + asystent server-first

Ten plik opisuje kolejność prac. Nie wykonywać całej listy jednym ciągiem.
Aktualny etap wskazuje `STATE.md`.

---

## Etap 0 — baseline nowego przepływu

### Cel
Zbudować punkt odniesienia przed zmianami wydajnościowymi. Nie służy do
blokowania oczywistych napraw poprawności lub bezpieczeństwa.

### Zadania
- [ ] Zweryfikować, że scenariusze działają w aktualnym trybie: mapa katalogu +
      `find_recipes` + zakończenie tury po karcie.
- [ ] Jeśli Rafał jawnie zaakceptuje koszt: wykonać jeden pełny
      `pnpm agent:scenarios`.
- [ ] Zapisać surowe wyniki per scenariusz: czas, rundy, tools, tokeny, koszt,
      stopReason i wynik funkcjonalny.
- [ ] Osobno oznaczyć stare pomiary, żeby nie mieszać ich z nowym przepływem.
- [ ] Nie wyciągać procentowych wniosków z jednej próby; to baseline, nie
      benchmark statystyczny.

### Kryterium zakończenia
Mamy reprodukowalny harness i lokalny baseline. Płatny live benchmark może być
świadomie odłożony do Etapu 6. Anchor porównawczy dla stanu „przed”:
`22aa63c`. Raport: `reports/00-baseline.md`.

---

## Etap 1 — poprawność stanu, kosztów i granic danych

### Cel
Usunąć błędy, które mogą zmieniać wynik rozmowy, gubić koszt albo naruszać
granice danych przed optymalizowaniem logiki.

### Zadania
- [ ] Stan propozycji/kart w kolejnych turach:
  - model/serwer rozumie „wybieram drugą”,
  - „zamień tylko wtorek” nie generuje całego planu od nowa,
  - historia zawiera minimalną, stabilną reprezentację aktywnej propozycji,
    zamiast pełnego renderowanego JSON-u.
- [ ] Zaprojektować referencje do pozycji propozycji tak, by nie zależały od
      kolejności tekstu modelu.
- [ ] Jawnie wymagać `isCatalog: true` dla wspólnego indeksu katalogu;
      prywatny przepis gospodarstwa nie może zostać publicznym kandydatem przez
      sam fakt właściciela.
- [ ] Rozliczenie zużycia modelu:
  - zapis zużycia niezależny od końcowego statusu tury,
  - exactly-once/idempotencja per wywołanie dostawcy,
  - zewnętrzne domknięcie/anulowanie nie gubi już naliczonego kosztu.
- [ ] Graceful shutdown jako zabezpieczenie: przestać przyjmować nowe tury,
      pozwolić krótko domknąć bieżące i poprawnie oznaczyć niedomknięte.
- [ ] Recovery przy starcie dla osieroconych tur, bez pozostawiania rozmowy
      zablokowanej do timeoutu.
- [ ] Kontrola budżetu przy współbieżnych turach: nie wystarczy „sprawdź przed
      startem”; potrzebna atomowa rezerwacja/rozliczenie lub równoważny mechanizm.
- [ ] `/auth/refresh`: nie opierać ochrony wyłącznie na IP. Opracować limit
      zweryfikowanej sesji/token-family + sensowny bezpiecznik IP.
- [ ] Decyzja/risk note dla rezydencji danych w UE pozostaje osobnym torem;
      nie mieszać jej z wyborem „który model jest lepszy”.

### Testy obowiązkowe
- rozmowa wieloturowa z wyborem pozycji,
- podmiana jednej pozycji bez zmiany reszty,
- prywatny przepis nie trafia do publicznego indeksu,
- anulowanie/timeout/restart simulation nie gubi i nie dubluje usage,
- dwa równoległe starty nie przekraczają budżetu,
- NAT-like burst na refresh nie blokuje poprawnych użytkowników całej sieci.

### Kryterium zakończenia
Poprawność i księgowanie są deterministyczne; brak znanych ścieżek gubienia
kosztu lub aktywnej propozycji. Raport: `reports/01-correctness-state-costs.md`.

---

## Etap 2 — serwerowy silnik planowania posiłków [NAJWAŻNIEJSZY]

### Cel
Przenieść maksymalnie dużo logiki jadłospisu z modelu do backendu.

### Docelowy przepływ
1. Model lub UI przekazuje intencję i wymagania.
2. Serwer pobiera kandydatów z katalogu.
3. Serwer stosuje ograniczenia twarde.
4. Serwer wybiera zestaw dań i porcje.
5. Serwer oblicza kcal/makro i ocenia wynik.
6. Serwer zwraca gotowy `PlanDraft` + diagnostykę.
7. Model co najwyżej wyjaśnia rezultat/kompromis.
8. Zapis planu nadal następuje przez istniejący mechanizm propozycji/apply.

### 2A — audyt domeny przed implementacją
- [ ] Sprawdzić rzeczywistą semantykę `plannedServings`, uczestników i celów
      żywieniowych. Nie projektować „porcji per osoba”, jeśli obecny model danych
      tego nie obsługuje.
- [ ] Jeśli do poprawnego planowania potrzebna byłaby zmiana modelu danych,
      najpierw opisać problem i warianty w raporcie; nie robić ukrytej migracji.
- [ ] Zdefiniować jawne wejście/wyjście planera, np.:
      `PlanningRequest`, `PlanningConstraints`, `PlanDraft`,
      `PlanDiagnostics`.
- [ ] Rozdzielić hard constraints od soft preferences.

### 2B — planer jednego dnia
- [ ] Dobór kandydatów według pory i odbiorców.
- [ ] Alergie/diety zawsze jako twarde filtry serwerowe.
- [ ] Rozsądne zakresy porcji; nie wolno „naprawiać” kcal absurdalnie wielką
      porcją jednego dania.
- [ ] Obliczenie kcal i makro po stronie serwera.
- [ ] Wynik zawiera odchylenie od celu oraz powód, gdy nie da się spełnić
      wymagań.
- [ ] Deterministyczne tie-breaki albo seedowana losowość — ten sam seed i dane
      powinny dawać ten sam wynik.

### 2C — planer tygodnia
- [ ] Rozszerzyć ten sam silnik na tydzień.
- [ ] Uwzględniać różnorodność i penalizować powtarzanie.
- [ ] Opcjonalnie premiować wspólne składniki, ale nie kosztem twardych
      ograniczeń i istotnego pogorszenia celu żywieniowego.
- [ ] Uwzględniać niedawno zaplanowane/jedzone przepisy, jeśli dane są dostępne.
- [ ] Nie wykonywać N niezależnych „planerów dnia”, jeśli prowadzi to do
      globalnie gorszego tygodnia.

### 2D — lokalna zmiana planu
- [ ] Operacja podmiany jednego dnia/slotu zachowuje resztę planu.
- [ ] Po zmianie serwer przelicza właściwy zakres i zwraca diagnostykę.
- [ ] „Zamień środę na wege, podobnie kalorycznie” nie wymaga ponownego
      generowania tygodnia przez LLM.

### 2E — API wewnętrzne
Docelowo agent powinien dostawać operacje domenowe wysokiego poziomu, np.
`build_meal_plan`, `replace_plan_item`, `suggest_meals`, a nie zestaw
drobnych kroków, które model musi sam orkiestrwać.

Nazw nie traktować jako wymogu — najpierw sprawdzić istniejące narzędzia i
unikać dublowania API.

### Kryteria jakości
Przed kodowaniem ustalić tolerancje dla:
- kalorii,
- makro,
- liczby powtórzeń,
- czasu przygotowania,
- liczby niespełnionych preferencji miękkich.

Planer musi umieć zwrócić **UNSAT / częściowo spełnione** z konkretnym powodem,
zamiast udawać poprawny wynik.

### Kryterium zakończenia
Model nie układa już ręcznie struktury dnia/tygodnia ani nie liczy porcji i
bilansu. Serwer zwraca gotowy, walidowalny szkic. Raport:
`reports/02-server-side-planner.md`.

---

## Etap 2.2 — porcje per osoba

### Cel
Główny invariant: gdy Scoffie planuje dzień, backend próbuje doprowadzić CAŁY dzień
KAŻDEJ osoby możliwie blisko 100 % jej `calorieGoal` (≤ 5 % bardzo dobrze, ≤ 10 %
akceptowalnie, > 10 % = PARTIAL; twarde ograniczenia nigdy dla kcal). Równy podział
`plannedServings` blokuje ten cel przy różnych celach w domu — potrzebna alokacja porcji
per osoba dla wspólnego dania.

### Zadania
- [x] Audyt cross-repo (backend + iOS) i projekt przed zmianą schematu.
- [x] Model danych z porcjami ułamkowymi; legacy bez alokacji = dzisiejszy równy podział.
- [x] Jednoznaczna relacja `plannedServings` ↔ suma porcji osób.
- [x] Planer: dobór przepisu + alokacja porcji (zakres i krok jako stałe domenowe).
- [x] Lista zakupów z jawną semantyką ilości (test).
- [x] iOS: dekodowanie starych/nowych planów, bilans z porcji osoby, cache (NIESKOMPILOWANE).
- [x] Kompatybilność stary/nowy klient × stary/nowy backend, plan rolloutu.
- [x] Testy obowiązkowe 1–12 (backend) i `planner:eval` przed/po; 13–17 (iOS) napisane,
      czekają na uruchomienie na Macu (`sh Scripts/plan-portions-check.sh`).

### Kryterium zakończenia
Para i rodzina o różnych celach schodzą istotnie poniżej granicy równego podziału,
twarde ograniczenia = 0, legacy działa bez zmian. Raport: `reports/02-2-per-user-portions.md`.

---

## Etap 3 — odchudzenie asystenta i liczby rund

### Cel
Po przeniesieniu domeny na serwer uprościć rolę modelu.

### Zadania
- [ ] Typowe „co na kolację?” powinno kończyć się jedną rundą modelu, jeżeli
      intencja jest jednoznaczna.
- [ ] Narzędzie wysokiego poziomu może samo wyszukać i przygotować 3 różne
      opcje; model nie musi najpierw osobno sterować `find_recipes`.
- [ ] Bilans dnia/tygodnia dołączać selektywnie do potrzebnego kontekstu;
      rozróżniać „zaplanowane” i „zjedzone”. Nie wysyłać zawsze całego
      gospodarstwa i całego tygodnia.
- [ ] Gdy terminalna karta została poprawnie utworzona, backend może dopisać
      krótkie deterministyczne zdanie zamiast płacić za kolejną rundę.
- [ ] Rozszerzyć mechanizm terminal cards tylko po sprawdzeniu sytuacji z
      kilkoma narzędziami kończącymi w jednej odpowiedzi.
- [ ] Usunąć sprzeczność wokół `get_household_context`, jeśli wymagany kontekst
      faktycznie jest już dostarczony.
- [ ] `apply_week_plan` usunąć z narzędzi modelu tylko po sprawdzeniu realnych
      call-sites/trybów kompatybilności.
- [ ] Narzędzia create/update/delete recipe nie powinny być eksponowane modelowi
      bez uzasadnionego scenariusza.
- [ ] Odchudzić odpowiedź `find_recipes`: zwracać minimalne dane potrzebne do
      decyzji, a szczegóły dociągać na żądanie. Nie usuwać informacji, które są
      potrzebne do wyjaśnienia „dlaczego to pasuje”.
- [ ] Niższy effort testować dopiero po stabilizacji serwerowego planera.
      Nie przyjmować założenia „low wszędzie”.

### Kryterium zakończenia
Dla standardowych scenariuszy spada liczba rund i danych wysyłanych modelowi,
a wynik nadal przechodzi te same walidatory domenowe. Raport:
`reports/03-agent-thinning.md`.

---

## Etap 4 — katalog, baza i API pod tysiące przepisów

### 4A — synchronizacja katalogu backend ↔ iOS
- [ ] Usunąć limit iOS powodujący zakończenie pełnego pobierania po 40×100 =
      4000 przepisów.
- [ ] Zaprojektować trwałą rewizję katalogu, której zmiana obejmuje create,
      update, deactivate/delete i istotne zmiany składników/tagów.
- [ ] Sync przyrostowy: klient podaje znaną rewizję, backend zwraca zmiany od
      niej.
- [ ] Obsłużyć tombstones/dezaktywacje, nie tylko rekordy dodane/zmienione.
- [ ] Snapshot fallback, gdy klient jest za stary lub brakuje historii delt.
- [ ] Kompresja transportu; ETag tylko tam, gdzie faktycznie używany jest HTTP.
      Dla WebSocket użyć własnego kontraktu rewizji.
- [ ] Po reconnect nie wysyłać pełnego katalogu bez powodu.
- [ ] Wspólny słownik/semantyka facetów/tagów między backendem i iOS.
- [ ] Test katalogu > 5000 przepisów, w tym aktualizacja i usunięcie/deaktywacja.

### 4B — cache i zapytania
- [ ] Oddzielić cache publicznego katalogu od danych zależnych od gospodarstwa.
- [ ] Polubienie przepisu nie może czyścić całego publicznego cache.
- [ ] LRU wprowadzać tylko jeśli daje realną korzyść; ważniejszy jest poprawny
      klucz i invalidacja.
- [ ] Popularności nie liczyć zapytaniem per przepis. Preferować jedno
      agregowanie zbiorcze + cache/single-flight; materializację dopiero, gdy
      pomiary jej wymagają.
- [ ] Odcisk/rewizję katalogu liczyć raz na odpowiedni zakres (np. tura), nie
      przy każdym wyszukiwaniu.
- [ ] Odcisk nie może opierać się wyłącznie na count + max(updatedAt), jeśli
      może ominąć zmianę danych.

### 4C — lista zakupów i polling tury
- [ ] Odczyt listy zakupów nie powinien bez potrzeby przebudowywać stanu.
      Jeśli rebuild jest konieczny, zrobić go raz z blokadą/single-flight +
      recheck albo przesunąć na moment mutacji.
- [ ] Ograniczyć zapis całego `draftText` co ~350 ms; rozważyć batching ok.
      1 s albo model przyrostowy.
- [ ] Polling tury nie powinien powodować nieproporcjonalnej liczby zapytań DB.

### 4D — Postgres/Prisma
- [ ] Zweryfikować brakujące indeksy na realnych zapytaniach, w tym
      `AgentMessage.turnId`, `Invitation.householdId`, `Recipe.authorId`.
- [ ] Nie dodawać indeksów „bo kolumna istnieje”; użyć planu zapytania / ścieżki
      hot path jako uzasadnienia.
- [ ] Jawnie skonfigurować pool i timeouty adekwatne do limitu Railway/Postgresa;
      nie zwiększać puli bez pomiaru.
- [ ] `statement_timeout` i timeout transakcji dobrać tak, by nie ubijać
      legalnych operacji wsadowych.
- [ ] Zachować retry dla konfliktów serializable i istniejącą kolejność blokad.

### Kryterium zakończenia
Katalog >5000 działa bez pełnego transferu przy zwykłej zmianie; nie ma limitu
4000 na iOS; hot paths nie robią N+1; cache ma jawne granice danych. Raport:
`reports/04-catalog-db-api-scale.md`.

---

## Etap 5 — trwałe wykonywanie tur

### Cel
Tura ma przetrwać restart procesu bez podwójnego zapisu i bez utraty kosztu.
Nie czekamy z tym problemem aż do drugiej instancji.

### Najpierw rozwiązanie minimalne
Preferować mechanizm oparty na istniejącym PostgreSQL/`AgentTurn`, jeśli
spełni wymagania. Redis/kolejka zewnętrzna nie jest celem samym w sobie.

### Wymagania
- [ ] Trwały stan zadania i lease/claim workera.
- [ ] Odzyskanie zadania po wygaśnięciu lease lub restarcie.
- [ ] Idempotentne efekty uboczne.
- [ ] Exactly-once księgowanie usage na poziomie tego, co kontrolujemy.
- [ ] Anulowanie widoczne przez worker z trwałego stanu, nie wyłącznie pamięci.
- [ ] Graceful shutdown pozostaje dodatkową ochroną, nie jedyną.
- [ ] Telemetria: liczba queued/running/retried/orphaned/failed.

### Dopiero przy potrzebie wielu instancji
- Redis adapter Socket.IO,
- współdzielone liczniki throttlingu,
- koordynacja cronów/advisory locks,
- wsadowanie pushy poza pamięcią procesu.

### Kryterium zakończenia
Kontrolowany restart podczas tury nie pozostawia rozmowy w RUNNING, nie
podwaja zapisu planu i nie gubi znanego kosztu. Raport:
`reports/05-durable-turns.md`.

---

## Etap 6 — końcowy benchmark, dobór modelu i routing

### Cel
Najpierw zmierzyć finalny przepływ server-first i porównać go z zamrożonym
stanem „przed”, a następnie dobrać model/routing dla ustabilizowanej architektury.

### 6A — końcowy benchmark przed/po
- [ ] Uruchomić ten sam reprezentatywny zestaw scenariuszy na anchorze `22aa63c`
      i na finalnym HEAD.
- [ ] Oba przebiegi wykonać możliwie tego samego dnia, na tym samym modelu,
      effort, ustawieniach kart, katalogu i środowisku.
- [ ] Preferować `concurrency=1` dla porównania latency/kosztu.
- [ ] Zachować surowe JSON-y obu przebiegów.
- [ ] Porównać koszt poprawnie zakończonego zadania, latency, rundy, tokeny,
      tool calls, stop reasons i correctness.
- [ ] Stare pomiary digest traktować jako historyczny kontekst, nie jako jedyne
      źródło „przed”.

### 6B — dataset do oceny modeli

- [ ] 20–30 reprezentatywnych rozmów z własnych scenariuszy Scoffie.
- [ ] Zawierać: prostą sugestię, plan dnia, plan tygodnia, modyfikację jednej
      pozycji, niejasne wymaganie, konflikt ograniczeń, pytanie o bilans,
      kontynuację po karcie.
- [ ] Dla części przypadków mieć automatyczne asercje, nie tylko ocenę opisową.

### 6C — metryki modeli
- koszt poprawnie zakończonego zadania,
- czas p50/p95,
- liczba rund,
- poprawność tool calls,
- liczba błędnych/nadmiarowych tools,
- spełnienie constraints,
- poprawność modyfikacji częściowej,
- jakość języka jako osobna metryka.

### 6D — strategia routingu
- Jeden „asystent” produktowo nie musi oznaczać jednego modelu technicznie.
- Najpierw sprawdzić prosty routing po typie zadania/ryzyku.
- Operacje deterministyczne nadal mają być bez LLM.
- Tańszy model może obsługiwać klasyfikację, streszczenia i proste tool calls,
  jeśli benchmark pokaże jakość.
- Mocniejszy model zostaje fallbackiem dla niejednoznacznych/trudnych rozmów.
- Nie budować warstwy wielu dostawców bez dowodu, że daje wartość.
- Nazwy i ceny kandydatów potwierdzić w oficjalnej dokumentacji w dniu testu;
  nie opierać decyzji na wcześniejszych zapowiedziach lub źródłach wtórnych.

### Rezydencja danych
To osobna decyzja architektoniczno-prawna. Benchmark jakości modelu nie
rozstrzyga, gdzie wolno przesyłać dane użytkownika.

### Kryterium zakończenia
Mamy tabelę wyników na tym samym zestawie przypadków oraz rekomendowany routing
oparty na kosztach **udanych** zadań. Raport: `reports/06-model-evaluation.md`.

---

## Backlog świadomie odłożony

Bez nowego dowodu z pomiarów:
- Elasticsearch/OpenSearch,
- vector DB/embeddingi jako główna wyszukiwarka,
- mikroserwis planera,
- druga instancja,
- Redis „na wszelki wypadek”,
- cache warmer,
- zmiana dostawcy tylko na podstawie benchmarków publicznych.
