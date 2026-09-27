import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppException } from '../src/common/app-exception';
import { HouseholdsService } from '../src/households/households.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApplyWeekPlanDto } from '../src/weekly-plans/dto/apply-week-plan.dto';
import { UpsertWeekSlotDto } from '../src/weekly-plans/dto/upsert-week-slot.dto';
import {
  currentWeekStart,
  formatWeekStart,
} from '../src/weekly-plans/utils/week-formatting.util';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';

/**
 * Bezpieczna edycja porcji per osoba (workstream plan-portions-safe-editing).
 *
 * Gwarancje: zapis ze starego stanu nie cofa cudzej zmiany (pełna alokacja,
 * pełny stan tygodnia), a edycje porcji RÓŻNYCH osób nie kolidują. Przeploty
 * są sekwencyjne albo sterowane zamkiem tygodnia — bez zegarów.
 */
type Portion = { userId: string; servings: number; revision?: number };
type Item = {
  id: string;
  dayOfWeek: string;
  mealType: string;
  recipeId: string;
  participantIds: string[];
  plannedServings: number;
  portions: Portion[];
  revision?: number;
};
type Plan = { revision?: number; items: Item[] };

/** Operacja porcji jednej osoby — przed poprawką jej nie ma. */
type SetPortionApi = {
  setPortion: (
    userId: string,
    householdId: string,
    weekStart: string,
    input: {
      planItemId: string;
      userId: string;
      servings: number;
      expectedRevision: number;
    },
  ) => Promise<unknown>;
};

const WEEK_START = '2026-08-31';

jest.setTimeout(60_000);

describe('Porcje per osoba — bezpieczna edycja', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let weeklyPlans: WeeklyPlansService;
  let households: HouseholdsService;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  let dinner: { id: string };
  let dinnerB: { id: string };
  let dinnerC: { id: string };

  const codeOf = (error: unknown): string => {
    if (error instanceof AppException) {
      return (error.getResponse() as { code: string }).code;
    }
    return `ERROR ${String((error as Error)?.message ?? error).slice(0, 120)}`;
  };
  const attempt = (work: () => Promise<unknown>) =>
    Promise.resolve()
      .then(work)
      .then(
        () => 'OK',
        (error: unknown) => codeOf(error),
      );

  /**
   * Token tylko wtedy, gdy odczyt go dał — na kodzie sprzed poprawki odczyt
   * tokenu nie ma, więc test idzie dzisiejszą ścieżką bez tokenu i pokazuje
   * rzeczywistą utratę zmiany, a nie odrzucenie nieznanego pola.
   */
  const token = (revision: number | undefined) =>
    revision === undefined ? {} : { expectedRevision: revision };

  const byPerson = (portions: Portion[]) =>
    Object.fromEntries(portions.map((p) => [p.userId, p.servings]));

  const createUser = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@porcje-edycja.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  };

  const couple = async (label: string) => {
    const asia = await createUser(`Asia${label}`);
    const rafal = await createUser(`Rafal${label}`);
    const home = await prisma.household.create({
      data: { name: `${label} ${Date.now()}`, createdById: asia },
      select: { id: true },
    });
    createdHouseholdIds.push(home.id);
    await prisma.membership.createMany({
      data: [
        { userId: asia, householdId: home.id, role: 'OWNER' },
        { userId: rafal, householdId: home.id, role: 'MEMBER' },
      ],
    });
    return { asia, rafal, householdId: home.id };
  };

  const readPlan = async (userId: string, householdId: string) =>
    (await weeklyPlans.getByHouseholdAndWeek(
      userId,
      householdId,
      WEEK_START,
    )) as unknown as Plan;

  const itemOf = (plan: Plan, recipeId: string, day = 'TUE') =>
    plan.items.find(
      (item) => item.recipeId === recipeId && item.dayOfWeek === day,
    );

  /** Zapis slotu z polami kontraktu, których stary DTO nie zna. */
  const upsert = (
    userId: string,
    householdId: string,
    fields: Record<string, unknown>,
  ) =>
    weeklyPlans.upsertWeekSlot(userId, householdId, WEEK_START, {
      dayOfWeek: 'TUE',
      mealType: 'DINNER',
      ...fields,
    } as unknown as UpsertWeekSlotDto);

  const apply = (
    userId: string,
    householdId: string,
    fields: Record<string, unknown>,
  ) =>
    weeklyPlans.applyWeekPlan(
      userId,
      householdId,
      WEEK_START,
      fields as unknown as ApplyWeekPlanDto,
    );

  const setPortion = (
    actor: string,
    householdId: string,
    input: Parameters<SetPortionApi['setPortion']>[3],
  ) =>
    (weeklyPlans as unknown as SetPortionApi).setPortion(
      actor,
      householdId,
      WEEK_START,
      input,
    );

  const statusOf = (error: unknown): number | null =>
    error instanceof AppException ? error.getStatus() : null;

  const detailsOf = (error: unknown): string[] =>
    error instanceof AppException ? (error.details ?? []) : [];

  /** Odmowa jako wartość — do sprawdzenia kodu, statusu i `details`. */
  const refusal = (work: () => Promise<unknown>) =>
    Promise.resolve()
      .then(work)
      .then(
        () => {
          throw new Error('oczekiwana odmowa, a zapis przeszedł');
        },
        (error: unknown) => ({
          code: codeOf(error),
          status: statusOf(error),
          details: detailsOf(error),
        }),
      );

  const latch = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { open, opened };
  };

  /** Czeka, aż `n` innych sesji tej bazy stoi na blokadzie. */
  const waitUntilWaiting = async (n: number) => {
    for (let i = 0; i < 5_000; i += 1) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS "waiting" FROM pg_stat_activity
        WHERE "datname" = current_database()
          AND "wait_event_type" = 'Lock'
          AND "pid" <> pg_backend_pid()`;
      if (Number(row.waiting) >= n) return true;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return false;
  };

  /**
   * Przeplot sterowany zamkiem tygodnia: osobna transakcja trzyma zamek,
   * wszystkie `works` ruszają i stają na nim (sprawdzone w `pg_stat_activity`),
   * potem zamek puszcza — zapisy przechodzą po kolei w nieznanej kolejności.
   * Wynik każdego: 'OK' albo kod błędu.
   */
  const underWeekLock = async (
    householdId: string,
    works: (() => Promise<unknown>)[],
  ) => {
    const planId = (
      await prisma.weeklyPlan.findFirstOrThrow({
        where: { householdId },
        select: { id: true },
      })
    ).id;
    const held = latch();
    const release = latch();
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.weeklyPlan.update({
          where: { id: planId },
          data: { updatedAt: new Date() },
          select: { id: true },
        });
        held.open();
        await release.opened;
      },
      { timeout: 30_000 },
    );
    await held.opened;
    const results = works.map((work) => attempt(work));
    const allWaited = await waitUntilWaiting(works.length);
    release.open();
    await holder;
    return { allWaited, results: await Promise.all(results) };
  };

  const trio = async (label: string) => {
    const { asia, rafal, householdId } = await couple(label);
    const ola = await createUser(`Ola${label}`);
    await prisma.membership.create({
      data: { userId: ola, householdId, role: 'MEMBER' },
    });
    return { asia, rafal, ola, householdId };
  };

  /** Pozycja z alokacją we wtorek; zwraca jej odczyt (z tokenami). */
  const allocated = async (
    actor: string,
    householdId: string,
    portions: { userId: string; servings: number }[],
    recipeId = dinner.id,
  ) => {
    await upsert(actor, householdId, { recipeId, portions });
    return itemOf(await readPlan(actor, householdId), recipeId)!;
  };

  const portionToken = (item: Item, userId: string) =>
    item.portions.find((p) => p.userId === userId)!.revision!;

  const setPortionAck = (
    actor: string,
    householdId: string,
    input: Parameters<SetPortionApi['setPortion']>[3],
  ) =>
    setPortion(actor, householdId, input) as Promise<
      Item & { changeKind: string; planRevision: number }
    >;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    weeklyPlans = app.get(WeeklyPlansService);
    households = app.get(HouseholdsService);
    const found = await prisma.recipe.findMany({
      where: {
        isCatalog: true,
        isActive: true,
        allergens: { isEmpty: true },
        OR: [
          { suitableMealTypes: { has: 'DINNER' } },
          { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 3,
    });
    if (found.length < 3) throw new Error('katalog dev nie ma trzech kolacji');
    [dinner, dinnerB, dinnerC] = found;
  });

  afterAll(async () => {
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  describe('regresje (FAIL przed poprawką)', () => {
    it('A. dwa odczyty tej samej alokacji → dwa pełne zapisy z tego samego tokenu: drugi NIE cofa pierwszego', async () => {
      const { asia, rafal, householdId } = await couple('A');
      await upsert(asia, householdId, {
        recipeId: dinner.id,
        portions: [
          { userId: asia, servings: 0.8 },
          { userId: rafal, servings: 1.25 },
        ],
      });
      const seenByA = itemOf(await readPlan(asia, householdId), dinner.id)!;
      const seenByB = itemOf(await readPlan(rafal, householdId), dinner.id)!;
      // A: Rafał 1,5 (Asia bez zmian).
      const a = await attempt(() =>
        upsert(asia, householdId, {
          recipeId: dinner.id,
          ...token(seenByA.revision),
          portions: [
            { userId: asia, servings: 0.8 },
            { userId: rafal, servings: 1.5 },
          ],
        }),
      );
      // B ze swojego (starego) odczytu: Asia 1,0 — i stara porcja Rafała.
      const b = await attempt(() =>
        upsert(rafal, householdId, {
          recipeId: dinner.id,
          ...token(seenByB.revision),
          portions: [
            { userId: asia, servings: 1 },
            { userId: rafal, servings: 1.25 },
          ],
        }),
      );
      const final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      console.log(
        `[A] tokeny A=${seenByA.revision} B=${seenByB.revision} → A: ${a} → B: ${b} → stan ${JSON.stringify(byPerson(final.portions))}`,
      );
      expect(a).toBe('OK');
      expect(b).toBe('PLAN_REVISION_CONFLICT');
      expect(byPerson(final.portions)).toEqual({ [asia]: 0.8, [rafal]: 1.5 });
    });

    it('B. nieaktualny pełny stan applyWeekPlan nie usuwa pozycji DODANEJ ani nie cofa ZMIENIONEJ po odczycie', async () => {
      const { asia, rafal, householdId } = await couple('B');
      await upsert(asia, householdId, { recipeId: dinner.id });
      const seen = await readPlan(asia, householdId);

      // Po odczycie A: B dodaje środę i zmienia audytorium wtorku.
      await upsert(rafal, householdId, {
        dayOfWeek: 'WED',
        recipeId: dinnerB.id,
      });
      await upsert(rafal, householdId, {
        recipeId: dinner.id,
        participantIds: [rafal],
      });

      // A zapisuje pełny stan ze swojego odczytu (wtorek „Wspólne” + poniedziałek).
      const result = await apply(asia, householdId, {
        ...token(seen.revision),
        slots: [
          { dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: dinner.id },
          { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: dinnerC.id },
        ],
      });
      const after = await readPlan(asia, householdId);
      console.log(
        `[B] token=${seen.revision} → applied=${result.applied} violations=${JSON.stringify(result.violations.map((v) => v.code))} → pozycje ${after.items.map((i) => `${i.dayOfWeek}:${i.participantIds.length}`).join(',')}`,
      );
      expect(result.applied).toBe(false);
      expect(result.violations.map((v) => v.code)).toEqual([
        'PLAN_REVISION_CONFLICT',
      ]);
      expect(itemOf(after, dinnerB.id, 'WED')).toBeDefined();
      expect(itemOf(after, dinner.id)!.participantIds).toEqual([rafal]);
      expect(itemOf(after, dinnerC.id, 'MON')).toBeUndefined();
    });

    it('C. edycje porcji RÓŻNYCH osób z tego samego odczytu zachowują obie zmiany', async () => {
      const { asia, rafal, householdId } = await couple('C');
      await upsert(asia, householdId, {
        recipeId: dinner.id,
        portions: [
          { userId: asia, servings: 0.8 },
          { userId: rafal, servings: 1.25 },
        ],
      });
      const seen = itemOf(await readPlan(asia, householdId), dinner.id)!;
      const revisionOf = (userId: string) =>
        seen.portions.find((p) => p.userId === userId)?.revision as number;

      const a = await attempt(() =>
        setPortion(asia, householdId, {
          planItemId: seen.id,
          userId: rafal,
          servings: 1.5,
          expectedRevision: revisionOf(rafal),
        }),
      );
      const b = await attempt(() =>
        setPortion(rafal, householdId, {
          planItemId: seen.id,
          userId: asia,
          servings: 1,
          expectedRevision: revisionOf(asia),
        }),
      );
      const final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      console.log(
        `[C] A(Rafał 1,5): ${a} → B(Asia 1,0): ${b} → stan ${JSON.stringify(byPerson(final.portions))}`,
      );
      expect([a, b]).toEqual(['OK', 'OK']);
      expect(byPerson(final.portions)).toEqual({ [asia]: 1, [rafal]: 1.5 });
    });
  });

  describe('macierz (ADR plan-portions-safe-editing)', () => {
    type Ack = Item & { changeKind: string; planRevision: number };
    const tuesday = (portions?: { userId: string; servings: number }[]) => ({
      dayOfWeek: 'TUE',
      mealType: 'DINNER',
      recipeId: dinner.id,
      ...(portions ? { portions } : {}),
    });
    /** `applyWeekPlan` jako praca dla `underWeekLock`: odmowa = wyjątek z kodem. */
    const applyOrThrow =
      (userId: string, householdId: string, fields: Record<string, unknown>) =>
      () =>
        apply(userId, householdId, fields).then((result) => {
          if (!result.applied) {
            throw new AppException(
              result.violations[0].code,
              'odmowa',
              HttpStatus.CONFLICT,
            );
          }
        });
    const violationsOf = (result: {
      violations: { index: number; code: string }[];
    }) => result.violations.map((v) => [v.index, v.code]);

    it('1. dwa pełne zapisy tej samej wersji RÓWNOLEGLE (pod zamkiem tygodnia): wchodzi dokładnie jeden, drugi PLAN_REVISION_CONFLICT — dla upsertWeekSlot i applyWeekPlan', async () => {
      const { asia, rafal, householdId } = await couple('Rownolegle');
      const seen = await allocated(asia, householdId, [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ]);
      const writeA = [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.5 },
      ];
      const writeB = [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.25 },
      ];
      const upserts = await underWeekLock(householdId, [
        () =>
          upsert(asia, householdId, {
            recipeId: dinner.id,
            expectedRevision: seen.revision,
            portions: writeA,
          }),
        () =>
          upsert(rafal, householdId, {
            recipeId: dinner.id,
            expectedRevision: seen.revision,
            portions: writeB,
          }),
      ]);
      expect(upserts.allWaited).toBe(true);
      expect([...upserts.results].sort()).toEqual([
        'OK',
        'PLAN_REVISION_CONFLICT',
      ]);
      const winner = upserts.results[0] === 'OK' ? writeA : writeB;
      let final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(final.portions)).toEqual(byPerson(winner));

      const plan = await readPlan(asia, householdId);
      const slotsWith = (rafalServings: number) => [
        tuesday([
          { userId: asia, servings: 0.8 },
          { userId: rafal, servings: rafalServings },
        ]),
      ];
      const applies = await underWeekLock(householdId, [
        applyOrThrow(asia, householdId, {
          expectedRevision: plan.revision,
          slots: slotsWith(1.1),
        }),
        applyOrThrow(rafal, householdId, {
          expectedRevision: plan.revision,
          slots: slotsWith(1.9),
        }),
      ]);
      console.log(
        `[1] upsert: ${upserts.results.join(' / ')}; apply: ${applies.results.join(' / ')}`,
      );
      expect(applies.allWaited).toBe(true);
      expect([...applies.results].sort()).toEqual([
        'OK',
        'PLAN_REVISION_CONFLICT',
      ]);
      final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(final.portions)[rafal]).toBe(
        applies.results[0] === 'OK' ? 1.1 : 1.9,
      );
    });

    it('2. porcje DWÓCH osób zmieniane równolegle z tego samego odczytu: obie zmiany zostają, plannedServings = ceil(Σ)', async () => {
      const { asia, rafal, householdId } = await couple('DwieOsoby');
      const seen = await allocated(asia, householdId, [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ]);
      const { allWaited, results } = await underWeekLock(householdId, [
        () =>
          setPortion(asia, householdId, {
            planItemId: seen.id,
            userId: rafal,
            servings: 1.5,
            expectedRevision: portionToken(seen, rafal),
          }),
        () =>
          setPortion(rafal, householdId, {
            planItemId: seen.id,
            userId: asia,
            servings: 1,
            expectedRevision: portionToken(seen, asia),
          }),
      ]);
      expect(allWaited).toBe(true);
      expect(results).toEqual(['OK', 'OK']);
      const final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(final.portions)).toEqual({ [asia]: 1, [rafal]: 1.5 });
      expect(final.plannedServings).toBe(3);
      // Każda porcja ma stempel SWOJEGO zapisu.
      expect(portionToken(final, asia)).not.toBe(portionToken(final, rafal));
    });

    it('3. porcja TEJ SAMEJ osoby z tego samego odczytu: drugi zapis PLAN_REVISION_CONFLICT (409, bieżący stempel w details); równolegle wchodzi dokładnie jeden', async () => {
      const { asia, rafal, householdId } = await couple('TaSamaOsoba');
      const seen = await allocated(asia, householdId, [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ]);
      const token = portionToken(seen, rafal);
      await setPortion(asia, householdId, {
        planItemId: seen.id,
        userId: rafal,
        servings: 1.5,
        expectedRevision: token,
      });
      const refused = await refusal(() =>
        setPortion(rafal, householdId, {
          planItemId: seen.id,
          userId: rafal,
          servings: 1.1,
          expectedRevision: token,
        }),
      );
      let now = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(refused).toEqual({
        code: 'PLAN_REVISION_CONFLICT',
        status: 409,
        details: [
          `planItemId:${seen.id}`,
          `currentRevision:${portionToken(now, rafal)}`,
        ],
      });
      expect(byPerson(now.portions)[rafal]).toBe(1.5);

      const { allWaited, results } = await underWeekLock(householdId, [
        () =>
          setPortion(asia, householdId, {
            planItemId: seen.id,
            userId: rafal,
            servings: 1.2,
            expectedRevision: portionToken(now, rafal),
          }),
        () =>
          setPortion(rafal, householdId, {
            planItemId: seen.id,
            userId: rafal,
            servings: 1.3,
            expectedRevision: portionToken(now, rafal),
          }),
      ]);
      expect(allWaited).toBe(true);
      expect([...results].sort()).toEqual(['OK', 'PLAN_REVISION_CONFLICT']);
      now = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(now.portions)[rafal]).toBe(
        results[0] === 'OK' ? 1.2 : 1.3,
      );
    });

    it('4. współbieżne przekroczenie sumy (dom trojga): każda zmiana osobno mieści się w 12, razem nie — wchodzi jedna, druga PLAN_PORTIONS_INVALID', async () => {
      const { asia, rafal, ola, householdId } = await trio('Suma');
      const seen = await allocated(asia, householdId, [
        { userId: asia, servings: 4 },
        { userId: rafal, servings: 4 },
        { userId: ola, servings: 3.5 },
      ]);
      const { allWaited, results } = await underWeekLock(householdId, [
        () =>
          setPortion(asia, householdId, {
            planItemId: seen.id,
            userId: asia,
            servings: 4.5,
            expectedRevision: portionToken(seen, asia),
          }),
        () =>
          setPortion(rafal, householdId, {
            planItemId: seen.id,
            userId: rafal,
            servings: 4.5,
            expectedRevision: portionToken(seen, rafal),
          }),
      ]);
      expect(allWaited).toBe(true);
      expect([...results].sort()).toEqual(['OK', 'PLAN_PORTIONS_INVALID']);
      const final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(
        final.portions.reduce((sum, portion) => sum + portion.servings, 0),
      ).toBe(12);
      expect(final.plannedServings).toBe(12);
    });

    it('5. edycja porcji vs zmiana uczestników: zapis ze starego odczytu dostaje konflikt; zmiana uczestników wymaga jawnych porcji i tokenu (bez niejawnego resetu)', async () => {
      const { asia, rafal, householdId } = await couple('Uczestnicy');
      const seen = await allocated(asia, householdId, [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ]);
      // Bez porcji — odmowa, nawet ze zgodnym tokenem.
      expect(
        await attempt(() =>
          upsert(asia, householdId, {
            recipeId: dinner.id,
            participantIds: [asia],
            expectedRevision: seen.revision,
          }),
        ),
      ).toBe('PLAN_PORTIONS_CONFLICT');
      // B: tylko Asia, jej porcja jawnie, token pozycji.
      expect(
        await attempt(() =>
          upsert(rafal, householdId, {
            recipeId: dinner.id,
            participantIds: [asia],
            portions: [{ userId: asia, servings: 0.8 }],
            expectedRevision: seen.revision,
          }),
        ),
      ).toBe('OK');
      // A ze starego odczytu: Rafała nie ma już w alokacji…
      const gone = await refusal(() =>
        setPortion(asia, householdId, {
          planItemId: seen.id,
          userId: rafal,
          servings: 1.5,
          expectedRevision: portionToken(seen, rafal),
        }),
      );
      expect(gone.code).toBe('PLAN_PORTIONS_CONFLICT');
      expect(gone.details).toContain('reason:NOT_IN_AUDIENCE');
      // …a porcję Asi przestemplował pełny zapis B.
      expect(
        (
          await refusal(() =>
            setPortion(asia, householdId, {
              planItemId: seen.id,
              userId: asia,
              servings: 1,
              expectedRevision: portionToken(seen, asia),
            }),
          )
        ).code,
      ).toBe('PLAN_REVISION_CONFLICT');

      // Odwrotna kolejność: najpierw porcja, potem zmiana uczestników ze
      // starego tokenu pozycji.
      const solo = itemOf(await readPlan(asia, householdId), dinner.id)!;
      await setPortion(asia, householdId, {
        planItemId: solo.id,
        userId: asia,
        servings: 1.1,
        expectedRevision: portionToken(solo, asia),
      });
      expect(
        await attempt(() =>
          upsert(rafal, householdId, {
            recipeId: dinner.id,
            participantIds: [],
            portions: [
              { userId: asia, servings: 0.8 },
              { userId: rafal, servings: 1 },
            ],
            expectedRevision: solo.revision,
          }),
        ),
      ).toBe('PLAN_REVISION_CONFLICT');
      // Po odświeżeniu: dodana osoba dostaje porcję podaną jawnie.
      const fresh = itemOf(await readPlan(asia, householdId), dinner.id)!;
      await upsert(rafal, householdId, {
        recipeId: dinner.id,
        participantIds: [],
        portions: [
          { userId: asia, servings: 1.1 },
          { userId: rafal, servings: 1 },
        ],
        expectedRevision: fresh.revision,
      });
      const final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(final.participantIds).toEqual([]);
      expect(byPerson(final.portions)).toEqual({ [asia]: 1.1, [rafal]: 1 });
    });

    it('6. edycja porcji vs zamiana i usunięcie dania: zamiana wymaga porcji i tokenu źródła; stara pozycja → PLAN_ITEM_NOT_FOUND / PLAN_REVISION_CONFLICT', async () => {
      const { asia, rafal, householdId } = await couple('Zamiana');
      const portions = [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ];
      const seen = await allocated(asia, householdId, portions);
      expect(
        await attempt(() =>
          upsert(rafal, householdId, {
            recipeId: dinnerB.id,
            replaceRecipeId: dinner.id,
            expectedRevision: seen.revision,
          }),
        ),
      ).toBe('PLAN_PORTIONS_CONFLICT');
      const swapped = (await upsert(rafal, householdId, {
        recipeId: dinnerB.id,
        replaceRecipeId: dinner.id,
        portions,
        expectedRevision: seen.revision,
      })) as unknown as Ack;
      expect(swapped.changeKind).toBe('REPLACED');
      expect(byPerson(swapped.portions)).toEqual(byPerson(portions));

      expect(
        (
          await refusal(() =>
            setPortion(asia, householdId, {
              planItemId: seen.id,
              userId: rafal,
              servings: 1.5,
              expectedRevision: portionToken(seen, rafal),
            }),
          )
        ).code,
      ).toBe('PLAN_ITEM_NOT_FOUND');
      // Zapis starej pozycji z jej tokenem — nie odtwarza jej.
      expect(
        await attempt(() =>
          upsert(asia, householdId, {
            recipeId: dinner.id,
            portions: [
              { userId: asia, servings: 1 },
              { userId: rafal, servings: 1.25 },
            ],
            expectedRevision: seen.revision,
          }),
        ),
      ).toBe('PLAN_REVISION_CONFLICT');
      // Ponowienie zamiany (źródła już nie ma).
      expect(
        await attempt(() =>
          upsert(rafal, householdId, {
            recipeId: dinnerC.id,
            replaceRecipeId: dinner.id,
            portions,
            expectedRevision: seen.revision,
          }),
        ),
      ).toBe('PLAN_REVISION_CONFLICT');
      expect(
        (await readPlan(asia, householdId)).items.map((i) => i.recipeId),
      ).toEqual([dinnerB.id]);

      await weeklyPlans.removeWeekSlot(rafal, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinnerB.id,
      });
      expect(
        (
          await refusal(() =>
            setPortion(asia, householdId, {
              planItemId: swapped.id,
              userId: asia,
              servings: 1,
              expectedRevision: portionToken(swapped, asia),
            }),
          )
        ).code,
      ).toBe('PLAN_ITEM_NOT_FOUND');
      expect((await readPlan(asia, householdId)).items).toEqual([]);
    });

    it('7. usunięcie i odtworzenie tej samej pozycji: nowy, wyższy stempel — stary token nie trafia w nową pozycję (bez ABA)', async () => {
      const { asia, rafal, householdId } = await couple('Odtworzenie');
      const portions = [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ];
      const seen = await allocated(asia, householdId, portions);
      await weeklyPlans.removeWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
      });
      const again = await allocated(asia, householdId, portions);
      expect(again.id).not.toBe(seen.id);
      expect(again.revision!).toBeGreaterThan(seen.revision!);
      expect(portionToken(again, asia)).toBeGreaterThan(
        portionToken(seen, asia),
      );
      expect(
        await attempt(() =>
          upsert(rafal, householdId, {
            recipeId: dinner.id,
            portions: [
              { userId: asia, servings: 1 },
              { userId: rafal, servings: 1.25 },
            ],
            expectedRevision: seen.revision,
          }),
        ),
      ).toBe('PLAN_REVISION_CONFLICT');
      expect(
        (
          await refusal(() =>
            setPortion(rafal, householdId, {
              planItemId: again.id,
              userId: asia,
              servings: 1,
              expectedRevision: portionToken(seen, asia),
            }),
          )
        ).code,
      ).toBe('PLAN_REVISION_CONFLICT');
      const final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(final.portions)).toEqual(byPerson(portions));
    });

    it('8. ponowienie po utraconej odpowiedzi: ten sam zapis drugi raz = sukces bez zmian (bez nowej rewizji); po późniejszej zmianie = konflikt, nowsza zmiana zostaje', async () => {
      const { asia, rafal, householdId } = await couple('Ponowienie');
      const seen = await allocated(asia, householdId, [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ]);
      const input = {
        planItemId: seen.id,
        userId: rafal,
        servings: 1.5,
        expectedRevision: portionToken(seen, rafal),
      };
      const first = await setPortionAck(asia, householdId, input);
      const retry = await setPortionAck(asia, householdId, input);
      expect([first.changeKind, retry.changeKind]).toEqual([
        'DETAILS_CHANGED',
        'NOOP',
      ]);
      expect(retry.planRevision).toBe(first.planRevision);
      expect((await readPlan(asia, householdId)).revision).toBe(
        first.planRevision,
      );

      let now = itemOf(await readPlan(asia, householdId), dinner.id)!;
      await setPortion(rafal, householdId, {
        planItemId: seen.id,
        userId: rafal,
        servings: 1.1,
        expectedRevision: portionToken(now, rafal),
      });
      expect(
        (await refusal(() => setPortion(asia, householdId, input))).code,
      ).toBe('PLAN_REVISION_CONFLICT');
      now = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(now.portions)[rafal]).toBe(1.1);

      // To samo dla pełnego zapisu pozycji.
      const full = {
        recipeId: dinner.id,
        portions: [
          { userId: asia, servings: 0.9 },
          { userId: rafal, servings: 1.1 },
        ],
        expectedRevision: now.revision,
      };
      const up1 = (await upsert(asia, householdId, full)) as unknown as Ack;
      const up2 = (await upsert(asia, householdId, full)) as unknown as Ack;
      expect([up1.changeKind, up2.changeKind]).toEqual([
        'DETAILS_CHANGED',
        'NOOP',
      ]);
      expect(up2.planRevision).toBe(up1.planRevision);
      now = itemOf(await readPlan(asia, householdId), dinner.id)!;
      await setPortion(rafal, householdId, {
        planItemId: now.id,
        userId: rafal,
        servings: 1.3,
        expectedRevision: portionToken(now, rafal),
      });
      expect(await attempt(() => upsert(asia, householdId, full))).toBe(
        'PLAN_REVISION_CONFLICT',
      );
      now = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(now.portions)).toEqual({ [asia]: 0.9, [rafal]: 1.3 });
    });

    it('9. applyWeekPlan: aktualny token = stan docelowy wchodzi; nieaktualny (także ponowienie po sukcesie i dryRun) = applied:false bez zmian', async () => {
      const { asia, householdId } = await couple('PelnyPlan');
      await upsert(asia, householdId, { recipeId: dinner.id });
      const seen = await readPlan(asia, householdId);
      const target = {
        slots: [
          tuesday(),
          { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: dinnerC.id },
        ],
      };
      const dry = await apply(asia, householdId, {
        ...target,
        expectedRevision: seen.revision,
        dryRun: true,
      });
      expect(dry.violations).toEqual([]);
      expect(dry.changes).toEqual({ created: 1, updated: 0, deleted: 0 });
      const ok = await apply(asia, householdId, {
        ...target,
        expectedRevision: seen.revision,
      });
      expect(ok.applied).toBe(true);
      const okRevision = (ok.plan as unknown as Plan).revision!;
      expect(okRevision).toBeGreaterThan(seen.revision!);

      const retry = await apply(asia, householdId, {
        ...target,
        expectedRevision: seen.revision,
      });
      expect(retry.applied).toBe(false);
      expect(retry.plan).toBeNull();
      expect(violationsOf(retry)).toEqual([[-1, 'PLAN_REVISION_CONFLICT']]);
      const dryStale = await apply(asia, householdId, {
        slots: [],
        expectedRevision: seen.revision,
        dryRun: true,
      });
      expect(violationsOf(dryStale)).toEqual([[-1, 'PLAN_REVISION_CONFLICT']]);

      const after = await readPlan(asia, householdId);
      expect(after.revision).toBe(okRevision);
      expect(after.items.map((i) => i.dayOfWeek).sort()).toEqual([
        'MON',
        'TUE',
      ]);
    });

    it('10. polityki wewnętrzne: verified/authoritative bez guarda = błąd programisty; force odmawia mimo zgodnego tokenu; nieaktualny token odmawia PRZED guardem; verified z guardem zastępuje alokację; strict bez tokenu — PLAN_REVISION_REQUIRED', async () => {
      const { asia, rafal, householdId } = await couple('Polityki');
      await allocated(asia, householdId, [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ]);
      const plan = await readPlan(asia, householdId);
      const slots = [
        tuesday([
          { userId: asia, servings: 1 },
          { userId: rafal, servings: 1.5 },
        ]),
      ];
      const internal = (
        fields: Record<string, unknown>,
        hooks: Parameters<WeeklyPlansService['applyWeekPlan']>[4],
      ) =>
        weeklyPlans.applyWeekPlan(
          asia,
          householdId,
          WEEK_START,
          fields as unknown as ApplyWeekPlanDto,
          hooks,
        );
      await expect(
        internal({ slots }, { portionsPolicy: 'verified' }),
      ).rejects.toThrow(/wymaga guarda/);
      await expect(
        internal({ slots }, { portionsPolicy: 'authoritative' }),
      ).rejects.toThrow(/wymaga guarda/);

      const guard = jest.fn().mockResolvedValue(undefined);
      const forced = await internal(
        { slots, expectedRevision: plan.revision },
        { portionsPolicy: 'no-allocation-changes', guard },
      );
      expect(violationsOf(forced)).toEqual([[0, 'PLAN_PORTIONS_CONFLICT']]);

      guard.mockClear();
      const stale = await internal(
        { slots, expectedRevision: plan.revision! - 1 },
        { portionsPolicy: 'verified', guard },
      );
      expect(violationsOf(stale)).toEqual([[-1, 'PLAN_REVISION_CONFLICT']]);
      expect(guard).not.toHaveBeenCalled();

      const strict = await apply(asia, householdId, { slots });
      expect(violationsOf(strict)).toEqual([[0, 'PLAN_REVISION_REQUIRED']]);

      const verified = await internal(
        { slots },
        { portionsPolicy: 'verified', guard },
      );
      expect(verified.applied).toBe(true);
      expect(guard).toHaveBeenCalledTimes(1);
      const final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(final.portions)).toEqual({ [asia]: 1, [rafal]: 1.5 });
    });

    it('11. zmiana składu domu (odejście) podbija tygodnie od bieżącego i unieważnia tokeny ich pozycji i porcji', async () => {
      const { asia, rafal, ola, householdId } = await trio('Sklad');
      const nextMonday = currentWeekStart(new Date());
      nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
      const week = formatWeekStart(nextMonday);
      const read = async () =>
        (await weeklyPlans.getByHouseholdAndWeek(
          asia,
          householdId,
          week,
        )) as unknown as Plan;
      await weeklyPlans.upsertWeekSlot(asia, householdId, week, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
        portions: [
          { userId: asia, servings: 0.8 },
          { userId: rafal, servings: 1.25 },
          { userId: ola, servings: 1 },
        ],
      });
      const before = await read();
      const item = before.items[0];

      await households.leave(ola, householdId);

      const after = await read();
      const afterItem = after.items[0];
      expect(after.revision!).toBeGreaterThan(before.revision!);
      expect(afterItem.revision).toBe(after.revision);
      expect(afterItem.portions.map((p) => p.revision)).toEqual([
        after.revision,
        after.revision,
      ]);
      expect(Object.keys(byPerson(afterItem.portions)).sort()).toEqual(
        [asia, rafal].sort(),
      );
      expect(
        (
          await refusal(() =>
            weeklyPlans.setPortion(asia, householdId, week, {
              planItemId: item.id,
              userId: rafal,
              servings: 1.5,
              expectedRevision: portionToken(item, rafal),
            }),
          )
        ).code,
      ).toBe('PLAN_REVISION_CONFLICT');
      const stale = await weeklyPlans.applyWeekPlan(asia, householdId, week, {
        expectedRevision: before.revision,
        slots: [],
      });
      expect(violationsOf(stale)).toEqual([[-1, 'PLAN_REVISION_CONFLICT']]);
      await weeklyPlans.setPortion(asia, householdId, week, {
        planItemId: item.id,
        userId: rafal,
        servings: 1.5,
        expectedRevision: portionToken(afterItem, rafal),
      });
      expect(byPerson((await read()).items[0].portions)[rafal]).toBe(1.5);
    });

    it('12. legacy i odmowa bez tokenu: pozycje bez alokacji — jak dotąd; zastąpienie/usunięcie alokacji bez tokenu = PLAN_REVISION_REQUIRED (428); setPortion bez alokacji = NOT_ALLOCATED; polityka nie jest polem DTO', async () => {
      const { asia, rafal, householdId } = await couple('Legacy');
      await upsert(asia, householdId, { recipeId: dinner.id });
      await upsert(asia, householdId, {
        dayOfWeek: 'WED',
        recipeId: dinnerB.id,
      });
      expect(
        await attempt(() =>
          upsert(rafal, householdId, {
            recipeId: dinner.id,
            participantIds: [rafal],
          }),
        ),
      ).toBe('OK');
      const legacy = await apply(asia, householdId, {
        slots: [{ ...tuesday(), participantIds: [rafal] }],
      });
      expect(legacy.applied).toBe(true);
      expect(legacy.changes).toEqual({ created: 0, updated: 0, deleted: 1 });

      const plain = itemOf(await readPlan(asia, householdId), dinner.id)!;
      const notAllocated = await refusal(() =>
        setPortion(asia, householdId, {
          planItemId: plain.id,
          userId: rafal,
          servings: 1.5,
          expectedRevision: plain.revision!,
        }),
      );
      expect(notAllocated).toEqual({
        code: 'PLAN_PORTIONS_CONFLICT',
        status: 409,
        details: [`planItemId:${plain.id}`, 'reason:NOT_ALLOCATED'],
      });

      const seen = await allocated(asia, householdId, [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ]);
      expect(
        await refusal(() =>
          upsert(asia, householdId, {
            recipeId: dinner.id,
            portions: [
              { userId: asia, servings: 1 },
              { userId: rafal, servings: 1.25 },
            ],
          }),
        ),
      ).toEqual({
        code: 'PLAN_REVISION_REQUIRED',
        status: 428,
        details: [`planItemId:${seen.id}`],
      });
      expect(
        violationsOf(
          await apply(asia, householdId, {
            slots: [
              tuesday([
                { userId: asia, servings: 1 },
                { userId: rafal, servings: 1.25 },
              ]),
            ],
          }),
        ),
      ).toEqual([[0, 'PLAN_REVISION_REQUIRED']]);
      expect(
        violationsOf(await apply(asia, householdId, { slots: [] })),
      ).toEqual([[-1, 'PLAN_REVISION_REQUIRED']]);
      expect(
        await attempt(() =>
          setPortion(asia, householdId, {
            planItemId: seen.id,
            userId: rafal,
            servings: 1.5,
          } as unknown as Parameters<SetPortionApi['setPortion']>[3]),
        ),
      ).toBe('VALIDATION_ERROR');
      expect(
        await attempt(() =>
          apply(asia, householdId, {
            slots: [],
            portionsPolicy: 'authoritative',
          }),
        ),
      ).toBe('VALIDATION_ERROR');
      expect(
        await attempt(() =>
          upsert(asia, householdId, {
            recipeId: dinner.id,
            portionsPolicy: 'verified',
            portions: [
              { userId: asia, servings: 1 },
              { userId: rafal, servings: 1.25 },
            ],
          }),
        ),
      ).toBe('VALIDATION_ERROR');
      const final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(final.portions)).toEqual({ [asia]: 0.8, [rafal]: 1.25 });
    });

    it('13. autoryzacja: cudza pozycja wygląda jak nieistniejąca, nie-członek dostaje NOT_HOUSEHOLD_MEMBER, odmowy nie niosą danych innego domu; domownik może zmienić porcję innej osoby', async () => {
      const home = await couple('Dom');
      const stranger = await couple('Obcy');
      const noWeek = await couple('ObcyBezTygodnia');
      const seen = await allocated(home.asia, home.householdId, [
        { userId: home.asia, servings: 0.8 },
        { userId: home.rafal, servings: 1.25 },
      ]);
      const input = {
        planItemId: seen.id,
        userId: home.rafal,
        servings: 2,
        expectedRevision: portionToken(seen, home.rafal),
      };
      await readPlan(stranger.asia, stranger.householdId);
      expect(
        await refusal(() =>
          setPortion(stranger.asia, stranger.householdId, input),
        ),
      ).toEqual({ code: 'PLAN_ITEM_NOT_FOUND', status: 404, details: [] });
      expect(
        await refusal(() => setPortion(noWeek.asia, noWeek.householdId, input)),
      ).toEqual({ code: 'PLAN_ITEM_NOT_FOUND', status: 404, details: [] });
      expect(
        (
          await refusal(() =>
            setPortion(stranger.asia, home.householdId, input),
          )
        ).code,
      ).toBe('NOT_HOUSEHOLD_MEMBER');

      expect(
        await attempt(() =>
          setPortion(home.rafal, home.householdId, {
            planItemId: seen.id,
            userId: home.asia,
            servings: 1,
            expectedRevision: portionToken(seen, home.asia),
          }),
        ),
      ).toBe('OK');
      const stale = await refusal(() =>
        setPortion(home.rafal, home.householdId, {
          planItemId: seen.id,
          userId: home.asia,
          servings: 1.2,
          expectedRevision: portionToken(seen, home.asia),
        }),
      );
      expect(stale.details).toHaveLength(2);
      expect(stale.details[0]).toBe(`planItemId:${seen.id}`);
      expect(stale.details[1]).toMatch(/^currentRevision:\d+$/);
      const final = itemOf(
        await readPlan(home.asia, home.householdId),
        dinner.id,
      )!;
      expect(byPerson(final.portions)).toEqual({
        [home.asia]: 1,
        [home.rafal]: 1.25,
      });
      expect(
        (await readPlan(stranger.asia, stranger.householdId)).items,
      ).toEqual([]);
    });

    it('14. migracja: kolumny revision NOT NULL DEFAULT 0; wiersze sprzed migracji (revision = 0) mają ważny token 0', async () => {
      const columns = await prisma.$queryRaw<
        { table_name: string; is_nullable: string; column_default: string }[]
      >`
        SELECT table_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'revision'
          AND table_name IN ('WeeklyPlan', 'PlanItem', 'PlanItemPortion')
        ORDER BY table_name`;
      expect(columns).toEqual([
        { table_name: 'PlanItem', is_nullable: 'NO', column_default: '0' },
        {
          table_name: 'PlanItemPortion',
          is_nullable: 'NO',
          column_default: '0',
        },
        { table_name: 'WeeklyPlan', is_nullable: 'NO', column_default: '0' },
      ]);

      const { asia, rafal, householdId } = await couple('Migracja');
      const seen = await allocated(asia, householdId, [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ]);
      // Stan wiersza sprzed migracji: DEFAULT 0 wszędzie.
      await prisma.weeklyPlan.updateMany({
        where: { householdId },
        data: { revision: 0 },
      });
      await prisma.planItem.update({
        where: { id: seen.id },
        data: { revision: 0 },
      });
      await prisma.planItemPortion.updateMany({
        where: { planItemId: seen.id },
        data: { revision: 0 },
      });
      const legacy = await readPlan(asia, householdId);
      const legacyItem = legacy.items[0];
      expect([
        legacy.revision,
        legacyItem.revision,
        ...legacyItem.portions.map((p) => p.revision),
      ]).toEqual([0, 0, 0, 0]);
      await setPortion(asia, householdId, {
        planItemId: seen.id,
        userId: rafal,
        servings: 1.5,
        expectedRevision: 0,
      });
      const after = await readPlan(asia, householdId);
      expect(after.revision).toBe(1);
      expect(after.items[0].revision).toBe(1);
      expect(portionToken(after.items[0], rafal)).toBe(1);
      expect(portionToken(after.items[0], asia)).toBe(0);
      expect(
        violationsOf(
          await apply(asia, householdId, { slots: [], expectedRevision: 0 }),
        ),
      ).toEqual([[-1, 'PLAN_REVISION_CONFLICT']]);
    });

    it('15. token w odczycie = token w odpowiedzi zapisu (upsertWeekSlot, setPortion, applyWeekPlan)', async () => {
      const { asia, rafal, householdId } = await couple('Tokeny');
      const created = (await upsert(asia, householdId, {
        recipeId: dinner.id,
        portions: [
          { userId: asia, servings: 0.8 },
          { userId: rafal, servings: 1.25 },
        ],
      })) as unknown as Ack;
      let read = await readPlan(asia, householdId);
      let item = itemOf(read, dinner.id)!;
      expect(created.revision).toBe(item.revision);
      expect(created.portions).toEqual(item.portions);
      expect(created.planRevision).toBe(read.revision);

      const set = await setPortionAck(asia, householdId, {
        planItemId: item.id,
        userId: rafal,
        servings: 1.5,
        expectedRevision: portionToken(item, rafal),
      });
      read = await readPlan(asia, householdId);
      item = itemOf(read, dinner.id)!;
      expect(set.revision).toBe(item.revision);
      expect(set.portions).toEqual(item.portions);
      expect(set.planRevision).toBe(read.revision);

      const applied = await apply(asia, householdId, {
        expectedRevision: read.revision,
        slots: [
          tuesday(
            item.portions.map(({ userId, servings }) => ({ userId, servings })),
          ),
          { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: dinnerB.id },
        ],
      });
      read = await readPlan(asia, householdId);
      const tokens = (plan: Plan) =>
        plan.items
          .map((i) => [i.id, i.revision, i.portions] as const)
          .sort((a, b) => a[0].localeCompare(b[0]));
      const appliedPlan = applied.plan as unknown as Plan;
      expect(appliedPlan.revision).toBe(read.revision);
      expect(tokens(appliedPlan)).toEqual(tokens(read));
    });
  });
});
