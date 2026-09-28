# Domknięcie pakietu nocnego 27/28.09.2026

Data review: 28.09.2026. Wykonawca: Codex, na polecenie Rafała.

## Zakres i status

Domykamy kod nocnego pakietu na `develop`. Ten raport nie oznacza wdrożenia na
produkcję ani zakończenia benchmarku live. Status scalenia ostatniej poprawki
jest widoczny w [PR #233](https://github.com/rpiechowicz/scoffie-backend/pull/233).
Raport w scalonym `develop` oznacza zakończenie integracji pakietu po zielonym CI.

Scalone podczas review: #226 (wspólne ograniczenia), #232 (odmiana składników),
#227 (tekst serwera przy PARTIAL, domyślnie OFF), #228 (tydzień w „pokaż inne”),
#229 (metryki), #231 (odmowa podmiany nieaktualnej propozycji po odejściu domownika).
#225 i #230 były scalone wcześniej. #233 zawiera kategorie „z/bez X” i poprawkę review.

## Poprawka review w #233

Tag FISH nie dowodzi, że ryba jest wędzona, a MEAT — że mięso jest mielone.
Poprzedni fallback po dowolnym rdzeniu frazy gubił te określenia i mógł też
uznać „mieszankę warzyw” za mięso. Fallback kategorii działa teraz tylko dla
pojedynczej nazwy kategorii w jawnej polskiej odmianie. Szczegółowa fraza nadal
wymaga dopasowania nazwy składnika; nie wnioskujemy określeń z tagu przepisu.

Dotyczy wspólnej funkcji `mentionsIngredient` używanej przez planowanie,
wyszukiwanie i sugestie. Nie zmieniono schematu narzędzi ani kontraktu API.
Dodano 11 przypadków unit (dopasowanie i wykluczanie), zaktualizowano niezależny
słownik wyroczni równoważności. Pozostałe reguły ograniczeń bez zmian.

## Weryfikacja

- Odczytano raporty M0–M12, sprawdzono diffy produkcyjne i statusy CI PR-ów.
- Sześć PR-ów scalono z zielonymi istniejącymi kontrolami, z przypiętym head SHA.
- Lokalna sonda wykonująca rzeczywiste funkcje źródłowe: przed poprawką 6/10 PASS
  (cztery regresje), po poprawce 10/10 PASS. To test celowany, nie pełna suita.
- Końcowa bramka: istniejący Backend CI PR #233 na wersji zintegrowanej z
  `develop` a69ce8b (wszystkie sześć pozostałych PR-ów już w bazie): lint,
  typecheck, build, unit, OpenAPI i E2E zgodnie z workflow. Wynik i szczegóły
  są w kontrolach PR-a; scalenie dopiero po sukcesie. Workflow nie zmieniano.
- Historyczne wyniki nocy 3666 unit / 850 E2E dotyczą wersji PRZED poprawką
  review, nie są przedstawiane jako wynik obecnego commita.

## Otwarte — rollout i pomiar, nie zaległe nocne PR-y

1. Live smoke OFF/ON dla `AI_PARTIAL_SERVER_TEXT`, porównanie poprawności, czasu
   i liczby wywołań. Brak klucza Anthropic i dostępu Railway w środowisku Codex;
   nie wykonano płatnych wywołań. Flaga pozostaje domyślnie `false`.
2. Wdrożenie `develop` → `main` oraz kontrola produkcji to osobny krok.
   W tej pracy nie zmieniano `main`, ENV ani danych produkcyjnych.
3. D1/D2: graceful shutdown i pula DB po odczycie limitów środowiska.
4. S5: pomiar konfliktów diety w zapisanych planach przed zmianą walidacji.
5. Finalny benchmark live po wdrożeniu poprawek — nie obiecywać wyliczonego
   −14,6% wywołań jako zmierzonego wyniku obecnej produkcji.

## Decyzje architektoniczne

- Repair engine: odłożony przy obecnym katalogu/funkcji celu (1/17 PARTIAL → OK),
  nie zadanie wymagane do zamknięcia tej integracji.
- Osobna warstwa komend: odłożona do wykazania korzyści pomiarem.
- Rozbudowany stan rozmowy: decyzja po metrykach; C0 i liczniki są w pakiecie.
- Nie rozpoczęto migracji Prisma/Node ani prac iOS/Android.

## Korekty odczytu raportów nocy

M12 §5 jest historyczny: obsługa „z X” została dodana drugim commitem #233.
M9 ma starszą listę sześciu PR-ów obok aktualnej listy siedmiu. Źródłem statusu
scalenia są PR-y, a ten raport jest aktualnym punktem kontynuacji.

Raporty źródłowe pozostają na `claude/nightly-2026-09-27` w
`docs/workstreams/nightly-2026-09-27/reports/`.
