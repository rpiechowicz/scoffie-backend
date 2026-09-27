# Kontrakt dla iOS — bezpieczna edycja porcji per osoba

Status: kontrakt backendu (gałąź `feature/plan-portions-safe-editing`, zależna od #209). iOS NIE jest zmieniany
w tym workstreamie; edycja porcji w aplikacji zostaje zablokowana, dopóki nie są spełnione warunki z ostatniej
sekcji. Decyzje i uzasadnienie: `docs/adr/plan-portions-safe-editing.md`. Pełne kształty: `openapi/openapi.json`
(`WeeklyPlanDto`, `PlanItemDto`, `PlanItemPortionDto`, `UpsertWeekSlotDto`, `ApplyWeekPlanDto`, `SetPortionDto`)
i `openapi/SOCKET-EVENTS.md` (`weeklyPlans:setPortion`).

## 1. Tokeny w odczycie

`weeklyPlans:getByWeek` (i każdy `plan` w odpowiedzi `applyWeekPlan`) niesie trzy rodzaje tokenów — liczby
całkowite ≥ 0, nieprzezroczyste dla klienta (nie licz na nich, nie zwiększaj lokalnie, porównuj tylko na równość):

| Pole                          | Token dla                                                                                               | Uwagi                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan.revision`               | `applyWeekPlan.data.expectedRevision`                                                                   | rośnie przy KAŻDEJ zmianie treści tygodnia (pozycje, uczestnicy, porcje, `plannedServings`); „zjedzone” go nie zmienia; WYŁĄCZNIE z pełnego odczytu (§1.1) |
| `items[].revision`            | `upsertWeekSlot.data.expectedRevision` (przy zamianie: źródło) i `expectedTargetRevision` (cel zamiany) | stempel pozycji; odtworzona pozycja (usunięta i dodana ponownie) ma NOWY, wyższy stempel                                                                   |
| `items[].portions[].revision` | `setPortion.data.expectedRevision`                                                                      | stempel porcji JEDNEJ osoby                                                                                                                                |

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

### 1.1. Token tygodnia = kompletny snapshot

`plan.revision` opisuje DOKŁADNIE `items` z tej samej odpowiedzi. Serwer czyta tydzień w jednej migawce bazy, więc
rewizja i pozycje pochodzą ze spójnego stanu. Token tygodnia niosą wyłącznie pełne odczyty:

- `weeklyPlans:getByWeek`;
- `plan` w acku `applyWeekPlan`.

Obowiązki klienta:

- `applyWeekPlan.data.expectedRevision` = `plan.revision` tego samego pełnego odczytu, z którego pochodzi wysyłany
  stan tygodnia;
- przed pełnym apply klient MUSI mieć kompletny stan odpowiadający temu tokenowi — nic spoza tego odczytu;
- tokenu tygodnia nie wolno przepisywać na inną kopię tygodnia (starszą albo częściowo zaktualizowaną ackami).

Serwer NIE wykryje starej treści wysłanej z nowym, poprawnym tokenem. Przykład: A trzyma tydzień z rewizji 12,
domownik dodaje środę (13), A zmienia porcję (14). Gdyby A oznaczył swoją kopię tokenem 14, pełny apply usunąłby
środę. Dlatego acki pozycji tokenu tygodnia NIE niosą.

### 1.2. Acki pojedynczej pozycji

Ack `upsertWeekSlot` i `setPortion` to pozycja z nowymi tokenami pozycji i porcji (`revision`,
`portions[].revision`) — bez rewizji tygodnia:

- klient aktualizuje tę pozycję i jej tokeny w lokalnej kopii;
- token tygodnia kopii ZOSTAJE stary, więc pełny apply z tej kopii kończy się `PLAN_REVISION_CONFLICT`, dopóki
  klient nie zrobi pełnego odczytu (`getByWeek`). Konflikt jest zamierzony.

### 1.3. Odpowiedzi w odwrotnej kolejności

Stemple pochodzą z jednego rosnącego licznika — z dwóch wersji tej samej pozycji (albo porcji) nowsza ma WYŻSZY
stempel. Reguły:

- token z acka przyjmuj tylko wtedy, gdy jest wyższy od znanego dla tej pozycji/porcji — spóźniony, starszy ack
  nie cofa tokenu;
- z dwóch pełnych odczytów aktualny jest ten z wyższą `plan.revision`; starszy odrzuć w całości (nie mieszaj
  pozycji z dwóch odczytów).

### 1.4. Kiedy tokeny porcji przestają pasować

- Pełny zapis pozycji (`upsertWeekSlot`, `applyWeekPlan`), który ją zmienia, nadaje nowe stemple WSZYSTKIM jej
  porcjom. Dotyczy to także zmiany samego audytorium przy tych samych wartościach, np. jawna lista wszystkich → „Wspólne”.
- `setPortion` zmienia stempel wyłącznie porcji swojej osoby — tokeny innych osób zostają.
- Zapis bez różnicy (NOOP) nie zmienia żadnego tokenu. Lista wszystkich obecnych domowników jest zapisywana
  jako „Wspólne”, więc „Wspólne” → lista wszystkich to NOOP.
- Zmiana składu domu zmienia wszystkie tokeny tygodni od bieżącego.

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

- `servings`: 0,5–6, wielokrotność 0,5 (od 27.09.2026 — pół, jedna, półtorej…; stepper w iOS co 0,5); suma porcji pozycji ≤ 12 (liczona pod zamkiem z porcjami innych osób);
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
    "changeKind": "DETAILS_CHANGED"
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
- Σ ≤ 12, krok 0,5, 0,5–6 na osobę — inaczej `PLAN_PORTIONS_INVALID`.

## 4. Zamiana dania z alokacją

`upsertWeekSlot` z nowym `recipeId` i `replaceRecipeId` = stare danie. Tokeny idą PARAMI:

- `expectedRevision` = `items[].revision` pozycji ŹRÓDŁOWEJ;
- `expectedTargetRevision` = `items[].revision` pozycji CELU, czyli pozycji z nowym `recipeId`, która w odczycie
  klienta już leży w tym slocie. `null`, gdy takiej pozycji w slocie nie ma.

Zachowanie porcji = jawne `portions` nowego dania (np. te same wartości).

```json
{
  "householdId": "…",
  "weekStart": "2026-10-05",
  "data": {
    "dayOfWeek": "TUE",
    "mealType": "DINNER",
    "recipeId": "NOWE…",
    "replaceRecipeId": "7d4e…",
    "portions": [
      { "userId": "a1…", "servings": 0.8 },
      { "userId": "b2…", "servings": 1.25 }
    ],
    "expectedRevision": 11,
    "expectedTargetRevision": null
  }
}
```

- bez `portions` na źródle z alokacją → `PLAN_PORTIONS_CONFLICT` (bez niejawnego resetu);
- jeden token bez drugiego → `PLAN_REVISION_REQUIRED` 428, `details: ["missing:expectedTargetRevision"]` albo
  `["missing:expectedRevision"]`;
- bez obu tokenów (legacy) → zamiana jak dotąd, ale źródła z alokacją nie wolno zastąpić innymi porcjami
  (`PLAN_REVISION_REQUIRED`);
- `PLAN_REVISION_CONFLICT` (nic nie zmienione, źródło zostaje), gdy:
  - źródła nie ma albo ma inny stempel;
  - cel ma inny stempel, powstał po odczycie (przy `null`), zniknął albo został usunięty i odtworzony;
- `expectedTargetRevision` bez `replaceRecipeId` → `VALIDATION_ERROR`.

## 5. Pełny tydzień (`applyWeekPlan`)

`data.expectedRevision` = `plan.revision` z TEGO SAMEGO pełnego odczytu, z którego pochodzą `slots` (§1.1).
Nieaktualny token: `applied: false`,
`violations: [{ "index": -1, "code": "PLAN_REVISION_CONFLICT", "message": "…" }]` (bez `dayOfWeek`/`mealType`/
`recipeId`), `plan: null`, nic nie zapisane. Zgodny token pozwala zastąpić i usunąć pozycje z alokacją. Bez tokenu:
pozycje BEZ alokacji jak dotąd (usuwane, jeśli ich nie ma w stanie docelowym), pozycje Z alokacją — naruszenie
`PLAN_REVISION_REQUIRED`.

## 6. Konflikt → odświeżenie → ponowienie

| Kod (WS `code`, `status`)                                      | Znaczenie                                                                                          | Co robi klient                                                                                                                                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAN_REVISION_CONFLICT` 409                                   | ktoś zmienił pozycję/porcję/tydzień od Twojego odczytu (albo pozycji już nie ma)                   | `getByWeek`; pokaż bieżący stan; ponów intencję użytkownika na NOWYM tokenie tylko, jeśli nadal ma sens (np. porcja innej wartości niż teraz) — nigdy automatycznie ze starym tokenem |
| `PLAN_REVISION_REQUIRED` 428                                   | zapis zastąpiłby/usunąłby alokację bez tokenu; zamiana z tokenem tylko jednej strony (`missing:…`) | błąd klienta: dołóż token(y) z odczytu; w produkcji — `getByWeek` i ponów z tokenami                                                                                                  |
| `PLAN_PORTIONS_CONFLICT` 409, `details` `reason:NOT_ALLOCATED` | `setPortion` na pozycji bez alokacji                                                               | alokację zaczyna jawny `upsertWeekSlot` z pełnymi `portions`                                                                                                                          |
| `PLAN_PORTIONS_CONFLICT` 409, `reason:NOT_IN_AUDIENCE`         | osoby nie ma już w alokacji (zmiana uczestników)                                                   | `getByWeek`, pokaż nowe audytorium                                                                                                                                                    |
| `PLAN_PORTIONS_CONFLICT` 409 (bez `reason`)                    | zapis bez `portions` skasowałby alokację                                                           | wyślij pełne `portions`                                                                                                                                                               |
| `PLAN_ITEM_NOT_FOUND` 404                                      | pozycji nie ma w tym tygodniu tego domu (usunięta, zamieniona — albo cudza)                        | `getByWeek`                                                                                                                                                                           |
| `PLAN_PORTIONS_INVALID` 400                                    | krok/widełki/suma > 12                                                                             | komunikat z `message`; nie ponawiaj bez zmiany wartości                                                                                                                               |
| `VALIDATION_ERROR` 400                                         | zły kształt (np. brak `expectedRevision` w `setPortion`)                                           | błąd klienta                                                                                                                                                                          |

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
2. iOS dekoduje `revision` (tydzień, pozycja, porcja) i trzyma tokeny per pozycja/porcja:
   - z acka przyjmuje tylko wyższe (§1.3);
   - token tygodnia bierze wyłącznie z pełnego odczytu, razem z całym stanem tygodnia (§1.1);
   - po acku pozycji token tygodnia zostaje stary.
3. Stepper porcji jednej osoby → wyłącznie `weeklyPlans:setPortion` (nie pełny `upsertWeekSlot`).
4. Zmiana uczestników → pełne `portions` + `expectedRevision`. Zamiana dania → tokeny źródła i celu
   (`expectedTargetRevision`, `null` = celu nie ma) — sekcje 3–4.
5. Każdy kod z tabeli w sekcji 6 obsłużony; `PLAN_REVISION_CONFLICT` kończy się odświeżeniem, nie cichym
   ponowieniem ze starym tokenem.
6. Wykrywanie funkcji z sekcji 8 — bez `plan.revision` edycja zostaje zablokowana.
7. iOS skompilowany i sprawdzony na macOS (testy UI/jednostkowe przepływów z sekcji 1–7) — z Windows NIE jest
   to możliwe; do tego czasu edycja zostaje zablokowana. Backend sprawdza te przepływy wyłącznie jako MODEL
   klienta w testach e2e (R1, R1b) — to nie jest test aplikacji iOS.
