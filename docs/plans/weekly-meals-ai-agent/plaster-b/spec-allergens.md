# IMPLEMENTATION SPEC — A4 (allergen whitelist + macro clamps, backend) & A5 (union write-back, iOS)

Scope: `weakly-meals-backend` (`src/common/allergens.ts`, `src/users/*`) + `weekly-meals-ios` (`SettingsView`, `WelcomeView`, `SessionStore`). No Prisma schema change, no Prisma migration. One optional data-cleanup SQL (Step 5) that **must run before** the iOS union write-back reaches users — rationale in §0.3.

---

## 0. Facts verified in the current source (not the audit text)

| Fact | Location |
|---|---|
| Allergen storage: no whitelist, only trim/lowercase/dedupe/sort | `src/users/users.service.ts:278-286` |
| Macros pass through raw, `null` preserved | `src/users/users.service.ts:302-315` |
| DTO **already has** `@Min/@Max` on `proteinG` (0..400), `fatG` (0..300), `carbsG` (0..800) with `@ValidateIf(value !== null)` | `src/users/dto/update-preferences.dto.ts:69-106` |
| DTO allergens: `@IsArray @ArrayUnique @ArrayMaxSize(32) @IsString({each}) @MaxLength(64,{each})` — **no `@IsIn`** | `src/users/dto/update-preferences.dto.ts:42-52` |
| WS payload class is a plain class, no `@ValidateNested()/@Type()` → **none of the DTO decorators run on the only live transport** | `src/users/users.gateway.ts:29-32`; no `@Controller` in `src/users` (controllers exist only in auth/observability/integrations) |
| `AppException(code, message, status, details?)`, `wsRespond` maps `code`/`message`/`status` into `{ok:false,...}` | `src/common/app-exception.ts:4-19`, `src/common/ws-response.ts:53-72` |
| `VALIDATION_ERROR` already in the union | `src/common/app-error-code.ts:5` |
| Plaster-A house style for a validation throw (mirror it) | `src/weekly-plans/utils/week-formatting.util.ts:35-41` |
| `UserPreference.allergens String[] @default([])`, macros `Int?` | `prisma/schema.prisma:63,70-72` |
| iOS `Allergen` raw values (exactly 7, no custom `rawValue` overrides) | `Models/Components/DietPreference.swift:118-126`: `gluten, lactose, eggs, nuts, peanuts, fish, soy` |
| `class-validator@0.14.3` `IsIn(values: readonly any[], …)` → a `as const` tuple is accepted without a spread/cast | `node_modules/class-validator/types/decorator/common/IsIn.d.ts:10` |
| **No** `src/users/users.service.spec.ts` exists | `ls src/users` → `dto/ users.gateway.ts users.module.ts users.service.ts` |
| `allergens` appears nowhere else in backend `src/`, `prisma/`, `scripts/`, `test/` — the service is the only writer | `grep -rn allergens --include=*.ts src prisma scripts test` |

### 0.1 iOS call sites of the allergen CSV (complete grep)
| File:line | Role |
|---|---|
| `SessionStore.swift:1725` | key constant `settings.diet.allergens` |
| `SessionStore.swift:1794-1800` | **read from server** → lowercase+sort+join; keeps unknowns (correct today) |
| `SessionStore.swift:1864-1873` | **write to server** → lowercase+sort; mirrors to AppStorage; no dedupe |
| `SessionStore.swift:1525` | wipe on logout |
| `SettingsView.swift:25` | `@AppStorage allergensRaw` |
| `SettingsView.swift:316-320` | `selectedAllergens` — `compactMap { Allergen(rawValue:) }` **drops unknowns** |
| `SettingsView.swift:366-377` | `toggleAllergen` — rebuilds CSV **from known only** → unknowns deleted locally |
| `SettingsView.swift:1267` | debounced sync sends `selectedAllergens.map(\.rawValue)` → unknowns deleted server-side |
| `SettingsView.swift:1282` | `hasCustomisedPreferences` ignores unknowns |
| `SettingsView.swift:1291` | `dietPreferencesSyncToken` (uses `allergensRaw`, so it does fire on unknown-only changes) |
| `SettingsView.swift:1925` | reset button clears CSV (intentional, keep) |
| `WelcomeView.swift:107-113` | init reads CSV → `Set<Allergen>`, **drops unknowns** |
| `WelcomeView.swift:321-329` | step 2/3 write `allergens.map(\.rawValue).sorted()` → unknowns deleted |
| `WelcomeStep3PreferencesView.swift:17-23,138-150` | chip toggle over `ForEach(Allergen.allCases)` — no change needed |
| `RecipePersonalization.swift:66-70` | `allergens(from:)` compactMap — **read-only filter path, correct as-is, do not touch** |
| `RecipesView.swift:48,96`, `PlanSlotPickerSheet.swift:61,110` | read-only consumers of the CSV — no change |

### 0.2 The two changes interact — deploy order is load-bearing
With a strict whitelist, `updatePreferences` rejects the **whole** payload (diet, kcal, goal, macros) if any allergen id is unknown. iOS union write-back echoes back whatever the server sent. Therefore a legacy row containing junk (`"anything"`, an old `shellfish`, a typo) would make the Settings sheet permanently unsavable for that user once both halves ship.

**Order: (1) backend whitelist + clamps deploy → (2) data cleanup SQL → (3) iOS union build.** After (2) every stored value is whitelisted, so the echo is always valid.

### 0.3 Rejected alternative (documented so nobody re-litigates it)
"Read the existing row and allow ids already stored, reject only newly-added unknowns." Costs an extra `userPreference.findUnique` on every preferences write, makes the rule state-dependent (untestable as a pure function), and leaves junk in the DB forever. Rejected in favour of the one-off SQL.

---

## 1. NEW FILE — `src/common/allergens.ts`

Why: single source of truth for the id vocabulary, shared by the service (WS path) and the DTO (HTTP path), mirroring `src/common/meal-types.ts:8-43` (`…_IN_ORDER as const` + `_VALUES: string[]` + `isX()` type guard).

```ts
import { HttpStatus } from '@nestjs/common';
import { AppException } from './app-exception';

/**
 * Slownik alergenow. Te siedem wartosci to DOKLADNIE `rawValue` enuma
 * `Allergen` z iOS (`Models/Components/DietPreference.swift:118-126`) —
 * kolumna `UserPreference.allergens` jest `String[]`, wiec baza nie pilnuje
 * niczego i bez tej listy w bazie ladowalo dowolne slowo (WebSocket nie
 * uruchamia walidatorow z DTO — patrz `weekly-plans.service.ts:688-696`).
 *
 * Dodanie wartosci (celery / mustard / sesame) MUSI wyjsc na produkcje
 * ZANIM klient iOS zacznie ja wysylac — inaczej serwer odrzuci caly zapis
 * preferencji tego uzytkownika.
 */
export const ALLERGEN_IDS = [
  'gluten',
  'lactose',
  'eggs',
  'nuts',
  'peanuts',
  'fish',
  'soy',
] as const;

export type AllergenId = (typeof ALLERGEN_IDS)[number];

/** Mutowalna kopia dla `@IsIn` i `@ApiProperty({ enum })`. */
export const ALLERGEN_ID_VALUES: string[] = [...ALLERGEN_IDS];

export function isAllergenId(value: unknown): value is AllergenId {
  return typeof value === 'string' && ALLERGEN_ID_VALUES.includes(value);
}

/**
 * trim → lowercase → odrzuc puste → deduplikuj → posortuj, a nieznane id
 * ZGLOS zamiast po cichu wyrzucic: klient, ktory wysyla „shellfish", ma sie
 * o tym dowiedziec, a nie myslec, ze uzytkownik jest chroniony.
 */
export function normalizeAllergenIds(values: readonly string[]): AllergenId[] {
  const cleaned = Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
        .filter(Boolean),
    ),
  ).sort();

  const unknown = cleaned.filter((value) => !isAllergenId(value));
  if (unknown.length > 0) {
    throw new AppException(
      'VALIDATION_ERROR',
      `Nieznane alergeny: ${unknown.join(', ')}`,
      HttpStatus.BAD_REQUEST,
      { field: 'allergens', unknown, allowed: ALLERGEN_ID_VALUES },
    );
  }

  return cleaned as AllergenId[];
}
```

Notes: dedupe happens **before** the whitelist check so `['Gluten','gluten ']` → `['gluten']` (one entry, no error). `details` is surfaced to iOS through `AppException` → but note `wsRespond` (`ws-response.ts:62-67`) only forwards `error`/`code`/`status`, **not** `details` — the unknown ids reach the client inside the message string, which is why the message enumerates them.

---

## 2. `src/users/users.service.ts` — three edits

### 2.1 Imports (top of file, after line 11)
Current `src/users/users.service.ts:1-11` ends with the `avatar-color.util` import. Add:
```ts
import { HttpStatus } from '@nestjs/common';      // extend the existing line 1 import
import { AppException } from '../common/app-exception';
import { normalizeAllergenIds } from '../common/allergens';
```
(line 1 is currently `import { Injectable, NotFoundException } from '@nestjs/common';` → becomes `import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';`)

### 2.2 Macro bound constants — after line 18
Current:
```
16: const ACTIVITY_LEVEL_MIN = 1;
17: const ACTIVITY_LEVEL_MAX = 4;
18: const ACTIVITY_LEVEL_DEFAULT = 2;
```
Append:
```ts
// Gorne granice makr. Te same liczby stoja w `@Min/@Max` DTO
// (`update-preferences.dto.ts:69-106`), ale DTO nie ma jak zadzialac na
// WebSockecie, wiec twarde przyciecie musi byc tutaj.
const PROTEIN_G_MAX = 400;
const FAT_G_MAX = 300;
const CARBS_G_MAX = 800;
```

### 2.3 Allergens — replace lines 278-286
Current:
```
278:    if (data.allergens !== undefined) {
279:      const normalised = Array.from(
280:        new Set(
281:          data.allergens.map((a) => a.trim().toLowerCase()).filter(Boolean),
282:        ),
283:      ).sort();
284:      update.allergens = normalised;
285:      create.allergens = normalised;
286:    }
```
New:
```ts
    if (data.allergens !== undefined) {
      // Rzuca VALIDATION_ERROR na nieznanych id — patrz `common/allergens.ts`.
      const normalised = normalizeAllergenIds(data.allergens);
      update.allergens = normalised;
      create.allergens = normalised;
    }
```

### 2.4 Macros — replace lines 302-315
Current:
```
302:    // Makra przechodza jak sa, lacznie z `null` — to jest sygnal „wroc do
303:    // liczenia automatem", a nie brak wartosci.
304:    if (data.proteinG !== undefined) {
305:      update.proteinG = data.proteinG;
306:      create.proteinG = data.proteinG;
307:    }
308:    if (data.fatG !== undefined) {
309:      update.fatG = data.fatG;
310:      create.fatG = data.fatG;
311:    }
312:    if (data.carbsG !== undefined) {
313:      update.carbsG = data.carbsG;
314:      create.carbsG = data.carbsG;
315:    }
```
New:
```ts
    // `null` przechodzi nietkniete — to jest sygnal „wroc do liczenia
    // automatem", a nie brak wartosci. Liczby przycinamy jak `calorieGoal`,
    // bo na WebSockecie `@Min/@Max` z DTO nigdy sie nie uruchamiaja.
    if (data.proteinG !== undefined) {
      const value = clampMacro(data.proteinG, PROTEIN_G_MAX, 'proteinG');
      update.proteinG = value;
      create.proteinG = value;
    }
    if (data.fatG !== undefined) {
      const value = clampMacro(data.fatG, FAT_G_MAX, 'fatG');
      update.fatG = value;
      create.fatG = value;
    }
    if (data.carbsG !== undefined) {
      const value = clampMacro(data.carbsG, CARBS_G_MAX, 'carbsG');
      update.carbsG = value;
      create.carbsG = value;
    }
```

### 2.5 New module-scope helper — place directly under the constants added in 2.2
```ts
/**
 * `null` zostaje `null`. Liczba jest zaokraglana i przycinana do 0..max.
 * Cokolwiek innego (string, NaN, Infinity — WebSocket przepusci wszystko)
 * jest bledem klienta, nie wartoscia do zapisania.
 */
function clampMacro(
  value: number | null,
  max: number,
  field: 'proteinG' | 'fatG' | 'carbsG',
): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppException(
      'VALIDATION_ERROR',
      `${field} musi byc liczba calkowita 0..${max} albo null`,
      HttpStatus.BAD_REQUEST,
      { field },
    );
  }
  return Math.min(Math.max(Math.round(value), 0), max);
}
```

Design note: out-of-range **numbers** clamp (same posture as `calorieGoal:269-276` / `activityLevel:293-300` — the slider can only produce in-range values, so an out-of-range number is a bug, not user intent), while a wrong **type** throws. Unknown allergens throw rather than clamp because there is no safe "nearest" value and silently dropping an allergen is a safety issue.

---

## 3. `src/users/dto/update-preferences.dto.ts` — HTTP-path defence

Current lines 42-52 (`allergens`). Replace the decorator block:
```ts
  @ApiPropertyOptional({
    example: ['gluten', 'nuts'],
    enum: ALLERGEN_ID_VALUES,
    isArray: true,
    description:
      'Lowercase allergen IDs matching the iOS Allergen enum. ' +
      'Uwaga: te dekoratory NIE dzialaja na sciezce WebSocketu ' +
      '(payload gatewaya nie ma @ValidateNested) — twarda walidacja siedzi ' +
      'w UsersService.updatePreferences przez normalizeAllergenIds().',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @IsIn(ALLERGEN_IDS, { each: true })
  allergens?: string[];
```
Import changes: add `IsIn` to the `class-validator` import (line 2-15) and `import { ALLERGEN_IDS, ALLERGEN_ID_VALUES } from '../../common/allergens';` after line 16.

Also update the class docblock at lines 24-27 (`- allergens: at most 32 unique short strings`) → `- allergens: at most 32 ids from ALLERGEN_IDS; enforced server-side in the service because WS skips these decorators`.

Macro decorators (69-106) need **no** change — they already carry the same numbers as the new service clamps; add a one-line comment above `proteinG` pointing at `clampMacro` so the two stay in sync.

**Out of scope here** (audit A4 second half, `@ValidateNested()/@Type()` on `UsersPreferencesUpdatePayload`, `users.gateway.ts:29-32`): that is a cross-gateway change (same hole in `weekly-plans.gateway.ts`, `households.gateway.ts`, …) and must be done as one pattern-wide patch, not smuggled into this one. Leave `users.gateway.ts` untouched.

---

## 4. Tests

### 4.1 NEW `src/common/allergens.spec.ts` (pure, no Nest)
Pattern source: `src/weekly-plans/utils/week-formatting.util.spec.ts:16-29`.

```
describe('normalizeAllergenIds')
```
| `it` | input | expected |
|---|---|---|
| `powinno znormalizowac i posortowac znane id` | `[' Gluten ', 'SOY', 'eggs']` | `['eggs','gluten','soy']` |
| `powinno deduplikowac po normalizacji` | `['gluten','Gluten',' gluten']` | `['gluten']` |
| `powinno pomijac puste stringi` | `['gluten','', '   ']` | `['gluten']` |
| `powinno zwrocic pusta liste dla pustego wejscia` | `[]` | `[]` |
| `powinno odrzucic nieznane id jako VALIDATION_ERROR` (`it.each` over `'shellfish'`, `'celery'`, `'anything'`, `'GLUTEN_FREE'`) | `['gluten', <bad>]` | throws `AppException`; `getResponse()` `toMatchObject({ code:'VALIDATION_ERROR' })`; `(response as any).message` `toContain(<bad>)` |
| `powinno wymienic wszystkie nieznane id naraz` | `['zzz','aaa']` | message contains both `aaa` and `zzz` |

```
describe('isAllergenId')
```
| `it` | input → expected |
|---|---|
| `powinno rozpoznac 7 id` | each of `ALLERGEN_IDS` → `true` |
| `powinno odrzucic inne wartosci` | `'Gluten'`, `'celery'`, `''`, `null`, `42` → `false` |
| `powinno pilnowac kontraktu z iOS` | `expect(ALLERGEN_ID_VALUES).toEqual(['gluten','lactose','eggs','nuts','peanuts','fish','soy'])` — the guard that catches an accidental rename against `DietPreference.swift:119-125` |

### 4.2 NEW `src/users/users.service.spec.ts`
Pattern source: `src/weekly-plans/weekly-plans.service.spec.ts:1-5, 92-187` (module-level `makePrismaMock()` returning an `any` object of `jest.fn()` delegates + a `$transaction` that calls the callback with the same mock; `Test.createTestingModule({ providers: [Service, { provide: PrismaService, useValue: prisma }] })`; `afterEach(() => jest.clearAllMocks())`; Polish `it` names).

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/app-exception';

const mockUserId = 'user-1';

const mockPreferenceRow = {
  userId: mockUserId,
  dietPreference: 'NONE',
  calorieGoal: 2000,
  allergens: [] as string[],
  goal: 'HEALTHY',
  activityLevel: 2,
  proteinG: null as number | null,
  fatG: null as number | null,
  carbsG: null as number | null,
  pushPlanChanges: true,
  pushShoppingList: true,
  pushHousehold: true,
  pushQuietHours: true,
  timeZone: null as string | null,
};

const makePrismaMock = () => {
  const mock: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: mockUserId }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    userPreference: {
      findUnique: jest.fn().mockResolvedValue(mockPreferenceRow),
      create: jest.fn().mockResolvedValue(mockPreferenceRow),
      upsert: jest.fn().mockResolvedValue(mockPreferenceRow),
    },
    $transaction: jest.fn().mockImplementation((cbOrOps: any) => {
      if (typeof cbOrOps === 'function') return cbOrOps(mock);
      return Promise.all(cbOrOps);
    }),
  };
  return mock;
};
```
`beforeEach` builds the module exactly as in `weekly-plans.service.spec.ts:145-156`.

Assertion helper used throughout: `const arg = prisma.userPreference.upsert.mock.calls[0][0];` then assert on `arg.update` / `arg.create`.

```
describe('UsersService.updatePreferences — allergeny')
```
| `it` | input (`data`) | expected |
|---|---|---|
| `powinno znormalizowac, zdeduplikowac i posortowac znane alergeny` | `{ allergens: [' Gluten ', 'SOY', 'eggs', 'gluten'] }` | `upsert` called once; `update.allergens === ['eggs','gluten','soy']`; `create.allergens` identical |
| `powinno odrzucic nieznany alergen jako VALIDATION_ERROR` | `{ allergens: ['gluten','shellfish'] }` | `rejects.toThrow(AppException)`; caught `getResponse()` `toMatchObject({code:'VALIDATION_ERROR'})`; message contains `shellfish` |
| `nie powinno nic zapisac, gdy alergen jest nieznany` | `{ calorieGoal: 2200, allergens: ['celery'] }` | rejects **and** `expect(prisma.userPreference.upsert).not.toHaveBeenCalled()` — proves the whole payload is refused, i.e. no partial write |
| `powinno pozwolic wyczyscic liste pusta tablica` | `{ allergens: [] }` | `update.allergens === []` |
| `nie powinno ruszac alergenow, gdy pole nie przyszlo` | `{ calorieGoal: 2100 }` | `'allergens' in arg.update === false` |

```
describe('UsersService.updatePreferences — makra')
```
| `it` | input | expected |
|---|---|---|
| `powinno przyciac proteinG do 0..400` | `{ proteinG: 9999 }` / `{ proteinG: -50 }` (two `it.each` rows) | `400` / `0` |
| `powinno przyciac fatG do 0..300` | `{ fatG: 5000 }` / `{ fatG: -1 }` | `300` / `0` |
| `powinno przyciac carbsG do 0..800` | `{ carbsG: 99999 }` / `{ carbsG: -10 }` | `800` / `0` |
| `powinno zaokraglic wartosc ulamkowa` | `{ proteinG: 160.7 }` | `161` |
| `powinno zachowac null jako null` | `{ proteinG: null, fatG: null, carbsG: null }` | all three `=== null` (use `toBeNull()`, **not** falsy) |
| `powinno przepuscic wartosc w zakresie bez zmian` | `{ proteinG: 160, fatG: 61, carbsG: 254 }` | identical values |
| `nie powinno ruszac makr, ktore nie przyszly` | `{ proteinG: 160 }` | `'fatG' in arg.update === false && 'carbsG' in arg.update === false` |
| `powinno odrzucic wartosc nieliczbowa` | `{ proteinG: 'abc' as any }` and `{ fatG: Number.POSITIVE_INFINITY }` | `AppException` / `code: 'VALIDATION_ERROR'` |

```
describe('UsersService.updatePreferences — regresja pozostalych pol')
```
| `it` | input | expected |
|---|---|---|
| `powinno nadal przycinac calorieGoal 1200..3500` | `{ calorieGoal: 99 }` / `{ calorieGoal: 9999 }` | `1200` / `3500` |
| `powinno nadal przycinac activityLevel 1..4` | `{ activityLevel: 9 }` | `4` |
| `powinno zamienic pusty timeZone na null` | `{ timeZone: '   ' }` | `update.timeZone === null` |

---

## 5. Data migration (SQL, run in the container) — REQUIRED before the iOS build ships

Not a Prisma migration: no schema change, so `prisma/migrations/` stays untouched.

**5.1 Inspect (safe, read-only)**
```bash
docker compose exec db psql -U weeklymeals -d weeklymeals -c \
"SELECT v AS value, count(*) FROM \"UserPreference\" p, unnest(p.allergens) v \
 WHERE v <> ALL (ARRAY['gluten','lactose','eggs','nuts','peanuts','fish','soy']) \
 GROUP BY v ORDER BY 2 DESC;"
```
```bash
docker compose exec db psql -U weeklymeals -d weeklymeals -c \
"SELECT count(*) FROM \"UserPreference\" WHERE \"proteinG\" NOT BETWEEN 0 AND 400 \
 OR \"fatG\" NOT BETWEEN 0 AND 300 OR \"carbsG\" NOT BETWEEN 0 AND 800;"
```
If both return zero rows, skip 5.2/5.3 entirely and record that in the PR.

**5.2 Backup, then strip** (single psql session, wrapped in a transaction)
```sql
BEGIN;
CREATE TABLE "UserPreference_backup_20260828" AS
  SELECT "userId", allergens, "proteinG", "fatG", "carbsG" FROM "UserPreference";

UPDATE "UserPreference" p SET allergens = COALESCE((
    SELECT array_agg(DISTINCT v ORDER BY v) FROM unnest(p.allergens) v
    WHERE v = ANY (ARRAY['gluten','lactose','eggs','nuts','peanuts','fish','soy'])
  ), '{}')
WHERE EXISTS (SELECT 1 FROM unnest(p.allergens) v
              WHERE v <> ALL (ARRAY['gluten','lactose','eggs','nuts','peanuts','fish','soy']));

UPDATE "UserPreference" SET
  "proteinG" = LEAST(GREATEST("proteinG", 0), 400),
  "fatG"     = LEAST(GREATEST("fatG", 0), 300),
  "carbsG"   = LEAST(GREATEST("carbsG", 0), 800)
WHERE "proteinG" NOT BETWEEN 0 AND 400
   OR "fatG"     NOT BETWEEN 0 AND 300
   OR "carbsG"   NOT BETWEEN 0 AND 800;
COMMIT;
```
Note the macro `UPDATE` is null-safe: `LEAST/GREATEST` with a `NULL` argument yields `NULL`, and the `WHERE` never matches a `NULL` column, so "licz za mnie" rows are untouched.

**5.3 Rollback**
```sql
UPDATE "UserPreference" p SET allergens = b.allergens,
  "proteinG" = b."proteinG", "fatG" = b."fatG", "carbsG" = b."carbsG"
FROM "UserPreference_backup_20260828" b WHERE b."userId" = p."userId";
```
Drop the backup table only after the iOS build has been in the field for a release cycle. Rollback of the **code** is a plain revert — nothing in the DB depends on the new constants.

---

## 6. iOS — union write-back (A5)

Principle: `settings.diet.allergens` (the CSV) is the durable superset; the `Allergen` enum is only a *rendering* filter. Every write to the server = `known ∪ unknown`.

### 6.1 `Views/Dashboard/Settings/SettingsView.swift`

**(a) after line 320**, next to `selectedAllergens` — computed, not `@State`, because `allergensRaw` is `@AppStorage` and already re-publishes when `SessionStore.loadUserPreferences` rewrites the key mid-sheet; a `@State` mirror would go stale.

Current 316-320:
```
316:    private var selectedAllergens: Set<Allergen> {
317:        Set(allergensRaw
318:            .split(separator: ",")
319:            .compactMap { Allergen(rawValue: String($0)) })
320:    }
```
Replace/extend with:
```swift
    private var allergenTokens: [String] {
        allergensRaw
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty }
    }

    private var selectedAllergens: Set<Allergen> {
        Set(allergenTokens.compactMap { Allergen(rawValue: $0) })
    }

    /// Wartości, których ta wersja aplikacji nie zna — nowszy build dopisał
    /// je do konta i nie wolno ich skasować przy zwykłym stuknięciu w chip.
    /// Renderować ich nie ma jak (brak tytułu), więc tylko je przenosimy.
    private var unknownAllergens: [String] {
        Array(Set(allergenTokens.filter { Allergen(rawValue: $0) == nil })).sorted()
    }

    /// Pełny zestaw do wysyłki: znane ∪ nieznane, posortowany.
    private var allergensPayload: [String] {
        Array(Set(selectedAllergens.map(\.rawValue)).union(unknownAllergens)).sorted()
    }
```

**(b) `toggleAllergen`, lines 366-377** — current tail:
```
373:        allergensRaw = current
374:            .map(\.rawValue)
375:            .sorted()
376:            .joined(separator: ",")
```
New tail:
```swift
        allergensRaw = Array(Set(current.map(\.rawValue)).union(unknownAllergens))
            .sorted()
            .joined(separator: ",")
```

**(c) debounced sync, line 1267** — current `allergens: selectedAllergens.map(\.rawValue),` → `allergens: allergensPayload,`

**(d) `hasCustomisedPreferences`, line 1282** — current `|| !selectedAllergens.isEmpty` → `|| !allergenTokens.isEmpty` (otherwise a user whose only allergens are unknown to this build sees no "Wyczyść preferencje" button).

**(e) reset button, line 1925** — `allergensRaw = ""` stays as-is. Clearing everything is an explicit user action; it must clear unknowns too. Add a one-line comment saying so, because it is the one place where the union rule is deliberately not applied.

`dietPreferencesSyncToken` (line 1291) already interpolates `allergensRaw`, so (b) still fires the debounced save. No change.

### 6.2 `Views/Welcome/WelcomeView.swift`
Here a `@State` **is** required: the view holds `Set<Allergen>` (line 39) and never keeps the raw string.

**(a) after line 39** add:
```swift
    /// Wartości alergenów zapisane na koncie, których ten build nie rozumie.
    /// Trzymamy je, żeby zapis z kreatora nie skasował ustawienia zrobionego
    /// na nowszej wersji aplikacji (patrz `SettingsView.unknownAllergens`).
    @State private var unknownAllergens: [String]
```

**(b) init, replace lines 107-113**
```
107:        let storedAllergensRaw = defaults.string(forKey: "settings.diet.allergens") ?? ""
108:        let initialAllergens: Set<Allergen> = Set(
109:            storedAllergensRaw
110:                .split(separator: ",")
111:                .compactMap { Allergen(rawValue: String($0)) }
112:        )
113:        _allergens = State(initialValue: initialAllergens)
```
→
```swift
        let storedAllergensRaw = defaults.string(forKey: "settings.diet.allergens") ?? ""
        let storedTokens = storedAllergensRaw
            .split(separator: ",")
            .map { String($0).trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty }
        _allergens = State(initialValue: Set(storedTokens.compactMap { Allergen(rawValue: $0) }))
        _unknownAllergens = State(
            initialValue: Array(Set(storedTokens.filter { Allergen(rawValue: $0) == nil })).sorted()
        )
```

**(c) step 2/3 save, line 321** — current `let allergenRaws = allergens.map(\.rawValue).sorted()` →
```swift
        let allergenRaws = Array(Set(allergens.map(\.rawValue)).union(unknownAllergens)).sorted()
```
Line 326 (`allergens: allergenRaws,`) unchanged. `WelcomeStep3PreferencesView` needs **no** change (it binds `Set<Allergen>` only).

### 6.3 `Models/Stores/SessionStore.swift`
**(a) read path 1794-1800 — no change.** It already stores every server string verbatim; that is what makes the union possible.

**(b) write path, lines 1864-1873** — add dedupe so a caller passing duplicates cannot produce `"gluten,gluten"` in AppStorage (the DTO has `@ArrayUnique()` on the HTTP path but nothing enforces it over WS):
```
1865:            let normalised = allergens
1866:                .map { $0.lowercased() }
1867:                .sorted()
```
→
```swift
            let normalised = Array(Set(
                allergens
                    .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
                    .filter { !$0.isEmpty }
            )).sorted()
```

**(c) doc comment, lines 1830-1832** — current:
```
1830:    /// Push the supplied preferences slice to the backend. Pass only the
1831:    /// fields you want to change — the backend merges with the existing
1832:    /// row. Allergens, when supplied, replace the full set.
```
→ append:
```swift
    /// row. Allergens, when supplied, replace the full set — dlatego callerzy
    /// MUSZĄ wysyłać sumę „znane ∪ nieznane" (`SettingsView.allergensPayload`,
    /// `WelcomeView.unknownAllergens`). Wysłanie samych rozpoznanych wartości
    /// kasuje z konta alergen ustawiony na nowszej wersji aplikacji.
    /// Serwer odrzuca id spoza `src/common/allergens.ts` całym payloadem
    /// (`code: "VALIDATION_ERROR"`), więc nowa wartość enuma musi najpierw
    /// wyjść na backend.
```

**(d) error visibility (small, recommended)** — `saveUserPreferences` (`1907-1916`) does `let _: WsEnvelope<…> = try await socket.emitWithAck(…)` and only catches transport throws; an `ok:false` envelope is decoded successfully and silently ignored, so a `VALIDATION_ERROR` looks like a successful save while AppStorage keeps the rejected value. Change to bind the envelope and log on `!envelope.ok` (`#if DEBUG print` or whatever the file's existing logging idiom is — grep `os_log`/`print` in this file before choosing). Do **not** add user-facing UI in this plaster.

`RecipePersonalization.allergens(from:)` (`:66-70`) stays a `compactMap` — it is a *filter* input, and an unknown id genuinely cannot filter anything client-side.

---

## 7. Should celery / mustard / sesame go in now?

**Recommendation: NO — defer to the A1/A3 ingredient-tags work. Ship only the whitelist + clamps + union write-back here.**

What it would take if you did it anyway (~2 h, and it is genuinely small):
1. `DietPreference.swift:118-126` — 3 enum cases; `title` (`:129-139`) — `"Seler"`, `"Musztarda"`, `"Sezam"`. Chips render automatically (`SettingsView.swift:1855 ForEach(Allergen.allCases)`, `WelcomeStep3PreferencesView.swift:139`).
2. `RecipeDietProfile.swift` `Keywords` (`:321-435`) — three new stem arrays + three branches in `classify` (`:160-270`): `celeryStems = ["seler"]` (+ phrase carriers `bulion`, `kostka rosołowa`, `przyprawa uniwersalna`, `vegeta`), `sesameStems = ["sezam", "tahini", "hummus"]`, `mustardStems = ["musztard", "gorczyc"]` (+ `majonez` is a mustard carrier in most Polish brands).
3. `src/common/allergens.ts` — 3 entries in `ALLERGEN_IDS`, **deployed a release ahead of the iOS build** (§0.2), plus the spec row in 4.1 updated.
4. No DB migration (`String[]`).

Why defer:
- The three values only become *trustworthy* once `Ingredient.allergens` is curated (A1: 403 rows). Until then the celery chip is driven by a heuristic that provably misses the actual carriers — `bulion drobiowy`/`bulion warzywny` in 10 recipes and `przyprawa uniwersalna` (A9 rows 8-9). A chip that promises celery-safety and delivers 10 false negatives is worse than no chip; the file's own design note says exactly this (`DietPreference.swift:97-99`: *"chip, którego nie ma czym wypełnić, obiecuje ochronę, której nie dowozimy"*).
- Doing it now means writing the stems twice (Swift heuristic now, curated tags in A1) — the exact two-dictionary divergence A1 is meant to end.
- The one thing that genuinely **must** ship first is the union write-back (§6), because it has to be in the field *before* the enum grows. That is in this plaster. Adding the values themselves costs nothing later.

If you nonetheless want them now, sequence strictly: backend `ALLERGEN_IDS` deploy → wait for it to be live → iOS build with enum + stems + union.

---

## 8. Verification (nothing runs on the developer Mac)

Backend unit tests — jest inside the `api` container (`WORKDIR /app`; the runner image has full `node_modules` incl. ts-jest, but **no** `jest.config.js`, so it must be copied):
```bash
docker compose up -d api
docker cp "/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/src" weeklymeals-api:/app/src
docker cp "/Users/rafi/Desktop/Weekly Meals App/weakly-meals-backend/jest.config.js" weeklymeals-api:/app/jest.config.js
docker exec weeklymeals-api npx jest src/common/allergens.spec.ts src/users/users.service.spec.ts
docker exec weeklymeals-api npx jest            # full suite, regression
```
Type-check (no local `tsc`): `docker exec weeklymeals-api npx tsc -p tsconfig.json --noEmit`. Note this is currently the *only* place specs get type-checked (T2: `isolatedModules: true` makes ts-jest transpile-only, `tsconfig.build.json` excludes `*.spec.ts`) — so run it, or a signature typo in the new spec passes jest silently.

Behavioural smoke over the real WS path (this is what proves the DTO-vs-service split):
```bash
docker compose exec api pnpm ws:smoke users:preferences:update \
  '{"userId":"<USER_ID>","data":{"allergens":["gluten","shellfish"]}}'      # expect ok:false, code VALIDATION_ERROR
docker compose exec api pnpm ws:smoke users:preferences:update \
  '{"userId":"<USER_ID>","data":{"allergens":[" Gluten ","SOY"],"proteinG":9999,"fatG":-5,"carbsG":null}}'
docker compose exec api pnpm ws:smoke users:preferences:get '{"userId":"<USER_ID>"}'
# expect allergens ["gluten","soy"], proteinG 400, fatG 0, carbsG null
```
(Rebuild the image — `docker compose up -d --build api` — before the smoke, since it runs `dist/`, not the `docker cp`-ed `src/`.)

iOS — no test target exists (`weekly meals.xcodeproj` has one `PBXNativeTarget`, zero `XCTest` matches), so verification is a build plus a manual pass:
```bash
cd "/Users/rafi/Desktop/Weekly Meals App/weekly-meals-ios"
xcodebuild -project "weekly meals.xcodeproj" -scheme "weekly meals" \
  -destination "generic/platform=iOS Simulator" -sdk iphonesimulator build \
  ARCHS=arm64 CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=YES EXCLUDED_ARCHS=x86_64
```
Manual union check (5 min, simulator + psql), which is the only thing that actually proves A5:
1. `UPDATE "UserPreference" SET allergens = ARRAY['gluten','celery'] WHERE "userId" = '<USER_ID>';` — `celery` is temporarily whitelisted for the test, or run this step *before* the Step-5 cleanup.
2. Launch the app, open Ustawienia → Dieta i alergeny: only the *Gluten* chip is checked (celery is unrenderable) — expected.
3. Toggle *Jaja* on, wait ~1 s for the debounce.
4. `SELECT allergens FROM "UserPreference" WHERE "userId"='<USER_ID>';` → **expected `{celery,eggs,gluten}`**; on today's build it is `{eggs,gluten}`. That diff is the whole fix.
5. Tap "Wyczyść preferencje" → `{}` (unknowns cleared too, by design).

---

## 9. Ordered steps

| # | Step | Files | Effort | Gate |
|---|---|---|---|---|
| 1 | Create `src/common/allergens.ts` (§1) | 1 new | 20 min | — |
| 2 | Service: imports, macro constants, `clampMacro`, replace 278-286 and 302-315 (§2) | `users.service.ts` | 30 min | — |
| 3 | DTO: `@IsIn` + docblock/comment updates (§3) | `update-preferences.dto.ts` | 10 min | — |
| 4 | `src/common/allergens.spec.ts` (§4.1) | 1 new | 25 min | — |
| 5 | `src/users/users.service.spec.ts` (§4.2) | 1 new | 60 min | — |
| 6 | Container run: `npx jest` (targeted, then full) + `tsc --noEmit` (§8) | — | 15 min | **all green before merge** |
| 7 | Backend PR merged + deployed; `ws:smoke` on the deployed API (§8) | — | 15 min | backend live |
| 8 | Inspect SQL; if non-empty → backup + strip (§5) | — | 20 min | **must complete before step 11 ships** |
| 9 | iOS `SettingsView` union (§6.1 a–e) | `SettingsView.swift` | 30 min | — |
| 10 | iOS `WelcomeView` union (§6.2 a–c) + `SessionStore` (§6.3 a–d) | 2 files | 30 min | — |
| 11 | `xcodebuild` + manual union check (§8) | — | 25 min | **step 8 done** |
| 12 | Decide celery/mustard/sesame (§7) — recommended: park in the A1/A3 backlog, no code | — | 0 | — |

Total ≈ 4 h 30 min. Steps 1-6 are one backend PR; steps 9-11 are one iOS PR that must land after step 8.

Cross-references left deliberately open (do not fold in): `@ValidateNested()/@Type()` on WS payload classes (A4, gateway-wide pattern change), `Recipe.allergens` materialization + curated ingredient tags (A1/A3), Polish classifier stem fixes for granola/musli/zakwas (A2).