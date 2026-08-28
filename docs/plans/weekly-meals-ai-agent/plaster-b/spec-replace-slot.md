# WP-05 — Server-side atomic slot replacement (`replaceRecipeId`)

**Goal:** one round-trip, one transaction, one broadcast for "Zmień przepis". Today iOS does `removeWeekSlot` → `upsertWeekSlot` (`WeeklyMealStore.swift:231-246`), which leaves an empty slot on the server if the second call fails, emits 2× `weekChanged` + 2× `shoppingListChanged`, and loses the old item's participants/servings/eaten marks unconditionally.

**Verified against current source (post-Plaster A):** `parseWeekStart` is already strict (`utils/week-formatting.util.ts:14-27`: regex + `getUTCDay() === 1` → `AppException('VALIDATION_ERROR', …, 400)`), so nothing here re-validates `weekStart`. `PlanItem` unique is `@@unique([weeklyPlanId, dayOfWeek, mealType, recipeId])` (`prisma/schema.prisma:379`); `PlanItemParticipant`/`PlanItemConsumption` cascade on `PlanItem` delete (`:391, :409`) — deleting the replaced item needs no manual child cleanup.

---

## 0. Decisions (fixed; implement exactly these)

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Where does the replace happen | Inside the **existing** `$transaction` in `upsertWeekSlot`, before the `existingItem` lookup | Keeps one tx, one `markShoppingListStale`, one ack; no new public method needed. `WeeklyPlansService.replaceSlot` is *not* added — `applyProposal` (later) calls `upsertWeekSlot` with `replaceRecipeId`. |
| D2 | `replaceRecipeId === recipeId` | **Ignore it** (treat as absent), do not throw | `PlanSlotPickerSheet.swift:454` passes `editing?.recipe.id`, which equals the picked recipe when the user re-picks the same meal to change only the audience. Throwing `VALIDATION_ERROR` there would break "Zapisz" for the commonest edit. Malformed (non-UUID) values still throw. |
| D3 | Participants when DTO omits `participantIds` and a replaced item exists | **Carry over the replaced item's participants**, intersected with current members, collapsing to `[]` when it names every member or becomes empty | "Zmień przepis" on a split slot (`Ania: sałatka` → `Ania: zupa`) must stay Ania's meal. DTO values always win when `participantIds` is present (even `[]` = explicit „Wspólne"). Intersecting with members prevents a WP-04 ghost from throwing `PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD` on a swap. |
| D4 | `plannedServings` on the replacement | `resolveUpdatedPlannedServings({ currentPlannedServings: replaced.plannedServings, currentParticipantIds: replaced.participants, nextParticipantIds: effectiveParticipantIds, memberCount, requested: dto.plannedServings })` | Reuses the shipped, spec-covered rule: explicit wins; unchanged audience keeps the stored value (manual "gotuję 4 porcje" survives the swap); a value equal to the old auto is recomputed. |
| D5 | `changeKind` | New literal `'REPLACED'`, returned from **both** branches whenever `replacedItemIds.length > 0` | The update branch could otherwise return `NOOP` while a row was actually deleted. |
| D6 | Broadcast | Unchanged: **one** `weeklyPlans:weekChanged` with `action: 'UPSERT_SLOT'`, one `shoppingListChanged` | `PlanChangeNotificationService.singleChangeText` (iOS `:361-378`) has **no `default:` branch** — a new action string like `REPLACE_SLOT` would silently drop the local notification on every installed build. Do not rename the action. |
| D7 | Push | `if (result?.changeKind === 'CREATED' \|\| result?.changeKind === 'REPLACED')` | Replacing a meal *is* news for the other member; today it reaches them as `REMOVE_SLOT` + `CREATED`. |
| D8 | P2002 on create | `AppException('CONFLICT', 'This recipe is already assigned to that day and meal slot', HttpStatus.CONFLICT)` | Mirrors `addItem` (`weekly-plans.service.ts:255-266`, which uses Nest's `ConflictException`); `AppException` yields the same wire `code: 'CONFLICT'` via `ws-response.ts:38-50` but is explicit about the code. Currently a concurrent same-recipe create surfaces as `INTERNAL_ERROR 500`. |
| D9 | `removeWeekSlot` | Untouched. Still the API for explicit removal and whole-slot clears | `WeeklyPlanView.swift:481, 495` and `WeeklyMealStore.swift:415` depend on it. |
| D10 | Migration | **None.** No schema change, no SQL, no backfill | Rollback = revert the commit; old clients keep working (D11). |
| D11 | Backward compat | Old iOS builds still send REMOVE+UPSERT; the new field is optional and absent → code path identical to today | No version gate, no feature flag. |

---

## 1. Backend

### 1.1 `src/weekly-plans/dto/upsert-week-slot.dto.ts` — add `replaceRecipeId`

Current tail (lines 55-60):
```ts
    55	  @IsOptional()
    56	  @IsInt()
    57	  @Min(1)
    58	  @Max(12)
    59	  plannedServings?: number;
    60	}
```
Insert **before** line 60 (`}`):
```ts

  /**
   * „Zmień przepis" w jednym wywołaniu: ten wariant znika ze slotu w tej
   * samej transakcji, w której powstaje `recipeId`. Bez tego pola klient
   * musiał wysłać REMOVE + UPSERT — dwa acki, a między nimi okno, w którym
   * slot na serwerze jest pusty (WP-05).
   *
   * Równe `recipeId` znaczy „nic nie podmieniaj" (arkusz edycji zna tylko
   * przepis, który właśnie edytuje, i wysyła go także wtedy, gdy użytkownik
   * zmienia samo audytorium).
   */
  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsOptional()
  @IsUUID()
  replaceRecipeId?: string;
```
`IsUUID` is already imported (line 9); no import change. Note `recipeId` itself is only `@IsString()` (line 29) — keep it that way; do not tighten it in this change.

> The WS path never runs these decorators (gateway envelopes `weekly-plans.gateway.ts:96-101` have no `@ValidateNested()`; documented at `weekly-plans.service.ts:686-702`), so the decorators are for Swagger/REST only. The real gate is 1.2.

### 1.2 `src/weekly-plans/weekly-plans.service.ts` — module-scope helpers

Add next to `sameMemberSet` (currently `:66-71`):
```ts
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * `replaceRecipeId` z payloadu WS nie przechodzi przez żaden pipe (koperty w
 * gatewayu nie mają dekoratorów), a trafia prosto do `where` Prismy na kolumnie
 * `@db.Uuid` — liczba albo „abc" wysadza zapytanie jako INTERNAL_ERROR 500
 * zamiast czytelnego 400.
 */
function parseReplaceRecipeId(
  value: unknown,
  recipeId: string,
): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppException(
      'VALIDATION_ERROR',
      'replaceRecipeId musi być identyfikatorem UUID',
      HttpStatus.BAD_REQUEST,
    );
  }
  // Ten sam przepis = zmiana audytorium, nie podmiana dania.
  return value === recipeId ? null : value;
}
```

### 1.3 `weekly-plans.service.ts` — `upsertWeekSlot` (line 309)

**(a) Before the transaction.** Current lines 315-331 end with `plannedServingsForCreate`. Append after line 331:
```ts
    const replaceRecipeId = parseReplaceRecipeId(dto.replaceRecipeId, dto.recipeId);
    // Audytorium podmienianego dania przejmuje nowe danie tylko wtedy, gdy
    // klient nic o audytorium nie powiedział. Zbiór domowników pobieramy przed
    // transakcją, bo `resolveParticipants` na tej gałęzi zwraca sam licznik.
    const memberIds =
      replaceRecipeId && dto.participantIds === undefined
        ? new Set(
            (
              await this.prisma.membership.findMany({
                where: { householdId },
                select: { userId: true },
              })
            ).map((m) => m.userId),
          )
        : null;
```

**(b) Inside the tx, after the `weeklyPlan` upsert (after line 355), before the `existingItem` lookup comment at line 357:**
```ts
      // Podmiana dania w slocie. Kasujemy STARY wariant w tej samej
      // transakcji, w której powstaje nowy — uczestnicy i znaczniki zjedzenia
      // lecą kaskadą (`schema.prisma`, `onDelete: Cascade`). Kolejność jest
      // istotna: limity niżej mają liczyć stan PO usunięciu, inaczej wymiana
      // dania w pełnym slocie (6 wariantów) kończyła się
      // PLAN_SLOT_VARIANT_LIMIT_REACHED, choć liczba dań się nie zmienia.
      let replacedItem: {
        id: string;
        plannedServings: number;
        participants: { userId: string }[];
      } | null = null;

      if (replaceRecipeId) {
        replacedItem = await tx.planItem.findFirst({
          where: {
            weeklyPlanId: weeklyPlan.id,
            dayOfWeek: dto.dayOfWeek,
            mealType: dto.mealType,
            recipeId: replaceRecipeId,
          },
          select: {
            id: true,
            plannedServings: true,
            participants: { select: { userId: true } },
          },
        });
        if (replacedItem) {
          await tx.planItem.delete({ where: { id: replacedItem.id } });
        }
      }

      // Audytorium i porcje przejęte po skasowanym daniu (D3/D4). Ghost po
      // byłym domowniku (WP-04) odsiewamy zamiast rzucać
      // PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD — inaczej takiego slotu nie dałoby
      // się już podmienić.
      let effectiveParticipantIds = participantIds;
      if (replacedItem && dto.participantIds === undefined && memberIds) {
        const carried = replacedItem.participants
          .map((p) => p.userId)
          .filter((id) => memberIds.has(id));
        effectiveParticipantIds =
          carried.length === 0 || carried.length === memberIds.size
            ? []
            : carried;
      }
      const plannedServingsAfterReplace = replacedItem
        ? this.resolveUpdatedPlannedServings({
            currentPlannedServings: replacedItem.plannedServings,
            currentParticipantIds: replacedItem.participants.map((p) => p.userId),
            nextParticipantIds: effectiveParticipantIds,
            memberCount,
            requested: dto.plannedServings,
          })
        : plannedServingsForCreate;
```

**(c) Update branch (existing recipe already in the slot).** Replace `nextParticipantIds: participantIds` at line 386 with `nextParticipantIds: effectiveParticipantIds`, line 399 `participantIds.map(...)` with `effectiveParticipantIds.map(...)`, line 418 `sameMemberSet(currentParticipantIds, participantIds)` with `sameMemberSet(currentParticipantIds, effectiveParticipantIds)`, and the return at 420-425:
```ts
   420	        return {
   421	          ...withPlanItemRelationIds(updatedItem),
   422	          changeKind: detailsChanged
   423	            ? ('DETAILS_CHANGED' as const)
   424	            : ('NOOP' as const),
   425	        };
```
becomes
```ts
        return {
          ...withPlanItemRelationIds(updatedItem),
          // Skasowany wariant to zmiana tygodnia nawet wtedy, gdy sam
          // trafiony item wygląda identycznie — NOOP zgasiłby push.
          changeKind: replacedItem
            ? ('REPLACED' as const)
            : detailsChanged
              ? ('DETAILS_CHANGED' as const)
              : ('NOOP' as const),
          replacedItemIds: replacedItem ? [replacedItem.id] : [],
        };
```

**(d) Create branch.** Line 478 `plannedServings: plannedServingsForCreate` → `plannedServings: plannedServingsAfterReplace`; line 480 `participantIds.map(...)` → `effectiveParticipantIds.map(...)`. Wrap the `tx.planItem.create` (lines 472-484) in try/catch mirroring `addItem:255-266`:
```ts
      let createdItem;
      try {
        createdItem = await tx.planItem.create({ /* …unchanged data… */ });
      } catch (error) {
        // Dwa telefony wstawiające ten sam przepis w ten sam slot trafiają
        // w @@unique([weeklyPlanId, dayOfWeek, mealType, recipeId]). Dotąd
        // wychodziło to jako INTERNAL_ERROR 500 (łapane tylko w `addItem`).
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new AppException(
            'CONFLICT',
            'This recipe is already assigned to that day and meal slot',
            HttpStatus.CONFLICT,
          );
        }
        throw error;
      }
```
Return (lines 492-495):
```ts
      return {
        ...withPlanItemRelationIds(createdItem),
        changeKind: replacedItem ? ('REPLACED' as const) : ('CREATED' as const),
        replacedItemIds: replacedItem ? [replacedItem.id] : [],
      };
```
`Prisma` and `AppException`/`HttpStatus` are already imported (`:7, :13, :2-6`).

### 1.4 `src/weekly-plans/weekly-plans.gateway.ts` — push gate (line 504-521)

Current:
```ts
   507	      // („Zmień przepis" idzie jako REMOVE_SLOT + CREATED i dalej powiadamia,
   508	      // bo bufor sklei te dwa zdarzenia w jedno zdanie.)
   509	      if (result?.changeKind === 'CREATED') {
```
New comment + condition:
```ts
      // („Zmień przepis" to teraz JEDEN upsert z `replaceRecipeId` → REPLACED;
      // dawniej REMOVE_SLOT + CREATED, czyli dwa rozgłoszenia i dwa wpisy
      // w buforze pushy. Akcja w rozgłoszeniu zostaje UPSERT_SLOT — starsze
      // iOS ma w `PlanChangeNotificationService.singleChangeText` switch bez
      // gałęzi domyślnej, więc nowy string zgasiłby powiadomienie.)
      if (result?.changeKind === 'CREATED' || result?.changeKind === 'REPLACED') {
```
No other gateway change. The `weekChanged` emit at `:487-503` and the `emitShoppingListChanged` at `:494-501` stay exactly as they are and now fire **once** per swap.

### 1.5 Call sites of `upsertWeekSlot` (backend, grep-verified)

- `src/weekly-plans/weekly-plans.gateway.ts:479` — WS (only live path).
- `src/weekly-plans/weekly-plans.controller.ts` — check with `grep -n "upsertWeekSlot" src/weekly-plans/weekly-plans.controller.ts`; if a REST route exists it passes the DTO through and needs no edit (global `ValidationPipe` now also validates `replaceRecipeId`).
- `src/weekly-plans/weekly-plans.service.spec.ts:196, 217, 253, …` (fixtures; extended in §3).
No other caller. `resolveUpdatedPlannedServings` gains no new caller outside this method.

---

## 2. iOS

### 2.1 `Models/Stores/WeeklyPlanStore.swift` — protocols

Line 34 (`WeeklyPlanRepository`):
```swift
    func upsertWeekSlot(weekStart: String, date: Date, mealSlot: MealSlot, recipeId: UUID, participantIds: [String], plannedServings: Int?) async throws -> WeekPlanSlot?
```
→ add `replaceRecipeId: UUID?` **after** `recipeId`:
```swift
    /// `replaceRecipeId` drops that variant from the slot in the SAME server
    /// transaction — „Zmień przepis" without an empty-slot window.
    func upsertWeekSlot(weekStart: String, date: Date, mealSlot: MealSlot, recipeId: UUID, replaceRecipeId: UUID?, participantIds: [String], plannedServings: Int?) async throws -> WeekPlanSlot?
```
Line 50 (`WeeklyPlanTransportClient`): same insertion, `replaceRecipeId: String?`.

### 2.2 `WebSocketWeeklyPlanTransportClient.upsertWeekSlot` (line 261)

Signature gains `replaceRecipeId: String?`; after the `plannedServings` block (lines 274-276) add:
```swift
        // Wysyłamy tylko przy realnej podmianie. Serwer i tak ignoruje wartość
        // równą `recipeId`, ale nie ma po co jej wysyłać.
        if let replaceRecipeId, replaceRecipeId != recipeId {
            data["replaceRecipeId"] = replaceRecipeId
        }
```
No ack-shape change: `BackendPlanItemAckDTO` = `BackendWeeklyPlanItemDTO`, and the extra `changeKind`/`replacedItemIds` keys are ignored by `Codable`.

### 2.3 `ApiWeeklyPlanRepository.upsertWeekSlot` (line 488)

Add the parameter and forward `replaceRecipeId: replaceRecipeId?.uuidString` into the `client.upsertWeekSlot` call (line 492-499).

### 2.4 `Models/Stores/WeeklyMealStore.swift:193-246` — drop the double call

Current:
```swift
   230	        do {
   231	            if let replacingRecipeId, replacingRecipeId != recipe.id {
   232	                try await weeklyPlanRepository.removeWeekSlot(
   233	                    weekStart: weekStart,
   234	                    date: date,
   235	                    mealSlot: slot,
   236	                    recipeId: replacingRecipeId
   237	                )
   238	            }
   239	            let saved = try await weeklyPlanRepository.upsertWeekSlot(
   240	                weekStart: weekStart,
   241	                date: date,
   242	                mealSlot: slot,
   243	                recipeId: recipe.id,
```
New:
```swift
        do {
            // Jedno wywołanie zamiast REMOVE + UPSERT: serwer kasuje stary
            // wariant w tej samej transakcji (`replaceRecipeId`), więc nie ma
            // okna, w którym slot jest pusty, ani rollbacku „usunięte, ale nie
            // dodane". Rozgłoszenie i push też są pojedyncze.
            let saved = try await weeklyPlanRepository.upsertWeekSlot(
                weekStart: weekStart,
                date: date,
                mealSlot: slot,
                recipeId: recipe.id,
                replaceRecipeId: replacingRecipeId == recipe.id ? nil : replacingRecipeId,
                participantIds: participantIds,
                plannedServings: plannedServings
            )
```
Everything else in the method is unchanged: the optimistic update at `:210-226` (which already filters out `replacingRecipeId`) stays, and the single `catch` at `:270-275` (`setMeals(previous, …)`) now rolls back a genuinely atomic operation. Update the doc comment at `:178-179` to say the drop happens server-side.

### 2.5 Call sites (grep-verified; **no signature change for callers** — `replacingRecipeId` keeps its name/default)

- `Views/Dashboard/Recipes/Components/AddToPlanSheet.swift:691` `replacingRecipeId: replacing` — unchanged.
- `Views/Dashboard/WeeklyPlan/PlanSlotPickerSheet.swift:454` `replacingRecipeId: editing?.recipe.id` — unchanged (D2 covers the equal case).
- `PlanSlotPickerSheet.swift:473` (`saveAudienceOnly`), `WeeklyPlanView.swift:465` (`saveServings`), `CalendarView.swift:388`, `WeeklyMealStore.swift:406` (`applySavedPlanToWeek`) — omit `replacingRecipeId`, unchanged.
- Conformances to the two protocols: **only** `WebSocketWeeklyPlanTransportClient` (`WeeklyPlanStore.swift:187`) and `ApiWeeklyPlanRepository` (`:454`), wired in `SessionStore.swift:451-463`. There is **no** mock/preview transport for weekly plans: `StoreEnvironmentKeys.swift:14` uses `WeeklyMealStore()` with `weeklyPlanRepository == nil`, and `UnconfiguredRecipeSocketClient` (`Networking/Recipes/SocketIORecipeSocketClient.swift:224`) is only used by `RecipeCatalogStore.swift:57` and the shopping-list key (`StoreEnvironmentKeys.swift:25`). **Nothing else to update.**
- Optional polish (5 min): `Models/Stores/UserFacingErrorMapper.swift` — the mapper falls through to the raw server string, so a P2002 race would show English. Add before the `internal_error` rule (`:63`): `if lower.contains("already assigned to that day and meal slot") { return "Ten przepis jest już w tym slocie." }`.

---

## 3. Tests

### 3.1 `src/weekly-plans/weekly-plans.service.spec.ts` — extend the existing file

Fixture style is fixed by the file: `makePrismaMock()` (`:88-176`) with `jest.fn()` delegates and `$transaction` calling the callback with the same mock (`:169-175`); module built with `Test.createTestingModule({ providers: [WeeklyPlansService, ShoppingListService, { provide: PrismaService, useValue: prisma }] })` (`:186-196`). Two members (`mockUserId`, `mockOtherUserId`), `mockWeekStart = '2026-04-13'` (Monday).

Add after the `upsertWeekSlot — porcje na istniejącym itemie` block (ends `:497`):

```ts
describe('upsertWeekSlot — replaceRecipeId', () => { … });
```
with these cases. `oldRecipeId = 'recipe-uuid-2'`; both ids must be **valid UUIDs** now that `parseReplaceRecipeId` runs — introduce `const mockRecipeId = '11111111-1111-4111-8111-111111111111'` / `const mockOldRecipeId = '22222222-2222-4222-8222-222222222222'` (change the existing `mockRecipeId = 'recipe-uuid-1'` at `:12`; it is only used as an opaque string, so no other assertion breaks) — or keep `mockRecipeId` as is and only make `replaceRecipeId` a UUID. Prefer the latter (smaller blast radius): `const mockReplacedRecipeId = '22222222-2222-4222-8222-222222222222'`.

Helper inside the describe:
```ts
const mockReplacedRow = (plannedServings = 2, participantIds: string[] = []) =>
  prisma.planItem.findFirst
    .mockResolvedValueOnce({                        // 1st call = replaced item
      id: 'plan-item-old',
      plannedServings,
      participants: participantIds.map((userId) => ({ userId })),
    })
    .mockResolvedValueOnce(null);                   // 2nd call = target recipe
```

| `it(...)` | Input | Expected |
|---|---|---|
| `usuwa podmieniany wariant i tworzy nowy w JEDNEJ transakcji` | `mockReplacedRow(2, [])`; dto `{ dayOfWeek: 'MON', mealType: 'BREAKFAST', recipeId: mockRecipeId, replaceRecipeId: mockReplacedRecipeId }` | `prisma.planItem.delete` called with `{ where: { id: 'plan-item-old' } }`; `prisma.planItem.create` called; `prisma.$transaction` called **once**; result `expect.objectContaining({ changeKind: 'REPLACED', replacedItemIds: ['plan-item-old'] })` |
| `przejmuje audytorium po podmienianym daniu, gdy DTO go nie podaje` | `mockReplacedRow(1, [mockUserId])`; dto without `participantIds` | `create` called with `data: expect.objectContaining({ participants: { create: [{ userId: mockUserId }] }, plannedServings: 1 })` |
| `audytorium z DTO wygrywa z przejętym` | `mockReplacedRow(1, [mockUserId])`; dto `participantIds: [mockOtherUserId]` | `create` with `participants: { create: [{ userId: mockOtherUserId }] }`, `plannedServings: 1` |
| `jawne puste audytorium znaczy „Wspólne", nie „przejmij"` | `mockReplacedRow(1, [mockUserId])`; dto `participantIds: []` | `create` with `participants: { create: [] }`, `plannedServings: 2` |
| `ręcznie ustawione porcje przeżywają podmianę` | `mockReplacedRow(4, [])`; dto without `plannedServings`/`participantIds` | `create` with `plannedServings: 4` (audience unchanged → `resolveUpdatedPlannedServings` keeps it) |
| `porcje z reguły auto przeliczają się z przejętego audytorium` | `mockReplacedRow(2, [])`; dto `participantIds: [mockUserId]` | `create` with `plannedServings: 1` |
| `replaceRecipeId równe recipeId nie kasuje niczego` | `prisma.planItem.findFirst.mockResolvedValue({ id: mockPlanItem.id, plannedServings: 2, participants: [] })`; dto `{ …base, replaceRecipeId: mockRecipeId, plannedServings: 3 }` — note `recipeId` must be the same UUID | `prisma.planItem.delete` **not** called; `planItem.update` called; `changeKind: 'DETAILS_CHANGED'` (and with `plannedServings: 2` → `'NOOP'`) |
| `podmiana na przepis już obecny w slocie kasuje stary i aktualizuje trafiony` | `findFirst` → replaced row, then `{ id: mockPlanItem.id, plannedServings: 2, participants: [] }`; dto `{ recipeId: mockRecipeId, replaceRecipeId: mockReplacedRecipeId }` | `delete` called with old id; `planItem.update` called with `where: { id: mockPlanItem.id }`; `create` **not** called; `changeKind: 'REPLACED'` |
| `limity liczą się PO usunięciu podmienianego wariantu` | `prisma.planItem.count.mockResolvedValue(6)` (slot full at `MAX_VARIANTS_PER_SLOT`), replaced row present, target absent | resolves (no throw), `create` called. Contrast case: **without** `replaceRecipeId` and `count = 6` → `rejects.toThrow(AppException)` with `code: 'PLAN_SLOT_VARIANT_LIMIT_REACHED'`. *(Mock caveat: `count` is a single `jest.fn()` used for all three counters; a “post-delete” count is not naturally simulated — assert only that the call succeeds when a replacement is in flight, using `mockResolvedValue(5)` for the “would be 6 before delete” framing, and document the limitation in a comment. Real post-delete counting is exercised by the smoke test in §4.3.)* |
| `wyścig dwóch telefonów kończy się CONFLICT, nie INTERNAL_ERROR` | `prisma.planItem.create.mockRejectedValue(Object.assign(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' })))` | `rejects.toMatchObject({ response: { code: 'CONFLICT' } })` — import `Prisma` from `@prisma/client` at the top of the spec |
| `nie-UUID w replaceRecipeId to VALIDATION_ERROR, nie 500` | dto `replaceRecipeId: 'abc'` (cast `as any`) | `rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } })`; `prisma.$transaction` **not** called |
| `ghost po byłym domowniku nie blokuje podmiany` | `prisma.membership.findMany.mockResolvedValue([{ userId: mockUserId }])`; `mockReplacedRow(2, [mockUserId, 'ghost-user'])`; dto without `participantIds` | resolves; `create` with `participants: { create: [] }` (carried set == full member set → collapses to „Wspólne"), `plannedServings: 1` |

Also add to the fixtures: `prisma.planItem.delete` already exists (`:110`) — no mock additions needed beyond `membership.findMany` (`:92`, already returns both members).

### 3.2 `src/weekly-plans/weekly-plans.gateway.spec.ts` — **new file** (only gateway spec in the repo; no existing pattern to copy, follow the service spec's `Test.createTestingModule` shape)

```ts
const emit = jest.fn();
const weeklyPlansService = {
  getUserDisplayName: jest.fn().mockResolvedValue('Ania'),
  upsertWeekSlot: jest.fn(),
  removeWeekSlot: jest.fn(),
};
const notificationsService = { enqueueWeeklyPlanChange: jest.fn(), enqueueShoppingListChange: jest.fn() };
// module: providers [WeeklyPlansGateway,
//   { provide: WeeklyPlansService, useValue: weeklyPlansService },
//   { provide: ShoppingListService, useValue: {} },
//   { provide: NotificationsService, useValue: notificationsService },
//   { provide: WsTelemetryService, useValue: { onConnect: jest.fn(), onDisconnect: jest.fn() } }]
// then: (gateway as any).server = { emit };
```
Cases (`describe('weeklyPlans:upsertWeekSlot')`):
- `podmiana rozgłasza się RAZ, jako UPSERT_SLOT` — service returns `{ changeKind: 'REPLACED' }`; assert `emit` called exactly twice total (`weeklyPlans:weekChanged` once with `expect.objectContaining({ action: 'UPSERT_SLOT' })`, `weeklyPlans:shoppingListChanged` once) and **no** `REMOVE_SLOT` emit.
- `REPLACED wysyła push` — `notificationsService.enqueueWeeklyPlanChange` called once with `action: 'UPSERT_SLOT'`.
- `CREATED wysyła push` (regression) / `DETAILS_CHANGED i NOOP nie wysyłają` — `enqueueWeeklyPlanChange` not called.
Note the jest `moduleNameMapper` in `jest.config.js:24-26` redirects `households.service` to a stub; the gateway's import chain (`NotificationsService` → no households import, verified) is clean, so no extra mapping is needed.

---

## 4. Verification (nothing runs on the developer Mac)

`docker-compose.yml` has **no bind mount** for `src`, so the container must be fed with `docker cp`.

**4.1 Backend unit tests (inside `weeklymeals-api`)**
```
docker cp "/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src" weeklymeals-api:/app/src
docker cp "/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/jest.config.js" weeklymeals-api:/app/jest.config.js
docker exec weeklymeals-api npx jest src/weekly-plans/weekly-plans.service.spec.ts src/weekly-plans/weekly-plans.gateway.spec.ts
docker exec weeklymeals-api npx jest          # full suite before merge
```

**4.2 Type check / build (container only)**
```
docker exec weeklymeals-api npx tsc --noEmit -p tsconfig.json
```

**4.3 WS smoke (real DB, proves the atomicity and the caps-after-delete rule)**
```
docker compose exec api pnpm ws:smoke weeklyPlans:upsertWeekSlot \
  '{"userId":"<USER_ID>","householdId":"<HH_ID>","weekStart":"2026-08-31","data":{"dayOfWeek":"MON","mealType":"DINNER","recipeId":"<NEW>","replaceRecipeId":"<OLD>"}}'
docker compose exec api pnpm ws:smoke weeklyPlans:getByWeek \
  '{"userId":"<USER_ID>","householdId":"<HH_ID>","weekStart":"2026-08-31"}'
```
Expect: ack `ok:true`, `changeKind:"REPLACED"`, `replacedItemIds` length 1; the week contains `<NEW>` and not `<OLD>`; `participantIds` equal to the old item's. Repeat with `"replaceRecipeId":"abc"` → `code:"VALIDATION_ERROR"`, and with `replaceRecipeId == recipeId` → `DETAILS_CHANGED`/`NOOP`, no deletion.

**4.4 iOS**
```
xcodebuild -project "/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios/weekly meals.xcodeproj" \
  -scheme "weekly meals" -destination 'platform=iOS Simulator,name=iPhone 16' build
```
(there is no test target; `xcshareddata/xcschemes/weekly meals.xcscheme` is the only scheme). Manual pass on the simulator against the container: PlanSlotPickerSheet → edit a meal → pick a different recipe; the second device must receive exactly **one** `weekChanged` and one notification, and the slot must never flash empty.

---

## 5. Data migration / rollback

- **No schema change, no Prisma migration, no SQL.** `PlanItem`'s unique index and the cascades already do the work.
- **Rollback:** revert the backend commit — old clients (which still send REMOVE+UPSERT) and new clients degrade differently: a new iOS build against an old backend would send `replaceRecipeId`, which the old service silently ignores (unknown DTO key, no `forbidNonWhitelisted` on the WS path) → the old recipe would stay in the slot next to the new one. **Therefore ship backend first, iOS second**, and do not roll the backend back after the iOS build is released without also pinning the app version.
- Deleting the replaced `PlanItem` destroys its `PlanItemConsumption` rows (eaten marks) — same as today's REMOVE path, so no behaviour regression, but note it in the release notes.

---

## 6. Ordered steps & effort

| # | Step | Files | Effort |
|---|---|---|---|
| 1 | DTO field `replaceRecipeId` | `dto/upsert-week-slot.dto.ts` | 10 min |
| 2 | `UUID_PATTERN` + `parseReplaceRecipeId` | `weekly-plans.service.ts` (module scope) | 15 min |
| 3 | Pre-tx: parse + conditional `memberIds` load | `weekly-plans.service.ts:315-331` | 15 min |
| 4 | In-tx: find + delete replaced item, `effectiveParticipantIds`, `plannedServingsAfterReplace` | `weekly-plans.service.ts` after `:355` | 40 min |
| 5 | Both branches: use `effectiveParticipantIds`, `REPLACED`, `replacedItemIds` | `:383-425`, `:472-495` | 25 min |
| 6 | P2002 → `AppException('CONFLICT', …, 409)` around the create | `:472-484` | 15 min |
| 7 | Gateway push gate `CREATED \|\| REPLACED` + comment | `weekly-plans.gateway.ts:504-509` | 10 min |
| 8 | Service spec: 12 cases | `weekly-plans.service.spec.ts` (+ ~200 lines) | 60 min |
| 9 | New gateway spec: 4 cases | `weekly-plans.gateway.spec.ts` | 40 min |
| 10 | Run 4.1 + 4.2 + 4.3 | container | 20 min |
| 11 | iOS: both protocols + both conformances gain `replaceRecipeId` | `WeeklyPlanStore.swift:34, 50, 261, 488` | 20 min |
| 12 | iOS: drop the `removeWeekSlot` pre-call in `upsertWeekSlot` | `WeeklyMealStore.swift:230-246` (+doc `:178`) | 15 min |
| 13 | iOS optional: CONFLICT copy in `UserFacingErrorMapper` | `UserFacingErrorMapper.swift:63` | 5 min |
| 14 | Run 4.4 + manual two-device pass | Xcode + container | 30 min |

**Total ≈ 2 h backend + 45 min iOS + 50 min verification.** Steps 1-10 are shippable on their own (backend-only, no client change); 11-14 are a separate commit.