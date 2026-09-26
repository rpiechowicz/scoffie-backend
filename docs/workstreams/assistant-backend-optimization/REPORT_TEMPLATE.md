# Raport etapu <NN> — <nazwa>

**Data:** YYYY-MM-DD  
**Status:** DONE | PARTIAL | BLOCKED  
**Branch:**  
**Zakres z TASKS.md:**  

## 1. Co zostało zrobione

Krótko, konkretnie. Oddziel fakty od planów.

## 2. Zmiany w kodzie

| Plik / moduł | Co zmieniono | Dlaczego |
|---|---|---|

Jeżeli były migracje DB, opisz:
- nazwę migracji,
- wpływ na istniejące dane,
- sposób rollbacku / forward-fix.

## 3. Kontrakty i kompatybilność

- REST / WebSocket / OpenAPI:
- iOS:
- zmienne środowiskowe:
- kompatybilność wsteczna:

## 4. Testy

Podaj **dokładne komendy** i wynik.

| Test / komenda | Wynik |
|---|---|

Nie pisz „testy przechodzą”, jeśli nie zostały uruchomione.

## 5. Pomiary przed / po

| Metryka | Przed | Po | Zmiana | Źródło pomiaru |
|---|---:|---:|---:|---|

Dla asystenta, jeśli dotyczy:
- czas tury,
- rundy modelu,
- input/output/cache tokens,
- koszt,
- tool calls,
- trafienie w constraints,
- kcal/makro deviation.

Każdą wartość oznacz jako:
- **MEASURED** — zmierzona,
- **CALCULATED** — wyliczona,
- **ESTIMATE** — szacunek.

## 6. Wydajność bazy / API

Jeśli etap dotyczył DB:
- liczba zapytań na hot path,
- najważniejsze EXPLAIN/ANALYZE lub inne dowody,
- cache hit/miss, jeśli mierzone,
- wpływ na transfer danych.

## 7. Ryzyka i regresje

- nowe ryzyka:
- znane ryzyka pozostawione:
- potencjalne edge cases:

## 8. Odstępstwa od planu

Każdy punkt z TASKS.md, którego nie zrobiono albo wykonano inaczej, wraz z
powodem.

## 9. Decyzje potrzebne od Rafała

Tylko decyzje, których wykonawca nie powinien podejmować samodzielnie.

## 10. Co proponujesz dalej

Maksymalnie kilka konkretnych punktów. **Nie rozpoczynaj ich jeszcze.**

## 11. Commity

- `<sha>` — <opis>
