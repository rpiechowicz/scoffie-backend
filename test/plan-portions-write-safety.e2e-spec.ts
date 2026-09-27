import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { Prisma } from '@prisma/client';
import {
  CARDS_CAPABILITY_V1,
  kcalForPerson,
} from '../src/agent/cards/agent-cards';
import * as liveEvents from '../src/common/live-events';
import { configureApp } from '../src/app.setup';
import { AppException } from '../src/common/app-exception';
import { PrismaService } from '../src/prisma/prisma.service';
import { lockWeekForWrite } from '../src/weekly-plans/utils/week-write-lock.util';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';
import { AgentToolExecutor } from '../src/agent/tools/agent-tool-executor';

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
  revision: number;
};

const WEEK_START = '2026-08-31';
const CLIENT_TODAY = '2026-09-02';

type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

jest.setTimeout(60_000);

describe('Porcje per osoba — zapis ze starego stanu', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let weeklyPlans: WeeklyPlansService;
  let executor: AgentToolExecutor;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  let dinner: { id: string };
  let dinnerB: { id: string };
  let dinnerC: { id: string };

  const ENV_KEYS = [
    'AI_ENABLED',
    'AI_PROVIDER',
    'AI_STUB_DELAY_MS',
    'AI_TIER_OVERRIDE',
    'AI_CONSENT_REQUIRED',
    'AI_CARDS_MODE',
    'THROTTLE_DEFAULT_LIMIT',
    'THROTTLE_IP_LIMIT',
    'THROTTLE_AUTH_LIMIT',
    'THROTTLE_AGENT_MESSAGE_LIMIT',
    'THROTTLE_AGENT_POLL_LIMIT',
  ] as const;
  const original: Record<string, string | undefined> = {};
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

  const code = async (attempt: Promise<unknown>): Promise<string> =>
    attempt.then(
      () => 'BRAK_ODMOWY',
      (error: unknown) => codeOf(error),
    );

  /** Jawny zapis alokacji przez domenę — klient, który porcje zna. */
  const allocate = (
    userId: string,
    householdId: string,
    recipeId: string,
    portions: Portion[],
    participantIds?: string[],
    dayOfWeek: 'MON' | 'TUE' | 'WED' = 'TUE',
  ) =>
    weeklyPlans.upsertWeekSlot(userId, householdId, WEEK_START, {
      dayOfWeek,
      mealType: 'DINNER',
      recipeId,
      ...(participantIds ? { participantIds } : {}),
      portions,
    });

  const itemOf = (items: Item[], recipeId: string, day = 'TUE') =>
    items.find((item) => item.recipeId === recipeId && item.dayOfWeek === day);

  /**
   * Zastąpienie ISTNIEJĄCEJ alokacji przez klienta, który przed chwilą ją
   * przeczytał — z tokenem pozycji (ADR `plan-portions-safe-editing`).
   */
  const reallocate = async (
    userId: string,
    householdId: string,
    recipeId: string,
    portions: Portion[],
  ) => {
    const seen = itemOf(await readItems(userId, householdId), recipeId)!;
    return weeklyPlans.upsertWeekSlot(userId, householdId, WEEK_START, {
      dayOfWeek: 'TUE',
      mealType: 'DINNER',
      recipeId,
      portions,
      expectedRevision: seen.revision,
    });
  };

  /** Dom dwojga z sesją HTTP Asi (tury asystenta, propozycje). */
  const sessionCouple = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `porcje-zapis-${stamp}@porcje-zapis.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    const rafal = await createUser(`Rafal${label}`);
    const home = await prisma.household.create({
      data: { name: `${label} ${stamp}`, createdById: session.user.id },
      select: { id: true },
    });
    createdHouseholdIds.push(home.id);
    await prisma.membership.createMany({
      data: [
        { userId: session.user.id, householdId: home.id, role: 'OWNER' },
        { userId: rafal, householdId: home.id, role: 'MEMBER' },
      ],
    });
    return { session, asia: session.user.id, rafal, householdId: home.id };
  };

  /** Tura stubu (zero wywołań modelu) — do końca, z odpowiedzią. */
  const turn = async (
    session: Session,
    householdId: string,
    text: string,
    cards = true,
  ) => {
    const conversation = (
      (
        await request(app.getHttpServer())
          .post('/agent/conversations')
          .set(auth(session.accessToken))
          .send({ householdId })
          .expect(201)
      ).body as { id: string }
    ).id;
    const accepted = await request(app.getHttpServer())
      .post(`/agent/conversations/${conversation}/messages`)
      .set(auth(session.accessToken))
      .send({
        text,
        clientMessageId: randomUUID(),
        weekStart: WEEK_START,
        clientToday: CLIENT_TODAY,
        timeZone: 'Europe/Warsaw',
        clientCapabilities: cards ? [CARDS_CAPABILITY_V1] : [],
      })
      .expect(202);
    const turnId = (accepted.body as { turnId: string }).turnId;
    for (const deadline = Date.now() + 15_000; ; ) {
      const row = await prisma.agentTurn.findUniqueOrThrow({
        where: { id: turnId },
      });
      if (row.status !== 'RUNNING') {
        expect(row.status).toBe('DONE');
        break;
      }
      if (Date.now() > deadline) throw new Error(`tura ${turnId} wisi`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const answer = await prisma.agentMessage.findFirstOrThrow({
      where: { turnId, role: 'ASSISTANT' },
    });
    return { conversationId: conversation, answer };
  };

  const proposalOf = async (answer: { card: unknown }) =>
    prisma.agentProposal.findUniqueOrThrow({
      where: { id: (answer.card as { proposalId: string }).proposalId },
    });

  const plansQuota = async (householdId: string) =>
    (
      await prisma.aiUsageCounter.findMany({
        where: { kind: 'plans', scopeId: householdId },
      })
    ).reduce((sum, row) => sum + row.value, 0);

  const weeklyPlanId = async (householdId: string) =>
    (
      await prisma.weeklyPlan.findFirstOrThrow({
        where: { householdId },
        select: { id: true },
      })
    ).id;

  /**
   * „Transakcja B”: alokacja 0,5 + 2 zapisywana pod zamkiem tygodnia —
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
            { planItemId: item.id, userId: people.asia, units: 10 },
            { planItemId: item.id, userId: people.rafal, units: 40 },
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
    for (const key of ENV_KEYS) original[key] = process.env[key];
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_STUB_DELAY_MS = '0';
    process.env.AI_TIER_OVERRIDE = 'PRO';
    process.env.AI_CONSENT_REQUIRED = 'false';
    process.env.AI_CARDS_MODE = 'soft';
    for (const key of [
      'THROTTLE_DEFAULT_LIMIT',
      'THROTTLE_IP_LIMIT',
      'THROTTLE_AUTH_LIMIT',
      'THROTTLE_AGENT_MESSAGE_LIMIT',
      'THROTTLE_AGENT_POLL_LIMIT',
    ]) {
      process.env[key] = '10000';
    }
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    weeklyPlans = app.get(WeeklyPlansService);
    executor = app.get(AgentToolExecutor);
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
    await prisma.invitation.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
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
    log.push('B: alokacja 0,5/2 zapisana, zamek tygodnia trzymany');

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
    expect(byPerson(item.portions)).toEqual({ [asia]: 0.5, [rafal]: 2 });
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
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ],
    });
    log.push('B: alokacja 0,5/2 zapisana i zatwierdzona');

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

    expect(byPerson(item.portions)).toEqual({ [asia]: 0.5, [rafal]: 2 });
    expect(item.plannedServings).toBe(3);
    expect(aResult).toBe('PLAN_PORTIONS_CONFLICT');
  });

  describe('upsertWeekSlot', () => {
    it('2. `portions` pominięte i `[]`: identyczny zapis zostawia alokację (NOOP), zmiana = PLAN_PORTIONS_CONFLICT', async () => {
      const { asia, rafal, householdId } = await couple('Pusta');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      const omitted = await weeklyPlans.upsertWeekSlot(
        asia,
        householdId,
        WEEK_START,
        { dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: dinner.id },
      );
      expect(omitted.changeKind).toBe('NOOP');
      const empty = await weeklyPlans.upsertWeekSlot(
        asia,
        householdId,
        WEEK_START,
        {
          dayOfWeek: 'TUE',
          mealType: 'DINNER',
          recipeId: dinner.id,
          portions: [],
        },
      );
      expect(empty.changeKind).toBe('NOOP');
      expect(
        await code(
          weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
            dayOfWeek: 'TUE',
            mealType: 'DINNER',
            recipeId: dinner.id,
            participantIds: [rafal],
            portions: [],
          }),
        ),
      ).toBe('PLAN_PORTIONS_CONFLICT');
      const [item] = await readItems(asia, householdId);
      expect(byPerson(item.portions)).toEqual({ [asia]: 0.5, [rafal]: 2 });
      expect(item.plannedServings).toBe(3);
      expect(item.participantIds).toEqual([]);
    });

    it('3. jawne `portions` zastępują alokację tylko z tokenem pozycji (bez tokenu → PLAN_REVISION_REQUIRED, nic nie zmienione)', async () => {
      const { asia, rafal, householdId } = await couple('Jawne');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      expect(
        await code(
          allocate(asia, householdId, dinner.id, [
            { userId: asia, servings: 1 },
            { userId: rafal, servings: 1.5 },
          ]),
        ),
      ).toBe('PLAN_REVISION_REQUIRED');
      expect(
        byPerson((await readItems(asia, householdId))[0].portions),
      ).toEqual({ [asia]: 0.5, [rafal]: 2 });
      await reallocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const [item] = await readItems(asia, householdId);
      expect(byPerson(item.portions)).toEqual({ [asia]: 1, [rafal]: 1.5 });
      expect(item.plannedServings).toBe(3);
    });

    it('4. replaceRecipeId: źródło z alokacją bez porcji → odmowa, NIC nie zmienione (źródło zostaje, cel nie powstaje)', async () => {
      const { asia, rafal, householdId } = await couple('ZamianaZrodlo');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      expect(
        await code(
          weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
            dayOfWeek: 'TUE',
            mealType: 'DINNER',
            recipeId: dinnerB.id,
            replaceRecipeId: dinner.id,
          }),
        ),
      ).toBe('PLAN_PORTIONS_CONFLICT');
      const items = await readItems(asia, householdId);
      expect(items.map((item) => item.recipeId)).toEqual([dinner.id]);
      expect(byPerson(items[0].portions)).toEqual({
        [asia]: 0.5,
        [rafal]: 2,
      });
    });

    it('4b. replaceRecipeId: źródło z alokacją i JAWNE porcje nowego dania → zamiana przechodzi z tokenem źródła (bez → PLAN_REVISION_REQUIRED)', async () => {
      const { asia, rafal, householdId } = await couple('ZamianaJawna');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      const swap = {
        dayOfWeek: 'TUE' as const,
        mealType: 'DINNER' as const,
        recipeId: dinnerB.id,
        replaceRecipeId: dinner.id,
        portions: [
          { userId: asia, servings: 1 },
          { userId: rafal, servings: 1.5 },
        ],
      };
      expect(
        await code(
          weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, swap),
        ),
      ).toBe('PLAN_REVISION_REQUIRED');
      const source = itemOf(await readItems(asia, householdId), dinner.id)!;
      const result = await weeklyPlans.upsertWeekSlot(
        asia,
        householdId,
        WEEK_START,
        {
          ...swap,
          expectedRevision: source.revision,
          expectedTargetRevision: null,
        },
      );
      expect(result.changeKind).toBe('REPLACED');
      const items = await readItems(asia, householdId);
      expect(items.map((item) => item.recipeId)).toEqual([dinnerB.id]);
      expect(byPerson(items[0].portions)).toEqual({ [asia]: 1, [rafal]: 1.5 });
    });

    it('4c. replaceRecipeId: CEL już w slocie z alokacją — zmiana audytorium celu → odmowa, źródło NIE usunięte', async () => {
      const { asia, rafal, householdId } = await couple('ZamianaCel');
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
      });
      await allocate(asia, householdId, dinnerB.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      expect(
        await code(
          weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
            dayOfWeek: 'TUE',
            mealType: 'DINNER',
            recipeId: dinnerB.id,
            replaceRecipeId: dinner.id,
            participantIds: [asia],
          }),
        ),
      ).toBe('PLAN_PORTIONS_CONFLICT');
      const items = await readItems(asia, householdId);
      expect(items.map((item) => item.recipeId).sort()).toEqual(
        [dinner.id, dinnerB.id].sort(),
      );
      expect(byPerson(itemOf(items, dinnerB.id)!.portions)).toEqual({
        [asia]: 0.5,
        [rafal]: 2,
      });

      // Ten sam cel bez zmiany audytorium: źródło znika, cel nietknięty.
      const kept = await weeklyPlans.upsertWeekSlot(
        asia,
        householdId,
        WEEK_START,
        {
          dayOfWeek: 'TUE',
          mealType: 'DINNER',
          recipeId: dinnerB.id,
          replaceRecipeId: dinner.id,
        },
      );
      expect(kept.changeKind).toBe('REPLACED');
      const after = await readItems(asia, householdId);
      expect(after.map((item) => item.recipeId)).toEqual([dinnerB.id]);
      expect(byPerson(after[0].portions)).toEqual({
        [asia]: 0.5,
        [rafal]: 2,
      });
    });

    it('5. legacy bez alokacji: zmiana audytorium i stepper jak dotąd; niezależna pozycja obok alokowanej działa', async () => {
      const { asia, rafal, householdId } = await couple('Legacy');
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
      });
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
        participantIds: [asia],
      });
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
        participantIds: [asia],
        plannedServings: 3,
      });
      let [item] = await readItems(asia, householdId);
      expect(item.participantIds).toEqual([asia]);
      expect(item.plannedServings).toBe(3);
      expect(item.portions).toEqual([]);

      await allocate(
        asia,
        householdId,
        dinnerB.id,
        [
          { userId: asia, servings: 0.5 },
          { userId: rafal, servings: 2 },
        ],
        undefined,
        'WED',
      );
      const created = await weeklyPlans.upsertWeekSlot(
        asia,
        householdId,
        WEEK_START,
        {
          dayOfWeek: 'WED',
          mealType: 'DINNER',
          recipeId: dinnerC.id,
          participantIds: [rafal],
        },
      );
      expect(created.changeKind).toBe('CREATED');
      const items = await readItems(asia, householdId);
      expect(byPerson(itemOf(items, dinnerB.id, 'WED')!.portions)).toEqual({
        [asia]: 0.5,
        [rafal]: 2,
      });
      [item] = items.filter((row) => row.recipeId === dinnerC.id);
      expect(item.participantIds).toEqual([rafal]);
    });

    it('6. jawne usunięcie i „zjedzone” działają na pozycji z alokacją', async () => {
      const { asia, rafal, householdId } = await couple('Usun');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      await weeklyPlans.setMealEaten(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
        isEaten: true,
      });
      let [item] = await readItems(asia, householdId);
      expect(byPerson(item.portions)).toEqual({ [asia]: 0.5, [rafal]: 2 });
      await weeklyPlans.removeWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
      });
      expect(await readItems(asia, householdId)).toEqual([]);

      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      [item] = await readItems(asia, householdId);
      expect(item.portions).toHaveLength(2);
      await weeklyPlans.clearWeekPlan(asia, householdId, WEEK_START);
      expect(await readItems(asia, householdId)).toEqual([]);
    });

    it('7. odmowa nie emituje sukcesu i nie zmienia pozycji; obcy dostaje NOT_HOUSEHOLD_MEMBER przed porcjami', async () => {
      const { asia, rafal, householdId } = await couple('Odmowa');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      const before = await readItems(asia, householdId);
      const live = jest.spyOn(liveEvents, 'emitLive');
      try {
        expect(
          await code(
            weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
              dayOfWeek: 'TUE',
              mealType: 'DINNER',
              recipeId: dinner.id,
              participantIds: [asia],
            }),
          ),
        ).toBe('PLAN_PORTIONS_CONFLICT');
        const refused = await weeklyPlans.applyWeekPlan(
          asia,
          householdId,
          WEEK_START,
          {
            slots: [
              {
                dayOfWeek: 'TUE',
                mealType: 'DINNER',
                recipeId: dinner.id,
                participantIds: [asia],
              },
            ],
          },
        );
        expect(refused.applied).toBe(false);
        expect(live).not.toHaveBeenCalled();
      } finally {
        live.mockRestore();
      }
      expect(await readItems(asia, householdId)).toEqual(before);

      const outsider = await createUser('Obcy');
      expect(
        await code(
          weeklyPlans.upsertWeekSlot(outsider, householdId, WEEK_START, {
            dayOfWeek: 'TUE',
            mealType: 'DINNER',
            recipeId: dinner.id,
          }),
        ),
      ).toBe('NOT_HOUSEHOLD_MEMBER');
    });
  });

  describe('applyWeekPlan', () => {
    it('8. jedna konfliktująca pozycja → applied:false z naruszeniem, NIC nie zapisane (także nowe sloty)', async () => {
      const { asia, rafal, householdId } = await couple('Apply');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      const before = await readItems(asia, householdId);
      const slots = [
        {
          dayOfWeek: 'MON' as const,
          mealType: 'DINNER' as const,
          recipeId: dinnerB.id,
        },
        {
          dayOfWeek: 'TUE' as const,
          mealType: 'DINNER' as const,
          recipeId: dinner.id,
          plannedServings: 4,
        },
      ];
      const dry = await weeklyPlans.applyWeekPlan(
        asia,
        householdId,
        WEEK_START,
        { slots, dryRun: true },
      );
      expect(dry.violations.map((v) => [v.index, v.code])).toEqual([
        [1, 'PLAN_PORTIONS_CONFLICT'],
      ]);
      const result = await weeklyPlans.applyWeekPlan(
        asia,
        householdId,
        WEEK_START,
        { slots },
      );
      expect(result.applied).toBe(false);
      expect(result.violations.map((v) => [v.index, v.code])).toEqual([
        [1, 'PLAN_PORTIONS_CONFLICT'],
      ]);
      expect(result.changes).toEqual({ created: 0, updated: 0, deleted: 0 });
      expect(await readItems(asia, householdId)).toEqual(before);
    });

    it('9. identyczne wymienienie pozycji z alokacją (bez porcji, także `[]`) zostawia ją; reszta stanu docelowego wchodzi', async () => {
      const { asia, rafal, householdId } = await couple('ApplyKeep');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      const result = await weeklyPlans.applyWeekPlan(
        asia,
        householdId,
        WEEK_START,
        {
          slots: [
            { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: dinnerB.id },
            {
              dayOfWeek: 'TUE',
              mealType: 'DINNER',
              recipeId: dinner.id,
              portions: [],
            },
          ],
        },
      );
      expect(result.applied).toBe(true);
      expect(result.changes).toEqual({ created: 1, updated: 0, deleted: 0 });
      const items = await readItems(asia, householdId);
      expect(byPerson(itemOf(items, dinner.id)!.portions)).toEqual({
        [asia]: 0.5,
        [rafal]: 2,
      });
      expect(itemOf(items, dinner.id)!.plannedServings).toBe(3);
      expect(itemOf(items, dinnerB.id, 'MON')).toBeDefined();
    });

    it('10. `no-allocation-changes` nie zmienia porcji; `authoritative` BEZ guarda odrzucone przed zapisem (baza bez zmian)', async () => {
      const { asia, rafal, householdId } = await couple('Polityki');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      const forced = await weeklyPlans.applyWeekPlan(
        asia,
        householdId,
        WEEK_START,
        {
          slots: [
            {
              dayOfWeek: 'TUE',
              mealType: 'DINNER',
              recipeId: dinner.id,
              portions: [
                { userId: asia, servings: 1 },
                { userId: rafal, servings: 1 },
              ],
            },
          ],
        },
        { portionsPolicy: 'no-allocation-changes' },
      );
      expect(forced.violations.map((v) => v.code)).toEqual([
        'PLAN_PORTIONS_CONFLICT',
      ]);
      const before = await readItems(asia, householdId);
      let refusal = 'BRAK_ODMOWY';
      await weeklyPlans
        .applyWeekPlan(
          asia,
          householdId,
          WEEK_START,
          {
            slots: [
              {
                dayOfWeek: 'TUE',
                mealType: 'DINNER',
                recipeId: dinner.id,
                plannedServings: 2,
              },
            ],
          },
          { portionsPolicy: 'authoritative' },
        )
        .catch((error: unknown) => {
          refusal = String((error as Error).message);
        });
      console.log(`[authoritative bez guarda] ${refusal}`);
      expect(refusal).not.toBe('BRAK_ODMOWY');
      expect(await readItems(asia, householdId)).toEqual(before);
    });
  });

  describe('propozycje i narzędzia AI (stub, zero wywołań modelu)', () => {
    it('11. alokacja dodana PO propozycji: apply bez force → STALE (odcisk); z force i zmianą pozycji → STALE/VIOLATIONS; kwota, wiadomość i plan nietknięte', async () => {
      const { session, asia, householdId } = await sessionCouple('PropForce');
      // Pozycja imienna (tylko Asia), bez alokacji — propozycja wymienia ją
      // jako „Wspólne”, czyli zmienia audytorium.
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
        participantIds: [asia],
      });
      const { answer, conversationId } = await turn(
        session,
        householdId,
        `Propozycja [[propose:${dinnerB.id}:${WEEK_START}]] [[propose:${dinner.id}:${WEEK_START}]]`,
      );
      const proposal = await proposalOf(answer);
      expect(proposal.status).toBe('PENDING');

      // Po utworzeniu propozycji ktoś ustawia alokację tej pozycji.
      await allocate(
        asia,
        householdId,
        dinner.id,
        [{ userId: asia, servings: 1.5 }],
        [asia],
      );
      const before = await readItems(asia, householdId);

      const plain = await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({})
        .expect(409);
      expect((plain.body as { details: string[] }).details).toContain(
        'reason:CHANGED',
      );

      const forced = await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({ force: true })
        .expect(409);
      expect((forced.body as { details: string[] }).details).toEqual([
        'reason:VIOLATIONS',
        'PLAN_PORTIONS_CONFLICT',
      ]);
      const after = await prisma.agentProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      expect(after.status).toBe('STALE');
      expect(after.appliedAt).toBeNull();
      expect(await readItems(asia, householdId)).toEqual(before);
      expect(await plansQuota(householdId)).toBe(0);
      expect(
        await prisma.agentMessage.count({
          where: { conversationId, kind: 'APPLIED' },
        }),
      ).toBe(0);
    });

    it('12. z force propozycja wymienia pozycję z alokacją bez zmian → zapis przechodzi, alokacja zostaje', async () => {
      const { session, asia, rafal, householdId } =
        await sessionCouple('PropKeep');
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
      });
      const { answer } = await turn(
        session,
        householdId,
        `Propozycja [[propose:${dinnerB.id}:${WEEK_START}]] [[propose:${dinner.id}:${WEEK_START}]]`,
      );
      const proposal = await proposalOf(answer);
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({ force: true })
        .expect(200);
      const items = await readItems(asia, householdId);
      expect(byPerson(itemOf(items, dinner.id)!.portions)).toEqual({
        [asia]: 0.5,
        [rafal]: 2,
      });
      expect(itemOf(items, dinnerB.id, 'MON')).toBeDefined();
    });

    it('13. undo: alokacja dodana PO zapisie → odmowa (odcisk), status APPLIED, alokacja zostaje; bez zmian po zapisie → cofnięcie przywraca tydzień z porcjami', async () => {
      const { session, asia, rafal, householdId } = await sessionCouple('Undo');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      const first = await turn(
        session,
        householdId,
        `Propozycja [[propose:${dinnerB.id}:${WEEK_START}]] [[propose:${dinner.id}:${WEEK_START}]]`,
      );
      const proposal = await proposalOf(first.answer);
      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({})
        .expect(200);
      let items = await readItems(asia, householdId);
      expect(byPerson(itemOf(items, dinner.id)!.portions)).toEqual({
        [asia]: 0.5,
        [rafal]: 2,
      });

      // Undo po zapisie bez zmian: tydzień wraca do stanu sprzed, porcje zostają.
      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/undo`)
        .set(auth(session.accessToken))
        .send({})
        .expect(200);
      items = await readItems(asia, householdId);
      expect(items.map((item) => item.recipeId)).toEqual([dinner.id]);
      expect(byPerson(items[0].portions)).toEqual({
        [asia]: 0.5,
        [rafal]: 2,
      });

      // Drugi zapis, potem zmiana alokacji — cofnięcie odmawia.
      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({})
        .expect(200);
      await reallocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const refused = await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/undo`)
        .set(auth(session.accessToken))
        .send({})
        .expect(409);
      expect((refused.body as { details: string[] }).details).toEqual([
        'reason:CHANGED_AFTER_APPLY',
      ]);
      const row = await prisma.agentProposal.findUniqueOrThrow({
        where: { id: proposal.id },
      });
      expect(row.status).toBe('APPLIED');
      items = await readItems(asia, householdId);
      expect(byPerson(itemOf(items, dinner.id)!.portions)).toEqual({
        [asia]: 1,
        [rafal]: 1.5,
      });
    });

    it('14. narzędzia AI (prawdziwy AgentToolExecutor, bez modelu) nie obchodzą zabezpieczenia: bezpośredni zapis zmiany pozycji z alokacją = odmowa, identyczny slot ją zostawia; propozycja zachowuje alokację (PRESERVE, per-user-portions-write-safety)', async () => {
      const { asia, rafal, householdId } = await couple('Narzedzia');
      await allocate(
        asia,
        householdId,
        dinner.id,
        [{ userId: asia, servings: 1.5 }],
        [asia],
      );
      const before = await readItems(asia, householdId);
      const context = (proposalMode: boolean) => ({
        userId: asia,
        householdId,
        catalogIndex: {},
        conversationId: randomUUID(),
        turnId: randomUUID(),
        proposalMode,
        collectCard: () => undefined,
      });
      // Model nie podaje uczestników = „Wspólne” — na imiennej pozycji to
      // zmiana audytorium, a porcji model podać nie umie (`toSlots`).
      const tuesday = {
        day_of_week: 'TUE',
        meal_type: 'DINNER',
        recipe: dinner.id,
      };

      const proposed = await executor.execute(
        'propose_week_plan',
        {
          week_start: WEEK_START,
          slots: [
            { day_of_week: 'MON', meal_type: 'DINNER', recipe: dinnerB.id },
            tuesday,
          ],
        },
        context(true),
      );
      // Od workstreamu per-user-portions-write-safety propozycja nie odmawia:
      // serwer oznacza pozycję z alokacją `PRESERVE` i przelicza ją na nowe
      // audytorium (Asia zachowuje 1,5, Rafał dostaje 1,0) — model niczego
      // nie liczy. Propozycja niczego nie zapisuje.
      expect(JSON.stringify(proposed)).not.toContain('PLAN_PORTIONS_CONFLICT');
      expect(await readItems(asia, householdId)).toEqual(before);

      const applied = await executor.execute(
        'apply_week_plan',
        { week_start: WEEK_START, dry_run: false, slots: [tuesday] },
        context(false),
      );
      expect(JSON.stringify(applied)).toContain('PLAN_PORTIONS_CONFLICT');
      expect(await readItems(asia, householdId)).toEqual(before);

      // Pozycja „Wspólna” z alokacją — ten sam slot jej nie zmienia.
      await weeklyPlans.removeWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
      });
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ]);
      const kept = await executor.execute(
        'apply_week_plan',
        { week_start: WEEK_START, dry_run: false, slots: [tuesday] },
        context(false),
      );
      expect(JSON.stringify(kept)).not.toContain('PLAN_PORTIONS_CONFLICT');
      expect(kept.ok).toBe(true);
      const [item] = await readItems(asia, householdId);
      expect(byPerson(item.portions)).toEqual({ [asia]: 0.5, [rafal]: 2 });
      expect(item.plannedServings).toBe(3);
    });
  });

  describe('review: force usuwa, podgląd KEEP, authoritative bez ochrony', () => {
    /** Tydzień i stan propozycji — do porównania „nic się nie zmieniło”. */
    const snapshot = async (
      asia: string,
      householdId: string,
      proposalId: string,
      conversationId: string,
    ) => ({
      items: await readItems(asia, householdId),
      proposal: await prisma.agentProposal.findUniqueOrThrow({
        where: { id: proposalId },
        select: { status: true, appliedAt: true },
      }),
      quota: await plansQuota(householdId),
      applied: await prisma.agentMessage.count({
        where: { conversationId, kind: 'APPLIED' },
      }),
    });

    it('15. force apply: propozycja POMIJA pozycję, która po jej utworzeniu dostała alokację → odmowa, pozycja zostaje', async () => {
      const { session, asia, rafal, householdId } =
        await sessionCouple('ForceUsun');
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
      });
      // Stan docelowy propozycji: sam poniedziałek — wtorek wypada.
      const { answer, conversationId } = await turn(
        session,
        householdId,
        `Propozycja [[propose:${dinnerB.id}:${WEEK_START}]]`,
      );
      const proposal = await proposalOf(answer);
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 1.5 },
      ]);

      const plain = await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({})
        .expect(409);
      expect((plain.body as { details: string[] }).details).toContain(
        'reason:CHANGED',
      );
      const before = await snapshot(
        asia,
        householdId,
        proposal.id,
        conversationId,
      );

      const forced = await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({ force: true });
      const after = await snapshot(
        asia,
        householdId,
        proposal.id,
        conversationId,
      );
      console.log(
        `[force-usun] status=${forced.status} details=${JSON.stringify((forced.body as { details?: unknown }).details)} items=${after.items.map((i) => `${i.dayOfWeek}:${i.portions.length}`).join(',')}`,
      );
      expect(forced.status).toBe(409);
      expect((forced.body as { details: string[] }).details).toEqual([
        'reason:VIOLATIONS',
        'PLAN_PORTIONS_CONFLICT',
      ]);
      expect(after.items).toEqual(before.items);
      expect(after.proposal.status).toBe('STALE');
      expect(after.proposal.appliedAt).toBeNull();
      expect(after.quota).toBe(0);
      expect(after.applied).toBe(0);
    });

    it('16. force apply: zamiana dania jako usunięcie starego klucza slotu i nowy klucz → odmowa, stare danie z alokacją zostaje', async () => {
      const { session, asia, rafal, householdId } =
        await sessionCouple('ForceZamiana');
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
      });
      // MON B, TUE C — wtorkowa kolacja X wypada, wchodzi C (nowy klucz).
      const { answer, conversationId } = await turn(
        session,
        householdId,
        `Propozycja [[propose:${dinnerB.id}:${WEEK_START}]] [[propose:${dinnerC.id}:${WEEK_START}]]`,
      );
      const proposal = await proposalOf(answer);
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 1.5 },
      ]);
      const before = await snapshot(
        asia,
        householdId,
        proposal.id,
        conversationId,
      );
      const forced = await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({ force: true });
      const after = await snapshot(
        asia,
        householdId,
        proposal.id,
        conversationId,
      );
      console.log(
        `[force-zamiana] status=${forced.status} items=${after.items.map((i) => `${i.dayOfWeek}:${i.recipeId === dinner.id ? 'X' : 'inne'}:${i.portions.length}`).join(',')}`,
      );
      expect(forced.status).toBe(409);
      expect((forced.body as { details: string[] }).details).toEqual([
        'reason:VIOLATIONS',
        'PLAN_PORTIONS_CONFLICT',
      ]);
      expect(after.items).toEqual(before.items);
      expect(after.proposal.status).toBe('STALE');
      expect(after.quota).toBe(0);
      expect(after.applied).toBe(0);
    });

    it('16b. surowy applyWeekPlan bez tokenu NIE usuwa pozycji z alokacją spoza stanu docelowego (PLAN_REVISION_REQUIRED); z tokenem tygodnia — usuwa (ADR plan-portions-safe-editing, domknięty API GAP)', async () => {
      const { asia, rafal, householdId } = await couple('StrictUsun');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 1.5 },
      ]);
      const target = {
        slots: [
          {
            dayOfWeek: 'MON' as const,
            mealType: 'DINNER' as const,
            recipeId: dinnerB.id,
          },
        ],
      };
      const refused = await weeklyPlans.applyWeekPlan(
        asia,
        householdId,
        WEEK_START,
        target,
      );
      expect(refused.applied).toBe(false);
      expect(
        refused.violations.map((v) => [v.index, v.code, v.recipeId]),
      ).toEqual([[-1, 'PLAN_REVISION_REQUIRED', dinner.id]]);
      expect(
        (await readItems(asia, householdId)).map((item) => item.recipeId),
      ).toEqual([dinner.id]);

      const { revision } = (await weeklyPlans.getByHouseholdAndWeek(
        asia,
        householdId,
        WEEK_START,
      )) as unknown as { revision: number };
      const result = await weeklyPlans.applyWeekPlan(
        asia,
        householdId,
        WEEK_START,
        { ...target, expectedRevision: revision },
      );
      expect(result.applied).toBe(true);
      expect(result.changes).toEqual({ created: 1, updated: 0, deleted: 1 });
      expect(
        (await readItems(asia, householdId)).map((item) => item.recipeId),
      ).toEqual([dinnerB.id]);
    });

    it('17. podgląd, dryRun, zapis i bilans są zgodne dla KEEP (pominięte i `[]`); WRITE i CONFLICT bez zmian', async () => {
      for (const empty of [undefined, []] as const) {
        const { asia, rafal, householdId } = await couple('PodgladKeep');
        await allocate(asia, householdId, dinner.id, [
          { userId: asia, servings: 0.5 },
          { userId: rafal, servings: 1.5 },
        ]);
        const tuesday = {
          dayOfWeek: 'TUE' as const,
          mealType: 'DINNER' as const,
          recipeId: dinner.id,
          ...(empty ? { portions: [...empty] } : {}),
        };
        const slots = [
          {
            dayOfWeek: 'MON' as const,
            mealType: 'DINNER' as const,
            recipeId: dinnerB.id,
          },
          tuesday,
        ];
        const label = empty ? '[]' : 'pominięte';

        const preview = await weeklyPlans.previewWeekPlan(
          asia,
          householdId,
          WEEK_START,
          { slots },
        );
        const dry = await weeklyPlans.applyWeekPlan(
          asia,
          householdId,
          WEEK_START,
          { slots, dryRun: true },
        );
        const previewTue = preview.slots!.find(
          (slot) => slot.dayOfWeek === 'TUE',
        )!;
        const cardKcal = kcalForPerson(
          preview.slots!.filter((slot) => slot.dayOfWeek === 'TUE'),
          asia,
        );
        console.log(
          `[podglad ${label}] preview.updated=${preview.changes.updated} dry.updated=${dry.changes.updated} previewTue.portions=${JSON.stringify(previewTue.portions)} servingsPerPerson=${previewTue.servingsPerPerson} kcalKarty(Asia)=${cardKcal}`,
        );
        expect(preview.changes).toEqual({ created: 1, updated: 0, deleted: 0 });
        expect(dry.changes).toEqual({ created: 1, updated: 0, deleted: 0 });
        expect(byPerson(previewTue.portions ?? [])).toEqual({
          [asia]: 0.5,
          [rafal]: 1.5,
        });

        const applied = await weeklyPlans.applyWeekPlan(
          asia,
          householdId,
          WEEK_START,
          { slots },
        );
        expect(applied.changes).toEqual({ created: 1, updated: 0, deleted: 0 });
        const saved = itemOf(await readItems(asia, householdId), dinner.id)!;
        expect(byPerson(saved.portions)).toEqual(
          byPerson(previewTue.portions!),
        );
        const balance = await weeklyPlans.weeklyBalance(
          asia,
          householdId,
          WEEK_START,
          asia,
        );
        const tueKcal = balance.days.find((day) => day.dayOfWeek === 'TUE')!
          .planned.kcal;
        expect(Math.abs(cardKcal - tueKcal)).toBeLessThanOrEqual(1);
      }

      // WRITE: jawne inne porcje — podgląd liczy aktualizację i pokazuje nowe.
      const { asia, rafal, householdId } = await couple('PodgladWrite');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 1.5 },
      ]);
      const write = await weeklyPlans.previewWeekPlan(
        asia,
        householdId,
        WEEK_START,
        {
          slots: [
            {
              dayOfWeek: 'TUE',
              mealType: 'DINNER',
              recipeId: dinner.id,
              portions: [
                { userId: asia, servings: 1 },
                { userId: rafal, servings: 1 },
              ],
            },
          ],
        },
      );
      expect(write.changes).toEqual({ created: 0, updated: 1, deleted: 0 });
      expect(byPerson(write.slots![0].portions ?? [])).toEqual({
        [asia]: 1,
        [rafal]: 1,
      });
      // CONFLICT: zmiana audytorium bez porcji — naruszenie w podglądzie.
      const conflict = await weeklyPlans.previewWeekPlan(
        asia,
        householdId,
        WEEK_START,
        {
          slots: [
            {
              dayOfWeek: 'TUE',
              mealType: 'DINNER',
              recipeId: dinner.id,
              participantIds: [asia],
            },
          ],
        },
      );
      expect(conflict.violations.map((v) => v.code)).toEqual([
        'PLAN_PORTIONS_CONFLICT',
      ]);
    });

    it('18. karta propozycji (prawdziwa ścieżka propose_week_plan): pozycja KEEP pokazuje zachowaną alokację i kcal zgodne z bilansem po zapisie', async () => {
      const { session, asia, rafal, householdId } =
        await sessionCouple('Karta');
      await allocate(asia, householdId, dinner.id, [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 1.5 },
      ]);
      const { answer } = await turn(
        session,
        householdId,
        `Propozycja [[propose:${dinnerB.id}:${WEEK_START}]] [[propose:${dinner.id}:${WEEK_START}]]`,
      );
      const proposal = await proposalOf(answer);
      // Akcja propozycji NIE niesie porcji — decyzja zapisu zapada pod zamkiem.
      const tuesdayAction = (
        proposal.action as {
          slots: { dayOfWeek: string; portions?: unknown }[];
        }
      ).slots.find((slot) => slot.dayOfWeek === 'TUE')!;
      expect(tuesdayAction.portions).toBeUndefined();

      const card = proposal.card as {
        days: {
          dayOfWeek: string;
          kcalTotal: number;
          slots: { portions?: { userId: string; servings: number }[] }[];
        }[];
      };
      const tueCard = card.days.find((day) => day.dayOfWeek === 'TUE')!;
      console.log(
        `[karta] TUE portions=${JSON.stringify(tueCard.slots[0].portions)} kcalTotal=${tueCard.kcalTotal}`,
      );
      expect(byPerson(tueCard.slots[0].portions ?? [])).toEqual({
        [asia]: 0.5,
        [rafal]: 1.5,
      });

      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({})
        .expect(200);
      const balance = await weeklyPlans.weeklyBalance(
        asia,
        householdId,
        WEEK_START,
        asia,
      );
      const tueKcal = balance.days.find((day) => day.dayOfWeek === 'TUE')!
        .planned.kcal;
      expect(Math.abs(tueCard.kcalTotal - tueKcal)).toBeLessThanOrEqual(1);
      expect(
        byPerson(
          itemOf(await readItems(asia, householdId), dinner.id)!.portions,
        ),
      ).toEqual({ [asia]: 0.5, [rafal]: 1.5 });
    });

    it('19. prawdziwe undo z poprawnym odciskiem przywraca DOKŁADNY stan — także pozycję bez alokacji; po zmianie planu odmawia bez częściowego zapisu', async () => {
      const { session, asia, rafal, householdId } =
        await sessionCouple('UndoDokladne');
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
      });
      const beforeApply = await readItems(asia, householdId);
      const { answer } = await turn(
        session,
        householdId,
        `Propozycja [[propose:${dinnerB.id}:${WEEK_START}]] [[propose:${dinner.id}:${WEEK_START}]]`,
      );
      const proposal = await proposalOf(answer);
      // Porcje w akcji — tak, jak liczy je planer przy włączonej fladze
      // (stub nie umie ich wymusić na konkretnej pozycji). Odcisk bazowy
      // i ścieżki apply/undo zostają prawdziwe.
      const action = proposal.action as {
        slots: Record<string, unknown>[];
      };
      await prisma.agentProposal.update({
        where: { id: proposal.id },
        data: {
          action: {
            slots: action.slots.map((slot) =>
              slot.dayOfWeek === 'TUE'
                ? {
                    ...slot,
                    portions: [
                      { userId: asia, servings: 0.5 },
                      { userId: rafal, servings: 1.5 },
                    ],
                  }
                : slot,
            ),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({})
        .expect(200);
      expect(
        byPerson(
          itemOf(await readItems(asia, householdId), dinner.id)!.portions,
        ),
      ).toEqual({ [asia]: 0.5, [rafal]: 1.5 });

      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/undo`)
        .set(auth(session.accessToken))
        .send({})
        .expect(200);
      const restored = await readItems(asia, householdId);
      expect(restored.map((item) => item.recipeId)).toEqual([dinner.id]);
      expect(restored[0].portions).toEqual([]);
      expect(restored[0].plannedServings).toBe(beforeApply[0].plannedServings);
      expect(restored[0].participantIds).toEqual(beforeApply[0].participantIds);

      // Ponowny zapis, potem zmiana planu (nowe danie) — undo odmawia, nic nie wchodzi.
      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .send({})
        .expect(200);
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'WED',
        mealType: 'DINNER',
        recipeId: dinnerC.id,
      });
      const beforeUndo = await readItems(asia, householdId);
      const refused = await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/undo`)
        .set(auth(session.accessToken))
        .send({})
        .expect(409);
      expect((refused.body as { details: string[] }).details).toEqual([
        'reason:CHANGED_AFTER_APPLY',
      ]);
      expect(await readItems(asia, householdId)).toEqual(beforeUndo);
      expect(
        (
          await prisma.agentProposal.findUniqueOrThrow({
            where: { id: proposal.id },
          })
        ).status,
      ).toBe('APPLIED');
    });
  });
});
