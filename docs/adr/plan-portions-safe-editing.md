# ADR: bezpieczna edycja porcji per osoba — rewizje i zmiana porcji jednej osoby

Status: zaakceptowane do implementacji (workstream `plan-portions-safe-editing`, 2026-09-27)
Zależy od: `docs/adr/plan-portions-write-safety.md` (PR #209, niezmergowany) — ta gałąź stoi na jego HEAD.

## Problem (zmierzone, `test/plan-portions-safe-editing.e2e-spec.ts`, regresje A–C na `2a4899b`)

- **A.** Dwa odczyty tej samej alokacji, dwa pełne zapisy `portions`. Oba przechodzą, drugi cofa zmianę
  pierwszego (Rafał 1,5 → 1,25). Jawne `portions` zastępują alokację bez żadnej kontroli wersji.
- **B.** Pełny stan `applyWeekPlan` ze starego odczytu. `applied: true` — usuwa pozycję dodaną po odczycie
  i cofa zmianę audytorium innej pozycji.
- **C.** Nie ma operacji zmiany porcji jednej osoby. Każda edycja to pełna alokacja, więc edycje RÓŻNYCH osób
  też się nadpisują.

## Mapa zapisujących (wszystkie biorą `lockWeekForWrite` / `lockWeeksForWriteFrom` jako pierwszą blokadę)

| Zapisujący | Co zmienia | Rewizja po tym ADR |
|---|---|---|
| `upsertWeekSlot` (+ `replaceRecipeId`) | tworzy/aktualizuje pozycję, usuwa źródło zamiany | +1 tydzień; pozycja i jej porcje = nowa rewizja |
| `applyWeekPlan` (WS, narzędzia AI, apply/undo propozycji) | tworzy/aktualizuje/usuwa pozycje | +1 tydzień (gdy jest zmiana); zmienione pozycje/porcje = nowa rewizja |
| `setPortion` (nowe) | porcja jednej osoby | +1 tydzień; pozycja i ta porcja = nowa rewizja |
| `removeWeekSlot`, `clearWeekPlan` | usuwa pozycje | +1 tydzień (gdy coś usunięto) |
| zmiana składu domu (`plan-roster.util`) | porcje/`plannedServings` pozycji tygodni od bieżącego | +1 każdy tydzień od poniedziałku; WSZYSTKIE pozycje i porcje tych tygodni = nowa rewizja tygodnia |
| `setMealEaten` | znaczniki zjedzenia | bez rewizji (nie zmienia treści planu) |

## Decyzja 1 — kontrola konfliktów: rewizja tygodnia + rewizje pozycji i porcji z jednego licznika

Rozważone:

| Wariant | Pełny stan (`applyWeekPlan`) | Nowa pozycja, której klient nie widział | Edycja jednej pozycji | Edycje różnych osób |
|---|---|---|---|---|
| wersja pozycji | nie wykrywa nowej/usuniętej pozycji | nie | tak | konflikt (za gruby) |
| wersja tygodnia | tak | tak | konflikt przy KAŻDEJ zmianie tygodnia (za gruba) | konflikt |
| odcisk treści (jak propozycje) | tak | tak | tak | — ale ABA: ponowienie po cudzym „cofnięciu” wraca ze starym zapisem |
| **licznik tygodnia + stemple** | **tak** | **tak** | **tak (stempel pozycji)** | **niezależne (stempel porcji)** |

Wybór: jeden monotoniczny licznik `WeeklyPlan.revision` (INT) podbijany o 1 w każdej transakcji, która zmienia
treść tygodnia. Pozycja i porcja dostają jako stempel wartość licznika z chwili swojej ostatniej zmiany
(`PlanItem.revision`, `PlanItemPortion.revision`). Stemple nigdy się nie powtarzają w obrębie tygodnia, więc:

- **usunięcie i ponowne utworzenie** tej samej pozycji (ten sam klucz slotu) daje nowy, wyższy stempel — stary
  token nie trafia w nową pozycję;
- **ponowienie** nie przejdzie po cudzej zmianie (brak ABA, w przeciwieństwie do odcisku treści);
- **zmiana składu domu** podbija tygodnie i stemple wszystkich ich pozycji i porcji (celowo zgrubnie: rzadkie
  zdarzenie, klient odświeża).

Sprawdzenie tokenu i zapis zachodzą w TEJ SAMEJ transakcji, po `lockWeekForWrite`, na stanie odczytanym pod
zamkiem (READ COMMITTED dla upsert/`setPortion`, SERIALIZABLE z ponowieniem dla `applyWeekPlan`).

Tokeny w odczycie:
- `weeklyPlans:getByWeek` → `plan.revision` (tydzień), `items[].revision`, `items[].portions[].revision`;
- ta sama postać w ackach `upsertWeekSlot`, `setPortion` i w `plan` z `applyWeekPlan`.

Odcisk treści zostaje tam, gdzie już jest (propozycje: `baselineHash`, `appliedHash`) — status propozycji robi
z nich operację jednorazową, więc ABA nie grozi.

## Decyzja 2 — `weeklyPlans:setPortion`

```
data: { planItemId: UUID, userId: UUID, servings: number (0,1–6, krok 0,05), expectedRevision: int ≥ 0 }
```

Semantyka, pod zamkiem tygodnia:
1. członkostwo wołającego (przed transakcją i pod zamkiem);
2. pozycja o `planItemId` w TYM tygodniu TEGO domu — inaczej `PLAN_ITEM_NOT_FOUND` (także cudzy dom: bez
   wyroczni istnienia);
3. pozycja bez alokacji → `PLAN_PORTIONS_CONFLICT`, `details: ['reason:NOT_ALLOCATED']` (alokacja zaczyna się
   jawnym zapisem pełnych `portions`);
4. osoby nie ma w alokacji (zmiana audytorium) → `PLAN_PORTIONS_CONFLICT`, `reason:NOT_IN_AUDIENCE`;
5. `expectedRevision` ≠ stempel porcji TEJ osoby:
   - bieżąca porcja == żądana → sukces bez zmiany (ponowienie po utraconej odpowiedzi);
   - inaczej → `PLAN_REVISION_CONFLICT` (409) z `details: ['planItemId:…', 'currentRevision:<stempel porcji>']`;
6. Σ porcji po zmianie ≤ 12 (porcje INNYCH osób odczytane pod zamkiem) → inaczej `PLAN_PORTIONS_INVALID`;
7. zapis: porcja tej osoby i `plannedServings = ceil(Σ)`; rewizja tygodnia +1, stemple pozycji i tej porcji;
   lista zakupów „stale”; broadcast `weeklyPlans:weekChanged` (akcja `UPSERT_SLOT` — iOS zna tylko te nazwy).

Porcje innych osób nie są zapisywane ani ich stemple ruszane, więc A zmienia Rafała, B zmienia Asię → obie
zmiany zostają. Nadpisanie TEJ SAMEJ osoby chroni stempel jej porcji (pkt 5). Współbieżne przekroczenie sumy
wyklucza zamek (drugi widzi porcję pierwszego).

Autoryzacja jak przy każdym zapisie planu: dowolny członek domu (nie tylko „właściciel” porcji).

## Decyzja 3 — tokeny na istniejących zapisach i polityka zapisu

`upsertWeekSlot.data.expectedRevision` (opcjonalne) = stempel pozycji, którą zapis zmienia. Przy
`replaceRecipeId` to stempel pozycji ŹRÓDŁOWEJ.
- Podany i zgodny → zapis zweryfikowany.
- Podany i niezgodny: gdy zapis nic by nie zmienił → sukces NOOP; inaczej `PLAN_REVISION_CONFLICT`.
- Podany, a pozycji brak (usunięta, odtworzona) → `PLAN_REVISION_CONFLICT`.

`applyWeekPlan.data.expectedRevision` (opcjonalne) = rewizja tygodnia.
- Zgodny → zapis zweryfikowany.
- Niezgodny → `applied: false`, `violations: [{ index: -1, code: 'PLAN_REVISION_CONFLICT' }]`, nic nie wchodzi.
  Ponowienie po utraconej odpowiedzi też dostaje konflikt: bezpieczne, klient odświeża.

Polityka porcji (rozszerza ADR `plan-portions-write-safety`; `portionsWriteDecision`):

| Zapis na pozycji Z alokacją | `strict` (bez tokenu: WS, narzędzia AI) | `verified` (token zgodny / guard propozycji) | `no-allocation-changes` (force) | `authoritative` (undo) |
|---|---|---|---|---|
| bez `portions`, bez zmiany | KEEP | KEEP | KEEP | WRITE |
| bez `portions`, ze zmianą | CONFLICT | CONFLICT | CONFLICT | WRITE |
| jawne `portions` = bieżące | WRITE (nic) | WRITE | WRITE | WRITE |
| jawne `portions` ≠ bieżące | **REVISION_REQUIRED** | WRITE | CONFLICT | WRITE |
| usunięcie (brak w stanie docelowym) | **REVISION_REQUIRED** | usunięcie | CONFLICT | usunięcie |

- Pozycje BEZ alokacji — bez zmian względem legacy we wszystkich politykach.
- `verified` i `authoritative` wolno wyłącznie z `guard` (in-process). Z drutu `verified` powstaje tylko przez
  zgodny `expectedRevision`. Polityki nie są polem DTO.
- Apply propozycji bez `force` → `verified`: `guard` porównuje odcisk tygodnia z porcjami pod zamkiem.
- Podgląd propozycji (`previewWeekPlan`, tylko in-process) liczy `verified`, bo tak zostanie zapisany.

Kody:
- `PLAN_REVISION_CONFLICT` 409 — nieaktualny token;
- `PLAN_REVISION_REQUIRED` 428 — zapis, który zastąpiłby albo usunął alokację, wymaga tokenu;
- `PLAN_PORTIONS_CONFLICT` 409 — niejawna utrata alokacji / `setPortion` na pozycji bez alokacji albo spoza
  audytorium.

W `applyWeekPlan` wszystkie wracają jako naruszenia (`applied:false`), bez 409. Każda odmowa: transakcja
wycofana w całości (także przejęcie propozycji), brak broadcastu, brak kwoty.

## Decyzja 4 — zmiana uczestników i zamiana dania

Serwer niczego nie przenosi ani nie przelicza (bez planera i AI). Klient, który zmienia audytorium albo danie
pozycji z alokacją, podaje JAWNIE pełne `portions` dla nowego audytorium/dania + token:
- osoby pozostające: klient przepisuje ich bieżące porcje (albo nowe);
- osoba dodana: klient podaje jej porcję — sugestia 1,00, jak reguła serwera przy dołączeniu do domu;
- osoba usunięta: znika z `portions`;
- Σ > 12 albo krok/widełki → `PLAN_PORTIONS_INVALID`.

Zamiana dania z alokacją:
- zachowanie = jawne `portions` nowego dania (np. te same wartości) + token źródła;
- bez `portions` → `PLAN_PORTIONS_CONFLICT` — odmowa, bez niejawnego resetu;
- jawnego „resetuj do równego podziału” nie wprowadzamy (OPEN DECISION).

## Decyzja 5 — ponowienia i idempotencja

Bez klucza operacji. Stemple z jednego monotonicznego licznika wystarczają:
- `setPortion` i `upsertWeekSlot`: ponowienie po sukcesie widzi niezgodny stempel. Gdy stan już jest żądanym →
  sukces; gdy ktoś zmienił go później → konflikt. Nigdy nie cofa nowszej zmiany.
- `applyWeekPlan` z tokenem: ponowienie = konflikt (bezpieczne, bez cofania).

Brak tabeli kluczy = brak retencji i trwałego stanu do sprzątania.

## Zgodność wstecz

| Klient | Zachowanie |
|---|---|
| starszy iOS | nie wysyła tokenu ani `portions`; pozycje bez alokacji — jak dotąd; pozycje z alokacją — KEEP/CONFLICT jak w ADR `write-safety` (bez zmian) |
| surowy WS `applyWeekPlan` bez tokenu | pozycje bez alokacji: kontrakt stanu docelowego bez zmian — usuwa pozycje spoza listy, TAKŻE takie, których klient nie widział (NIE chronimy starego stanu bez tokenu); pozycje z alokacją: usunięcie i jawna zmiana wymagają tokenu (`REVISION_REQUIRED`) |
| narzędzia AI (bez tokenu, `strict`) | nie usuną ani nie zastąpią alokacji (naruszenie dla modelu); propozycje idą przez `verified` / `force` / undo — bez nowych wymaganych pól w narzędziach |
| propozycje sprzed wdrożenia | odcisk treści bez zmian (rewizja nie wchodzi do odcisku) |

## Migracja

Addytywna, forward-only: `revision INT NOT NULL DEFAULT 0` na `WeeklyPlan`, `PlanItem`, `PlanItemPortion`.
Istniejące plany startują od 0 — token 0 jest ważny, pierwszy zapis daje 1. Bez backfillu.

Rollback:
- kodu — stare wersje ignorują kolumny;
- bazy — nową migracją korygującą (`DROP COLUMN`), nigdy ręczną edycją `_prisma_migrations`.

## Rollout, obserwowalność, wydajność, bezpieczeństwo

- **Rollout:** deploy backendu po #209. Stary iOS działa bez zmian. Nowy iOS odblokuje edycję po wdrożeniu
  (warunki w `docs/workstreams/plan-portions-safe-editing/ios-contract.md`).
- **Obserwowalność:** konflikty to zwykłe kody błędów WS (`PLAN_REVISION_CONFLICT` / `…_REQUIRED` /
  `PLAN_PORTIONS_CONFLICT`) — widoczne w dotychczasowym logowaniu odpowiedzi; bez nowych metryk (OPEN DECISION:
  licznik konfliktów w `/ops/metrics`).
- **Wydajność:** +1 `UPDATE WeeklyPlan` na zapisującą transakcję (wiersz jest już zablokowany przez zamek); zmiana
  składu domu +2 `UPDATE` na tygodnie od poniedziałku.
- **Bezpieczeństwo/prywatność:**
  - rewizje to liczniki bez danych;
  - `planItemId` szukany wyłącznie w tygodniu domu wołającego, po sprawdzeniu członkostwa — cudza pozycja =
    `PLAN_ITEM_NOT_FOUND`, jak nieistniejąca;
  - `details` niesie tylko id i rewizję pozycji własnego domu.

## Test matrix

`test/plan-portions-safe-editing.e2e-spec.ts` (PostgreSQL, prawdziwe serwisy, bariery bez zegarów, AI tylko
stub):
1. dwa pełne zapisy tej samej wersji (także równolegle);
2. dwie osoby;
3. ta sama osoba;
4. współbieżne przekroczenie sumy;
5. edycja vs zmiana uczestników;
6. edycja vs zamiana/usunięcie;
7. usunięcie i odtworzenie;
8. ponowienie (także po późniejszej zmianie);
9. nieaktualny pełny plan;
10. apply/force/undo;
11. zmiana składu domu;
12. legacy i odmowa bez tokenu;
13. autoryzacja i brak wycieku;
14. migracja (wiersz z `revision = 0`);
15. token w odczycie = token w odpowiedzi.

Plus poprzedni `plan-portions-write-safety.e2e`.

## Ograniczenia (świadome)

- `applyWeekPlan` BEZ tokenu nadal usuwa pozycje BEZ alokacji spoza stanu docelowego (kontrakt legacy).
- `removeWeekSlot` / `clearWeekPlan` bez tokenu — jawne usunięcie (OPEN DECISION: opcjonalny token).
- Zmiana składu domu unieważnia tokeny wszystkich pozycji tygodni od bieżącego (zgrubnie, bezpiecznie).
- `setMealEaten` nie podbija rewizji.
- Brak jawnego „resetu do równego podziału”.
