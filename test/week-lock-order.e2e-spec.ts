import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';

/**
 * Kolejność blokad w transakcjach zmieniających tydzień — na żywej bazie.
 *
 * Od zamka zapisu tygodnia (`lockWeekForWrite`) każdy piszący trzyma wiersz
 * `WeeklyPlan`. Zamek pomaga tylko wtedy, gdy WSZYSCY biorą zasoby w tej samej
 * kolejności; inaczej dwie poprawne transakcje czekają na siebie nawzajem,
 * Postgres po `deadlock_timeout` zabija jedną z nich, a użytkownik dostaje 500
 * (albo — w `runSerializable` — ciche ponowienie, które maskuje problem).
 *
 * Dlatego ta suita NIE ufa końcowemu sukcesowi wywołań. Patrzy bazie na ręce:
 *  - próbkuje `pg_blocking_pids` i szuka CYKLU oczekiwań, dopóki trwa;
 *  - liczy próby transakcji i zapisuje błąd każdej nieudanej (przezroczysty
 *    szpieg na `$transaction` — niczego nie udaje, tylko notuje).
 *
 * Bariery są blokadami w bazie, trzymanymi przez transakcję testu — żadnych
 * `sleep`. „Czekam, aż N sesji stanie na blokadzie" to warunek, nie opóźnienie.
 */
type Session = { accessToken: string; user: { id: string } };

const WEEK_START = '2026-10-05';

describe('Kolejność blokad tygodnia (e2e, żywa baza)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let plans: WeeklyPlansService;
  let userId: string;
  let householdId: string;
  let dinner: string;
  const weekStartDate = new Date(`${WEEK_START}T00:00:00.000Z`);

  type Deferred = { promise: Promise<void>; resolve: () => void };
  const deferred = (): Deferred => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };

  /** Sesje TEJ bazy stojące na blokadzie, z tym, kto je blokuje. */
  const waiters = () =>
    prisma.$queryRaw<{ pid: number; blockers: number[] }[]>`
      SELECT pid, pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()`;

  const waitForWaiters = async (count: number) => {
    const deadline = Date.now() + 8_000;
    for (;;) {
      if ((await waiters()).length >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`na blokadzie nie stanęło ${count} sesji`);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  /**
   * Próbkuje graf oczekiwań do chwili, gdy `settled` się rozstrzygnie.
   * Cykl A→B→A żyje najwyżej `deadlock_timeout` (1 s), próbka trwa ~ms.
   */
  const watchForCycle = async (settled: Promise<unknown>) => {
    let done = false;
    void settled.finally(() => (done = true));
    let cycle = false;
    while (!done) {
      const rows = await waiters();
      const blockedBy = new Map(rows.map((row) => [row.pid, row.blockers]));
      for (const [pid, blockers] of blockedBy) {
        if (blockers.some((other) => blockedBy.get(other)?.includes(pid))) {
          cycle = true;
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return cycle;
  };

  /** Przezroczysty licznik prób transakcji; błędy nieudanych zostają w `failures`. */
  const recordTransactions = () => {
    const failures: string[] = [];
    let attempts = 0;
    const original = prisma.$transaction.bind(prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    jest
      .spyOn(prisma, '$transaction')
      .mockImplementation((...args: unknown[]) => {
        attempts += 1;
        return original(...args).catch((error: unknown) => {
          const known = error as { code?: string; message?: string };
          failures.push(`${known.code ?? '?'}: ${known.message ?? ''}`);
          throw error;
        });
      });
    return { failures, attempts: () => attempts };
  };

  const outcome = (call: Promise<unknown>) =>
    call.then(
      () => 'ok',
      (error: Error) =>
        `błąd: ${error.message.replace(/\s+/g, ' ').slice(0, 160)}`,
    );

  const planItems = () =>
    prisma.planItem.count({
      where: { weeklyPlan: { householdId, weekStart: weekStartDate } },
    });

  const wipeWeek = async () => {
    const scope = { householdId, weekStart: weekStartDate };
    await prisma.shoppingListArchiveState.deleteMany({ where: scope });
    await prisma.shoppingList.deleteMany({ where: scope });
    await prisma.weeklyPlan.deleteMany({ where: scope });
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    plans = app.get(WeeklyPlansService);

    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `Blokady ${stamp}`,
        email: `blokady-${stamp}@locks.local`,
      })
      .expect(201);
    userId = (res.body as Session).user.id;
    const household = await prisma.household.create({
      data: { name: `Dom blokad ${stamp}`, createdById: userId },
    });
    householdId = household.id;
    await prisma.membership.create({
      data: { userId, householdId, role: 'OWNER' },
    });
    const recipe = await prisma.recipe.findFirst({
      where: {
        isCatalog: true,
        suitableMealTypes: { has: 'DINNER' },
        allergens: { isEmpty: true },
      },
      select: { id: true },
    });
    if (!recipe) throw new Error('katalog nie ma kolacji');
    dinner = recipe.id;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await wipeWeek();
  });

  afterAll(async () => {
    await prisma.household.deleteMany({ where: { id: householdId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  /**
   * [ścieżka, wywołanie, pozycje po wszystkim, UPRAWNIONE ponowienia].
   * `applyWeekPlan` jest SERIALIZABLE: po odczekaniu na zamku jego migawka
   * jest starsza niż zatwierdzone czyszczenie, więc dostaje konflikt
   * serializacji (P2034) i liczy wszystko od nowa — tak ma być, to na tym stoi
   * „Cofnij". Zakleszczenie wygląda inaczej: cykl w grafie oczekiwań i surowe
   * `40P01`, którego Prisma na P2034 NIE mapuje.
   */
  const writers: [string, () => Promise<unknown>, number, number][] = [
    [
      'upsertWeekSlot',
      () =>
        plans.upsertWeekSlot(userId, householdId, WEEK_START, {
          dayOfWeek: 'MON',
          mealType: 'DINNER',
          recipeId: dinner,
        }),
      1,
      0,
    ],
    [
      'applyWeekPlan',
      () =>
        plans.applyWeekPlan(userId, householdId, WEEK_START, {
          slots: [{ dayOfWeek: 'MON', mealType: 'DINNER', recipeId: dinner }],
        }),
      1,
      1,
    ],
    [
      'removeWeekSlot',
      () =>
        plans.removeWeekSlot(userId, householdId, WEEK_START, {
          dayOfWeek: 'MON',
          mealType: 'DINNER',
        }),
      0,
      0,
    ],
  ];

  it.each(writers)(
    '%s i czyszczenie tygodnia nie czekają na siebie nawzajem (tydzień istnieje, stan archiwum bez archiwum)',
    async (_name, write, itemsAfter, retries) => {
      await prisma.weeklyPlan.create({
        data: { householdId, weekStart: weekStartDate },
      });
      await prisma.shoppingListArchiveState.create({
        data: { householdId, weekStart: weekStartDate, currentArchiveId: null },
      });
      const list = await prisma.shoppingList.create({
        data: { householdId, weekStart: weekStartDate },
      });

      const held = deferred();
      const release = deferred();
      // BARIERA: wiersz listy zakupów. `clearWeekPlan` dochodzi do niego JUŻ
      // z zamkiem tygodnia w ręku, a jeszcze PRZED stanem archiwum.
      const barrier = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM "ShoppingList" WHERE id = ${list.id}::uuid FOR UPDATE`,
          );
          held.resolve();
          await release.promise;
        },
        { timeout: 18_000 },
      );
      await held.promise;
      const tx = recordTransactions();

      let clearing: Promise<string> | null = null;
      let writing: Promise<string> | null = null;
      let cycle = false;
      try {
        // 1. Czyszczenie: bierze zamek tygodnia i staje na barierze.
        clearing = outcome(
          plans.clearWeekPlan(userId, householdId, WEEK_START),
        );
        await waitForWaiters(1);
        // 2. Zapis posiłku: staje na zamku tygodnia trzymanym przez czyszczenie.
        //    Pytanie testu: CO trzyma w tej chwili w ręku.
        writing = outcome(write());
        await waitForWaiters(2);
        // 3. Bariera puszcza: czyszczenie idzie dalej — po stan archiwum.
        const both = Promise.all([clearing, writing]);
        release.resolve();
        cycle = await watchForCycle(both);
      } finally {
        release.resolve();
        await barrier.catch(() => undefined);
        await Promise.all([clearing, writing]);
      }

      // Jedna asercja na cały obraz: przy porażce widać naraz cykl, ofiarę
      // i to, czy ponowienie ją zamaskowało. Bariera poszła przed szpiegiem,
      // więc próby = czyszczenie + zapis (+ uprawnione ponowienia zapisu).
      expect({
        cycle,
        failures: tx.failures.map((failure) => failure.slice(0, 5)),
        attempts: tx.attempts(),
        clearing: await clearing,
        writing: await writing,
      }).toEqual({
        cycle: false,
        failures: Array.from({ length: retries }, () => 'P2034'),
        attempts: 2 + retries,
        clearing: 'ok',
        writing: 'ok',
      });
      // Zapis czekał na czyszczenie, więc wszedł PO nim i został.
      expect(await planItems()).toBe(itemsAfter);
    },
    25_000,
  );

  it('to samo, gdy tygodnia JESZCZE NIE MA: zapis, który go zakłada, i czyszczenie biorą stan archiwum i listę zakupów w tej samej kolejności', async () => {
    await prisma.shoppingListArchiveState.create({
      data: { householdId, weekStart: weekStartDate, currentArchiveId: null },
    });
    await prisma.shoppingList.create({
      data: { householdId, weekStart: weekStartDate },
    });

    const held = deferred();
    const release = deferred();
    // BARIERA: wiersz przepisu. Wstawienie pozycji planu sprawdza klucz obcy
    // (FOR KEY SHARE na przepisie) — zapis staje więc w POŁOWIE transakcji,
    // po założeniu tygodnia i po stanie archiwum, a przed listą zakupów.
    const barrier = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "Recipe" WHERE id = ${dinner}::uuid FOR UPDATE`,
        );
        held.resolve();
        await release.promise;
      },
      { timeout: 18_000 },
    );
    await held.promise;
    const tx = recordTransactions();

    let clearing: Promise<string> | null = null;
    let writing: Promise<string> | null = null;
    let cycle = false;
    try {
      writing = outcome(
        plans.upsertWeekSlot(userId, householdId, WEEK_START, {
          dayOfWeek: 'MON',
          mealType: 'DINNER',
          recipeId: dinner,
        }),
      );
      await waitForWaiters(1);
      // Tydzień zapisu jest niezatwierdzony, więc czyszczenie go NIE widzi
      // i nie ma zamka, na którym mogłoby grzecznie poczekać.
      clearing = outcome(plans.clearWeekPlan(userId, householdId, WEEK_START));
      await waitForWaiters(2);
      const both = Promise.all([clearing, writing]);
      release.resolve();
      cycle = await watchForCycle(both);
    } finally {
      release.resolve();
      await barrier.catch(() => undefined);
      await Promise.all([clearing, writing]);
    }

    // P2034 Prismy znaczy zarówno „konflikt serializacji", jak i „deadlock",
    // więc po samym błędzie nie da się ich odróżnić — rozstrzyga graf oczekiwań.
    // Ponowienie czyszczenia jest tu UPRAWNIONE (zapis zdążył usunąć stan
    // archiwum, który czyszczenie już widziało), byle nie wynikało z cyklu.
    expect({
      cycle,
      clearing: await clearing,
      writing: await writing,
      failures: tx.failures.length,
    }).toEqual({ cycle: false, clearing: 'ok', writing: 'ok', failures: 1 });
    expect(await planItems()).toBe(0);
  }, 25_000);
});
