# Workstream: Scoffie backend + asystent server-first

**Start:** 26.09.2026  
**Zakres:** `scoffie-backend` + wybrane zadania w `scoffie-ios`  
**Cel:** przygotować Scoffie do katalogu liczonego w tysiącach przepisów oraz
uprościć, przyspieszyć i potanić asystenta bez przerzucania logiki domenowej na
LLM.

## Zasada architektoniczna

> **Model rozumie język użytkownika. Serwer wykonuje logikę domenową, obliczenia,
> planowanie, walidację, stan i zapis.**

Model ma przede wszystkim:
1. rozpoznać intencję i nieprecyzyjne wymagania użytkownika,
2. poprosić o doprecyzowanie, gdy serwer nie może bezpiecznie podjąć decyzji,
3. wyjaśnić wynik lub kompromis.

Serwer ma odpowiadać za:
- wyszukiwanie, filtrowanie i ranking przepisów,
- alergeny, diety, uprawnienia i wszystkie twarde ograniczenia,
- dobór posiłków, porcje, kcal i makro,
- różnorodność oraz wykorzystanie wspólnych składników,
- modyfikację tylko wskazanego fragmentu planu,
- stan aktywnej propozycji i jej historię,
- listę zakupów i obliczenia domenowe,
- idempotencję, anulowanie, ponowienia, budżet i rozliczenie kosztu,
- generowanie kart i prostych deterministycznych komunikatów, gdy model nie jest
  potrzebny.

Kliknięcie w UI, które już jednoznacznie opisuje operację, nie powinno uruchamiać
modelu.

## Jak pracujemy

1. `STATE.md` mówi, który etap jest aktualnie aktywny.
2. `TASKS.md` zawiera pełny zakres i kryteria akceptacji.
3. Claude wykonuje **jeden etap naraz**.
4. Po etapie uruchamia właściwe testy i pomiary.
5. Tworzy raport w `reports/` według `REPORT_TEMPLATE.md`.
6. Aktualizuje `STATE.md`.
7. **Zatrzymuje pracę i czeka na review.**

Nie wolno „przy okazji” rozpoczynać kolejnego etapu.

## Reguły pomiaru

Optymalizacja nie jest uznana za skuteczną tylko dlatego, że kod wygląda na
lżejszy. Raport musi odróżniać:
- wynik zmierzony,
- wynik wyliczony,
- hipotezę / szacunek.

Dla asystenta mierzymy co najmniej:
- czas całej tury oraz, jeśli możliwe, p50/p95,
- liczbę wywołań modelu,
- tokeny wejścia/wyjścia/cache,
- koszt tury,
- liczbę wywołań narzędzi,
- poprawność użycia narzędzi,
- spełnienie ograniczeń planu,
- trafienie w cele kcal/makro w zdefiniowanej tolerancji,
- liczbę zapytań DB na kluczowych ścieżkach, gdy jest to przedmiotem etapu.

**Płatnego benchmarku na żywym modelu nie uruchamiać przed Etapem 6 bez jawnej zgody Rafała.**
Aktualna decyzja: płatne porównanie odkładamy na finał. Anchor stanu „przed” to
commit `22aa63c`; na końcu benchmarkujemy anchor i finalny HEAD w tych samych
warunkach.

## Granice na ten workstream

Na razie **nie** wprowadzamy:
- Elasticsearch/OpenSearch,
- bazy wektorowej i embeddingów jako podstawy wyszukiwania katalogu,
- mikroserwisów dla planera,
- drugiej instancji tylko „na zapas”,
- Redis wyłącznie dlatego, że może się kiedyś przydać,
- podgrzewania cache przy małym ruchu,
- zmiany dostawcy modelu bez benchmarku,
- zmian GitHub Actions z powodów niezwiązanych bezpośrednio z tym workstreamem.

Jeżeli pomiar wykaże potrzebę któregoś z powyższych elementów, najpierw opisać
dowód i alternatywy w raporcie.

## Zasady bezpieczeństwa zmian

- Nie wykonywać zapisów na produkcji bez jawnej zgody.
- Nie zmieniać kontraktów iOS/backend po cichu; aktualizować OpenAPI/kontrakty.
- Migracje muszą być bezpieczne dla istniejących danych.
- Nowe operacje planu zachowują istniejące zasady blokad i `runSerializable`.
- Nie obchodzić kart/propozycji i human-in-the-loop tylko po to, żeby zmniejszyć
  liczbę rund modelu.
- Dane o zdrowiu i prywatne przepisy nie mogą trafić do zakresu publicznego
  katalogu.

## Źródła kontekstu

Przed pracą warto znać:
- `docs/review/2026-09-26-przeglad-ekosystemu.md`,
- `docs/plans/scoffie-ai-agent/wyszukiwarka-i-tempo-2026-09.md`,
- `docs/plans/scoffie-ai-agent/tempo-2026-09-24.md`,
- `docs/plans/scoffie-ai-agent/cost-model.md`,
- główne `CLAUDE.md`,
- `scoffie-ios/CLAUDE.md` przy zadaniach cross-repo.
