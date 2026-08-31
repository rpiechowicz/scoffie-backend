# Implementation spec — WP-04 (ghost participants) + WP-07 (auto servings not re-derived)

**Scope:** one new pure util `src/weekly-plans/utils/plan-roster.util.ts`, one new helper in `week-formatting.util.ts`, 5 call sites in 2 services, 1 new spec file, 1 optional gateway broadcast, 1 one-off SQL script. **No Prisma schema change, no migration.**

---

## 0. Facts verified in the current source (post–Plaster A)

| Fact | Evidence |
|---|---|
| `parseWeekStart` is already strict: `/^\d{4}-\d{2}-\d{2}$/` + `getUTCDay() === 1` + UTC midnight | `src/weekly-plans/utils/week-formatting.util.ts:13-28` |
| No "current Monday" helper exists anywhere in the backend | `grep -rn "getUTCDay\|startOfWeek\|setUTCDate" src/` → only `week-formatting.util.ts:24` and `notifications/notification-copy.util.ts:132-134` |
| `WeeklyPlansModule` exports nothing → `HouseholdsModule` cannot inject `WeeklyPlansService`/`ShoppingListService` | `src/weekly-plans/weekly-plans.module.ts:7-10` (`providers` only, no `exports`) |
| `markShoppingListStale` is an **instance method**, not static; body uses only `tx`, no `this` | `src/weekly-plans/services/shopping-list.service.ts:408-431` |
| A missing `ShoppingList` row is **not** an error on read — `getShoppingListSnapshot` falls through to `rebuildShoppingListSnapshotWithClient` | `shopping-list.service.ts:438-484` (`if (snapshot) {…}` then `480: return this.rebuild…`) |
| `PlanItemParticipant` / `PlanItemConsumption` cascade on `PlanItem` and `User` only — `Membership` is unrelated | `prisma/schema.prisma:391-392`, `:409-410`, `:284-295` |
| `PlanItemParticipant` PK is `@@id([planItemId, userId])` → a user appears at most once per item | `schema.prisma:394` |
| `ShoppingList.updatedAt` is `@updatedAt` → `updateMany` bumps it automatically | `schema.prisma:485` |
| jest maps **any** import ending in `households.service` to the stub → hook tests cannot live in `households.service.spec.ts` | `jest.config.js:22-25` |
| Both gateways use the same `WS_GATEWAY_OPTIONS`, no namespace → `this.server` is the **same** Socket.IO server | `households.gateway.ts:99`, `weekly-plans.gateway.ts:136` |
| iOS ignores an unknown `weekChanged.action`: `singleChangeText` `default: return nil` → no local notification, but `scheduleWeekReload` already ran | `PlanChangeNotificationService.swift:361-378`, `WeeklyMealStore.swift:527-544` |
| iOS `households:membersChanged` handler updates the member list **only** — it never refetches the week or the list | `SessionStore.swift:577-631` |
| Prisma 6.2 — relation filters (`some`/`none`, to-one) are supported inside `updateMany`/`deleteMany` `where` | `package.json` → `"@prisma/client": "^6.2.1"` |
| The container has devDeps (jest/ts-jest/tsc) and `/app/src`, `/app/tsconfig.json`, but **not** `jest.config.js` | `Dockerfile:32-43` (`COPY --from=deps /app/node_modules`), `container_name: weeklymeals-api` |

**New finding not in the audit:** `UsersService.deleteAccount` is a **4th membership-removal path** (`src/users/users.service.ts:417-439`). `tx.user.delete` at `:438` cascades the ghost rows away, so WP-04 does not bite there — but the items whose participant set becomes empty are **silently promoted to "Wspólne"**, and auto servings are **not** re-derived (WP-07 in full). It must call the same hook.

---

## 1. Design decisions (with justification)

### D1 — Where the code lives: `src/weekly-plans/utils/plan-roster.util.ts`, pure functions taking `tx`

Same shape as `settleHouseholdAfterMemberLeft` (`src/households/household-cleanup.util.ts:34-37`): `export async function f(tx: PrismaLike, …)`. Rationale:
- `HouseholdsModule` (`households.module.ts:6-11`) would otherwise need `WeeklyPlansModule` to `exports: [WeeklyPlansService]`, and `WeeklyPlansService` would need `HouseholdsService` for member counts → module cycle.
- The work **must** run inside the caller's existing `$transaction` (`households.service.ts:188`, `:588`, `:614`; `users.service.ts:417`). A DI'd service would still have to accept `tx`, so DI buys nothing.
- Import direction `households → weekly-plans/utils` already exists conceptually (`weekly-plans/utils/auth-checks.util.ts` reads `Membership`); there is no import cycle: `plan-roster.util` imports only `@prisma/client` and `./week-formatting.util`.

### D2 — Stale marking: `tx.shoppingList.updateMany`, **not** `ShoppingListService.markShoppingListStale`

`markShoppingListStale` (`shopping-list.service.ts:408-431`) is an instance method → unusable without DI. Do **not** duplicate its `upsert`: an upsert would *create* `ShoppingList` rows for weeks that never had a list, and a missing row already means "rebuild from scratch" on read (`shopping-list.service.ts:480-484`). One statement covers all touched weeks:

```ts
await tx.shoppingList.updateMany({
  where: { householdId, weekStart: { gte: monday } },
  data: { isStale: true },
});
```

### D3 — Item whose participant set becomes empty → **DELETE** (do not promote to "Wspólne")

Recommended, for weeks `>= current Monday` only.

- The row exists *because* that person eats it. Promoting it to `[]` makes it a household-wide meal nobody chose: it shows on every member's dashboard (`SavedMealPlan.swift:194-197` `visibleTo` falls back to `filter(\.isShared)`), it counts against everyone's kcal (`nutritionPerPerson`), and `PlanAudienceChips.collapsed` (`PlanAudienceChips.swift:47-51`) would then treat it as a deliberate "Wspólne".
- **Nothing user-visible is lost:** an item whose only participant is the ghost is *already* invisible to every remaining member (`visibleTo` returns `own = []` → falls back to shared → this item is not shared → not rendered). Deleting it removes a row nobody can see but which `buildShoppingListBase` still buys food for (participants are ignored by the shopping list).
- Deleting also unblocks WP-04's user-facing symptom: `WeeklyPlanView.swift:467` re-sends `participantIds` → `weekly-plans.service.ts:664-671` throws `PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD`.
- **Multi-participant items are kept**, minus the ghost row — "Ania + Marek's lunch" is still Ania's lunch.

### D4 — Past weeks (`weekStart < current Monday`): do nothing

Past weeks are a record of what happened; `PlanItemConsumption` rows for a departed member are *accurate*. They never feed the current shopping list or the servings math, and the read path renders them harmlessly. Deleting them would rewrite history.

### D5 — Servings heuristic: mirror `resolveUpdatedPlannedServings`, with the same documented blind spot

`weekly-plans.service.ts:766-774` decides "was this value auto?" by comparing the stored value to the auto rule (`resolvePlannedServings`, `:686-706` → `min(12, max(1, participants.length || memberCount))`). The hook reuses exactly that: a shared item (`participants: none`) whose `plannedServings === clamp(oldMemberCount)` was auto → set to `clamp(newMemberCount)`.

**Limitation (must be in the doc comment):** a *manual* value that happens to equal the old member count is indistinguishable from an auto value and will be re-derived. This is the same limitation the service already accepts and documents at `weekly-plans.service.ts:727-730`. The real fix is a `servingsMode AUTO|MANUAL` column (WP-07 "LATER", 4 h + iOS) — out of scope here.

### D6 — Counts are derived inside the hook, not passed by the caller

Every call site deletes **exactly one** membership per household before calling, so `oldMemberCount = newMemberCount + 1` is exact. `onRosterChanged` stays exported with explicit counts because `acceptInvitation`'s *join* branch uses `upsert` (`households.service.ts:200-213`) and cannot know whether a row was created.

### D7 — Skip everything when the household was deleted

`settleHouseholdAfterMemberLeft` (`household-cleanup.util.ts:44-47`) deletes the household when nobody is left; `Household → WeeklyPlan → PlanItem` cascades (`schema.prisma:343`, `:370`) remove everything. Calling the hook after a `DELETED` settlement is wasted work (and `tx.weeklyPlan.findMany` on a deleted household returns `[]` anyway). Gate on `settlement.outcome !== 'DELETED'`.

---

## 2. Change 1 — `currentWeekStart` in `week-formatting.util.ts`

**File:** `src/weekly-plans/utils/week-formatting.util.ts`
**Current tail (lines 30-33):**

```ts
30: /// Renders a Date as `yyyy-mm-dd` using the ISO timezone slice.
31: export function formatWeekStart(value: Date): string {
32:   return value.toISOString().slice(0, 10);
33: }
```

**Insert after line 33:**

```ts
/// Poniedziałek tygodnia, w którym `now` wypada — liczony w UTC, w tej samej
/// reprezentacji co `parseWeekStart` (północ UTC), więc wynik da się wprost
/// porównać z `WeeklyPlan.weekStart`.
///
/// UTC, a nie strefa telefonu, bo serwer żadnej innej nie zna. Klucz tygodnia
/// jest datą KALENDARZOWĄ telefonu, więc w oknie 00:00–01:00 czasu polskiego
/// w poniedziałek (= niedziela 22:00–23:00 UTC) serwer wskaże jeszcze
/// poprzedni poniedziałek. To jest bezpieczny kierunek pomyłki: filtr
/// „>= poniedziałek" obejmuje wtedy tydzień SZERSZY, nigdy węższy — sprzątamy
/// o jeden tydzień za dużo, nie za mało.
export function currentWeekStart(now: Date = new Date()): Date {
  const isoOffset = now.getUTCDay() === 0 ? 6 : now.getUTCDay() - 1;
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  monday.setUTCDate(monday.getUTCDate() - isoOffset);
  return monday;
}
```

---

## 3. Change 2 — new file `src/weekly-plans/utils/plan-roster.util.ts`

Full content (paste as-is; comments in Polish to match repo style):

```ts
import { Prisma } from '@prisma/client';
import { currentWeekStart, formatWeekStart } from './week-formatting.util';

/// Klient Prismy albo transakcja — jak w `household-cleanup.util.ts`.
/// Porządkowanie planu MUSI iść w tej samej transakcji co usunięcie
/// członkostwa, które je wywołało.
export type PrismaLike = Prisma.TransactionClient;

export type PlanRosterOutcome = {
  /// Klucze tygodni (`YYYY-MM-DD`), których plan i lista mogły się zmienić —
  /// gotowe do rozgłoszenia przez gateway.
  touchedWeekStarts: string[];
  /// Itemy skasowane, bo odchodzący był ich JEDYNYM uczestnikiem.
  deletedItemIds: string[];
  /// Ile „Wspólnych" przeliczyło auto-porcje.
  reDerivedItemCount: number;
};

/// Klamra `plannedServings` — ta sama, co `WeeklyPlansService.
/// resolvePlannedServings` (`weekly-plans.service.ts:700-705`). Gdyby te dwie
/// rozjechały się, hook „naprawiałby" wartości, których serwis nigdy by nie
/// zapisał.
function autoServings(memberCount: number): number {
  return Math.min(12, Math.max(1, memberCount));
}

/// Listy zakupów tygodni od bieżącego poniedziałku do przeliczenia.
///
/// `updateMany`, a nie `ShoppingListService.markShoppingListStale`: tamto jest
/// metodą instancji (DI), a jej `upsert` ZAKŁADAŁBY wiersze list dla tygodni,
/// które nigdy żadnej nie miały. Brak wiersza i tak znaczy „zbuduj od zera"
/// (`shopping-list.service.ts:480-484`), więc kasowanie ważności dotyczy
/// wyłącznie tego, co realnie leży w cache'u.
async function markFutureShoppingListsStale(
  tx: PrismaLike,
  householdId: string,
  monday: Date,
): Promise<void> {
  await tx.shoppingList.updateMany({
    where: { householdId, weekStart: { gte: monday } },
    data: { isStale: true },
  });
}

/// Przelicza auto-porcje „Wspólnych" po zmianie składu gospodarstwa.
///
/// Rozpoznanie „to była wartość auto" jest tym samym porównaniem, którego
/// używa `WeeklyPlansService.resolveUpdatedPlannedServings`
/// (`weekly-plans.service.ts:766-774`): zapisana liczba równa STAREJ regule
/// auto znaczy „nikt tego nie nadpisywał".
///
/// Granica jest znana i akceptowana: ręcznie ustawione „gotuję 2 porcje"
/// w domu dwuosobowym jest nieodróżnialne od auto i przeliczy się razem z nim.
/// Docelowo rozstrzygnie to kolumna `servingsMode AUTO|MANUAL` (WP-07) —
/// dopóki jej nie ma, wybieramy cichy błąd w rzadkim przypadku zamiast
/// pewnego, systematycznego błędu w każdym.
async function reDeriveSharedServings(
  tx: PrismaLike,
  householdId: string,
  oldMemberCount: number,
  newMemberCount: number,
  monday: Date,
): Promise<number> {
  const previousAuto = autoServings(oldMemberCount);
  const nextAuto = autoServings(newMemberCount);
  // Także dla 13 -> 14: obie wartości przycinają się do 12, nie ma czego ruszać.
  if (previousAuto === nextAuto) {
    return 0;
  }

  const updated = await tx.planItem.updateMany({
    where: {
      plannedServings: previousAuto,
      // Pusty zbiór uczestników = „Wspólne" (`schema.prisma:383-385`). Itemy
      // imienne liczą porcje z długości listy, nie z liczby domowników, więc
      // zmiana składu ich nie dotyczy.
      participants: { none: {} },
      weeklyPlan: { householdId, weekStart: { gte: monday } },
    },
    data: { plannedServings: nextAuto },
  });

  return updated.count;
}

/// Zmiana składu gospodarstwa BEZ odejścia konkretnej osoby (np. ktoś
/// dołączył). Wołane wprost z `HouseholdsService.acceptInvitation`.
export async function onRosterChanged(
  tx: PrismaLike,
  householdId: string,
  oldMemberCount: number,
  newMemberCount: number,
  now: Date = new Date(),
): Promise<number> {
  if (oldMemberCount === newMemberCount) {
    return 0;
  }
  const monday = currentWeekStart(now);
  const count = await reDeriveSharedServings(
    tx,
    householdId,
    oldMemberCount,
    newMemberCount,
    monday,
  );
  if (count > 0) {
    await markFutureShoppingListsStale(tx, householdId, monday);
  }
  return count;
}

/// Sprząta plan po domowniku, który przestał należeć do gospodarstwa.
///
/// Wołane PO usunięciu członkostwa i PO `settleHouseholdAfterMemberLeft`,
/// w tej samej transakcji. Dotyczy wyłącznie tygodni od bieżącego
/// poniedziałku — przeszłość jest zapisem tego, co się wydarzyło, i zostaje
/// nietknięta.
///
/// Item, którego JEDYNYM uczestnikiem był odchodzący, jest kasowany, a nie
/// cicho awansowany na „Wspólny": wiersz istnieje dlatego, że TA osoba to je.
/// Po awansie danie pojawiłoby się na pulpicie każdego domownika i w jego
/// kaloriach, choć nikt go nie wybrał. Kasowanie nie zabiera nikomu nic
/// z ekranu — taki item jest już dziś niewidoczny dla wszystkich
/// (`SavedMealPlan.swift:194-197`), a mimo to lista zakupów kupuje na niego
/// jedzenie.
export async function onMemberLeft(
  tx: PrismaLike,
  householdId: string,
  userId: string,
  now: Date = new Date(),
): Promise<PlanRosterOutcome> {
  const monday = currentWeekStart(now);
  const weekScope = { householdId, weekStart: { gte: monday } };

  const weeks = await tx.weeklyPlan.findMany({
    where: weekScope,
    select: { weekStart: true },
    orderBy: { weekStart: 'asc' },
  });
  const touchedWeekStarts = weeks.map((w) => formatWeekStart(w.weekStart));

  // Kandydaci do skasowania trzeba policzyć PRZED usunięciem wierszy
  // uczestników — potem nie ma już po czym poznać, czy zbiór był jednoosobowy.
  const affected = await tx.planItem.findMany({
    where: {
      weeklyPlan: weekScope,
      participants: { some: { userId } },
    },
    select: { id: true, participants: { select: { userId: true } } },
  });
  const deletedItemIds = affected
    .filter((item) => item.participants.length === 1)
    .map((item) => item.id);

  if (deletedItemIds.length > 0) {
    // Kaskada z `PlanItem` zabiera uczestników i „zjedzone" (`schema.prisma:
    // 391`, `:409`), więc osobne deleteMany na nich nie są potrzebne.
    await tx.planItem.deleteMany({ where: { id: { in: deletedItemIds } } });
  }

  await tx.planItemParticipant.deleteMany({
    where: { userId, planItem: { weeklyPlan: weekScope } },
  });
  await tx.planItemConsumption.deleteMany({
    where: { userId, planItem: { weeklyPlan: weekScope } },
  });

  // Skład zmienił się na pewno, więc auto-porcje „Wspólnych" liczą się od nowa.
  // Dokładnie jedno członkostwo znika na wywołanie (wszystkie cztery ścieżki
  // kasują po jednym), więc stary licznik to nowy + 1.
  const newMemberCount = await tx.membership.count({ where: { householdId } });
  const reDerivedItemCount = await reDeriveSharedServings(
    tx,
    householdId,
    newMemberCount + 1,
    newMemberCount,
    monday,
  );

  await markFutureShoppingListsStale(tx, householdId, monday);

  return { touchedWeekStarts, deletedItemIds, reDerivedItemCount };
}
```

> **If the reviewer objects to relation filters inside `updateMany`/`deleteMany`** (they are supported in Prisma 6.2, but generate correlated subqueries): the mechanical fallback is `const ids = await tx.planItem.findMany({ where: {…}, select: { id: true } })` followed by `updateMany({ where: { id: { in: ids.map(i => i.id) } } })`. Do **not** mix the two styles; pick one and keep the spec's test assertions in sync.

---

## 4. Change 3 — call sites (complete enumeration)

`grep -rn "membership.delete\|membership.deleteMany\|settleHouseholdAfterMemberLeft" src/` →
`users.service.ts:427,435` · `households.service.ts:190,197,589,595,615,618`. Plus the *join* path `households.service.ts:200-213`. That is **5** sites; `create` (`:88-105`) needs nothing (a brand-new 1-member household has no plans).

### 4.1 `HouseholdsService.acceptInvitation` — `src/households/households.service.ts`

Add to the import block after line 23:

```ts
import { onMemberLeft, onRosterChanged } from '../weekly-plans/utils/plan-roster.util';
```

**Current (lines 188-198):**

```ts
188:    return this.prisma.$transaction(async (tx) => {
189:      for (const previous of otherMemberships) {
190:        await tx.membership.delete({
191:          where: {
192:            userId_householdId: { userId, householdId: previous.householdId },
193:          },
194:        });
197:        await settleHouseholdAfterMemberLeft(tx, previous.householdId);
198:      }
```

**New:** capture the settlement and hook the *left* households, then bracket the upsert with member counts for the *joined* household.

```ts
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      for (const previous of otherMemberships) {
        await tx.membership.delete({
          where: {
            userId_householdId: { userId, householdId: previous.householdId },
          },
        });
        // Dom, z którego właśnie wyszedł ostatni domownik, znika razem
        // z planami i listami — patrz `settleHouseholdAfterMemberLeft`.
        const settlement = await settleHouseholdAfterMemberLeft(
          tx,
          previous.householdId,
        );
        // Dom skasowany = plan poleciał kaskadą, nie ma czego sprzątać.
        if (settlement.outcome !== 'DELETED') {
          await onMemberLeft(tx, previous.householdId, userId, now);
        }
      }

      // Liczniki dookoła `upsert`, bo `upsert` nie mówi, czy coś stworzył —
      // przy `update: {}` na istniejącym członkostwie skład się NIE zmienia
      // i przeliczanie porcji byłoby błędem.
      const memberCountBefore = await tx.membership.count({
        where: { householdId: invitation.householdId },
      });

      const membership = await tx.membership.upsert({ /* … :200-213 unchanged … */ });

      const memberCountAfter = await tx.membership.count({
        where: { householdId: invitation.householdId },
      });
      await onRosterChanged(
        tx,
        invitation.householdId,
        memberCountBefore,
        memberCountAfter,
        now,
      );
```

Return value (`:253-256`) gains one field for the gateway broadcast:

```ts
      return {
        ...membership,
        leftHouseholdIds: otherMemberships.map((m) => m.householdId),
        touchedWeekStarts: await weekKeysFrom(tx, invitation.householdId, now), // see note
      };
```

> **Simplification:** rather than a second helper, have `onRosterChanged` return `{ count, touchedWeekStarts }` if you want the join path to broadcast. If you skip §6 (broadcasts), keep `onRosterChanged` returning `number` and do not touch the return object.

### 4.2 `HouseholdsService.removeMember` — `households.service.ts:588-597`

**Current:**

```ts
588:    return this.prisma.$transaction(async (tx) => {
589:      const removed = await tx.membership.delete({
590:        where: { userId_householdId: { userId: memberUserId, householdId } },
591:      });
595:      await settleHouseholdAfterMemberLeft(tx, householdId);
596:      return removed;
597:    });
```

**New:**

```ts
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const removed = await tx.membership.delete({
        where: { userId_householdId: { userId: memberUserId, householdId } },
      });
      // Ta sama reguła co przy wyjściu — … (comment :592-594 unchanged)
      const settlement = await settleHouseholdAfterMemberLeft(tx, householdId);
      const roster =
        settlement.outcome === 'DELETED'
          ? { touchedWeekStarts: [] as string[] }
          : await onMemberLeft(tx, householdId, memberUserId, now);
      return { ...removed, touchedWeekStarts: roster.touchedWeekStarts };
    });
```

*Why the leaver's id, not `userId`:* `userId` is the **owner performing the removal**; the departing member is `memberUserId`. Getting this backwards deletes the owner's own participations — the single most likely bug in this change. Assert it in the tests.

### 4.3 `HouseholdsService.leave` — `households.service.ts:610-625`

**Current:**

```ts
614:    const settlement = await this.prisma.$transaction(async (tx) => {
615:      await tx.membership.delete({
616:        where: { userId_householdId: { userId, householdId } },
617:      });
618:      return settleHouseholdAfterMemberLeft(tx, householdId);
619:    });
```

**New:**

```ts
    const now = new Date();
    const { settlement, touchedWeekStarts } = await this.prisma.$transaction(
      async (tx) => {
        await tx.membership.delete({
          where: { userId_householdId: { userId, householdId } },
        });
        const settled = await settleHouseholdAfterMemberLeft(tx, householdId);
        if (settled.outcome === 'DELETED') {
          return { settlement: settled, touchedWeekStarts: [] as string[] };
        }
        const roster = await onMemberLeft(tx, householdId, userId, now);
        return { settlement: settled, touchedWeekStarts: roster.touchedWeekStarts };
      },
    );

    return {
      success: true,
      householdDeleted: settlement.outcome === 'DELETED',
      touchedWeekStarts,
    };
```

### 4.4 `UsersService.deleteAccount` — `src/users/users.service.ts:417-439` (not in the audit)

**Current (lines 426-436):**

```ts
426:      for (const membership of memberships) {
427:        await tx.membership.delete({
428:          where: {
429:            userId_householdId: { userId, householdId: membership.householdId },
430:          },
431:        });
435:        await settleHouseholdAfterMemberLeft(tx, membership.householdId);
436:      }
```

**New:** insert after `:435`, before the loop closes:

```ts
        const settlement = await settleHouseholdAfterMemberLeft(
          tx,
          membership.householdId,
        );
        // Kaskada z `tx.user.delete` (:438) zabiera wiersze uczestnictwa, ale
        // ROBI TO PÓŹNIEJ i po cichu: item, na którym ta osoba była jedynym
        // uczestnikiem, awansowałby na „Wspólny", a auto-porcje „Wspólnych"
        // zostałyby policzone dla starego składu. Hook musi pójść PRZED
        // usunięciem użytkownika, dopóki wiersze jeszcze istnieją.
        if (settlement.outcome !== 'DELETED') {
          await onMemberLeft(tx, membership.householdId, userId, now);
        }
```

with `const now = new Date();` above `this.prisma.$transaction` at `:417`, and the import added to the existing `:7` import line group.

### 4.5 Paths that need **no** change

| Path | Why |
|---|---|
| `HouseholdsService.create` (`:88-105`) | New 1-member household; no `WeeklyPlan` rows exist yet. |
| `settleHouseholdAfterMemberLeft` → `DELETED` | `Household → WeeklyPlan → PlanItem → participants/consumptions` all cascade (`schema.prisma:343,370,391,409`). |
| `settleHouseholdAfterMemberLeft` → `OWNER_PROMOTED` | Role change only; member **count** unchanged. |
| `updateMemberRole` (`:531-562`) | Same — count unchanged. |
| `declineInvitation`, `previewInvitation` | No membership write. |

---

## 5. Tests — new file `src/weekly-plans/utils/plan-roster.util.spec.ts`

Pattern follows `src/households/household-cleanup.util.spec.ts` (a plain `makeTx()` of `jest.fn()` delegates cast to `PrismaLike`) — **not** `Test.createTestingModule`, because the unit under test is a free function that takes `tx`, so there is nothing to inject. The `Test.createTestingModule` + `$transaction`-calls-the-callback-with-the-same-mock convention (`weekly-plans.service.spec.ts:174-204`) applies to the *service* specs and is not needed here; it is also unusable for the call sites, since `jest.config.js:22-25` redirects `households.service` to `households.service.stub`.

Use an **in-memory store** so "manual values untouched" is a behavioural assertion, not a `where`-shape assertion.

```ts
import { PrismaLike, onMemberLeft, onRosterChanged } from './plan-roster.util';

const HOUSEHOLD = 'hh-1';
const LEAVER = 'user-2';
const STAYER = 'user-1';
// Czwartek. Bieżący poniedziałek = 2026-08-24.
const NOW = new Date('2026-08-27T10:00:00.000Z');
const MONDAY = new Date('2026-08-24T00:00:00.000Z');
const NEXT_WEEK = new Date('2026-08-31T00:00:00.000Z');
const LAST_WEEK = new Date('2026-08-17T00:00:00.000Z');
```

`makeTx({ items, weeks, memberCount })` returns delegates:
`weeklyPlan.findMany`, `planItem.findMany`, `planItem.deleteMany`, `planItem.updateMany`, `planItemParticipant.deleteMany`, `planItemConsumption.deleteMany`, `membership.count`, `shoppingList.updateMany` — each a `jest.fn()`; `planItem.findMany` / `updateMany` / `deleteMany` implemented against the in-memory `items` array honouring `where.plannedServings`, `where.participants.none`, `where.weeklyPlan.weekStart.gte`, `where.id.in`.

### `describe('onMemberLeft')`

| `it` | Input | Expected |
|---|---|---|
| `usuwa wiersze ducha tylko w tygodniach od bieżącego poniedziałku` | items in weeks `2026-08-17`, `2026-08-24`, `2026-08-31` | `planItemParticipant.deleteMany` called **once** with `{ where: { userId: 'user-2', planItem: { weeklyPlan: { householdId: 'hh-1', weekStart: { gte: MONDAY } } } } }`; identical `where` on `planItemConsumption.deleteMany` |
| `kasuje item, na którym odchodzący był jedynym uczestnikiem` | `findMany` → `[{id:'solo', participants:[{userId:LEAVER}]}, {id:'duo', participants:[{userId:STAYER},{userId:LEAVER}]}]` | `planItem.deleteMany` called with `{ where: { id: { in: ['solo'] } } }`; result `deletedItemIds === ['solo']`; `'duo'` survives |
| `nie kasuje itemu współdzielonego z pozostającym domownikiem` | as above | in-memory store still contains `'duo'` |
| `nie kasuje niczego, gdy odchodzący nie miał posiłków imiennych` | `findMany` → `[]` | `planItem.deleteMany` **not called**; `deletedItemIds === []` |
| `nie rusza tygodni z przeszłości` | store has `{id:'past', week: LAST_WEEK, participants:[{userId:LEAVER}]}` | `'past'` still present; not in `deletedItemIds` |
| `przelicza Wspólne z 2 na 1 po odejściu` | `membership.count` → `1`; item `{plannedServings: 2, participants: []}` | item `plannedServings === 1`; result `reDerivedItemCount === 1` |
| `nie rusza wartości ręcznej` | `membership.count` → `1`; items `{ps:2, participants:[]}` and `{ps:4, participants:[]}` | first → `1`, second stays `4` |
| `nie rusza itemów imiennych` | `{ps:2, participants:[{userId:STAYER}]}` | stays `2` (filtered out by `participants: { none: {} }`) |
| `oznacza listy zakupów od bieżącego poniedziałku jako nieaktualne` | any | `shoppingList.updateMany` called with `{ where: { householdId: 'hh-1', weekStart: { gte: MONDAY } }, data: { isStale: true } }` |
| `zwraca klucze dotkniętych tygodni` | `weeklyPlan.findMany` → `[{weekStart: MONDAY},{weekStart: NEXT_WEEK}]` | `touchedWeekStarts === ['2026-08-24','2026-08-31']` |

### `describe('onRosterChanged')`

| `it` | Input | Expected |
|---|---|---|
| `przelicza Wspólne z 1 na 2 po dołączeniu domownika` | `(tx, HOUSEHOLD, 1, 2, NOW)`; item `{ps:1, participants:[]}` | `plannedServings === 2`; returns `1`; `shoppingList.updateMany` called once |
| `nie robi nic, gdy skład się nie zmienił` | `(tx, HOUSEHOLD, 2, 2, NOW)` | `planItem.updateMany` **not called**; `shoppingList.updateMany` **not called**; returns `0` |
| `nie robi nic, gdy obie liczby przycinają się do 12` | `(tx, HOUSEHOLD, 13, 14, NOW)` | `planItem.updateMany` **not called**; returns `0` |
| `przycina nowy licznik do 12` | `(tx, HOUSEHOLD, 12, 15, NOW)` | not called (12 → 12) |
| `nie oznacza list nieaktualnymi, gdy nic nie przeliczono` | `(tx, HOUSEHOLD, 1, 2, NOW)` with zero matching items | `shoppingList.updateMany` **not called** |

### Append to `src/weekly-plans/utils/week-formatting.util.spec.ts`

```ts
describe('currentWeekStart', () => {
  it.each([
    ['poniedziałek północ',  '2026-08-24T00:00:00.000Z', '2026-08-24'],
    ['czwartek popołudnie',  '2026-08-27T15:30:00.000Z', '2026-08-24'],
    ['niedziela 23:59',      '2026-08-30T23:59:59.999Z', '2026-08-24'],
    ['poniedziałek 00:00 następnego tygodnia', '2026-08-31T00:00:00.000Z', '2026-08-31'],
    ['przełom roku',         '2027-01-01T12:00:00.000Z', '2026-12-28'],
  ])('%s -> %s', (_label, iso, expected) => {
    expect(formatWeekStart(currentWeekStart(new Date(iso)))).toBe(expected);
  });

  it('zwraca datę, którą parseWeekStart uzna za poprawną', () => {
    const monday = currentWeekStart(new Date('2026-08-27T10:00:00.000Z'));
    expect(monday.getUTCDay()).toBe(1);
    expect(parseWeekStart(formatWeekStart(monday)).getTime()).toBe(monday.getTime());
  });
});
```

---

## 6. Optional (recommended, P2) — tell the other phones

`SessionStore.swift:577-631` handles `households:membersChanged` by refreshing the member list **only**; it never reloads the week or the shopping list. Without this step, a remaining member sees the deleted item and the stale servings until they navigate away and back.

Both gateways share one Socket.IO server (`WS_GATEWAY_OPTIONS`, no namespace), so `HouseholdsGateway` can emit the weekly-plans events directly. In `src/households/households.gateway.ts`, after each `await this.emitMembersChanged({…})` at `:211-216`, `:420-425`, `:439-444`:

```ts
      const changeVersion = Date.now();
      for (const weekStart of result.touchedWeekStarts ?? []) {
        this.server.emit('weeklyPlans:weekChanged', {
          householdId: payload.householdId,
          weekStart,
          action: 'MEMBERSHIP_CHANGED',
          changedByUserId: payload.userId,
          changedByDisplayName,
          changeVersion,
        });
        this.server.emit('weeklyPlans:shoppingListChanged', {
          householdId: payload.householdId,
          weekStart,
          action: 'MEMBERSHIP_CHANGED',
          changedByUserId: payload.userId,
          changedByDisplayName,
          changeVersion,
        });
      }
```

`changeVersion: Date.now()` mirrors `weekly-plans.gateway.ts:232-234`. **No iOS change needed:** `WeeklyMealStore.handleRemoteWeekPlanChanged` (`:527-534`) filters on `weekStart == observedWeekStart` and the monotonic `changeVersion`, then `scheduleWeekReload`; the unknown action falls into `singleChangeText`'s `default: return nil` (`PlanChangeNotificationService.swift:376-377`) → **refetch without a spurious push**. That is exactly the desired behaviour: the plan silently corrects itself.

---

## 7. Data migration / one-off SQL (dev then prod)

**No Prisma migration.** These are manual `psql` statements; run them **after** the code deploy so no new ghosts appear between the two.

Run: `docker compose exec db psql -U weeklymeals -d weeklymeals -c "<sql>"`.
`date_trunc('week', CURRENT_DATE)` returns ISO Monday; `CURRENT_DATE` uses the session `TimeZone`, which is UTC in the container — matches `currentWeekStart`.

### 7.1 Diagnostic first (read-only)

```sql
SELECT
  count(*) FILTER (WHERE w."weekStart" >= date_trunc('week', CURRENT_DATE)) AS ghost_participants_future,
  count(*) FILTER (WHERE w."weekStart" <  date_trunc('week', CURRENT_DATE)) AS ghost_participants_past
FROM "PlanItemParticipant" p
JOIN "PlanItem"   i ON i.id = p."planItemId"
JOIN "WeeklyPlan" w ON w.id = i."weeklyPlanId"
WHERE NOT EXISTS (
  SELECT 1 FROM "Membership" m
  WHERE m."userId" = p."userId" AND m."householdId" = w."householdId");
```

Same query against `"PlanItemConsumption"`. Then the items that would be **deleted** — review this list before running 7.3:

```sql
SELECT w."householdId", w."weekStart", i.id, i."dayOfWeek", i."mealType", i."recipeId"
FROM "PlanItem" i
JOIN "WeeklyPlan" w ON w.id = i."weeklyPlanId"
WHERE w."weekStart" >= date_trunc('week', CURRENT_DATE)
  AND EXISTS (SELECT 1 FROM "PlanItemParticipant" p WHERE p."planItemId" = i.id)
  AND NOT EXISTS (
    SELECT 1 FROM "PlanItemParticipant" p
    JOIN "Membership" m ON m."userId" = p."userId" AND m."householdId" = w."householdId"
    WHERE p."planItemId" = i.id);
```

And a **do-not-auto-fix** diagnostic for WP-07 drift (shared items whose servings ≠ current member count):

```sql
SELECT w."householdId", w."weekStart", count(*) AS shared_items, i."plannedServings",
       (SELECT count(*) FROM "Membership" m WHERE m."householdId" = w."householdId") AS members
FROM "PlanItem" i
JOIN "WeeklyPlan" w ON w.id = i."weeklyPlanId"
WHERE w."weekStart" >= date_trunc('week', CURRENT_DATE)
  AND NOT EXISTS (SELECT 1 FROM "PlanItemParticipant" p WHERE p."planItemId" = i.id)
GROUP BY 1,2,4;
```

**Do not bulk-update these.** Historic drift is unrecoverable: the old member count is not stored, so an auto value and a deliberate "gotuję 4 porcje" are indistinguishable, and a blanket `UPDATE … SET "plannedServings" = members` would clobber the manual ones. The hook fixes drift going forward; existing drift resolves the next time the user touches the audience (`resolveUpdatedPlannedServings`, `weekly-plans.service.ts:766-774`) or the roster changes again.

### 7.2 Backup (this **is** the rollback)

```sql
CREATE TABLE "_bak_wp04_PlanItem"        AS SELECT i.* FROM "PlanItem" i JOIN "WeeklyPlan" w ON w.id = i."weeklyPlanId" WHERE w."weekStart" >= date_trunc('week', CURRENT_DATE);
CREATE TABLE "_bak_wp04_PlanItemParticipant" AS SELECT p.* FROM "PlanItemParticipant" p JOIN "PlanItem" i ON i.id = p."planItemId" JOIN "WeeklyPlan" w ON w.id = i."weeklyPlanId" WHERE w."weekStart" >= date_trunc('week', CURRENT_DATE);
CREATE TABLE "_bak_wp04_PlanItemConsumption"  AS SELECT c.* FROM "PlanItemConsumption" c JOIN "PlanItem" i ON i.id = c."planItemId" JOIN "WeeklyPlan" w ON w.id = i."weeklyPlanId" WHERE w."weekStart" >= date_trunc('week', CURRENT_DATE);
```

### 7.3 Cleanup — one transaction, this order

```sql
BEGIN;

-- 1. Itemy, których cały skład jest z poza gospodarstwa (kaskada zabiera
--    ich uczestników i „zjedzone").
DELETE FROM "PlanItem" i
USING "WeeklyPlan" w
WHERE i."weeklyPlanId" = w.id
  AND w."weekStart" >= date_trunc('week', CURRENT_DATE)
  AND EXISTS (SELECT 1 FROM "PlanItemParticipant" p WHERE p."planItemId" = i.id)
  AND NOT EXISTS (
    SELECT 1 FROM "PlanItemParticipant" p
    JOIN "Membership" m ON m."userId" = p."userId" AND m."householdId" = w."householdId"
    WHERE p."planItemId" = i.id);

-- 2. Pozostałe wiersze ducha na itemach współdzielonych.
DELETE FROM "PlanItemParticipant" p
USING "PlanItem" i, "WeeklyPlan" w
WHERE p."planItemId" = i.id AND i."weeklyPlanId" = w.id
  AND w."weekStart" >= date_trunc('week', CURRENT_DATE)
  AND NOT EXISTS (SELECT 1 FROM "Membership" m
                  WHERE m."userId" = p."userId" AND m."householdId" = w."householdId");

-- 3. „Zjedzone" po ludziach spoza domu (dotyczy też itemów „Wspólnych").
DELETE FROM "PlanItemConsumption" c
USING "PlanItem" i, "WeeklyPlan" w
WHERE c."planItemId" = i.id AND i."weeklyPlanId" = w.id
  AND w."weekStart" >= date_trunc('week', CURRENT_DATE)
  AND NOT EXISTS (SELECT 1 FROM "Membership" m
                  WHERE m."userId" = c."userId" AND m."householdId" = w."householdId");

-- 4. Listy zakupów przeliczą się przy najbliższym odczycie.
UPDATE "ShoppingList" SET "isStale" = true
WHERE "weekStart" >= date_trunc('week', CURRENT_DATE);

COMMIT;
```

Re-run 7.1 → all counts for `*_future` must be `0`; `*_past` is expected to stay non-zero (D4).

### 7.4 Rollback

- **Code:** revert the commit. The change is purely additive (new file + new call lines); no schema, no migration, no data dependency. Redeploy.
- **Data:** restore from `_bak_wp04_*` (`INSERT INTO "PlanItem" SELECT * FROM "_bak_wp04_PlanItem" ON CONFLICT DO NOTHING;` — restore `PlanItem` before its child tables, whose FKs cascade). Drop the `_bak_wp04_*` tables once a release has gone by without a report.
- **Note:** if `WP-01`'s `UPDATE "ShoppingList" SET "isStale"=true` already ran, step 4 is a no-op and needs no rollback — a stale list only costs one rebuild.

---

## 8. Verification (no `tsc`/`jest`/`prisma` on the developer Mac)

```bash
cd "/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend"
docker compose up -d api

# jest.config.js is NOT baked into the image (Dockerfile:32-43) — it must be copied.
docker cp ./src            weeklymeals-api:/app/src
docker cp ./jest.config.js weeklymeals-api:/app/jest.config.js

# 1. the new unit tests
docker compose exec api npx jest \
  src/weekly-plans/utils/plan-roster.util.spec.ts \
  src/weekly-plans/utils/week-formatting.util.spec.ts

# 2. nothing else broke (household-cleanup, weekly-plans, shopping-list specs)
docker compose exec api npx jest

# 3. types — the call sites are the risky part (return-shape changes)
docker compose exec api npx tsc --noEmit -p tsconfig.json

# 4. lint
docker compose exec api npx eslint "src/**/*.ts"
```

**Manual end-to-end on the dev stack** (`commands.txt` idiom):

```bash
docker compose exec api pnpm ws:smoke weeklyPlans:getWeek '{"userId":"<A>","householdId":"<H>","weekStart":"<MONDAY>"}'
docker compose exec api pnpm ws:smoke households:removeMember '{"userId":"<OWNER>","householdId":"<H>","memberUserId":"<B>"}'
docker compose exec api pnpm ws:smoke weeklyPlans:getWeek '{"userId":"<A>","householdId":"<H>","weekStart":"<MONDAY>"}'
docker compose exec api pnpm ws:smoke weeklyPlans:getShoppingList '{"userId":"<A>","householdId":"<H>","weekStart":"<MONDAY>"}'
```

Expect: B's solo items gone, shared items keep only A in `participantIds`, `plannedServings` 2 → 1 on "Wspólne", shopping quantities halved.

**iOS** (only needed if §6 lands, and only as a regression check — there is no Swift source change):

```bash
xcodebuild -project "/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals.xcodeproj" \
  -scheme "weekly meals" -destination 'platform=iOS Simulator,name=iPhone 16' build
```

Then two simulators in one household: remove member on device A → device B's Plan reloads within the 250 ms debounce, no notification banner.

---

## 9. Ordered steps and effort

| # | Step | Files | Effort | Depends on |
|---|---|---|---|---|
| 1 | `currentWeekStart` + its spec cases | `week-formatting.util.ts`, `week-formatting.util.spec.ts` | 20 min | — |
| 2 | `plan-roster.util.ts` (§3) | new file | 1.5 h | 1 |
| 3 | `plan-roster.util.spec.ts` (§5) incl. in-memory store | new file | 1.5 h | 2 |
| 4 | Wire the 4 removal call sites + the join path (§4) | `households.service.ts`, `users.service.ts` | 1 h | 2 |
| 5 | Run §8 steps 1-4 in the container; fix types | — | 30 min | 3, 4 |
| 6 | *(optional, P2)* broadcasts (§6) + `touchedWeekStarts` in the 3 return shapes | `households.gateway.ts`, `households.service.ts` | 45 min | 4 |
| 7 | Diagnostic SQL on dev; review the delete list (§7.1) | — | 15 min | — |
| 8 | Backup + cleanup SQL on dev; re-run diagnostics; smoke (§7.2-7.4, §8) | — | 30 min | 5, 7 |
| 9 | Same on prod, after the code deploy | — | 20 min | 8 |

**Total ≈ 5.5 h** (6.5 h with §6) — consistent with the audit's "WP-04 2-3 h + WP-07 2 h (hook)", minus the overlap between the two hooks.

**Known limitations to record in the PR description:** (a) manual `plannedServings` equal to the old member count is re-derived (D5 — fixed only by the future `servingsMode` column); (b) past weeks keep their ghost rows by design (D4), so a "participants ⊆ members" validator must scope itself to `weekStart >= current Monday` or treat history as read-only; (c) the UTC-vs-phone-timezone Monday boundary widens the cleanup window by at most one week, never narrows it.