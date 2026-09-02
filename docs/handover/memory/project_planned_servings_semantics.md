---
name: project-planned-servings-semantics
description: 'PlanItem.plannedServings to łączna liczba porcji dania, nie na osobę; brak wartości znaczy „policz z audytorium", nigdy „jedna porcja".'
metadata:
  node_type: memory
  type: project
  originSessionId: b2c1c8be-870b-42da-a493-b2dd70f946b0
  modified: 2026-08-28T08:11:47.008Z
---

Wprowadzone 2026-08-23 na branchu `feat/recipe-servings` (oba repa).

- `Recipe.servings` — na ile porcji NAPISANY jest przepis. Od 28.08.2026 importer
  przyjmuje 1..8 (wcześniej wymuszał 2, przez co partie na 4 osoby pokazywały
  950–1290 kcal „na porcję”); siedem przepisów ma 4 (pierogi ×2, zapiekanka
  makaronowa, kotlety mielone, gulasz wieprzowy, fasolka po bretońsku, gołąbki),
  reszta 2 — rosół i schabowy świadomie zostały na 2 (decyzja Rafała). Makra
  i gramatury w bazie opisują CAŁY przepis, czyli wszystkie `servings`.
- `PlanItem.plannedServings` — ile porcji faktycznie gotujemy w slocie. **Liczba łączna,
  nie na osobę.**
- Lista zakupów skaluje składniki przez `plannedServings / recipe.servings`.
- Udział jednej osoby: `plannedServings / liczba jedzących`, gdzie jedzący to
  `participantIds.count`, a przy pustej liście („Wspólne") — liczba domowników.

**Dlaczego to ważne:** przy regule auto (wspólne → liczba domowników, solo → 1) udział na
osobę wychodzi dokładnie `1.0`, więc licznik kalorii pokazuje to samo co przed zmianą.
Rusza się wyłącznie lista zakupów. Jeśli licznik kalorii nagle się połowi, to znaczy, że
gdzieś wpadła jedynka tam, gdzie miało być „nie wiem".

**Jak stosować:** brak wartości = „policz z audytorium". To dotyczy i wire'u (pominięte
`plannedServings` w `UpsertWeekSlotDto`), i klienta (`PlanMeal.plannedServings` jest
`Int?`, bez `?? 1` w mapowaniu). Nigdy nie podstawiaj tam jedynki — w domu dwuosobowym
połowi zakupy i kalorie, a wygląda jak świadomy wybór użytkownika. Gałąź UPDATE w
`upsertWeekSlot` przelicza porcje tylko wtedy, gdy zapisana wartość równała się regule
auto ze STAREGO audytorium; inaczej zostawia ręczny wybór.

Od plastra B (28.08.2026) klamra 1..12 i reguła auto żyją w jednym miejscu:
`src/weekly-plans/utils/planned-servings.util.ts` (`clampPlannedServings`, `autoPlannedServings`),
używanym przez serwis planu i hooki składu domu (`plan-roster.util.ts`: odejście domownika
kasuje jego posiłki solo od bieżącego poniedziałku, zdejmuje duchy ze współdzielonych i przelicza
auto-porcje „Wspólnych” N→N-1; dołączenie N→N+1; przeszłe tygodnie nietknięte). Ta sama
znana granica: ręczna wartość równa auto ze STAREGO składu przelicza się razem z auto —
docelowo kolumna `servingsMode AUTO|MANUAL`. Podmiana dania (`replaceRecipeId`) przenosi
porcje jak edycja: ręczne zostają, auto liczy się z nowego audytorium.

Migracja `20260823100000_plan_item_planned_servings` robi backfill u siebie, wbrew
konwencji „backfill do skryptu" — bo waga pozycji na liście zakupów zmienia się w tym
samym wdrożeniu, więc okno bez backfillu oznaczałoby połowę zakupów dla każdego
istniejącego tygodnia.

Powiązane: [[project-recipe-macro-convention]], [[project-meal-slots-architecture]],
[[project-docker-no-auto-migrate]].
