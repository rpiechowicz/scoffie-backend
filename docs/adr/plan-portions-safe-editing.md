# ADR: bezpieczna edycja porcji per osoba — rewizje i zmiana porcji jednej osoby

Status: zaakceptowane do implementacji (workstream `plan-portions-safe-editing`, 2026-09-27); poprawione po
review (2026-09-27): token tygodnia tylko z pełnej migawki, tokeny celu zamiany, stemple porcji przy zmianie
audytorium w `applyWeekPlan`.
Zależy od: `docs/adr/plan-portions-write-safety.md` (PR #209, niezmergowany) — ta gałąź stoi na jego HEAD.

## Problem (zmierzone, `test/plan-portions-safe-editing.e2e-spec.ts`, regresje A–C na `2a4899b`)

- **A.** Dwa odczyty tej samej alokacji, dwa pełne zapisy `portions`. Oba przechodzą, drugi cofa zmianę
  pierwszego (Rafał 1,5 → 1,25). Jawne `portions` zastępują alokację bez żadnej kontroli wersji.
- **B.** Pełny stan `applyWeekPlan` ze starego odczytu. `applied: true` — usuwa pozycję dodaną po odczycie
  i cofa zmianę audytorium innej pozycji.
- **C.** Nie ma operacji zmiany porcji jednej osoby. Każda edycja to pełna alokacja, więc edycje RÓŻNYCH osób
  też się nadpisują.

## Mapa zapisujących (wszystkie biorą `lockWeekForWrite` / `lockWeeksForWriteFrom` jako pierwszą blokadę)

| Zapisujący                                                | Co zmienia                                            | Rewizja po tym ADR                                                                                |
| --------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `upsertWeekSlot` (+ `replaceRecipeId`)                    | tworzy/aktualizuje pozycję, usuwa źródło zamiany      | +1 tydzień (gdy jest zmiana); pozycja i WSZYSTKIE jej porcje = nowa rewizja                       |
| `applyWeekPlan` (WS, narzędzia AI, apply/undo propozycji) | tworzy/aktualizuje/usuwa pozycje                      | +1 tydzień (gdy jest zmiana); zmienione pozycje i WSZYSTKIE ich porcje = nowa rewizja             |
| `setPortion` (nowe)                                       | porcja jednej osoby                                   | +1 tydzień; pozycja i ta porcja = nowa rewizja                                                    |
| `removeWeekSlot`, `clearWeekPlan`                         | usuwa pozycje                                         | +1 tydzień (gdy coś usunięto)                                                                     |
| zmiana składu domu (`plan-roster.util`)                   | porcje/`plannedServings` pozycji tygodni od bieżącego | +1 każdy tydzień od poniedziałku; WSZYSTKIE pozycje i porcje tych tygodni = nowa rewizja tygodnia |
| `setMealEaten`                                            | znaczniki zjedzenia                                   | bez rewizji (nie zmienia treści planu)                                                            |

## Decyzja 1 — kontrola konfliktów: rewizja tygodnia + rewizje pozycji i porcji z jednego licznika

Rozważone:

| Wariant                        | Pełny stan (`applyWeekPlan`)        | Nowa pozycja, której klient nie widział | Edycja jednej pozycji                            | Edycje różnych osób                                                 |
| ------------------------------ | ----------------------------------- | --------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| wersja pozycji                 | nie wykrywa nowej/usuniętej pozycji | nie                                     | tak                                              | konflikt (za gruby)                                                 |
| wersja tygodnia                | tak                                 | tak                                     | konflikt przy KAŻDEJ zmianie tygodnia (za gruba) | konflikt                                                            |
| odcisk treści (jak propozycje) | tak                                 | tak                                     | tak                                              | — ale ABA: ponowienie po cudzym „cofnięciu” wraca ze starym zapisem |
| **licznik tygodnia + stemple** | **tak**                             | **tak**                                 | **tak (stempel pozycji)**                        | **niezależne (stempel porcji)**                                     |

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

### Kontrakt tokenów (po review)

**Token tygodnia (`plan.revision`) jest związany z KOMPLETNYM snapshotem** — z dokładnie tym zestawem pozycji
i porcji, z którym przyszedł:

- niosą go wyłącznie pełne odczyty: `weeklyPlans:getByWeek` i `plan` w acku `applyWeekPlan`;
- odczyt tygodnia to jedna migawka bazy. Prisma czyta `include` OSOBNYMI zapytaniami (tydzień, pozycje, każda
  relacja — sprawdzone w logu Postgresa), więc `getByHouseholdAndWeek` biegnie w transakcji REPEATABLE READ:
  - wszystkie zapytania widzą stan z chwili pierwszego;
  - regresja R1c: zapis zatwierdzony w trakcie odczytu dawał wcześniej starą rewizję z nowymi pozycjami;
  - transakcja jest interaktywna, bo jednoelementowy `$transaction([...])` Prisma wysyła bez `BEGIN`.
- acki pojedynczej pozycji (`upsertWeekSlot`, `setPortion`) niosą TYLKO tokeny tej pozycji i jej porcji
  (`revision`, `portions[].revision`), NIE niosą rewizji tygodnia:
  - pierwotnie niosły `planRevision`, a `ios-contract.md` kazał nią nadpisywać token lokalnego tygodnia;
  - regresja R1: pełny apply ze starej kopii przechodził wtedy i usuwał pozycję domownika;
- ack pozycji jest spójny, bo pozycję czyta ta sama transakcja zapisu pod zamkiem tygodnia. Żaden zapis treści
  tygodnia nie wchodzi w trakcie.

**Obowiązek klienta** — serwer nie rozpozna starej treści, jeśli klient poda do niej nowy, poprawny token:

- `expectedRevision` w `applyWeekPlan` = `plan.revision` z tego samego pełnego odczytu, z którego pochodzi
  wysyłany stan;
- tokenu tygodnia nie wolno przepisywać na inną (starszą albo częściowo zaktualizowaną) kopię;
- po acku pozycji klient aktualizuje tę pozycję i jej tokeny, ale token tygodnia jego kopii zostaje stary. Pełny
  apply z tej kopii kończy się więc konfliktem, dopóki klient nie zrobi pełnego odczytu.

**Odpowiedzi w odwrotnej kolejności.** Stemple pochodzą z jednego monotonicznego licznika, więc z dwóch wersji tej
samej pozycji/porcji nowsza ma WYŻSZY stempel. Klient przyjmuje token z acka tylko wtedy, gdy jest wyższy od
znanego. Tak samo z dwóch pełnych odczytów aktualny jest ten z wyższą `plan.revision` — starszy odrzuca w całości
(regresja R1b).

### Unieważnianie tokenów porcji

- Pełny zapis pozycji (`upsertWeekSlot`, `applyWeekPlan`), który ją zmienia, przestemplowuje WSZYSTKIE jej
  porcje. Dotyczy to także zmiany samego audytorium przy identycznych wartościach: jawna lista wszystkich
  domowników → „Wspólne” (regresja R3, dotąd tylko `upsertWeekSlot`).
- `setPortion` przestemplowuje wyłącznie porcję swojej osoby — edycje różnych osób pozostają niezależne.
- Prawdziwy NOOP niczego nie zapisuje ani nie stempluje (R3b). „Wspólne” → lista wszystkich obecnych domowników
  jest nim z definicji, bo zapis normalizuje taką listę do „Wspólne” (`normalizeParticipants`,
  `resolveParticipants`). Stan w bazie się nie zmienia, a stare tokeny zostają ważne.
- Zmiana składu domu przestemplowuje wszystko od bieżącego tygodnia.

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

`upsertWeekSlot.data.expectedRevision` (opcjonalne) = stempel pozycji, którą zapis zmienia; przy
`replaceRecipeId` — stempel pozycji ŹRÓDŁOWEJ. Znaczenie pola bez zmian od pierwszej wersji.

- Podany i zgodny → zapis zweryfikowany.
- Podany i niezgodny: gdy zapis (bez zamiany) nic by nie zmienił → sukces NOOP; inaczej `PLAN_REVISION_CONFLICT`.
- Podany, a pozycji brak (usunięta, odtworzona) → `PLAN_REVISION_CONFLICT`.

**Zamiana dania chroni źródło I cel.** `upsertWeekSlot.data.expectedTargetRevision` (opcjonalne, wyłącznie przy
`replaceRecipeId`) = stempel pozycji CELU, czyli pozycji z przepisem `recipeId`, która już leży w slocie, albo
`null`, gdy według odczytu klienta takiej pozycji w slocie nie ma.

Sam token źródła nie chroni celu. Regresja R2: zamiana X→Y ze zgodnym tokenem X nadpisywała zmienionego po
odczycie Y i usuwała X.

- Tokeny zamiany idą parami: `expectedRevision` bez `expectedTargetRevision` albo odwrotnie → 428
  `PLAN_REVISION_REQUIRED`, `details: ['missing:expectedTargetRevision' | 'missing:expectedRevision']`.
- Bez obu tokenów → zamiana legacy, bez zmian (cel `strict`).
- `expectedTargetRevision` bez zamiany → `VALIDATION_ERROR`.
- Pod zamkiem tygodnia, PRZED usunięciem źródła: źródło musi istnieć ze stemplem `expectedRevision`. Cel musi
  mieć stempel `expectedTargetRevision` albo nie istnieć (gdy `null`). Wszystko inne → `PLAN_REVISION_CONFLICT`,
  nic nie zmienione: cel zmieniony, powstały po odczycie, usunięty, usunięty i odtworzony (nowy stempel).
- Zgodny token celu = cel `verified`, więc jawne porcje mogą zastąpić jego alokację.

`applyWeekPlan.data.expectedRevision` (opcjonalne) = rewizja tygodnia.

- Zgodny → zapis zweryfikowany.
- Niezgodny → `applied: false`, `violations: [{ index: -1, code: 'PLAN_REVISION_CONFLICT' }]`, nic nie wchodzi.
  Ponowienie po utraconej odpowiedzi też dostaje konflikt: bezpieczne, klient odświeża.

Polityka porcji (rozszerza ADR `plan-portions-write-safety`; `portionsWriteDecision`):

| Zapis na pozycji Z alokacją         | `strict` (bez tokenu: WS, narzędzia AI) | `verified` (token zgodny / guard propozycji) | `no-allocation-changes` (force) | `authoritative` (undo) |
| ----------------------------------- | --------------------------------------- | -------------------------------------------- | ------------------------------- | ---------------------- |
| bez `portions`, bez zmiany          | KEEP                                    | KEEP                                         | KEEP                            | WRITE                  |
| bez `portions`, ze zmianą           | CONFLICT                                | CONFLICT                                     | CONFLICT                        | WRITE                  |
| jawne `portions` = bieżące          | WRITE (nic)                             | WRITE                                        | WRITE                           | WRITE                  |
| jawne `portions` ≠ bieżące          | **REVISION_REQUIRED**                   | WRITE                                        | CONFLICT                        | WRITE                  |
| usunięcie (brak w stanie docelowym) | **REVISION_REQUIRED**                   | usunięcie                                    | CONFLICT                        | usunięcie              |

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

- zachowanie = jawne `portions` nowego dania (np. te same wartości) + tokeny źródła i celu (`null`, gdy celu
  nie ma w slocie);
- bez `portions` → `PLAN_PORTIONS_CONFLICT` — odmowa, bez niejawnego resetu;
- jawnego „resetuj do równego podziału” nie wprowadzamy (OPEN DECISION).

## Decyzja 5 — ponowienia i idempotencja

Bez klucza operacji. Stemple z jednego monotonicznego licznika wystarczają:

- `setPortion` i `upsertWeekSlot`: ponowienie po sukcesie widzi niezgodny stempel. Gdy stan już jest żądanym →
  sukces; gdy ktoś zmienił go później → konflikt. Nigdy nie cofa nowszej zmiany.
- `applyWeekPlan` z tokenem: ponowienie = konflikt (bezpieczne, bez cofania).

Brak tabeli kluczy = brak retencji i trwałego stanu do sprzątania.

## Zgodność wstecz

| Klient                               | Zachowanie                                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| starszy iOS                          | nie wysyła tokenu ani `portions`; pozycje bez alokacji — jak dotąd; pozycje z alokacją — KEEP/CONFLICT jak w ADR `write-safety` (bez zmian)                                                                                                                |
| surowy WS `applyWeekPlan` bez tokenu | pozycje bez alokacji: kontrakt stanu docelowego bez zmian — usuwa pozycje spoza listy, TAKŻE takie, których klient nie widział (NIE chronimy starego stanu bez tokenu); pozycje z alokacją: usunięcie i jawna zmiana wymagają tokenu (`REVISION_REQUIRED`) |
| narzędzia AI (bez tokenu, `strict`)  | nie usuną ani nie zastąpią alokacji (naruszenie dla modelu); propozycje idą przez `verified` / `force` / undo — bez nowych wymaganych pól w narzędziach                                                                                                    |
| propozycje sprzed wdrożenia          | odcisk treści bez zmian (rewizja nie wchodzi do odcisku)                                                                                                                                                                                                   |
| zamiana bez tokenów (starszy iOS)    | bez zmian — `expectedTargetRevision` jest nowe i opcjonalne; wymagane dopiero razem z `expectedRevision` przy `replaceRecipeId`                                                                                                                            |
| `planRevision` w ackach              | usunięte przed wydaniem (PR niezmergowany) — żaden klient go nie czytał                                                                                                                                                                                    |

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

Review (describe „review patch — regresje”):

- R1 — ack pozycji nie odświeża tokenu starego snapshotu;
- R1b — odpowiedzi w odwrotnej kolejności;
- R1c — spójna migawka odczytu;
- R2/R2b — cel zamiany: zmieniony, z alokacją, powstały po odczycie, odtworzony, nieistniejący, legacy;
- R3 (apply/upsert) — zmiana audytorium unieważnia tokeny porcji;
- R3b — NOOP po normalizacji i niezależność `setPortion`.

Plus poprzedni `plan-portions-write-safety.e2e`.

## Ograniczenia (świadome)

- `applyWeekPlan` BEZ tokenu nadal usuwa pozycje BEZ alokacji spoza stanu docelowego (kontrakt legacy).
- `removeWeekSlot` / `clearWeekPlan` bez tokenu — jawne usunięcie (OPEN DECISION: opcjonalny token).
- Zmiana składu domu unieważnia tokeny wszystkich pozycji tygodni od bieżącego (zgrubnie, bezpiecznie).
- `setMealEaten` nie podbija rewizji.
- Brak jawnego „resetu do równego podziału”.

## Uzupełnienia z implementacji

- `lockWeekForWrite` oddaje rewizję tygodnia odczytaną pod zamkiem; podbicie (`bumpWeekRevision`) zachodzi raz na
  transakcję, przy pierwszym faktycznym zapisie — odmowa i zapis bez różnicy nie zmieniają rewizji.
- `upsertWeekSlot`, który niczego by nie zmienił, nie zapisuje pozycji (wcześniej przepisywał ją identycznie) —
  inaczej przestemplowałby porcje i unieważnił cudze tokeny bez zmiany treści.
- Acki `upsertWeekSlot` i `setPortion` NIE niosą rewizji tygodnia (patrz „Kontrakt tokenów”; `planRevision`
  z pierwszej wersji usunięte po review).
- Naruszenie całego tygodnia (`PLAN_REVISION_CONFLICT`, `index: -1`) nie ma `dayOfWeek`/`mealType`/`recipeId` —
  te pola `PlanViolation` są opcjonalne.
- Cel zamiany dania jest `verified` tylko ze zgodnym `expectedTargetRevision`; zamiana legacy (bez tokenów)
  ocenia go jako `strict`.
