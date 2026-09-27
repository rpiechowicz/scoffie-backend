# ADR: zapis pozycji planu nie kasuje niejawnie porcji per osoba

Status: zaakceptowane do implementacji (workstream `plan-portions-write-safety`, 2026-09-27)
Kontekst: `docs/workstreams/catalog-sync-per-user-portions/report.md` (iOS, addendum 2), raport 02.2 (porcje per osoba).

## Problem

`PlanItemPortion` (porcja osoby w jednostkach 1/20) jest źródłem prawdy dla pozycji z alokacją. Każdy zapis, który
przepisuje pozycję, zastępuje jednak CAŁĄ alokację:

- `upsertWeekSlot` robi `portions: { deleteMany: {}, create: toPortionRows(portions) }`, więc brak pola albo `[]`
  kasuje alokację;
- `replaceRecipeId` usuwa pozycję źródłową razem z porcjami;
- `applyWeekPlan` przy slocie bez `portions` uznaje to za zmianę (`!samePortions`) i kasuje.

Klient, który alokacji nie zna — starszy iOS, zapis ze stanu sprzed odświeżenia, narzędzie AI bez pola porcji —
usuwa ją zwykłym zapisem. Reproducer: `test/plan-portions-write-safety.e2e-spec.ts` (1, 1b) — FAIL na `31044a4`.

## Niezmiennik

> Klient, który nie przekazuje jawnej i odpowiednio chronionej intencji zmiany alokacji, nie może przez zwykły
> zapis pozycji usunąć ani zastąpić istniejących porcji per osoba.

## Mapa ścieżek zapisu

| Ścieżka | Co robi z alokacją dziś | Rodzaj |
|---|---|---|
| `upsertWeekSlot` na istniejącej pozycji, bez `portions` / `[]` | kasuje | **niejawne nadpisanie** |
| `upsertWeekSlot` z `portions` | zastępuje | jawne (bez CAS) |
| `upsertWeekSlot` + `replaceRecipeId`: źródło z alokacją | usuwa pozycję z porcjami | **niejawne**, gdy bez `portions` |
| `upsertWeekSlot` + `replaceRecipeId`: cel już w slocie, z alokacją | jak zwykły upsert celu | **niejawne**, gdy bez `portions` |
| `applyWeekPlan`: slot na istniejącej pozycji bez `portions` | kasuje | **niejawne nadpisanie** |
| `applyWeekPlan`: slot z `portions` | zastępuje | jawne (bez CAS) |
| `applyWeekPlan`: pozycji brak w stanie docelowym | usuwa pozycję | jawne usunięcie (kontrakt stanu docelowego) |
| apply propozycji (bez `force`) | przez `applyWeekPlan`; `guard` pod zamkiem porównuje odcisk tygodnia (z porcjami) | chronione odciskiem |
| apply propozycji z `force` | przez `applyWeekPlan`; odcisk POMIJANY — sloty propozycji mogą być starsze niż stan | **stan sprzed** |
| undo propozycji | przez `applyWeekPlan`; `guard` pod zamkiem wymaga odcisku = stan po zapisie | chronione odciskiem |
| narzędzia AI (`apply_week_plan`, `propose_*`; `toSlots`) | sloty bez pola `portions` | **niejawne nadpisanie** (przez apply) |
| `removeWeekSlot`, `clearWeekPlan` | usuwają pozycje | jawne usunięcie |
| `setMealEaten` | nie dotyka | — |
| zmiana składu domu (`plan-roster.util`) | dopisuje 1,00 / zdejmuje porcję odchodzącego | świadoma semantyka serwera |

## Decyzja — semantyka

Jedna funkcja decyzji (`portionsWriteDecision`, `plan-portions.util.ts`) dla istniejącej pozycji i zapisu, który
w nią trafia. Liczona **w transakcji zapisu, po `lockWeekForWrite`**, na pozycji odczytanej pod zamkiem:

| Stan pozycji | Zapis | Wynik |
|---|---|---|
| bez alokacji | cokolwiek | **WRITE** — zachowanie legacy bez zmian |
| z alokacją | `portions` pominięte albo `[]`, to samo audytorium i `plannedServings` pominięte albo równe | **KEEP** — pozycja nietknięta (nic nie jest zapisywane) |
| z alokacją | `portions` pominięte albo `[]`, inne audytorium albo inna liczba porcji | **CONFLICT** |
| z alokacją | `portions` podane | **WRITE** — jawna intencja (bez ochrony przed utraconą zmianą, patrz niżej) |
| z alokacją | `portions` podane, zapis propozycji z `force` | **WRITE** tylko, gdy alokacja się nie zmienia; inaczej **CONFLICT** |

Uzasadnienia:

- **`[]` = pominięte.** Brak jawnej, chronionej operacji „wyczyść alokację”. Żaden obecny klient nie wysyła `[]`
  jako decyzji — pole jest nowe, starszy iOS go nie zna. Kto chce pozbyć się alokacji, usuwa danie (jawnie).
- **KEEP zamiast odmowy przy identycznym ponownym zapisie.** Zapis, który niczego w pozycji nie zmienia, zostawia
  ją nietkniętą. To nie jest „przenieś porcje” — nic nie jest przenoszone ani przeliczane. Dzięki temu narzędzia AI
  i propozycje, które pozycję z alokacją tylko wymieniają (bez pola porcji), jej nie kasują.
- **CONFLICT przy zmianie bez porcji.** Nie przenosimy alokacji na nowe audytorium i nie przeliczamy jej na nową
  liczbę porcji — taka operacja nie ma kontraktu. Odmowa jest jawna.
- **`replaceRecipeId`:**
  - źródło z alokacją i zapis bez `portions` → **CONFLICT** (zamiana usunęłaby porcje niejawnie);
  - z `portions` → WRITE (jawna alokacja nowego dania);
  - cel już w slocie → decyzja jak wyżej, na celu.

  Odmowa zapada PRZED usunięciem źródła, a transakcja cofa wszystko.
- **`applyWeekPlan` (pełny i częściowy stan docelowy):**
  - decyzja dla każdego slotu na istniejącej pozycji;
  - jeden CONFLICT = cały zapis odrzucony (brak częściowego zapisu);
  - KEEP = pozycja pominięta (nie liczy się jako zmiana);
  - pozycje spoza stanu docelowego są usuwane jak dziś (jawne usunięcie w kontrakcie stanu docelowego) —
    w polityce `strict`; przy `no-allocation-changes` usunięcie pozycji z alokacją = CONFLICT (patrz niżej).
- **Polityka zapisu — parametr wewnętrzny `ApplyWeekPlanHooks.portionsPolicy`, nie pole WS:**
  - `strict` (domyślnie): WS, narzędzia AI, apply propozycji bez `force`. Bez `force` `guard` sprawdził pod zamkiem,
    że tydzień = stan, na którym propozycja powstała, więc jej jawne porcje liczono na bieżącej alokacji.
  - `no-allocation-changes`: apply propozycji z `force`. Odcisk jest pominięty, więc stan docelowy propozycji
    może być starszy niż tydzień — nie wolno zmienić istniejącej alokacji: ani aktualizacją pozycji (brak pola,
    stare porcje), ani USUNIĘCIEM pozycji z alokacją spoza stanu docelowego (także zamiana dania wyrażona jako
    usunięcie starego klucza i nowy klucz). Naruszenie usunięcia ma `index: -1`.
  - `authoritative`: undo. `guard` w tej samej transakcji wymaga, by tydzień (z porcjami) był dokładnie stanem po
    zapisie, więc migawka „przed” jest intencją chronioną odciskiem — także przywrócenie „bez alokacji”.
    `applyWeekPlan` odrzuca `authoritative` bez `guard` na wejściu, przed jakąkolwiek operacją na bazie.

**Granica zaufania polityk.** `ApplyWeekPlanHooks` to parametr WYŁĄCZNIE in-process: gateway
`weeklyPlans:applyWeekPlan` przekazuje samo `payload.data`, a DTO nie ma pola polityki (walidacja wycina nieznane
pola). Serwis nie umie sprawdzić, CO robi `guard` — wymusza tylko jego obecność. Zaufanie opiera się na tym, że
jedyne produkcyjne miejsce z `authoritative` to `AgentProposalsService.undo`, którego `guard` porównuje
`appliedHash` z odciskiem tygodnia odczytanego pod zamkiem (`git grep portionsPolicy`: apply propozycji —
`strict` / `no-allocation-changes`, undo — `authoritative`). Nowe użycie `authoritative` wymaga takiego samego
guarda i przeglądu.

### Kod i koperty

| Ścieżka | Odmowa |
|---|---|
| `weeklyPlans:upsertWeekSlot` (WS) | `AppException('PLAN_PORTIONS_CONFLICT', …, 409, ['planItemId:<id>'])` → koperta `{ ok:false, code, status:409, details }`; brak broadcastu (gateway rozgłasza po sukcesie) |
| `weeklyPlans:applyWeekPlan` (WS) i wywołania w procesie | `{ applied:false, dryRun, violations:[{ index, dayOfWeek, mealType, recipeId, code:'PLAN_PORTIONS_CONFLICT', message }], changes:0, plan:null }` — kontrakt domenowy bez 409; gateway nie rozgłasza przy `applied:false` |
| apply propozycji | tx wycofana (także przejęcie statusu w `guard`) → status `STALE`, `409 AI_PROPOSAL_STALE`, `details: ['reason:VIOLATIONS','PLAN_PORTIONS_CONFLICT']`; bez kwoty, wiadomości i broadcastu |
| undo propozycji | polityka `authoritative`; przy zmianie po zapisie — istniejąca odmowa odcisku `reason:CHANGED_AFTER_APPLY`, status zostaje `APPLIED` |
| narzędzia AI | wynik `applyWeekPlan` z `violations` → model dostaje naruszenie, jak przy alergenie |

Odmowa w `applyWeekPlan` zapada w transakcji (po `guard`), więc rzucamy wewnętrzny wyjątek wycofujący całą
transakcję i dopiero poza nią zamieniamy go na `applied:false`. Nic z `guard`/`settle` (przejęcie propozycji,
kwota, wiadomość) nie zostaje zatwierdzone.

`dryRun` i `previewWeekPlan` liczą tę samą decyzję (`portionsDecisions`) na odczycie bez zamka — doradczo, żeby
model i karta wiedziały wcześniej: konflikty jako naruszenia, pozycja KEEP nie liczy się jako zmiana, a slot
podglądu pokazuje jej ZACHOWANĄ alokację (stan efektywny, zgodny z zapisem i bilansem). Akcja propozycji porcji
nie dostaje — wiążąca jest kontrola w transakcji zapisu, na stanie pod zamkiem.

## Współbieżność

Każdy zapis `PlanItem` / `PlanItemPortion` bierze `lockWeekForWrite` jako pierwszą blokadę transakcji
(`upsertWeekSlot`, `applyWeekPlan`, `removeWeekSlot`, `clearWeekPlan`, zmiana składu domu przez
`lockWeeksForWriteFrom`). Decyzja zapada PO zamku, na pozycji odczytanej w tej samej transakcji:

- `upsertWeekSlot` (READ COMMITTED): po odczekaniu na zamek zapytania widzą stan zatwierdzony przez poprzedniego
  posiadacza — reproducer 1 sprawdza właśnie ten przeplot;
- `applyWeekPlan` (SERIALIZABLE): gdy migawka jest starsza niż cudze zatwierdzenie, `UPDATE` zamka kończy się
  błędem serializacji, `runSerializable` ponawia próbę, a decyzja liczy się od nowa.

Kontrola przed transakcją nie jest wiążąca.

## Czego ten patch NIE rozwiązuje

- **Utraconej zmiany między świadomymi klientami.** Pełna alokacja podana jawnie (`portions`) nadal zastępuje
  bieżącą bez wersji: A i B zmieniające porcje różnych osób ze starych kopii — wygrywa ostatni. Ochrona wymaga
  CAS/wersji pozycji (`expectedVersion`) albo atomowej zmiany porcji jednej osoby (`setPortion`). Tu NIE ma
  bezpiecznej edycji jednej osoby i patch jej nie deklaruje.
- **Starego stanu docelowego w `applyWeekPlan` z WS.** Pełny stan tygodnia wysłany ze starej kopii usuwa pozycje,
  których klient nie znał — to ogólna własność kontraktu stanu docelowego (dotyczy każdego dania, nie tylko
  porcji); propozycje mają na to odcisk, surowy WS nie.
- Wersjonowania nie wprowadzamy: do tego niezmiennika (klient BEZ intencji co do alokacji) wystarcza stan pozycji
  odczytany pod zamkiem — obecność alokacji i brak jawnej intencji rozstrzygają decyzję bez wersji.
