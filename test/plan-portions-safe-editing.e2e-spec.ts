import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppException } from '../src/common/app-exception';
import { PrismaService } from '../src/prisma/prisma.service';
import { ApplyWeekPlanDto } from '../src/weekly-plans/dto/apply-week-plan.dto';
import { UpsertWeekSlotDto } from '../src/weekly-plans/dto/upsert-week-slot.dto';
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

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    weeklyPlans = app.get(WeeklyPlansService);
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
});
