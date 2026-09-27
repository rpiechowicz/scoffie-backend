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
import { ShoppingListService } from '../src/weekly-plans/services/shopping-list.service';
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
  let shoppingLists: ShoppingListService;
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
    shoppingLists = app.get(ShoppingListService);
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

  describe('review patch — regresje', () => {
    const nextWeek = () => {
      const monday = currentWeekStart(new Date());
      monday.setUTCDate(monday.getUTCDate() + 7);
      return formatWeekStart(monday);
    };
    const readWeek = async (
      userId: string,
      householdId: string,
      week: string,
    ) =>
      (await weeklyPlans.getByHouseholdAndWeek(
        userId,
        householdId,
        week,
      )) as unknown as Plan;
    /** Pozycja z odczytu jako slot pełnego stanu (to, co klient trzyma lokalnie). */
    const toSlot = (item: Item) => ({
      dayOfWeek: item.dayOfWeek,
      mealType: item.mealType,
      recipeId: item.recipeId,
      participantIds: item.participantIds,
      ...(item.portions.length > 0
        ? {
            portions: item.portions.map(({ userId, servings }) => ({
              userId,
              servings,
            })),
          }
        : {}),
    });
    const tuesdayOf = (portions: { userId: string; servings: number }[]) => ({
      dayOfWeek: 'TUE',
      mealType: 'DINNER',
      recipeId: dinner.id,
      portions,
    });
    const shoppingState = async (householdId: string) => ({
      lists: await prisma.shoppingList.findMany({
        where: { householdId },
        select: { id: true, isStale: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
      archiveStates: await prisma.shoppingListArchiveState.findMany({
        where: { householdId },
      }),
    });

    it('R1. ack pojedynczej pozycji nie odświeża tokenu STAREGO pełnego snapshotu: pełny apply ze starej kopii → konflikt, pozycja B zostaje; dopiero pełny odczyt daje nowy token', async () => {
      const { asia, rafal, householdId } = await couple('R1');
      await allocated(asia, householdId, [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ]);
      const snapshotA = await readPlan(asia, householdId);
      // B dodaje środę; A o tym nie wie.
      await upsert(rafal, householdId, {
        dayOfWeek: 'WED',
        recipeId: dinnerB.id,
      });
      const tuesdayA = itemOf(snapshotA, dinner.id)!;
      const ack = (await setPortion(asia, householdId, {
        planItemId: tuesdayA.id,
        userId: rafal,
        servings: 1.5,
        expectedRevision: portionToken(tuesdayA, rafal),
      })) as Item & Record<string, unknown>;
      // Model klienta z kontraktu sprzed poprawki: token tygodnia snapshotu
      // podmieniany na `planRevision` z acka, pozycja — na tę z acka.
      const weekToken =
        (ack.planRevision as number | undefined) ?? snapshotA.revision;
      const localItems = snapshotA.items.map((item) =>
        item.id === ack.id ? ack : item,
      );
      const stale = await apply(asia, householdId, {
        expectedRevision: weekToken,
        slots: localItems.map(toSlot),
      });
      const after = await readPlan(asia, householdId);
      console.log(
        `[R1] ack.planRevision=${String(ack.planRevision)} snapshot=${snapshotA.revision} → apply ${stale.applied ? 'applied' : JSON.stringify(stale.violations.map((v) => v.code))} → środa ${itemOf(after, dinnerB.id, 'WED') ? 'jest' : 'USUNIĘTA'}`,
      );
      expect('planRevision' in ack).toBe(false);
      expect(stale.applied).toBe(false);
      expect(stale.violations.map((v) => v.code)).toEqual([
        'PLAN_REVISION_CONFLICT',
      ]);
      expect(itemOf(after, dinnerB.id, 'WED')).toBeDefined();

      // Poprawny przepływ: pełny odczyt obejmuje zmianę B i daje nowy token.
      expect(after.revision!).toBeGreaterThan(snapshotA.revision!);
      const ok = await apply(asia, householdId, {
        expectedRevision: after.revision,
        slots: after.items.map(toSlot),
      });
      expect(ok.applied).toBe(true);
      expect(ok.changes).toEqual({ created: 0, updated: 0, deleted: 0 });
      expect(
        itemOf(await readPlan(asia, householdId), dinnerB.id, 'WED'),
      ).toBeDefined();
    });

    it('R1b. odpowiedzi w odwrotnej kolejności: stemple rosną monotonicznie — klient zostawia WYŻSZY token pozycji i nowszy snapshot (wyższa plan.revision); starszy jest odrzucany', async () => {
      const { asia, rafal, householdId } = await couple('R1b');
      const seen = await allocated(asia, householdId, [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ]);
      const ack1 = await setPortionAck(asia, householdId, {
        planItemId: seen.id,
        userId: rafal,
        servings: 1.5,
        expectedRevision: portionToken(seen, rafal),
      });
      const ack2 = await setPortionAck(rafal, householdId, {
        planItemId: seen.id,
        userId: asia,
        servings: 1,
        expectedRevision: portionToken(seen, asia),
      });
      expect(ack2.revision!).toBeGreaterThan(ack1.revision!);
      // Klient dostaje ack2, potem ack1: wyższy stempel wygrywa.
      const kept = [ack2, ack1].reduce((best, ack) =>
        ack.revision! > best.revision! ? ack : best,
      );
      expect(kept).toBe(ack2);
      const full = (expectedRevision: number | undefined) =>
        upsert(asia, householdId, {
          recipeId: dinner.id,
          portions: [
            { userId: asia, servings: 1.1 },
            { userId: rafal, servings: 1.5 },
          ],
          expectedRevision,
        });
      expect(await attempt(() => full(ack1.revision))).toBe(
        'PLAN_REVISION_CONFLICT',
      );
      expect(await attempt(() => full(kept.revision))).toBe('OK');

      const older = await readPlan(asia, householdId);
      const now = itemOf(older, dinner.id)!;
      await setPortion(rafal, householdId, {
        planItemId: now.id,
        userId: rafal,
        servings: 1.3,
        expectedRevision: portionToken(now, rafal),
      });
      const newer = await readPlan(asia, householdId);
      expect(newer.revision!).toBeGreaterThan(older.revision!);
      const staleApply = await apply(asia, householdId, {
        expectedRevision: older.revision,
        slots: older.items.map(toSlot),
      });
      expect(staleApply.violations.map((v) => v.code)).toEqual([
        'PLAN_REVISION_CONFLICT',
      ]);
    });

    it('R1c. odczyt tygodnia to jedna migawka: zapis zatwierdzony W TRAKCIE odczytu nie miesza rewizji z pozycjami', async () => {
      const { asia, householdId } = await couple('Migawka');
      await upsert(asia, householdId, { recipeId: dinner.id });
      const before = await readPlan(asia, householdId);
      const planId = (
        await prisma.weeklyPlan.findFirstOrThrow({
          where: { householdId },
          select: { id: true },
        })
      ).id;
      const held = latch();
      const release = latch();
      // Zapis domownika trzyma tabelę pozycji: odczyt przeczyta wiersz
      // tygodnia i stanie dopiero na pozycjach (osobne zapytanie).
      const writer = prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'LOCK TABLE "PlanItem" IN ACCESS EXCLUSIVE MODE',
          );
          held.open();
          await release.opened;
          await tx.weeklyPlan.update({
            where: { id: planId },
            data: { revision: { increment: 1 } },
          });
          await tx.planItem.create({
            data: {
              weeklyPlanId: planId,
              dayOfWeek: 'WED',
              mealType: 'DINNER',
              recipeId: dinnerB.id,
              plannedServings: 2,
              revision: before.revision! + 1,
            },
          });
        },
        { timeout: 30_000 },
      );
      await held.opened;
      const reading = readPlan(asia, householdId);
      const waited = await waitUntilWaiting(1);
      release.open();
      await writer;
      const seen = await reading;
      const hasWed = seen.items.some((item) => item.dayOfWeek === 'WED');
      console.log(
        `[R1c] odczyt czekał=${waited} → revision=${seen.revision} (przed ${before.revision}), środa=${hasWed}`,
      );
      expect(waited).toBe(true);
      // Spójność: nowa pozycja widoczna ⇔ rewizja po zapisie.
      expect(hasWed).toBe(seen.revision === before.revision! + 1);
      const fresh = await readPlan(asia, householdId);
      expect(fresh.revision).toBe(before.revision! + 1);
      expect(fresh.items.some((item) => item.dayOfWeek === 'WED')).toBe(true);
    });

    it('R2. zamiana X→Y: cel Y zmieniony po odczycie NIE jest nadpisany — sam token źródła nie wystarcza (428), stary token celu = konflikt; X zostaje, Y i lista zakupów bez zmian', async () => {
      const { asia, rafal, householdId } = await couple('R2');
      await upsert(asia, householdId, { recipeId: dinner.id });
      await upsert(asia, householdId, { recipeId: dinnerB.id });
      const seen = await readPlan(asia, householdId);
      const x = itemOf(seen, dinner.id)!;
      const y = itemOf(seen, dinnerB.id)!;
      // B: cel Y tylko dla Rafała.
      await upsert(rafal, householdId, {
        recipeId: dinnerB.id,
        participantIds: [rafal],
      });
      await shoppingLists.getShoppingList(asia, householdId, WEEK_START);
      const yAfterB = itemOf(await readPlan(asia, householdId), dinnerB.id)!;
      const shoppingBefore = await shoppingState(householdId);

      // A według kontraktu sprzed poprawki: token źródła, stara intencja wobec Y.
      const sourceOnly = await attempt(() =>
        upsert(asia, householdId, {
          recipeId: dinnerB.id,
          replaceRecipeId: dinner.id,
          participantIds: [],
          expectedRevision: x.revision,
        }),
      );
      const staleTarget = await attempt(() =>
        upsert(asia, householdId, {
          recipeId: dinnerB.id,
          replaceRecipeId: dinner.id,
          participantIds: [],
          expectedRevision: x.revision,
          expectedTargetRevision: y.revision,
        }),
      );
      const after = await readPlan(asia, householdId);
      const yNow = itemOf(after, dinnerB.id)!;
      console.log(
        `[R2] tylko token źródła: ${sourceOnly}; stary token celu: ${staleTarget} → X ${itemOf(after, dinner.id) ? 'jest' : 'USUNIĘTY'}, Y uczestnicy=${JSON.stringify(yNow.participantIds)}`,
      );
      expect(sourceOnly).toBe('PLAN_REVISION_REQUIRED');
      expect(staleTarget).toBe('PLAN_REVISION_CONFLICT');
      expect(itemOf(after, dinner.id)).toBeDefined();
      expect(yNow).toEqual(yAfterB);
      expect(await shoppingState(householdId)).toEqual(shoppingBefore);
    });

    it('R2b. zamiana X→Y — warianty celu: z alokacją, powstały po odczycie, usunięty i odtworzony, nieistniejący (poprawna zamiana), legacy bez tokenów', async () => {
      const portions = (a: string, r: string, sa: number, sr: number) => [
        { userId: a, servings: sa },
        { userId: r, servings: sr },
      ];
      const swap = (
        actor: string,
        householdId: string,
        fields: Record<string, unknown>,
      ) =>
        attempt(() =>
          upsert(actor, householdId, {
            recipeId: dinnerB.id,
            replaceRecipeId: dinner.id,
            ...fields,
          }),
        );

      // 1. Cel z alokacją, zmieniony porcją po odczycie.
      {
        const { asia, rafal, householdId } = await couple('R2Aloc');
        await upsert(asia, householdId, { recipeId: dinner.id });
        const yAlloc = await allocated(
          asia,
          householdId,
          portions(asia, rafal, 0.8, 1.25),
          dinnerB.id,
        );
        const seen = await readPlan(asia, householdId);
        const x = itemOf(seen, dinner.id)!;
        await setPortion(rafal, householdId, {
          planItemId: yAlloc.id,
          userId: rafal,
          servings: 1.5,
          expectedRevision: portionToken(yAlloc, rafal),
        });
        expect(
          await swap(asia, householdId, {
            portions: portions(asia, rafal, 1, 1),
            expectedRevision: x.revision,
            expectedTargetRevision: yAlloc.revision,
          }),
        ).toBe('PLAN_REVISION_CONFLICT');
        const mid = await readPlan(asia, householdId);
        expect(itemOf(mid, dinner.id)).toBeDefined();
        expect(byPerson(itemOf(mid, dinnerB.id)!.portions)[rafal]).toBe(1.5);
        // Z aktualnymi tokenami obu pozycji — jawne porcje celu wchodzą.
        expect(
          await swap(asia, householdId, {
            portions: portions(asia, rafal, 1, 1),
            expectedRevision: itemOf(mid, dinner.id)!.revision,
            expectedTargetRevision: itemOf(mid, dinnerB.id)!.revision,
          }),
        ).toBe('OK');
        const done = await readPlan(asia, householdId);
        expect(done.items.map((i) => i.recipeId)).toEqual([dinnerB.id]);
        expect(byPerson(done.items[0].portions)).toEqual({
          [asia]: 1,
          [rafal]: 1,
        });
      }

      // 2. Cel powstał dopiero po odczycie A (A oczekiwał „celu nie ma”).
      {
        const { asia, rafal, householdId } = await couple('R2Nowy');
        await upsert(asia, householdId, { recipeId: dinner.id });
        const seen = await readPlan(asia, householdId);
        await upsert(rafal, householdId, {
          recipeId: dinnerB.id,
          participantIds: [rafal],
        });
        expect(
          await swap(asia, householdId, {
            expectedRevision: itemOf(seen, dinner.id)!.revision,
            expectedTargetRevision: null,
          }),
        ).toBe('PLAN_REVISION_CONFLICT');
        const after = await readPlan(asia, householdId);
        expect(itemOf(after, dinner.id)).toBeDefined();
        expect(itemOf(after, dinnerB.id)!.participantIds).toEqual([rafal]);
      }

      // 3. Cel usunięty i odtworzony po odczycie (nowy stempel).
      {
        const { asia, rafal, householdId } = await couple('R2Odtw');
        await upsert(asia, householdId, { recipeId: dinner.id });
        await upsert(asia, householdId, { recipeId: dinnerB.id });
        const seen = await readPlan(asia, householdId);
        await weeklyPlans.removeWeekSlot(rafal, householdId, WEEK_START, {
          dayOfWeek: 'TUE',
          mealType: 'DINNER',
          recipeId: dinnerB.id,
        });
        await upsert(rafal, householdId, { recipeId: dinnerB.id });
        const recreated = itemOf(
          await readPlan(asia, householdId),
          dinnerB.id,
        )!;
        expect(recreated.revision!).toBeGreaterThan(
          itemOf(seen, dinnerB.id)!.revision!,
        );
        expect(
          await swap(asia, householdId, {
            expectedRevision: itemOf(seen, dinner.id)!.revision,
            expectedTargetRevision: itemOf(seen, dinnerB.id)!.revision,
          }),
        ).toBe('PLAN_REVISION_CONFLICT');
        expect(
          itemOf(await readPlan(asia, householdId), dinner.id),
        ).toBeDefined();
      }

      // 4. Celu nie ma i nie powstał — zwykła zamiana przechodzi.
      {
        const { asia, householdId } = await couple('R2Zwykla');
        await upsert(asia, householdId, { recipeId: dinner.id });
        const seen = await readPlan(asia, householdId);
        const ack = (await upsert(asia, householdId, {
          recipeId: dinnerB.id,
          replaceRecipeId: dinner.id,
          expectedRevision: itemOf(seen, dinner.id)!.revision,
          expectedTargetRevision: null,
        })) as unknown as { changeKind: string };
        expect(ack.changeKind).toBe('REPLACED');
        expect(
          (await readPlan(asia, householdId)).items.map((i) => i.recipeId),
        ).toEqual([dinnerB.id]);
      }

      // 5. Legacy (bez żadnego tokenu) — zamiana jak dotąd; token celu bez
      //    tokenu źródła i token celu bez zamiany — odmowa.
      {
        const { asia, householdId } = await couple('R2Legacy');
        await upsert(asia, householdId, { recipeId: dinner.id });
        const seen = await readPlan(asia, householdId);
        expect(
          await swap(asia, householdId, { expectedTargetRevision: null }),
        ).toBe('PLAN_REVISION_REQUIRED');
        expect(
          await attempt(() =>
            upsert(asia, householdId, {
              recipeId: dinner.id,
              expectedRevision: itemOf(seen, dinner.id)!.revision,
              expectedTargetRevision: null,
            }),
          ),
        ).toBe('VALIDATION_ERROR');
        expect(await swap(asia, householdId, {})).toBe('OK');
        expect(
          (await readPlan(asia, householdId)).items.map((i) => i.recipeId),
        ).toEqual([dinnerB.id]);
      }
    });

    it.each(['apply', 'upsert'] as const)(
      'R3 (%s). pełny zapis zmieniający audytorium (jawna lista wszystkich → „Wspólne”) przy identycznych porcjach unieważnia tokeny porcji; setPortion ze starym tokenem odmawia bez zmian',
      async (writer) => {
        const { asia, rafal, ola, householdId } = await trio(`R3${writer}`);
        const week = nextWeek();
        const values = [
          { userId: asia, servings: 0.8 },
          { userId: rafal, servings: 1.25 },
        ];
        await weeklyPlans.upsertWeekSlot(asia, householdId, week, {
          dayOfWeek: 'TUE',
          mealType: 'DINNER',
          recipeId: dinner.id,
          participantIds: [asia, rafal],
          portions: values,
        });
        // Ola odchodzi — pozycja zostaje z jawną listą WSZYSTKICH domowników.
        await households.leave(ola, householdId);
        const seen = await readWeek(asia, householdId, week);
        const item = seen.items[0];
        expect([...item.participantIds].sort()).toEqual([asia, rafal].sort());

        if (writer === 'apply') {
          const result = await weeklyPlans.applyWeekPlan(
            rafal,
            householdId,
            week,
            {
              expectedRevision: seen.revision,
              slots: [
                {
                  dayOfWeek: 'TUE',
                  mealType: 'DINNER',
                  recipeId: dinner.id,
                  participantIds: [],
                  portions: values,
                },
              ],
            },
          );
          expect(result.applied).toBe(true);
          expect(result.changes).toEqual({
            created: 0,
            updated: 1,
            deleted: 0,
          });
        } else {
          await weeklyPlans.upsertWeekSlot(rafal, householdId, week, {
            dayOfWeek: 'TUE',
            mealType: 'DINNER',
            recipeId: dinner.id,
            participantIds: [],
            portions: values,
            expectedRevision: item.revision,
          });
        }
        const refused = await refusal(() =>
          weeklyPlans.setPortion(asia, householdId, week, {
            planItemId: item.id,
            userId: rafal,
            servings: 1.5,
            expectedRevision: portionToken(item, rafal),
          }),
        );
        const after = (await readWeek(asia, householdId, week)).items[0];
        console.log(
          `[R3 ${writer}] uczestnicy ${JSON.stringify(item.participantIds.length)}→${JSON.stringify(after.participantIds)} stempel Rafała ${portionToken(item, rafal)}→${portionToken(after, rafal)} → setPortion: ${refused.code}`,
        );
        expect(after.participantIds).toEqual([]);
        expect(refused.code).toBe('PLAN_REVISION_CONFLICT');
        expect(byPerson(after.portions)).toEqual(byPerson(values));
      },
    );

    it('R3b. „Wspólne” → jawna lista wszystkich domowników to ten sam stan po normalizacji: prawdziwy NOOP (apply i upsert) — bez nowej rewizji, tokeny ważne; setPortion jednej osoby nie unieważnia tokenu drugiej', async () => {
      const { asia, rafal, householdId } = await couple('R3b');
      const values = [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.25 },
      ];
      const seen = await allocated(asia, householdId, values);
      const plan = await readPlan(asia, householdId);
      const applied = await apply(rafal, householdId, {
        expectedRevision: plan.revision,
        slots: [{ ...tuesdayOf(values), participantIds: [asia, rafal] }],
      });
      expect(applied.applied).toBe(true);
      expect(applied.changes).toEqual({ created: 0, updated: 0, deleted: 0 });
      const ack = (await upsert(rafal, householdId, {
        recipeId: dinner.id,
        participantIds: [asia, rafal],
        portions: values,
        expectedRevision: seen.revision,
      })) as unknown as { changeKind: string };
      expect(ack.changeKind).toBe('NOOP');
      expect((await readPlan(asia, householdId)).revision).toBe(plan.revision);

      // Niezależność setPortion: zmiana porcji Asi nie rusza tokenu Rafała.
      await setPortion(rafal, householdId, {
        planItemId: seen.id,
        userId: asia,
        servings: 1,
        expectedRevision: portionToken(seen, asia),
      });
      expect(
        await attempt(() =>
          setPortion(asia, householdId, {
            planItemId: seen.id,
            userId: rafal,
            servings: 1.5,
            expectedRevision: portionToken(seen, rafal),
          }),
        ),
      ).toBe('OK');
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
