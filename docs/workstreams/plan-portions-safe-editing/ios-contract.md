# Kontrakt dla iOS — bezpieczna edycja porcji per osoba

Status: kontrakt backendu (gałąź `feature/plan-portions-safe-editing`, zależna od #209). iOS NIE jest zmieniany
w tym workstreamie; edycja porcji w aplikacji zostaje zablokowana, dopóki nie są spełnione warunki z ostatniej
sekcji. Decyzje i uzasadnienie: `docs/adr/plan-portions-safe-editing.md`. Pełne kształty: `openapi/openapi.json`
(`WeeklyPlanDto`, `PlanItemDto`, `PlanItemPortionDto`, `UpsertWeekSlotDto`, `ApplyWeekPlanDto`, `SetPortionDto`)
i `openapi/SOCKET-EVENTS.md` (`weeklyPlans:setPortion`).

## 1. Tokeny w odczycie

`weeklyPlans:getByWeek` (i każdy `plan` w odpowiedzi `applyWeekPlan`) niesie trzy rodzaje tokenów — liczby
całkowite ≥ 0, nieprzezroczyste dla klienta (nie licz na nich, nie zwiększaj lokalnie, porównuj tylko na równość):

| Pole                          | Token dla                              | Uwagi                                                                                                                  |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `plan.revision`               | `applyWeekPlan.data.expectedRevision`  | rośnie przy KAŻDEJ zmianie treści tygodnia (pozycje, uczestnicy, porcje, `plannedServings`); „zjedzone” go nie zmienia |
| `items[].revision`            | `upsertWeekSlot.data.expectedRevision` | stempel pozycji; odtworzona pozycja (usunięta i dodana ponownie) ma NOWY, wyższy stempel                               |
| `items[].portions[].revision` | `setPortion.data.expectedRevision`     | stempel porcji JEDNEJ osoby                                                                                            |

```json
{
  "id": "3b0e…",
  "householdId": "5c1d…",
  "weekStart": "2026-10-05",
  "revision": 12,
  "items": [
    {
      "id": "9f2a…",
      "dayOfWeek": "TUE",
      "mealType": "DINNER",
      "recipeId": "7d4e…",
      "participantIds": [],
      "plannedServings": 3,
      "revision": 11,
      "portions": [
        { "userId": "a1…", "servings": 0.8, "revision": 9 },
        { "userId": "b2…", "servings": 1.25, "revision": 11 }
      ]
    }
  ]
}
```

Po każdym udanym zapisie klient zastępuje lokalne tokeny tymi z odpowiedzi:

- ack `upsertWeekSlot` i `setPortion` — pozycja z nowymi `revision` (pozycja i porcje) oraz `planRevision`
  (bieżąca `plan.revision`);
- ack `applyWeekPlan` — `plan` w całości.

Broadcast `weeklyPlans:weekChanged` nie niesie tokenów — po nim klient odświeża tydzień (`getByWeek`), tak jak dziś.
Wiersze sprzed wdrożenia mają token `0` — jest ważny.

## 2. `weeklyPlans:setPortion` — porcja jednej osoby

Zmienia wyłącznie porcję wskazanej osoby (i pochodne `plannedServings = ceil(Σ)`). Porcje innych osób i ich tokeny
zostają, więc dwie osoby edytujące RÓŻNE porcje z tego samego odczytu nie kolidują.

```json
{
  "householdId": "5c1d…",
  "weekStart": "2026-10-05",
  "data": {
    "planItemId": "9f2a…",
    "userId": "b2…",
    "servings": 1.5,
    "expectedRevision": 11
  }
}
```

- `servings`: 0,1–6, wielokrotność 0,05; suma porcji pozycji ≤ 12 (liczona pod zamkiem z porcjami innych osób);
- `expectedRevision`: `items[].portions[].revision` TEJ osoby — wymagane;
- zmieniać może każdy domownik (także cudzą porcję).

Ack:

```json
{
  "ok": true,
  "data": {
    "id": "9f2a…",
    "plannedServings": 3,
    "revision": 13,
    "portions": [
      { "userId": "a1…", "servings": 0.8, "revision": 9 },
      { "userId": "b2…", "servings": 1.5, "revision": 13 }
    ],
    "changeKind": "DETAILS_CHANGED",
    "planRevision": 13
  }
}
```

`changeKind: "NOOP"` = porcja już miała tę wartość (np. ponowienie) — nic nie zapisano, brak broadcastu.
Po zmianie idzie `weeklyPlans:weekChanged` (`action: "UPSERT_SLOT"`, `dayOfWeek`/`mealType` pozycji)
i `weeklyPlans:shoppingListChanged`; bez pusha.

## 3. Zmiana uczestników pozycji z alokacją

`weeklyPlans:upsertWeekSlot` z nowym `participantIds`, PEŁNYMI `portions` dla nowego audytorium i tokenem pozycji.
Serwer niczego nie przenosi ani nie przelicza — bez porcji zapis jest odrzucany (`PLAN_PORTIONS_CONFLICT`).

```json
{
  "householdId": "…",
  "weekStart": "2026-10-05",
  "data": {
    "dayOfWeek": "TUE",
    "mealType": "DINNER",
    "recipeId": "7d4e…",
    "participantIds": ["a1…", "b2…", "c3…"],
    "portions": [
      { "userId": "a1…", "servings": 0.8 },
      { "userId": "b2…", "servings": 1.25 },
      { "userId": "c3…", "servings": 1.0 }
    ],
    "expectedRevision": 11
  }
}
```

Reguły klienta:

- osoby, które zostają — ich bieżące porcje (albo nowe, jeśli użytkownik je zmienił);
- osoba dodana — porcja podana jawnie; sugestia 1,00 (jak reguła serwera przy dołączeniu do domu);
- osoba usunięta — znika z `portions`;
- zbiór osób w `portions` = audytorium (przy `participantIds: []` — wszyscy domownicy);
- Σ ≤ 12, krok 0,05, 0,1–6 na osobę — inaczej `PLAN_PORTIONS_INVALID`.

## 4. Zamiana dania z alokacją

`upsertWeekSlot` z nowym `recipeId`, `replaceRecipeId` = stare danie, jawnymi `portions` nowego dania i
`expectedRevision` = `items[].revision` pozycji ŹRÓDŁOWEJ. Zachowanie porcji = te same wartości w `portions`.

- bez `portions` → `PLAN_PORTIONS_CONFLICT` (bez niejawnego resetu);
- bez tokenu → `PLAN_REVISION_REQUIRED` (chyba że `portions` są identyczne z bieżącymi);
- źródła już nie ma albo ma inny stempel → `PLAN_REVISION_CONFLICT`.

## 5. Pełny tydzień (`applyWeekPlan`)

`data.expectedRevision` = `plan.revision`. Nieaktualny token: `applied: false`,
`violations: [{ "index": -1, "code": "PLAN_REVISION_CONFLICT", "message": "…" }]` (bez `dayOfWeek`/`mealType`/
`recipeId`), `plan: null`, nic nie zapisane. Zgodny token pozwala zastąpić i usunąć pozycje z alokacją. Bez tokenu:
pozycje BEZ alokacji jak dotąd (usuwane, jeśli ich nie ma w stanie docelowym), pozycje Z alokacją — naruszenie
`PLAN_REVISION_REQUIRED`.

## 6. Konflikt → odświeżenie → ponowienie

| Kod (WS `code`, `status`)                                      | Znaczenie                                                                        | Co robi klient                                                                                                                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAN_REVISION_CONFLICT` 409                                   | ktoś zmienił pozycję/porcję/tydzień od Twojego odczytu (albo pozycji już nie ma) | `getByWeek`; pokaż bieżący stan; ponów intencję użytkownika na NOWYM tokenie tylko, jeśli nadal ma sens (np. porcja innej wartości niż teraz) — nigdy automatycznie ze starym tokenem |
| `PLAN_REVISION_REQUIRED` 428                                   | zapis zastąpiłby/usunąłby alokację bez tokenu                                    | błąd klienta: dołóż token z odczytu; w produkcji — `getByWeek` i ponów z tokenem                                                                                                      |
| `PLAN_PORTIONS_CONFLICT` 409, `details` `reason:NOT_ALLOCATED` | `setPortion` na pozycji bez alokacji                                             | alokację zaczyna jawny `upsertWeekSlot` z pełnymi `portions`                                                                                                                          |
| `PLAN_PORTIONS_CONFLICT` 409, `reason:NOT_IN_AUDIENCE`         | osoby nie ma już w alokacji (zmiana uczestników)                                 | `getByWeek`, pokaż nowe audytorium                                                                                                                                                    |
| `PLAN_PORTIONS_CONFLICT` 409 (bez `reason`)                    | zapis bez `portions` skasowałby alokację                                         | wyślij pełne `portions`                                                                                                                                                               |
| `PLAN_ITEM_NOT_FOUND` 404                                      | pozycji nie ma w tym tygodniu tego domu (usunięta, zamieniona — albo cudza)      | `getByWeek`                                                                                                                                                                           |
| `PLAN_PORTIONS_INVALID` 400                                    | krok/widełki/suma > 12                                                           | komunikat z `message`; nie ponawiaj bez zmiany wartości                                                                                                                               |
| `VALIDATION_ERROR` 400                                         | zły kształt (np. brak `expectedRevision` w `setPortion`)                         | błąd klienta                                                                                                                                                                          |

Przykłady odpowiedzi:

```json
{ "ok": false, "code": "PLAN_REVISION_CONFLICT", "status": 409,
  "message": "Plan zmienił się od ostatniego odczytu. Odśwież plan i spróbuj ponownie.",
  "error": "Plan zmienił się od ostatniego odczytu. Odśwież plan i spróbuj ponownie.",
  "details": ["planItemId:9f2a…", "currentRevision:13"] }

{ "ok": false, "code": "PLAN_REVISION_REQUIRED", "status": 428,
  "message": "Zmiana porcji ustawionych osobno dla każdej osoby wymaga aktualnej wersji planu. Odśwież plan i spróbuj ponownie.",
  "error": "…", "details": ["planItemId:9f2a…"] }

{ "ok": false, "code": "PLAN_PORTIONS_CONFLICT", "status": 409, "message": "…", "error": "…",
  "details": ["planItemId:9f2a…", "reason:NOT_IN_AUDIENCE"] }
```

`details` służy logom i diagnostyce — decyzję podejmuj po `code` (i `reason`), `currentRevision` nie zastępuje
odświeżenia.

## 7. Ponowienia (utracona odpowiedź, timeout ACK)

Bez klucza operacji. Klient ponawia DOKŁADNIE ten sam payload (ten sam token):

- `setPortion` / `upsertWeekSlot`: jeśli pierwszy zapis wszedł, ponowienie dostaje sukces `changeKind: "NOOP"`
  (stan już jest żądanym) — przyjmij tokeny z acka; jeśli w międzyczasie ktoś zmienił pozycję —
  `PLAN_REVISION_CONFLICT` → odśwież (nowsza zmiana NIE jest cofana);
- `upsertWeekSlot` z `replaceRecipeId` i `applyWeekPlan`: ponowienie po sukcesie dostaje `PLAN_REVISION_CONFLICT`
  → odśwież i sprawdź, czy stan jest już taki, jakiego chciał użytkownik.

## 8. Zgodność wstecz i wykrywanie funkcji

- Starszy backend (bez tego PR) nie ma pól `revision` i ODRZUCA nieznane `expectedRevision` (`VALIDATION_ERROR`).
  Wykrywanie: `plan.revision` w odpowiedzi `getByWeek` — brak = edycja porcji zablokowana, zapisy bez tokenów.
- Starszy iOS (bez tokenów) działa jak dotąd: nie wysyła `portions`, a zapis bez nich nie kasuje alokacji
  (#209). Tokeny są opcjonalne dla pozycji BEZ alokacji.

## 9. Warunki odblokowania edycji porcji w UI

1. Backend z tym PR (i #209) wdrożony na produkcję; migracja `20260927120000_plan_revisions` zastosowana.
2. iOS dekoduje `revision` (tydzień, pozycja, porcja) i `planRevision`, trzyma je per pozycja i podmienia po
   każdym acku / odświeżeniu.
3. Stepper porcji jednej osoby → wyłącznie `weeklyPlans:setPortion` (nie pełny `upsertWeekSlot`).
4. Zmiana uczestników i zamiana dania na pozycji z alokacją → pełne `portions` + `expectedRevision` (sekcje 3–4).
5. Każdy kod z tabeli w sekcji 6 obsłużony; `PLAN_REVISION_CONFLICT` kończy się odświeżeniem, nie cichym
   ponowieniem ze starym tokenem.
6. Wykrywanie funkcji z sekcji 8 — bez `plan.revision` edycja zostaje zablokowana.
7. iOS skompilowany i sprawdzony na macOS (testy UI/jednostkowe przepływów z sekcji 2–7) — z Windows NIE jest
   to możliwe; do tego czasu edycja zostaje zablokowana.
