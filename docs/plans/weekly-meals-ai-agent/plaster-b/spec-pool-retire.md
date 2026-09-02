# WP-03 Implementation Spec — Retire the legacy weekly pool (`SharedMealPlan`) and the dead plan handlers

Verified against the **current** files on disk (post-Plaster A: `parseWeekStart` is strict Monday-only, shopping list uses verbatim catalog names). All paths absolute. Read-only analysis; nothing was modified.

---

## 0. Decisions (read this first)

| Question                                                                 | Decision                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drop `SharedMealPlan` / `SharedMealPlanItem` Prisma models + tables now? | **No.** Keep models and tables in this change. Add a follow-up ticket for a `DROP TABLE` migration ≥ 1 release after prod verification.                                                                                         | `git revert` is a complete rollback only while the schema is untouched. A `DROP TABLE` in the same PR makes rollback require a forward-fix migration, and `prisma-migrate-deploy-safe.js` runs on every container start (`/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/Dockerfile:55`), so a reverted image would boot against a schema that no longer matches the restored code. |
| Delete the pool **rows**?                                                | **Yes, but in a separate maintenance step, after a `pg_dump -t` backup.** Not required for correctness — once the fallback is gone the rows are simply never read.                                                              | The DELETE is the only irreversible part of this work. Decoupling it keeps step 1 a pure `git revert`.                                                                                                                                                                                                                                                                                         |
| Hard-remove all six handlers?                                            | **Five yes, one shim.** Remove `create`, `addItem`, `removeItem`, `listByHousehold`, `saveSavedPlan` outright. Keep `getSavedPlan` for **one release** as a 4-line stub returning `{ weekStart, items: [] }` with no DB access. | See §3 — a shipped iOS build calls `getSavedPlan` **before** `loadWeekPlanFromBackend` in the same `.task`, and a missing handler costs it 3 × 6 s of ACK retries → **~18 s blank calendar** for every not-yet-updated device. The other five events are called by nobody.                                                                                                                     |
| `SAVE_PLAN` notification copy?                                           | **Remove on the backend** (`notification-copy.util.ts`), **keep on iOS** for one release.                                                                                                                                       | Backend: the only producer (`saveSavedPlan`) is gone, so the branch is provably dead. iOS: 2 lines, protects against a mixed-version rollout.                                                                                                                                                                                                                                                  |
| `clearWeekPlan` pool deletion                                            | **Drop it** (not "keep harmless").                                                                                                                                                                                              | It is the only remaining writer of `sharedMealPlan*`. Leaving it forces the Prisma delegates to stay referenced and makes the "no code touches the pool" invariant untestable.                                                                                                                                                                                                                 |

**Net effect on the wire protocol:** 5 events deleted, 1 event becomes a no-op stub, 1 broadcast (`weeklyPlans:savedPlanChanged`) deleted, 1 broadcast action (`SAVE_PLAN_SYNC` on `weeklyPlans:weekChanged`) no longer emitted.

---

## 1. Backend — file-by-file

### 1.1 `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/weekly-plans/weekly-plans.gateway.ts`

**a) Imports — lines 13, 14, 20.** Current:

```ts
13	import { CreatePlanItemDto } from './dto/create-plan-item.dto';
14	import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';
...
20	import { SaveSharedMealPlanDto } from './dto/save-shared-meal-plan.dto';
```

→ Delete all three lines. Keep every other import (`Socket` is still used by `handleConnection`/`handleDisconnect`).

**b) Payload classes — delete four blocks.**

```ts
24	class WeeklyPlansListPayload {
25	  userId: string;
26	  householdId: string;
27	}
```

```ts
35	class WeeklyPlansCreatePayload {
...
50	}
```

(covers `WeeklyPlansCreatePayload` 35–39, `WeeklyPlansAddItemPayload` 41–45, `WeeklyPlansRemoveItemPayload` 47–50)

```ts
123	class WeeklyPlansSaveSavedPlanPayload {
124	  userId: string;
125	  householdId: string;
126	  weekStart: string;
127	  data: SaveSharedMealPlanDto;
128	}
```

**Keep** `WeeklyPlansGetSavedPlanPayload` (117–121) — the shim uses it.

**c) `buildSavedPlanFingerprint` — lines 236–253.** Delete the whole private method; its only caller is `saveSavedPlan`.

```ts
236	  private buildSavedPlanFingerprint(
237	    plan:
238	      | {
239	          items?: Array<{ mealType: string; quantity: number; recipe: { id: string } }>;
...
253	  }
```

**d) Handlers — delete lines 255–263 and 276–303.**

```ts
255	  @SubscribeMessage('weeklyPlans:listByHousehold')
256	  listByHousehold(@MessageBody() payload: WeeklyPlansListPayload) {
257	    return wsRespond(() =>
258	      this.weeklyPlansService.listByHousehold(
259	        payload.userId,
260	        payload.householdId,
261	      ),
262	    );
263	  }
```

```ts
276	  @SubscribeMessage('weeklyPlans:create')
...
303	  }
```

(covers `create` 276–285, `addItem` 287–296, `removeItem` 298–303). **Keep** `getByWeek` (265–274) — that is the live read path.

**e) `getSavedPlan` — lines 607–616.** Replace the body with the deprecation shim:

```ts
607	  @SubscribeMessage('weeklyPlans:getSavedPlan')
608	  getSavedPlan(@MessageBody() payload: WeeklyPlansGetSavedPlanPayload) {
609	    return wsRespond(() =>
610	      this.weeklyPlansService.getSharedMealPlan(
611	        payload.userId,
612	        payload.householdId,
613	        payload.weekStart,
614	      ),
615	    );
616	  }
```

New code (exact):

```ts
  /**
   * DEPRECATED — pula tygodniowa (`SharedMealPlan`) została wycofana; źródłem
   * prawdy jest wyłącznie `PlanItem` (Plan v2). Handler zostaje na JEDNO
   * wydanie i odpowiada pustą pulą, bo aplikacja ze sklepu woła go w
   * `CalendarView.task` PRZED wczytaniem tygodnia: brak handlera to trzy
   * nieudane próby ACK × 6 s, czyli ~18 s pustego kalendarza na
   * nieaktualizowanym telefonie. Nie dotyka bazy.
   *
   * TODO(WP-03): usunąć razem z `WeeklyPlansGetSavedPlanPayload` po tym, jak
   * telemetria przestanie notować to zdarzenie.
   */
  @SubscribeMessage('weeklyPlans:getSavedPlan')
  getSavedPlan(@MessageBody() payload: WeeklyPlansGetSavedPlanPayload) {
    return wsRespond(async () => ({
      weekStart: payload.weekStart,
      items: [] as never[],
    }));
  }
```

Shape matches iOS `BackendSharedMealPlanDTO` (`weekStart: String`, `items: [BackendSharedMealPlanItemDTO]`) exactly, so old clients decode it and render an empty pool — which is what they render anyway (§5.0).

**f) `saveSavedPlan` — delete lines 618–680** in full (handler, fingerprint gate, `savedPlanChanged` emit, `SAVE_PLAN_SYNC` `weekChanged` emit, `shoppingListChanged` emit, `notifyPlanChanged`).

**g) `clearWeekPlan` — delete the `savedPlanChanged` broadcast, lines 702–709.** Current:

```ts
701	      });
702	      this.server.emit('weeklyPlans:savedPlanChanged', {
703	        householdId: payload.householdId,
704	        weekStart: payload.weekStart,
705	        changedByUserId: payload.userId,
706	        changedByDisplayName,
707	        action: 'CLEAR_PLAN',
708	        changeVersion,
709	      });
710	      this.emitShoppingListChanged({
```

→ Delete 702–709. `changeVersion` (line 693) is still used by the `weekChanged` emit at 694–701, keep it. After this edit `weeklyPlans:savedPlanChanged` has **zero** emitters.

---

### 1.2 `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/weekly-plans/weekly-plans.service.ts`

**a) Imports.** Delete lines 9, 10, 14–18; edit line 2 and line 19.

```ts
 1	import {
 2	  ConflictException,      // ← DELETE: last uses were addItem:217 and :262
 3	  HttpStatus,
 4	  Injectable,
 5	  NotFoundException,
 6	} from '@nestjs/common';
...
 9	import { CreatePlanItemDto } from './dto/create-plan-item.dto';        // ← DELETE
10	import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';    // ← DELETE
...
14	import {                                                              // ← DELETE 14–18
15	  SaveSharedMealPlanDto,
16	  mergeSharedPlanRecipeIds,
17	  sharedPlanAddressedMealTypes,
18	} from './dto/save-shared-meal-plan.dto';
19	import { MealType, Prisma } from '@prisma/client';   // → import { Prisma } from '@prisma/client';
```

Verified survivors (do **not** touch): `HttpStatus`/`AppException` (223/231/239 go away but 449/457/465/666 remain), `NotFoundException` (150, 592, 606), `Prisma` (58 `satisfies Prisma.PlanItemInclude`), `MEAL_TYPES_IN_DAY_ORDER` (112), `runSerializable` (781), `ensureRecipeForHousehold` (317), `withPlanItemRelationIds` (152, 421, 493, 628), `sameMemberSet` (418, 762).

**b) `listByHousehold` — delete lines 114–127.**

```ts
114	  async listByHousehold(userId: string, householdId: string) {
115	    await ensureMembership(this.prisma, userId, householdId);
116	    const plans = await this.prisma.weeklyPlan.findMany({
117	      where: { householdId },
118	      orderBy: { weekStart: 'desc' },
```

Unbounded: loads every week of the household with full recipe + ingredient payloads. No caller after §1.1d.

**c) `create` — delete lines 155–163.**
**d) `addItem` — delete lines 165–277** (the whole method incl. the `$transaction`, the three cap checks and the P2002 catch).
**e) `removeItem` — delete lines 279–307.**

**f) `clearWeekPlan` — remove the pool branch.** Current (lines 790–814):

```ts
790	      });
791
792	      const sharedPlan = await tx.sharedMealPlan.findUnique({
793	        where: {
794	          householdId_weekStart: { householdId, weekStart: weekStartDate },
795	        },
796	        select: { id: true },
797	      });
798
799	      if (weeklyPlan) {
800	        await tx.planItem.deleteMany({ where: { weeklyPlanId: weeklyPlan.id } });
801	      }
802
803	      if (sharedPlan) {
804	        await tx.sharedMealPlanItem.deleteMany({ where: { sharedMealPlanId: sharedPlan.id } });
805	        await tx.sharedMealPlan.delete({ where: { id: sharedPlan.id } });
806	      }
```

New: delete the `const sharedPlan = …` lookup (792–797) and the `if (sharedPlan) { … }` block (803–806). Keep the `if (weeklyPlan)` block and everything from `shoppingItemCheck.deleteMany` down. This removes two queries from a `Serializable` transaction.

**g) `getSharedMealPlan` — delete lines 857–919.**
**h) `saveSharedMealPlan` — delete lines 921–1079** (whole method incl. `countsByMealType`, `pruneByMealType`, the `addressedMealTypes` scoping and the `return this.getSharedMealPlan(...)` tail). This is the WP-03 P1 defect itself: `pruneByMealType` was applied to every entry of `countsByMealType` (built from all `MEAL_TYPES_IN_DAY_ORDER`), not to `addressedMealTypes`, so a legacy `{breakfastRecipeIds:[…]}` wiped `SECOND_BREAKFAST`/`AFTERNOON_SNACK`/`SNACK`.

After (g)+(h) the file ends after `getUserDisplayName` (849–855) + the private servings helpers; add the closing `}` of the class.

---

### 1.3 `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/weekly-plans/services/shopping-list.service.ts`

**a) `buildShoppingListBase` — collapse the `else` branch, lines 94–144.** Current:

```ts
 94	    if (weeklyPlan && weeklyPlan.items.length > 0) {
...
100	      ingredientSources = weeklyPlan.items.map((item) => ({
101	        recipe: item.recipe,
102	        portionFactor:
103	          Math.max(1, item.plannedServings) / Math.max(1, item.recipe.servings),
104	      }));
105	    } else {
106	      // Legacy weeks: planned as a pool, never assigned to days.
107	      const sharedPlan = await client.sharedMealPlan.findUnique({
...
143	      }));
144	    }
```

New code: drop `else { … }` (105–144) entirely and make the `if` a guard:

```ts
// `PlanItem` jest JEDYNYM źródłem listy. Wycofana pula tygodniowa
// (`SharedMealPlan`) potrafiła podstawić widmową listę tygodniowi, z
// którego usunięto wszystkie posiłki po jednym — a asystentowi kazała
// liczyć bilans z danych, których nie widać w aplikacji (WP-03).
const ingredientSources = (weeklyPlan?.items ?? []).map((item) => ({
  recipe: item.recipe,
  portionFactor:
    Math.max(1, item.plannedServings) / Math.max(1, item.recipe.servings),
}));
```

…and delete the `let ingredientSources: Array<{…}> = [];` declaration at lines 81–93 (the explicit type is now inferred from `weeklyPlan.items`). Also fix the stale doc comment at lines 44–47 (`"The week-long shared pool it replaced is only consulted for weeks planned before that"`) — it now describes removed behaviour.

**b) `hasShoppingSourceData` — lines 349–387.** Current:

```ts
349	  private async hasShoppingSourceData(
350	    householdId: string,
351	    weekStartDate: Date,
352	    client: PrismaReadClient = this.prisma,
353	  ): Promise<boolean> {
354	    const [sharedPlan, weeklyPlan] = await Promise.all([
355	      client.sharedMealPlan.findUnique({
...
385	    return (
386	      (sharedPlan?.items.length ?? 0) > 0 || (weeklyPlan?.items.length ?? 0) > 0
387	    );
388	  }
```

New body (single query, no `Promise.all`):

```ts
  private async hasShoppingSourceData(
    householdId: string,
    weekStartDate: Date,
    client: PrismaReadClient = this.prisma,
  ): Promise<boolean> {
    const weeklyPlan = await client.weeklyPlan.findUnique({
      where: {
        householdId_weekStart: { householdId, weekStart: weekStartDate },
      },
      select: { items: { select: { id: true }, take: 1 } },
    });

    return (weeklyPlan?.items.length ?? 0) > 0;
  }
```

This is what makes ghost lists self-heal without SQL: for a pool-only week the read path at line 458 now sees `snapshot.items.length > 0 && !hasSourceData` → rebuild → empty list persisted.

---

### 1.4 DTOs — delete files

- `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/weekly-plans/dto/save-shared-meal-plan.dto.ts` (156 lines: `RecipeIdsByMealTypeConstraint`, `SaveSharedMealPlanDto`, `mergeSharedPlanRecipeIds`, `sharedPlanAddressedMealTypes`)
- `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/weekly-plans/dto/save-shared-meal-plan.dto.spec.ts` (106 lines, 7 cases)
- `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/weekly-plans/dto/create-plan-item.dto.ts` (21 lines)
- `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/weekly-plans/dto/create-weekly-plan.dto.ts` (8 lines) — note this was the last `@IsDateString()` weekStart DTO, superseded by `parseWeekStart`

**Comment fix (compile-neutral but the reference dangles):** `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/households/dto/update-meal-times.dto.ts:46-48`

```ts
46	 * To odwrotna reguła niż przy zapisie puli przepisów
47	 * (`SaveSharedMealPlanDto`), bo tam starszy klient nie zna nowych slotów;
48	 * tutaj mapę wysyła wyłącznie klient, który zna wszystkie.
```

→ replace 46–48 with: `* Mapę wysyła wyłącznie klient, który zna wszystkie sloty.`

---

### 1.5 `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/notifications/notification-copy.util.ts`

Line 13 — drop `SAVE_PLAN` from the union:

```ts
10	export type PlanChangeAction =
11	  | 'UPSERT_SLOT'
12	  | 'REMOVE_SLOT'
13	  | 'SAVE_PLAN'      // ← DELETE
14	  | 'CLEAR_PLAN'
15	  | (string & {});
```

(the `(string & {})` member keeps every call site type-checking.)

Lines 209–211 — delete the branch in `buildPlanSummary`:

```ts
206	  if (actions.has('CLEAR_PLAN')) {
207	    return { title, body: `${actor} usunął/ęła plan na ${week}.` };
208	  }
209	  if (actions.has('SAVE_PLAN')) {
210	    return { title, body: `${actor} ustawił/a plan na ${week}.` };
211	  }
```

No change needed in `notifications.service.ts` — `enqueueWeeklyPlanChange` (lines 188–214) is generic over `action`.

---

### 1.6 `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/prisma/schema.prisma` — **no change in this PR**

Keep `SharedMealPlan` (565–576), `SharedMealPlanItem` (578–592), and the back-relations at `Recipe.sharedMealPlanItems` (164) and `Household.sharedMealPlans` (243). Open the follow-up ticket now (see §8, step 8).

---

## 2. Full reference inventory (grep-verified)

Every remaining reference after the edits above must be **zero** except the four schema lines and the historical migration. Command used:

```
grep -rn -E "sharedMealPlan|SharedMealPlan|savedPlan|SavedPlan|listByHousehold|addItem|removeItem|CreatePlanItemDto|CreateWeeklyPlanDto|SAVE_PLAN|weeklyPlans:create" \
  --include='*.ts' --include='*.prisma' --include='*.sql' --include='*.json' --include='*.md' . | grep -v node_modules | grep -v '/dist/'
```

| File                                                                           | Lines                                                                                        | Action                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------- |
| `src/weekly-plans/weekly-plans.gateway.ts`                                     | 13, 14, 20, 24–27, 35–50, 123–128, 236–253, 255–263, 276–303, 618–680, 702–709               | delete; 607–616 → shim           |
| `src/weekly-plans/weekly-plans.service.ts`                                     | 2, 9, 10, 14–18, 19, 114–127, 155–163, 165–277, 279–307, 792–797, 803–806, 857–919, 921–1079 | delete / edit                    |
| `src/weekly-plans/services/shopping-list.service.ts`                           | 44–47 (comment), 81–93, 105–144, 354–384                                                     | delete / rewrite                 |
| `src/weekly-plans/dto/save-shared-meal-plan.dto.ts`                            | whole file                                                                                   | delete                           |
| `src/weekly-plans/dto/save-shared-meal-plan.dto.spec.ts`                       | whole file                                                                                   | delete                           |
| `src/weekly-plans/dto/create-plan-item.dto.ts`                                 | whole file                                                                                   | delete                           |
| `src/weekly-plans/dto/create-weekly-plan.dto.ts`                               | whole file                                                                                   | delete                           |
| `src/weekly-plans/weekly-plans.service.spec.ts`                                | 168–173 (`sharedMealPlan`/`sharedMealPlanItem` mock delegates)                               | **keep as spies**, see §6.2      |
| `src/weekly-plans/services/shopping-list.service.spec.ts`                      | 66–71 (`poolItem`), 79–84 (`poolWith`), 95–97 (mock), 347–378 (two tests)                    | see §6.1                         |
| `src/notifications/notification-copy.util.ts`                                  | 13, 209–211                                                                                  | delete                           |
| `src/notifications/notification-copy.util.spec.ts`                             | 174–189                                                                                      | delete test                      |
| `src/households/dto/update-meal-times.dto.ts`                                  | 46–48                                                                                        | comment fix                      |
| `prisma/schema.prisma`                                                         | 164, 243, 565–592                                                                            | **keep** (follow-up)             |
| `prisma/migrations/20260216123000_restore_missing_domain_tables/migration.sql` | 18–90                                                                                        | **never edit** (applied history) |

**Confirmed clean — no work needed:**

- `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/prisma/seed.ts` — zero hits for `sharedMealPlan`; it does not seed pools.
- `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/scripts/ws-smoke.ts` — a generic `<event> <json>` CLI (`process.argv[2]`), hardcodes no event names.
- `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/test/smoke.e2e-spec.ts` — only touches `weeklyPlans:upsertWeekSlot` / `weeklyPlans:weekChanged` (lines 142, 204–213). **Unaffected.**
- No REST controller exists for weekly plans (only `weekly-plans.gateway.ts`), so there is no HTTP surface to deprecate.
- `weekly-plans.module.ts` needs no change (it lists services/gateway, not DTOs).

---

## 3. What happens to a client still emitting the removed events

`wsRespond` never runs — Nest only invokes it from a registered `@SubscribeMessage`. With no handler, **socket.io silently drops the packet and never calls the ack callback**. There is no catch-all handler and no `onAny` in the codebase (grep-verified).

iOS side, `/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals/Networking/Recipes/SocketIORecipeSocketClient.swift`:

- `ackTimeoutSeconds = 6` (line 10), `maxAckAttempts = 3` (line 11), 250 ms × attempt backoff (line 186).
- `requestAck` resolves with `"NO ACK"` on timeout → `RecipeDataError.serverError("Brak ACK dla eventu …")` → retried 3×.

So a removed event costs an old client **≈18.5 s**, then an error, **not** a `NOT_FOUND`/`HTTP_ERROR` ack. That matters only for `getSavedPlan`, because `/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals/Views/Dashboard/Calendar/CalendarView.swift:297-303` awaits it **before** the week load:

```swift
297	            .task(id: datesViewModel.weekStartISO) {
298	                await mealStore.loadSavedPlanFromBackend(weekStart: datesViewModel.weekStartISO)
299	                await mealStore.loadWeekPlanFromBackend(
300	                    weekStart: datesViewModel.weekStartISO,
301	                    dates: datesViewModel.dates
302	                )
303	            }
```

→ an un-updated phone would show an empty calendar for ~18 s on **every week switch**. Hence the shim in §1.1e. With the shim: one round-trip, `ok: true`, empty pool, zero DB load, and `mapSavedPlan` produces an empty `SavedMealPlan` — which is indistinguishable from today's behaviour, because **no shipped View reads `savedPlan`** (§5.0).

The other five events are unreachable from any shipped iOS build (grep over the whole iOS tree: no call sites for `weeklyPlans:listByHousehold`, `:create`, `:addItem`, `:removeItem`; `saveSavedPlan` is reachable only via `saveMealPlanToBackend`/`clearSavedPlanFromBackend`, which have zero callers). Hard removal is safe.

`weeklyPlans:savedPlanChanged` disappearing is a pure no-op for old clients: `observeSavedPlanChanges` just never fires, and `handleRemoteSavedPlanChanged` early-returns on `event.weekStart == observedSavedPlanWeekStart` anyway.

---

## 4. Data: SQL for dev and prod

Run with `docker exec -i weeklymeals-db psql -U weeklymeals -d weeklymeals` (creds from `docker-compose.yml:7-9`). On prod use the managed connection string; **run every SELECT first and paste the output into the PR.**

### 4.1 Inventory (read-only, run on dev AND prod)

```sql
SELECT
  (SELECT count(*) FROM "SharedMealPlan")                       AS pools,
  (SELECT count(*) FROM "SharedMealPlanItem")                   AS pool_items,
  (SELECT count(DISTINCT "householdId") FROM "SharedMealPlan")  AS households,
  (SELECT min("weekStart") FROM "SharedMealPlan")               AS oldest_week,
  (SELECT max("weekStart") FROM "SharedMealPlan")               AS newest_week;
```

### 4.2 The fallback case — weeks that a ghost list is actually being built from

A week is affected iff it has ≥1 `SharedMealPlanItem` **and** 0 `PlanItem`s (that is exactly the `else` branch removed in §1.3a).

```sql
SELECT s."householdId",
       s."weekStart"::date               AS week_start,
       count(si.id)                      AS pool_items,
       (s."weekStart"::date >= date_trunc('week', now())::date) AS is_current_or_future
FROM "SharedMealPlan" s
JOIN "SharedMealPlanItem" si ON si."sharedMealPlanId" = s.id
WHERE NOT EXISTS (
  SELECT 1
  FROM "WeeklyPlan" w
  JOIN "PlanItem" pi ON pi."weeklyPlanId" = w.id
  WHERE w."householdId" = s."householdId"
    AND w."weekStart"   = s."weekStart"
)
GROUP BY s.id, s."householdId", s."weekStart"
ORDER BY s."weekStart" DESC;
```

Expected on this dataset: **0 rows** (the pool has had no writer since Plan v2 shipped, and `clearWeekPlan` deletes it). Any row here is a household whose shopping list is about to change from "ghost items" to "empty" — if `is_current_or_future = true`, mention it in the release note.

Companion query — pool weeks that _do_ have day items (the pool is invisible there, deleting is a pure no-op):

```sql
SELECT count(*) FROM "SharedMealPlan" s
WHERE EXISTS (SELECT 1 FROM "WeeklyPlan" w JOIN "PlanItem" pi ON pi."weeklyPlanId"=w.id
              WHERE w."householdId"=s."householdId" AND w."weekStart"=s."weekStart");
```

### 4.3 Optional belt-and-braces stale mark (run **before** the DELETE)

Not required — §1.3b makes the read path self-heal on next open. Run it only if §4.2 returned rows and you want the snapshots corrected without waiting for a read:

```sql
UPDATE "ShoppingList" sl
SET "isStale" = true
WHERE EXISTS (
  SELECT 1 FROM "SharedMealPlan" s
  WHERE s."householdId" = sl."householdId" AND s."weekStart" = sl."weekStart"
);
```

### 4.4 Backup + delete (separate maintenance step, after §8 step 7)

```bash
# backup — the only irreversible part of this work
docker exec weeklymeals-db pg_dump -U weeklymeals -d weeklymeals \
  -t '"SharedMealPlan"' -t '"SharedMealPlanItem"' --data-only \
  > shared_meal_plan_backup_$(date +%Y%m%d).sql
```

```sql
BEGIN;
  DELETE FROM "SharedMealPlanItem";
  DELETE FROM "SharedMealPlan";
  -- expect: pool_items = 0, pools = 0
  SELECT (SELECT count(*) FROM "SharedMealPlan") AS pools,
         (SELECT count(*) FROM "SharedMealPlanItem") AS pool_items;
COMMIT;
```

`SharedMealPlanItem` has `onDelete: Cascade` from `SharedMealPlan` (schema.prisma:587), so `DELETE FROM "SharedMealPlan"` alone would suffice; the explicit child delete keeps the statement order obvious in the audit log.

**Not touched:** `ShoppingListArchive` rows are frozen snapshots — some were built from pool data and stay as-is by design.

**Rollback of §4.4:** `psql < shared_meal_plan_backup_*.sql`. Only meaningful together with a `git revert` of the code.

### 4.5 Follow-up migration (later ticket, NOT now)

```sql
-- prisma/migrations/2026XXXXXXXXXX_usuniecie_puli_tygodniowej/migration.sql
DROP TABLE "SharedMealPlanItem";
DROP TABLE "SharedMealPlan";
```

plus deleting schema.prisma lines 164, 243, 565–592. Ship only after telemetry shows `weeklyPlans:getSavedPlan` at zero and the shim (§1.1e) is removed.

---

## 5. iOS

### 5.0 Reachability finding (drives everything below)

Grep over the whole iOS tree for `\.savedPlan|hasSavedPlan|allRecipes\(\)|availableRecipes\(|availableCount\(|markAsSelected|markAsAvailable|cleanupCalendarAndSync|applySavedPlanToWeek|saveMealPlan|clearSavedPlan|loadSavedPlanFromBackend|MealPlanViewModel|PlanEntry|SavedMealPlan`, excluding the three files that define them, returns exactly **two** hits:

```
weekly meals/Models/Components/MealSlot.swift:16     (a doc comment)
weekly meals/Views/Dashboard/Calendar/CalendarView.swift:298
```

So: **no View renders the pool, and `MealPlanViewModel` is never instantiated.** The whole subsystem is dead weight — one network call per week switch plus a `saved_plan.json` file.

The project uses `fileSystemSynchronizedGroups` (`weekly meals.xcodeproj/project.pbxproj:69`) and contains **0** references to `MealPlanViewModel`/`SavedMealPlan` — deleting files from disk needs **no `.pbxproj` edit**.

### 5.1 `Views/Dashboard/Calendar/CalendarView.swift` — do this first

Path: `/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals/Views/Dashboard/Calendar/CalendarView.swift`

Delete line 298 (`await mealStore.loadSavedPlanFromBackend(...)`). The `.task` becomes a single `await mealStore.loadWeekPlanFromBackend(weekStart:dates:)`. **Side benefit:** removes one serial 6 s-timeout round-trip from every week switch.

### 5.2 `Models/Stores/WeeklyMealStore.swift`

Path: `/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals/Models/Stores/WeeklyMealStore.swift`

Delete, in this order (line numbers from the current file):

| Lines                        | Symbol                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4–8 (comment)                | fix the header: drop `SavedMealPlan (… PlanEntry / SavedMealPlan …)` from the companion-types list, keep `DayMealPlan`/`PlanMeal`                                                                                                                                                                                                                          |
| 17                           | `private(set) var savedPlan: SavedMealPlan = SavedMealPlan()`                                                                                                                                                                                                                                                                                              |
| 22                           | `private var observedSavedPlanWeekStart: String?`                                                                                                                                                                                                                                                                                                          |
| 24                           | `private var lastSavedPlanChangeVersionByWeek: [String: Int64] = [:]`                                                                                                                                                                                                                                                                                      |
| 26                           | `private var pendingSavedPlanReloadTask: Task<Void, Never>?`                                                                                                                                                                                                                                                                                               |
| 33                           | `var hasSavedPlan: Bool { !savedPlan.isEmpty }`                                                                                                                                                                                                                                                                                                            |
| 55–60                        | the `observeSavedPlanChanges { … }` registration in `init`                                                                                                                                                                                                                                                                                                 |
| 68                           | `loadSavedPlan()` in `init` → **replace** with `Self.deleteLegacySavedPlanFile()` (see 5.2a)                                                                                                                                                                                                                                                               |
| 161–163                      | the two-line comment + `syncSavedPlanSelectionFlagsWithCalendar()` inside `loadWeekPlanFromBackend`                                                                                                                                                                                                                                                        |
| 369–371                      | `savedPlan = SavedMealPlan()` + `saveSavedPlan()` inside `clearWeekFromBackend`                                                                                                                                                                                                                                                                            |
| 377–436                      | doc comment + `applySavedPlanToWeek(weekStart:dates:plan:householdMemberCount:)`                                                                                                                                                                                                                                                                           |
| 438–449                      | `// MARK: - Saved Plan API`, `saveMealPlan(_:)`, `clearSavedPlan()`                                                                                                                                                                                                                                                                                        |
| 450–469                      | `loadSavedPlanFromBackend(weekStart:)`                                                                                                                                                                                                                                                                                                                     |
| 470–496                      | `saveMealPlanToBackend(_:weekStart:)`                                                                                                                                                                                                                                                                                                                      |
| 497–500                      | `clearSavedPlanFromBackend(weekStart:)`                                                                                                                                                                                                                                                                                                                    |
| 506, 509, 511, 513, 515, 517 | inside `resetLocalPlanningState()`: the `savedPlan`, `observedSavedPlanWeekStart`, `lastSavedPlanChangeVersionByWeek`, `pendingSavedPlanReloadTask?.cancel()`, `pendingSavedPlanReloadTask = nil`, `saveSavedPlan()` lines. Keep `plans = [:]`, `observedWeekStart`, `observedWeekDates`, `lastWeekChangeVersionByWeek`, `pendingWeekReloadTask`, `save()` |
| 547–567                      | `handleRemoteSavedPlanChanged(event:)`                                                                                                                                                                                                                                                                                                                     |
| 579–586                      | `scheduleSavedPlanReload(weekStart:)`                                                                                                                                                                                                                                                                                                                      |
| 591–594                      | the `if let observedSavedPlanWeekStart { scheduleSavedPlanReload(…) }` block in `scheduleRefreshForObservedState()`                                                                                                                                                                                                                                        |
| 597–611                      | `mapSavedPlan(dto:)` (incl. nested `expand(slot:)`)                                                                                                                                                                                                                                                                                                        |
| 613–625                      | `calendarUsageCounts()` — only callers are the two functions below                                                                                                                                                                                                                                                                                         |
| 627–635                      | `syncSavedPlanSelectionFlagsWithCalendar()`                                                                                                                                                                                                                                                                                                                |
| 637–678                      | `cleanupCalendarAndSync(with:)`                                                                                                                                                                                                                                                                                                                            |
| 680–695                      | `syncEntries(_:usedCounts:)`                                                                                                                                                                                                                                                                                                                               |
| 697–704                      | `markAsSelected(_:slot:)`                                                                                                                                                                                                                                                                                                                                  |
| 706–712                      | `markAsAvailable(_:slot:)`                                                                                                                                                                                                                                                                                                                                 |
| 714–717                      | `mutateEntries(for:_:)`                                                                                                                                                                                                                                                                                                                                    |
| 744–767                      | `// MARK: - Saved Plan Persistence`, `savedPlanURL`, `saveSavedPlan()`, `loadSavedPlan()` → **replace** per 5.2a                                                                                                                                                                                                                                           |

**Keep untouched:** `plans`, `fileURL`/`save()`/`load()` (`meal_plans.json`), `dateKey`, `plan(for:)`, `meals(for:slot:)`, `allRecipes(for dates:)` (this is the store's own, different from `SavedMealPlan.allRecipes()`), `loadWeekPlanFromBackend`, `upsertWeekSlot`, `removeWeekSlot`, `setMealEaten`, `clearWeekFromBackend`, `resetLocalPlanningState`, `refreshObservedState`, `handleRemoteWeekPlanChanged`, `scheduleWeekReload`, `scheduleRefreshForObservedState`.

**5.2a — `saved_plan.json` one-shot cleanup.** Replace the deleted persistence block (744–767) with:

```swift
    // MARK: - Legacy cleanup

    /// `saved_plan.json` trzymał wycofaną pulę tygodniową (WP-03). Plik nie ma
    /// już czytelnika, więc kasujemy go raz, przy pierwszym starcie po
    /// aktualizacji — inaczej zostałby na dysku każdego użytkownika na zawsze.
    /// Błąd „nie ma pliku" jest normalnym przypadkiem i jest ignorowany.
    private static func deleteLegacySavedPlanFile() {
        let url = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("saved_plan.json")
        try? FileManager.default.removeItem(at: url)
    }
```

and call it from `init` where line 68 was. It is idempotent (`try?` swallows `NSFileNoSuchFileError`), so no "did we already run it" flag is needed.

### 5.3 `Models/Stores/WeeklyPlanStore.swift`

Path: `/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals/Models/Stores/WeeklyPlanStore.swift`

| Lines   | Symbol                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------- |
| 41–43   | `fetchSavedPlan`, `saveSavedPlan`, `observeSavedPlanChanges` from `protocol WeeklyPlanRepository` |
| 55–57   | the same three from `protocol WeeklyPlanTransportClient`                                          |
| 84–92   | `struct BackendSharedMealPlanDTO` + `struct BackendSharedMealPlanItemDTO`                         |
| 128–135 | `struct BackendSavedPlanChangedDTO`                                                               |
| 382–398 | `WebSocketWeeklyPlanTransportClient.fetchSavedPlan` (emits `weeklyPlans:getSavedPlan`)            |
| 400–425 | `.saveSavedPlan` (emits `weeklyPlans:saveSavedPlan`)                                              |
| 427–452 | `.observeSavedPlanChanges` (subscribes `weeklyPlans:savedPlanChanged`)                            |
| 536–549 | `ApiWeeklyPlanRepository.fetchSavedPlan` / `.saveSavedPlan` / `.observeSavedPlanChanges`          |

`WebSocketWeeklyPlanTransportClient` (187) and `ApiWeeklyPlanRepository` (454) are the **only** conformances in the tree (no test doubles, no preview mocks — grep-verified), so protocol and implementations can be cut in one pass.

**Note:** the shim in §1.1e means an _old_ app keeps working against the new backend; the _new_ app simply never emits the event.

### 5.4 `Models/Plans/SavedMealPlan.swift`

Path: `/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals/Models/Plans/SavedMealPlan.swift` (452 lines)

Delete lines **344–452**: `// MARK: - PlanEntry`, `struct PlanEntry`, `// MARK: - SavedMealPlan`, `struct SavedMealPlan` (with `entriesBySlot`, `isEmpty`, `entries(for:)`, `setEntries(_:for:)`, `updateEntries(for:_:)`, `allRecipes()`, `availableRecipes(for:)`, `availableCount(for:slot:)`), and `extension SavedMealPlan` (`SlotKey`, `init(from:)`, `encode(to:)`).

**Keep lines 1–343 verbatim**: `PlanMeal` (incl. its custom `init(from:)` back-compat decoding of `eatenByUserIds`/`plannedServings`) and `DayMealPlan` (incl. `DayKey`, `init(from:)`, `encode(to:)`). These are the live Plan v2 types.

Consider renaming the file to `PlanMeal.swift` in a **separate** commit — a rename plus a content change in one commit makes the diff unreadable and the `fileSystemSynchronizedGroups` project will pick either name up automatically.

### 5.5 `ViewModels/MealPlanViewModel.swift` — delete the whole file

Path: `/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals/ViewModels/MealPlanViewModel.swift` (142 lines). Never instantiated anywhere (`MealPlanViewModel(` has zero hits). `ViewModels/` retains `DatesViewModel.swift`.

`RecipesCategory.toMealSlot` survives — it is still used at `Models/Components/RecipesModel.swift:321` (`primarySlot`).

### 5.6 `Models/Stores/SessionStore.swift` — no change

Path: `/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals/Models/Stores/SessionStore.swift`. Lines 899 and 1099 call `weeklyMealStore?.resetLocalPlanningState()`; the method keeps existing with a shorter body (§5.2). No `savedPlan` reference in the file (grep-verified). Lines 451/463 wire `WebSocketWeeklyPlanTransportClient` → `ApiWeeklyPlanRepository` — unchanged.

### 5.7 `Models/Stores/PlanChangeNotificationService.swift` — keep, adjust one comment

Path: `/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals/Models/Stores/PlanChangeNotificationService.swift`

- Line 374–375 `case "SAVE_PLAN": return "\(actor) ustawił/a plan posiłków na ten tydzień."` — **keep for one release** (2 lines, guards a new-app-against-old-server rollout), remove together with the `getSavedPlan` shim.
- Line 348 comment mentions `SAVE_PLAN_SYNC` as an example of a technical broadcast the backend deliberately doesn't push. That action is no longer emitted; edit the comment to reference `SET_MEAL_EATEN` only, so it does not document a dead event.

### 5.8 `Models/Components/MealSlot.swift` — comment only

Line 16: `/// SavedMealPlan) — nie wolno go zmieniać bez migracji cache'u.` → drop the `SavedMealPlan` mention, keep the `meal_plans.json` warning (still true for `DayMealPlan`).

### 5.9 Compile-order dependencies

Swift compiles the whole module at once, so a partial edit is a broken build. Do all of §5 in **one commit**, and if you build incrementally, follow: **5.1 → 5.2 → 5.3 → 5.4 → 5.5**. Reverse order leaves `MealPlanViewModel.loadFromSaved(_ plan: SavedMealPlan)` (line 89) referencing a deleted type and `WeeklyMealStore.mapSavedPlan(dto: BackendSharedMealPlanDTO)` referencing a deleted DTO.

---

## 6. Tests

Repo pattern to follow (both existing specs): `Test.createTestingModule({ providers: [Service, { provide: PrismaService, useValue: makePrismaMock() }] })`, a plain object of `jest.fn()` delegates, and `$transaction: jest.fn().mockImplementation(cb => typeof cb === 'function' ? cb(mock) : Promise.all(cb))` — i.e. the callback receives the **same** mock.

### 6.1 `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/weekly-plans/services/shopping-list.service.spec.ts`

**Delete:** the `poolItem` helper (lines 66–71 with its 63–65 comment) and `poolWith` (79–84).

**Keep** the mock delegate (lines 95–97) — it becomes the regression _sensor_, and change its comment:

```ts
    // Wycofana pula tygodniowa (WP-03). Delegat zostaje wyłącznie po to, żeby
    // test mógł udowodnić, że NIKT go już nie woła.
    sharedMealPlan: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
```

**Delete two tests:**

- `it('powinno oprzeć listę na starej puli, gdy tydzień nie ma dni w Planie v2')` (349–361) — asserts the exact behaviour being removed.
- `it('powinno przedkładać dni Planu v2 nad starą pulę dla tego samego tygodnia')` (363–378) — superseded by the new case below.

**Adjust:** `it('powinno zwrócić pustą listę, gdy tydzień nie ma żadnego źródła')` (380–382) — keep as is; it already passes with `weeklyPlan.findUnique → null`.

**Add**, replacing the `// ─── Współistnienie ze starą pulą ───` section header with `// ─── Wycofana pula tygodniowa (WP-03) ───`:

```ts
it('nie powinno budować listy ze starej puli, gdy tydzień nie ma dni w Planie v2', async () => {
  prisma.weeklyPlan.findUnique.mockResolvedValue(null);
  prisma.sharedMealPlan.findUnique.mockResolvedValue({
    id: 'shared-1',
    householdId: mockHouseholdId,
    weekStart: new Date(mockWeekStart),
    items: [
      {
        id: 'p-1',
        recipe: { ingredients: [ingredient('Makaron', 200)], servings: 2 },
        quantity: 3,
      },
    ],
  });

  await expect(getList()).resolves.toEqual([]);
  expect(prisma.sharedMealPlan.findUnique).not.toHaveBeenCalled();
});
```

Input: 0 `PlanItem`s + a pool with 3× 200 g pasta. Expected output: `[]` (previously: one row `Makaron 600 g`), and the pool delegate untouched.

```ts
it('nie powinno pytać o starą pulę, gdy tydzień ma dni w Planie v2', async () => {
  prisma.weeklyPlan.findUnique.mockResolvedValue(
    weekPlanWith([dayItem('i-1', 2, 'LUNCH', [ingredient('Ziemniaki', 500)])]),
  );

  const items = await getList();

  expect(items).toHaveLength(1);
  expect(findItem(items, 'ziemniak').totalAmount).toBe(500);
  expect(prisma.sharedMealPlan.findUnique).not.toHaveBeenCalled();
});
```

```ts
it('powinno przebudować listę do pustej, gdy snapshot ma pozycje, a tydzień nie ma już źródła', async () => {
  // Widmowa lista z WP-03: snapshot zbudowany kiedyś z puli, dziś bez
  // pokrycia w PlanItem. `hasShoppingSourceData` musi odpowiedzieć „nie ma
  // źródła" i wymusić przebudowę, a nie zwrócić stary snapshot.
  prisma.shoppingList.findUnique.mockResolvedValue({
    id: 'sl-1',
    isStale: false,
    items: [
      {
        id: 'sli-1',
        productKey: 'makaron|g',
        name: 'Makaron',
        unit: 'g',
        department: 'OTHER',
        totalAmount: 600,
        isChecked: false,
      },
    ],
  });
  prisma.weeklyPlan.findUnique.mockResolvedValue(null);

  await expect(getList()).resolves.toEqual([]);
  expect(prisma.sharedMealPlan.findUnique).not.toHaveBeenCalled();
});
```

Input: non-stale snapshot with 1 item, no day plan. Expected: `[]` after rebuild (before this change it returned the ghost row when a pool existed). This is the direct regression test for §1.3b.

### 6.2 `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/weekly-plans/weekly-plans.service.spec.ts`

No existing test covers `listByHousehold`/`create`/`addItem`/`removeItem`/`getSharedMealPlan`/`saveSharedMealPlan` (verified: the 34 `it(` blocks cover only `upsertWeekSlot`, `removeWeekSlot`, `setMealEaten`, `clearWeekPlan`, `setShoppingItemChecked`, `getByHouseholdAndWeek`) — **nothing to delete.**

**Keep** the mock delegates at 168–173 as sensors and add, inside `describe('clearWeekPlan')` after the existing `it('powinno usunąć wszystkie sloty danego tygodnia')`:

```ts
it('nie dotyka już wycofanej puli tygodniowej', async () => {
  await service.clearWeekPlan(mockUserId, mockHouseholdId, mockWeekStart);

  expect(prisma.planItem.deleteMany).toHaveBeenCalled();
  expect(prisma.sharedMealPlan.findUnique).not.toHaveBeenCalled();
  expect(prisma.sharedMealPlanItem.deleteMany).not.toHaveBeenCalled();
});
```

Input: member of `hh-1`, week `2026-04-13` (a Monday — required by the strict `parseWeekStart`). Expected: `PlanItem.deleteMany` called, both pool delegates never called.

Add a new top-level `describe` guarding against re-introduction:

```ts
// ─── Wycofane API (WP-03) ─────────────────────────────────────────────────

describe('wycofane metody puli tygodniowej', () => {
  it.each([
    'listByHousehold',
    'create',
    'addItem',
    'removeItem',
    'getSharedMealPlan',
    'saveSharedMealPlan',
  ])('%s nie istnieje już w serwisie', (method) => {
    expect(
      (service as unknown as Record<string, unknown>)[method],
    ).toBeUndefined();
  });
});
```

### 6.3 `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/weekly-plans/dto/save-shared-meal-plan.dto.spec.ts`

Delete the file (7 cases across `describe('mergeSharedPlanRecipeIds')` and `describe('sharedPlanAddressedMealTypes')`). The behaviour it pins no longer has a producer.

### 6.4 `/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src/notifications/notification-copy.util.spec.ts`

Delete `it('zapis puli wygrywa z pojedynczymi slotami')` (lines 174–189) — it asserts `buildPlanSummary(... {action:'SAVE_PLAN'}) === 'Marek ustawił/a plan na ten tydzień.'`, which is the branch removed in §1.5. With the branch gone, the same input would fall through to the single-slot text and the test would fail.

### 6.5 E2E

`/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/test/smoke.e2e-spec.ts` — **no change**. Only `weeklyPlans:upsertWeekSlot` (line 213) and the `weeklyPlans:weekChanged` listener (line 206) are exercised.

---

## 7. Verification (no `tsc`/`jest`/`prisma` on the developer Mac)

### 7.1 Backend unit tests inside the API container

`jest.config.js` is **not** baked into the image (Dockerfile copies `src`, `test`, `prisma`, `tsconfig.json`, `tsconfig.build.json`, `package.json`, but not `jest.config.js`), so it must be copied every run. The image's `/app/node_modules` comes from `pnpm install --frozen-lockfile` without `--prod`, so `jest`/`ts-jest` are present.

```bash
cd "/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend"
docker cp ./src           weeklymeals-api:/app/src
docker cp ./jest.config.js weeklymeals-api:/app/jest.config.js
docker cp ./tsconfig.json  weeklymeals-api:/app/tsconfig.json

# full suite
docker exec weeklymeals-api npx jest --ci

# focused
docker exec weeklymeals-api npx jest src/weekly-plans --ci
docker exec weeklymeals-api npx jest src/notifications --ci
```

`jest.config.js` maps `households.service` → `<rootDir>/households/households.service.stub` (APFS-blocked file workaround) — copying the whole `src` keeps the stub in place; do not copy individual files.

**Type-check without local `tsc`:**

```bash
docker exec weeklymeals-api npx tsc --noEmit -p /app/tsconfig.json
```

This is the check that catches every unused-import regression from §1.2a (`noUnusedLocals` behaviour depends on `tsconfig.json`; ESLint's `@typescript-eslint/no-unused-vars` will catch the rest — run `docker exec weeklymeals-api npx eslint src/weekly-plans src/notifications`).

**Prisma client:** unchanged (no schema edit), so no `prisma generate` needed. If you later do §4.5, regenerate inside the container: `docker exec weeklymeals-api npx prisma generate`.

### 7.2 Runtime smoke against the container

```bash
# 1. removed event → no ACK (expect the CLI to hit its 5 s timeout and exit non-zero)
WS_URL=http://localhost:3000 WS_TIMEOUT_MS=5000 \
  pnpm tsx scripts/ws-smoke.ts weeklyPlans:listByHousehold \
  '{"userId":"<uuid>","householdId":"<uuid>"}'

# 2. shim → ok:true with an empty pool
pnpm tsx scripts/ws-smoke.ts weeklyPlans:getSavedPlan \
  '{"userId":"<uuid>","householdId":"<uuid>","weekStart":"2026-08-31"}'
# expect: {"ok":true,"data":{"weekStart":"2026-08-31","items":[]}}

# 3. live path unaffected
pnpm tsx scripts/ws-smoke.ts weeklyPlans:getByWeek \
  '{"userId":"<uuid>","householdId":"<uuid>","weekStart":"2026-08-31"}'
pnpm tsx scripts/ws-smoke.ts weeklyPlans:getShoppingList \
  '{"userId":"<uuid>","householdId":"<uuid>","weekStart":"2026-08-31"}'
```

(`scripts/ws-smoke.ts` runs from the host against the published port 3000; it is a thin `socket.io-client` wrapper and needs no repo build.)

### 7.3 iOS

```bash
cd "/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios"
xcodebuild -project "weekly meals.xcodeproj" -scheme "weekly meals" \
  -destination 'platform=iOS Simulator,name=iPhone 16' build | tail -40
```

Because the project uses `fileSystemSynchronizedGroups`, the two deleted files (§5.4 partial, §5.5 full) need no project-file surgery. Manual check afterwards: open Calendar, switch weeks back and forth — the week must render on the first frame (no 6 s pause), and `~/Library/Developer/CoreSimulator/.../Documents/saved_plan.json` must be gone after the first launch.

---

## 8. Ordered steps

| #   | Step                                                                                                                                                                                | Effort | Blocking |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| 1   | Run §4.1 + §4.2 on **dev and prod**; paste results into the PR. If §4.2 returns rows, list the affected households in the release note.                                             | 20 min | —        |
| 2   | **iOS** §5.1 → 5.9 in one commit; `xcodebuild` per §7.3.                                                                                                                            | 1.5 h  | 1        |
| 3   | **Backend** §1.1 – 1.5 (code) in one commit.                                                                                                                                        | 1.5 h  | —        |
| 4   | **Backend tests** §6.1 – 6.4.                                                                                                                                                       | 1 h    | 3        |
| 5   | Verify: §7.1 (`jest` + `tsc --noEmit` + `eslint` in `weeklymeals-api`), then §7.2 smoke.                                                                                            | 30 min | 3, 4     |
| 6   | Ship iOS **first** (TestFlight/App Store). The new app simply stops calling the pool; the old backend keeps working.                                                                | —      | 2        |
| 7   | Deploy the backend (steps 3–5). Old apps still work via the `getSavedPlan` shim.                                                                                                    | —      | 5, 6     |
| 8   | **Separate maintenance window, after prod verification:** §4.3 (optional) → §4.4 backup + DELETE. Open the follow-up ticket for §4.5 + shim removal + iOS `SAVE_PLAN` case removal. | 30 min | 7        |

**Total ≈ 5 h** (audit estimated 2 h backend + 1 h iOS; the extra covers tests and the staged data step).

---

## 9. Rollback

| Step                       | Rollback                                                                                                                                                                                                                                                           | Cost              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| 3–5 (backend code)         | `git revert <sha>`, rebuild + restart `weeklymeals-api`. **No schema change**, so the reverted code finds `SharedMealPlan`/`SharedMealPlanItem` exactly as it left them.                                                                                           | ~5 min            |
| 2 / 6 (iOS)                | `git revert <sha>` + a new build. Users on the shipped build are unaffected: they only stop calling a dead endpoint. `saved_plan.json` is gone after §5.2a — the reverted code recreates it empty on next save, which is harmless (the pool has no reader anyway). | one release cycle |
| 8 (data DELETE)            | `psql < shared_meal_plan_backup_YYYYMMDD.sql`. **This is the only step that needs a backup** — take it or do not run the DELETE.                                                                                                                                   | ~5 min            |
| §4.5 (future `DROP TABLE`) | Not revertible by `git revert` alone; requires a forward migration recreating both tables + `prisma generate`. **Do not bundle it with this work.**                                                                                                                | —                 |

**Data migration flags:** none in this PR (no Prisma migration file is added). The only SQL is the optional `UPDATE "ShoppingList" SET "isStale"=true` (§4.3, idempotent, non-destructive) and the deferred `DELETE` (§4.4, backed up). `prisma-migrate-deploy-safe.js` will find no new migration and is a no-op.
