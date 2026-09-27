import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppException } from '../src/common/app-exception';
import { PrismaService } from '../src/prisma/prisma.service';
import { lockWeekForWrite } from '../src/weekly-plans/utils/week-write-lock.util';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';

/**
 * Porcje per osoba a zapis ze starego stanu (workstream plan-portions-write-safety).
 *
 * Niezmiennik: klient, który nie przekazuje jawnej i odpowiednio chronionej
 * intencji zmiany alokacji, nie może zwykłym zapisem pozycji usunąć ani
 * zastąpić istniejących porcji per osoba.
 *
 * Bez zegarów jako synchronizacji: transakcja B trzymana otwarta na zatrzasku
 * (obietnica), a „A czeka na zamek tygodnia” rozpoznajemy po
 * `pg_stat_activity` (`wait_event_type = 'Lock'`).
 */
type Portion = { userId: string; servings: number };
type Item = {
  id: string;
  dayOfWeek: string;
  mealType: string;
  recipeId: string;
  participantIds: string[];
  plannedServings: number;
  portions: Portion[];
};

const WEEK_START = '2026-08-31';

jest.setTimeout(60_000);

describe('Porcje per osoba — zapis ze starego stanu', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let weeklyPlans: WeeklyPlansService;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  let dinner: { id: string };

  const latch = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { open, opened };
  };

  const codeOf = (error: unknown): string => {
    if (error instanceof AppException) {
      return (error.getResponse() as { code: string }).code;
    }
    return `ERROR ${String((error as Error)?.message ?? error).slice(0, 160)}`;
  };

  /** Czeka, aż inna sesja tej bazy stanie na blokadzie (albo `done`). */
  const waitUntilBlocked = async (done: () => boolean) => {
    for (let i = 0; i < 2_000 && !done(); i += 1) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS "waiting" FROM pg_stat_activity
        WHERE "datname" = current_database()
          AND "wait_event_type" = 'Lock'
          AND "pid" <> pg_backend_pid()`;
      if (Number(row.waiting) > 0) return 'blocked' as const;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return done() ? ('done' as const) : ('timeout' as const);
  };

  const byPerson = (portions: Portion[]) =>
    Object.fromEntries(portions.map((p) => [p.userId, p.servings]));

  const createUser = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@porcje-zapis.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  };

  /** Dom dwojga: Asia (właścicielka) + Rafał. */
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

  const readItems = async (userId: string, householdId: string) => {
    const plan = (await weeklyPlans.getByHouseholdAndWeek(
      userId,
      householdId,
      WEEK_START,
    )) as unknown as { items: Item[] } | null;
    return plan?.items ?? [];
  };

  const weeklyPlanId = async (householdId: string) =>
    (
      await prisma.weeklyPlan.findFirstOrThrow({
        where: { householdId },
        select: { id: true },
      })
    ).id;

  /**
   * „Transakcja B”: alokacja 0,9 + 1,3 zapisywana pod zamkiem tygodnia —
   * tak jak zapis każdego klienta, który porcje zna. Trzymana otwarta do
   * `commit.open()`.
   */
  const holdAllocation = (
    planId: string,
    people: { asia: string; rafal: string },
  ) => {
    const wrote = latch();
    const commit = latch();
    const done = prisma.$transaction(
      async (tx) => {
        await lockWeekForWrite(tx, planId);
        const item = await tx.planItem.findFirstOrThrow({
          where: { weeklyPlanId: planId },
          select: { id: true },
        });
        await tx.planItemPortion.createMany({
          data: [
            { planItemId: item.id, userId: people.asia, units: 18 },
            { planItemId: item.id, userId: people.rafal, units: 26 },
          ],
        });
        await tx.planItem.update({
          where: { id: item.id },
          data: { plannedServings: 3 },
        });
        wrote.open();
        await commit.opened;
      },
      { timeout: 45_000, maxWait: 10_000 },
    );
    return { wrote: wrote.opened, commit: () => commit.open(), done };
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    weeklyPlans = app.get(WeeklyPlansService);
    const found = await prisma.recipe.findFirst({
      where: {
        isCatalog: true,
        isActive: true,
        OR: [
          { suitableMealTypes: { has: 'DINNER' } },
          { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (!found) throw new Error('katalog dev nie ma kolacji');
    dinner = found;
  });

  afterAll(async () => {
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.close();
  });

  it('1. RACE: A zapisuje bez porcji ze starego stanu, czekając na zamek, który trzyma B z nową alokacją — alokacja B zostaje', async () => {
    const log: string[] = [];
    const { asia, rafal, householdId } = await couple('Race');
    // 1. Pozycja bez alokacji.
    await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
      dayOfWeek: 'TUE',
      mealType: 'DINNER',
      recipeId: dinner.id,
    });
    // 2. Klient A odczytuje ten stan.
    const seenByA = await readItems(asia, householdId);
    expect(seenByA[0].portions).toEqual([]);
    log.push('A: odczyt — pozycja bez alokacji');

    // 3. Transakcja B zapisuje alokację i trzyma zamek tygodnia.
    const b = holdAllocation(await weeklyPlanId(householdId), {
      asia,
      rafal,
    });
    await b.wrote;
    log.push('B: alokacja 0,9/1,3 zapisana, zamek tygodnia trzymany');

    // 4. A zapisuje pozycję bez `portions` (zmiana „kto je”) — ze starego stanu.
    let aDone = false;
    const aWrite = weeklyPlans
      .upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
        participantIds: [asia],
      })
      .then(
        () => 'OK',
        (error: unknown) => codeOf(error),
      )
      .finally(() => (aDone = true));
    // 5. A czeka na zamek.
    const waited = await waitUntilBlocked(() => aDone);
    log.push(`A: zapis bez portions wysłany — ${waited}`);
    expect(waited).toBe('blocked');

    // 6. B commituje, 7. A kontynuuje.
    b.commit();
    await b.done;
    log.push('B: commit');
    const aResult = await aWrite;
    log.push(`A: wynik — ${aResult}`);

    const [item] = await readItems(asia, householdId);
    log.push(
      `stan: portions=${JSON.stringify(item.portions)} plannedServings=${item.plannedServings} participantIds=${JSON.stringify(item.participantIds)}`,
    );
    console.log(`[race] ${log.join(' → ')}`);

    // Bezpieczeństwo: alokacja B nie została niejawnie usunięta ani zmieniona.
    expect(byPerson(item.portions)).toEqual({ [asia]: 0.9, [rafal]: 1.3 });
    expect(item.plannedServings).toBe(3);
    expect(item.participantIds).toEqual([]);
    expect(aResult).toBe('PLAN_PORTIONS_CONFLICT');
  });

  it('1b. SEKWENCYJNIE: B commituje po odczycie A, przed zapisem A — alokacja B zostaje', async () => {
    const log: string[] = [];
    const { asia, rafal, householdId } = await couple('Seq');
    await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
      dayOfWeek: 'TUE',
      mealType: 'DINNER',
      recipeId: dinner.id,
    });
    const seenByA = await readItems(asia, householdId);
    expect(seenByA[0].portions).toEqual([]);
    log.push('A: odczyt — pozycja bez alokacji');

    // B: jawny zapis alokacji przez domenę (klient, który zna porcje).
    await weeklyPlans.upsertWeekSlot(rafal, householdId, WEEK_START, {
      dayOfWeek: 'TUE',
      mealType: 'DINNER',
      recipeId: dinner.id,
      portions: [
        { userId: asia, servings: 0.9 },
        { userId: rafal, servings: 1.3 },
      ],
    });
    log.push('B: alokacja 0,9/1,3 zapisana i zatwierdzona');

    // A: zapis ze starego stanu — stepper porcji łącznych, bez `portions`.
    const aResult = await weeklyPlans
      .upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
        plannedServings: 2,
      })
      .then(
        () => 'OK',
        (error: unknown) => codeOf(error),
      );
    log.push(`A: stepper bez portions — ${aResult}`);

    const [item] = await readItems(asia, householdId);
    log.push(
      `stan: portions=${JSON.stringify(item.portions)} plannedServings=${item.plannedServings}`,
    );
    console.log(`[sekwencyjnie] ${log.join(' → ')}`);

    expect(byPerson(item.portions)).toEqual({ [asia]: 0.9, [rafal]: 1.3 });
    expect(item.plannedServings).toBe(3);
    expect(aResult).toBe('PLAN_PORTIONS_CONFLICT');
  });
});
