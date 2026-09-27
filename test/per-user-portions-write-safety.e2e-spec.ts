import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CARDS_CAPABILITY_V1 } from '../src/agent/cards/agent-cards';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { lockWeekForWrite } from '../src/weekly-plans/utils/week-write-lock.util';
import { WeeklyPlansGateway } from '../src/weekly-plans/weekly-plans.gateway';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';
import { ShoppingListService } from '../src/weekly-plans/services/shopping-list.service';

/**
 * Per-user portions — write safety (workstream per-user-portions-write-safety).
 *
 * Wyścigi 1–4 (ETAP 1) używają WYŁĄCZNIE kontraktu, który istnieje już na
 * `develop` — ta sama suita mierzy FAIL przed i PASS po. Zapisy A idą przez
 * gateway WS (to, co robi telefon), a broadcast łapie szpieg serwera.
 * Przeploty: zamek tygodnia trzymany na zatrzasku, oczekiwanie wykryte w
 * `pg_stat_activity` — bez zegarów. AI tylko stub (zero wywołań modelu).
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
  revision?: number;
};
type Plan = { revision?: number; items: Item[] };
type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};
type WsAck = { ok: boolean; code?: string; data?: unknown };

const WEEK_START = '2026-08-31';
const CLIENT_TODAY = '2026-09-02';

jest.setTimeout(90_000);

describe('Per-user portions — write safety', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let weeklyPlans: WeeklyPlansService;
  let gateway: WeeklyPlansGateway;
  let shoppingLists: ShoppingListService;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  let dinner: { id: string };
  let dinnerB: { id: string };
  let dinnerC: { id: string };
  const emitted: { event: string; body: unknown }[] = [];
  let originalServer: unknown;

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

  /** Czeka, aż inna sesja tej bazy stoi na blokadzie. */
  const waitUntilBlocked = async () => {
    for (let i = 0; i < 5_000; i += 1) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS "waiting" FROM pg_stat_activity
        WHERE "datname" = current_database()
          AND "wait_event_type" = 'Lock'
          AND "pid" <> pg_backend_pid()`;
      if (Number(row.waiting) > 0) return true;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return false;
  };

  const byPerson = (portions: Portion[]) =>
    Object.fromEntries(portions.map((p) => [p.userId, p.servings]));

  /** Wiersze porcji w bazie — do porównania „bit w bit”. */
  const portionRows = async (planItemId: string) =>
    prisma.planItemPortion.findMany({
      where: { planItemId },
      orderBy: { userId: 'asc' },
    });

  const createUser = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@porcje-bezpieczne.local`,
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

  /** Dom z sesją HTTP Asi (tury asystenta, propozycje) i opcjonalnie Olą. */
  const sessionHome = async (label: string, withOla = false) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `porcje-bezpieczne-${stamp}@porcje-bezpieczne.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    const rafal = await createUser(`Rafal${label}`);
    const ola = withOla ? await createUser(`Ola${label}`) : null;
    const home = await prisma.household.create({
      data: { name: `${label} ${stamp}`, createdById: session.user.id },
      select: { id: true },
    });
    createdHouseholdIds.push(home.id);
    await prisma.membership.createMany({
      data: [
        { userId: session.user.id, householdId: home.id, role: 'OWNER' },
        { userId: rafal, householdId: home.id, role: 'MEMBER' },
        ...(ola
          ? [{ userId: ola, householdId: home.id, role: 'MEMBER' as const }]
          : []),
      ],
    });
    return { session, asia: session.user.id, rafal, ola, householdId: home.id };
  };

  const readPlan = async (
    userId: string,
    householdId: string,
    week = WEEK_START,
  ) =>
    (await weeklyPlans.getByHouseholdAndWeek(
      userId,
      householdId,
      week,
    )) as unknown as Plan;

  const itemOf = (plan: Plan, recipeId: string, day = 'TUE') =>
    plan.items.find(
      (item) => item.recipeId === recipeId && item.dayOfWeek === day,
    );

  /** Zapis telefonu przez gateway WS (koperta jak z iOS). */
  const wsClient = (userId: string) =>
    ({ data: { userId, mode: 'token' } }) as never;
  const wsUpsert = (
    userId: string,
    householdId: string,
    data: Record<string, unknown>,
    week = WEEK_START,
  ) =>
    gateway.upsertWeekSlot(wsClient(userId), {
      householdId,
      weekStart: week,
      data: { dayOfWeek: 'TUE', mealType: 'DINNER', ...data },
    } as never) as Promise<WsAck>;
  const wsApply = (
    userId: string,
    householdId: string,
    data: Record<string, unknown>,
    week = WEEK_START,
  ) =>
    gateway.applyWeekPlan(wsClient(userId), {
      householdId,
      weekStart: week,
      data,
    } as never) as Promise<WsAck>;

  /** Jawna alokacja przez domenę (klient, który porcje zna). */
  const allocate = async (
    userId: string,
    householdId: string,
    portions: Portion[],
    fields: Record<string, unknown> = {},
    week = WEEK_START,
  ) => {
    await weeklyPlans.upsertWeekSlot(userId, householdId, week, {
      dayOfWeek: 'TUE',
      mealType: 'DINNER',
      recipeId: dinner.id,
      portions,
      ...fields,
    } as never);
    return itemOf(
      await readPlan(userId, householdId, week),
      (fields.recipeId as string) ?? dinner.id,
    )!;
  };

  /**
   * „Transakcja B”: alokacja 1 + 1,5 zapisywana pod zamkiem tygodnia
   * i trzymana otwarta do `commit()`.
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
            { planItemId: item.id, userId: people.asia, units: 20 },
            { planItemId: item.id, userId: people.rafal, units: 30 },
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

  /** Tura stubu do końca (zero wywołań modelu). */
  const turn = async (
    session: Session,
    householdId: string,
    text: string,
    conversationId?: string,
  ) => {
    const conversation =
      conversationId ??
      (
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
        clientCapabilities: [CARDS_CAPABILITY_V1],
      })
      .expect(202);
    const turnId = (accepted.body as { turnId: string }).turnId;
    for (const deadline = Date.now() + 20_000; ; ) {
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
    return prisma.agentMessage.findFirstOrThrow({
      where: { turnId, role: 'ASSISTANT' },
    });
  };
  const proposalIdOf = (answer: { card: unknown }) =>
    (answer.card as { proposalId?: string } | null)?.proposalId ?? null;
  const applyProposal = (session: Session, proposalId: string) =>
    request(app.getHttpServer())
      .post(`/agent/proposals/${proposalId}/apply`)
      .set(auth(session.accessToken))
      .send({});

  beforeAll(async () => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_STUB_DELAY_MS = '0';
    process.env.AI_TIER_OVERRIDE = 'PRO';
    process.env.AI_CONSENT_REQUIRED = 'false';
    process.env.AI_CARDS_MODE = 'on';
    process.env.THROTTLE_DEFAULT_LIMIT = '10000';
    process.env.THROTTLE_IP_LIMIT = '10000';
    process.env.THROTTLE_AUTH_LIMIT = '10000';
    process.env.THROTTLE_AGENT_MESSAGE_LIMIT = '10000';
    process.env.THROTTLE_AGENT_POLL_LIMIT = '10000';
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    weeklyPlans = app.get(WeeklyPlansService);
    gateway = app.get(WeeklyPlansGateway);
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
    if (found.length < 3) throw new Error('katalog nie ma trzech kolacji');
    [dinner, dinnerB, dinnerC] = found;
  });

  beforeEach(() => {
    emitted.length = 0;
    const g = gateway as unknown as { server: unknown };
    originalServer = g.server;
    const emit = (event: string, body: unknown) => {
      emitted.push({ event, body });
      return true;
    };
    g.server = {
      emit,
      to: () => ({ emit }),
      in: () => ({
        socketsJoin: () => undefined,
        socketsLeave: () => undefined,
        disconnectSockets: () => undefined,
      }),
    };
  });

  afterEach(() => {
    (gateway as unknown as { server: unknown }).server = originalServer;
  });

  afterAll(async () => {
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

  describe('ETAP 1 — wyścigi (kontrakt z develop, FAIL przed poprawką)', () => {
    it('Race 1 (zamek). A czyta pozycję bez alokacji; B pod zamkiem zapisuje porcje; A wysyła stary upsert bez portions i czeka; B commit → A: jawny konflikt, alokacja B nietknięta, zero broadcastu A', async () => {
      const { asia, rafal, householdId } = await couple('Race1');
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
      });
      const seen = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(seen.portions).toEqual([]);
      const planId = (
        await prisma.weeklyPlan.findFirstOrThrow({
          where: { householdId },
          select: { id: true },
        })
      ).id;
      const b = holdAllocation(planId, { asia, rafal });
      await b.wrote;
      emitted.length = 0;
      const a = wsUpsert(asia, householdId, {
        recipeId: dinner.id,
        participantIds: [asia],
      });
      const waited = await waitUntilBlocked();
      b.commit();
      await b.done;
      const ack = await a;
      const after = itemOf(await readPlan(asia, householdId), dinner.id)!;
      console.log(
        `[Race1] A czekał=${waited} → ack ${ack.ok ? 'OK' : ack.code} → porcje ${JSON.stringify(byPerson(after.portions))} uczestnicy=${after.participantIds.length} broadcasty=${emitted.length}`,
      );
      expect(waited).toBe(true);
      expect(ack).toEqual(
        expect.objectContaining({ ok: false, code: 'PLAN_PORTIONS_CONFLICT' }),
      );
      expect(byPerson(after.portions)).toEqual({ [asia]: 1, [rafal]: 1.5 });
      expect(after.participantIds).toEqual([]);
      expect(after.plannedServings).toBe(3);
      expect(emitted).toEqual([]);
    });

    it.each([
      ['audytorium', { participantIds: 'ASIA' }],
      ['stepper plannedServings', { plannedServings: 2 }],
    ])(
      'Race 1b (sekwencyjnie, %s). B commituje alokację PRZED requestem A; stary payload A bez portions → konflikt, nic nie zapisane, zero broadcastu',
      async (_label, change) => {
        const { asia, rafal, householdId } = await couple('Race1b');
        await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
          dayOfWeek: 'TUE',
          mealType: 'DINNER',
          recipeId: dinner.id,
        });
        await allocate(rafal, householdId, [
          { userId: asia, servings: 1 },
          { userId: rafal, servings: 1.5 },
        ]);
        const before = itemOf(await readPlan(asia, householdId), dinner.id)!;
        const rowsBefore = await portionRows(before.id);
        emitted.length = 0;
        const ack = await wsUpsert(asia, householdId, {
          recipeId: dinner.id,
          ...('participantIds' in change ? { participantIds: [asia] } : change),
        });
        const after = itemOf(await readPlan(asia, householdId), dinner.id)!;
        console.log(
          `[Race1b ${_label}] ack ${ack.ok ? 'OK' : ack.code} → porcje ${JSON.stringify(byPerson(after.portions))}`,
        );
        expect(ack).toEqual(
          expect.objectContaining({
            ok: false,
            code: 'PLAN_PORTIONS_CONFLICT',
          }),
        );
        expect(await portionRows(before.id)).toEqual(rowsBefore);
        expect(after.plannedServings).toBe(before.plannedServings);
        expect(emitted).toEqual([]);
      },
    );

    it('Race 2. Stare danie ma porcje; nieaktualny klient podmienia przepis (replaceRecipeId) bez wiedzy o alokacji → konflikt; źródło i porcje zostają, nowe danie nie powstaje', async () => {
      const { asia, rafal, householdId } = await couple('Race2');
      const source = await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const rowsBefore = await portionRows(source.id);
      emitted.length = 0;
      const ack = await wsUpsert(rafal, householdId, {
        recipeId: dinnerB.id,
        replaceRecipeId: dinner.id,
      });
      const after = await readPlan(asia, householdId);
      console.log(
        `[Race2] ack ${ack.ok ? 'OK' : ack.code} → pozycje ${after.items.map((i) => `${i.recipeId === dinner.id ? 'X' : 'Y'}:${i.portions.length}`).join(',')}`,
      );
      expect(ack).toEqual(
        expect.objectContaining({ ok: false, code: 'PLAN_PORTIONS_CONFLICT' }),
      );
      expect(after.items.map((i) => i.recipeId)).toEqual([dinner.id]);
      expect(await portionRows(source.id)).toEqual(rowsBefore);
      expect(emitted).toEqual([]);
    });

    it('Race 3. applyWeekPlan: istniejąca pozycja z porcjami, slot bez portions — ze zmianą audytorium → applied:false (zero częściowego zapisu, zero broadcastu); bez zmiany → porcje bit w bit', async () => {
      const { asia, rafal, householdId } = await couple('Race3');
      const item = await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const rowsBefore = await portionRows(item.id);
      emitted.length = 0;
      const changed = await wsApply(asia, householdId, {
        slots: [
          {
            dayOfWeek: 'TUE',
            mealType: 'DINNER',
            recipeId: dinner.id,
            participantIds: [asia],
          },
          { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: dinnerB.id },
        ],
      });
      const data = changed.data as {
        applied: boolean;
        violations: { code: string }[];
      };
      const mid = await readPlan(asia, householdId);
      console.log(
        `[Race3] zmiana audytorium → applied=${data.applied} ${JSON.stringify(data.violations.map((v) => v.code))} pozycje=${mid.items.length} porcje=${JSON.stringify(byPerson(itemOf(mid, dinner.id)!.portions))}`,
      );
      expect(data.applied).toBe(false);
      expect(data.violations.map((v) => v.code)).toEqual([
        'PLAN_PORTIONS_CONFLICT',
      ]);
      expect(mid.items.map((i) => i.recipeId)).toEqual([dinner.id]);
      expect(await portionRows(item.id)).toEqual(rowsBefore);
      expect(emitted).toEqual([]);

      const same = await wsApply(asia, householdId, {
        slots: [
          { dayOfWeek: 'TUE', mealType: 'DINNER', recipeId: dinner.id },
          { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: dinnerB.id },
        ],
      });
      expect((same.data as { applied: boolean }).applied).toBe(true);
      expect(await portionRows(item.id)).toEqual(rowsBefore);
    });

    it('Race 4. Plan z porcjami; asystent (propozycja tygodnia, stub) zmienia INNĄ pozycję — nietknięta alokacja zostaje bit w bit', async () => {
      const { session, asia, rafal, householdId } = await sessionHome('Race4');
      const item = await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const rowsBefore = await portionRows(item.id);
      // MON = nowe danie, TUE = to samo danie co dziś (model nie zna porcji).
      const answer = await turn(
        session,
        householdId,
        `Plan [[propose:${dinnerB.id}:${WEEK_START}]] [[propose:${dinner.id}:${WEEK_START}]]`,
      );
      const proposalId = proposalIdOf(answer);
      expect(proposalId).not.toBeNull();
      const res = await applyProposal(session, proposalId!);
      const after = await readPlan(asia, householdId);
      console.log(
        `[Race4] apply ${res.status} → pozycje ${after.items.map((i) => i.dayOfWeek).join(',')} porcje TUE=${JSON.stringify(byPerson(itemOf(after, dinner.id)?.portions ?? []))}`,
      );
      expect(res.status).toBe(200);
      expect(itemOf(after, dinnerB.id, 'MON')).toBeDefined();
      expect(await portionRows(item.id)).toEqual(rowsBefore);
    });
  });

  describe('luki AI z mapy (FAIL na bazie #212)', () => {
    const allocatedTuesday = async (label: string) => {
      const home = await sessionHome(label);
      const item = await allocate(home.asia, home.householdId, [
        { userId: home.asia, servings: 1 },
        { userId: home.rafal, servings: 1.5 },
      ]);
      return { ...home, item };
    };

    it('G1. propozycja tygodnia (model) zamienia danie z porcjami na inne → nowe danie przejmuje porcje osób (KEEP), nie znikają', async () => {
      const { session, asia, rafal, householdId } =
        await allocatedTuesday('G1');
      const answer = await turn(
        session,
        householdId,
        `Plan [[propose:${dinnerB.id}:${WEEK_START}]] [[propose:${dinnerC.id}:${WEEK_START}]]`,
      );
      const proposalId = proposalIdOf(answer);
      expect(proposalId).not.toBeNull();
      expect((await applyProposal(session, proposalId!)).status).toBe(200);
      const after = await readPlan(asia, householdId);
      const swapped = itemOf(after, dinnerC.id);
      console.log(
        `[G1] TUE po zapisie: ${swapped ? JSON.stringify(byPerson(swapped.portions)) : 'brak'}`,
      );
      expect(itemOf(after, dinner.id)).toBeUndefined();
      expect(byPerson(swapped!.portions)).toEqual({
        [asia]: 1,
        [rafal]: 1.5,
      });
    });

    it('G1b. propozycja tygodnia (model) POMIJA danie z porcjami (bez zamiennika) → odmowa PLAN_PORTIONS_CONFLICT, propozycja nie powstaje, alokacja nietknięta', async () => {
      const { session, asia, householdId, item } =
        await allocatedTuesday('G1b');
      const rowsBefore = await portionRows(item.id);
      // Jedyny marker = poniedziałek; wtorku w stanie docelowym brak.
      const answer = await turn(
        session,
        householdId,
        `Plan [[propose:${dinnerB.id}:${WEEK_START}]]`,
      );
      console.log(
        `[G1b] karta=${proposalIdOf(answer) ? 'propozycja' : 'brak'} propozycje=${await prisma.agentProposal.count({ where: { householdId } })}`,
      );
      expect(proposalIdOf(answer)).toBeNull();
      expect(await prisma.agentProposal.count({ where: { householdId } })).toBe(
        0,
      );
      expect(
        itemOf(await readPlan(asia, householdId), dinner.id),
      ).toBeDefined();
      expect(await portionRows(item.id)).toEqual(rowsBefore);
    });

    it('G2. propose_swap dla całego domu (flaga planera wyłączona) → nowe danie przejmuje porcje osób', async () => {
      const { session, asia, rafal, householdId } =
        await allocatedTuesday('G2');
      const answer = await turn(
        session,
        householdId,
        `Zamień [[swap:TUE:DINNER:${dinnerC.id}]]`,
      );
      const proposalId = proposalIdOf(answer);
      expect(proposalId).not.toBeNull();
      expect((await applyProposal(session, proposalId!)).status).toBe(200);
      const swapped = itemOf(await readPlan(asia, householdId), dinnerC.id);
      console.log(
        `[G2] po zamianie: ${swapped ? JSON.stringify(byPerson(swapped.portions)) : 'brak'}`,
      );
      expect(byPerson(swapped!.portions)).toEqual({
        [asia]: 1,
        [rafal]: 1.5,
      });
    });

    it('G3. revise_proposal podmienia w czekającej propozycji pozycję z porcjami → nowe danie przejmuje porcje', async () => {
      const { session, asia, rafal, householdId } =
        await allocatedTuesday('G3');
      const first = await turn(
        session,
        householdId,
        `Plan [[propose:${dinnerB.id}:${WEEK_START}]] [[propose:${dinner.id}:${WEEK_START}]]`,
      );
      const pendingId = proposalIdOf(first);
      expect(pendingId).not.toBeNull();
      const revised = await turn(
        session,
        householdId,
        `Popraw [[revise:${pendingId}:TUE:DINNER:${dinnerC.id}]]`,
        first.conversationId,
      );
      const proposalId = proposalIdOf(revised);
      expect(proposalId).not.toBeNull();
      expect((await applyProposal(session, proposalId!)).status).toBe(200);
      const swapped = itemOf(await readPlan(asia, householdId), dinnerC.id);
      console.log(
        `[G3] po poprawce: ${swapped ? JSON.stringify(byPerson(swapped.portions)) : 'brak'}`,
      );
      expect(byPerson(swapped!.portions)).toEqual({
        [asia]: 1,
        [rafal]: 1.5,
      });
    });

    it('G4. pozycja z imienną listą WSZYSTKICH domowników (np. po odejściu) jest nietknięta przy propozycji dotyczącej innego posiłku — bez przepisania uczestników i stempli', async () => {
      const { session, asia, rafal, householdId, item } =
        await allocatedTuesday('G4');
      // Stan jak po odejściu trzeciej osoby: jawna lista obu domowników.
      await prisma.planItemParticipant.createMany({
        data: [
          { planItemId: item.id, userId: asia },
          { planItemId: item.id, userId: rafal },
        ],
      });
      const before = await prisma.planItem.findUniqueOrThrow({
        where: { id: item.id },
        include: { participants: true, portions: true },
      });
      const answer = await turn(
        session,
        householdId,
        `Zamień [[swap:MON:DINNER:${dinnerB.id}]]`,
      );
      const proposalId = proposalIdOf(answer);
      expect(proposalId).not.toBeNull();
      expect((await applyProposal(session, proposalId!)).status).toBe(200);
      const after = await prisma.planItem.findUniqueOrThrow({
        where: { id: item.id },
        include: { participants: true, portions: true },
      });
      console.log(
        `[G4] uczestnicy ${before.participants.length}→${after.participants.length}, rewizja ${String((before as { revision?: number }).revision)}→${String((after as { revision?: number }).revision)}`,
      );
      expect(after).toEqual(before);
    });
  });

  describe('ETAP 11 — macierz (1–2 = Race 1 / Race 1b wyżej)', () => {
    const trio = async (label: string) => {
      const { asia, rafal, householdId } = await couple(label);
      const ola = await createUser(`Ola${label}`);
      await prisma.membership.create({
        data: { userId: ola, householdId, role: 'MEMBER' },
      });
      return { asia, rafal, ola, householdId };
    };
    const attempt = (work: () => Promise<unknown>) =>
      Promise.resolve()
        .then(work)
        .then(
          () => 'OK',
          (error: unknown) =>
            (error as { getResponse?: () => { code: string } }).getResponse?.()
              .code ?? `ERROR ${String((error as Error)?.message)}`,
        );
    const upsert = (
      userId: string,
      householdId: string,
      fields: Record<string, unknown>,
    ) =>
      weeklyPlans.upsertWeekSlot(userId, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
        ...fields,
      } as never);
    const apply = (
      userId: string,
      householdId: string,
      fields: Record<string, unknown>,
    ) =>
      weeklyPlans.applyWeekPlan(
        userId,
        householdId,
        WEEK_START,
        fields as never,
      );
    const tue = (fields: Record<string, unknown> = {}) => ({
      dayOfWeek: 'TUE',
      mealType: 'DINNER',
      recipeId: dinner.id,
      ...fields,
    });
    const codes = (result: { violations: { code: string }[] }) =>
      result.violations.map((v) => v.code);
    const portionToken = (item: Item, userId: string) =>
      (
        item.portions.find((p) => p.userId === userId) as unknown as {
          revision: number;
        }
      ).revision;

    /** Zamek tygodnia trzymany, `works` czekają na nim, potem puszcza. */
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
          await lockWeekForWrite(tx, planId);
          held.open();
          await release.opened;
        },
        { timeout: 30_000 },
      );
      await held.opened;
      const results = works.map((work) => attempt(work));
      for (let i = 0; i < 5_000; i += 1) {
        const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS "waiting" FROM pg_stat_activity
          WHERE "datname" = current_database()
            AND "wait_event_type" = 'Lock' AND "pid" <> pg_backend_pid()`;
        if (Number(row.waiting) >= works.length) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      release.open();
      await holder;
      return Promise.all(results);
    };

    it('3 + 22. legacy bez nowych pól na planie BEZ alokacji — upsert (audytorium, stepper, zamiana) i applyWeekPlan działają jak dotąd', async () => {
      const { asia, rafal, householdId } = await couple('Legacy');
      expect(await attempt(() => upsert(asia, householdId, {}))).toBe('OK');
      expect(
        await attempt(() =>
          upsert(asia, householdId, { participantIds: [rafal] }),
        ),
      ).toBe('OK');
      expect(
        await attempt(() => upsert(asia, householdId, { plannedServings: 4 })),
      ).toBe('OK');
      expect(
        await attempt(() =>
          upsert(asia, householdId, {
            recipeId: dinnerB.id,
            replaceRecipeId: dinner.id,
          }),
        ),
      ).toBe('OK');
      const result = await apply(asia, householdId, {
        slots: [tue({ recipeId: dinnerC.id })],
      });
      expect(result.applied).toBe(true);
      expect(result.changes).toEqual({ created: 1, updated: 0, deleted: 1 });
      const plan = await readPlan(asia, householdId);
      expect(plan.items.map((i) => [i.recipeId, i.portions.length])).toEqual([
        [dinnerC.id, 0],
      ]);
    });

    it('4. PRESERVE: zmiana audytorium wymaga tokenu; ten sam stan = NOOP', async () => {
      const { asia, rafal, householdId } = await couple('Preserve');
      await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const same = (await upsert(asia, householdId, {
        portionPolicy: 'PRESERVE',
      })) as unknown as { changeKind: string };
      expect(same.changeKind).toBe('NOOP');
      expect(
        await attempt(() =>
          upsert(rafal, householdId, {
            portionPolicy: 'PRESERVE',
            participantIds: [asia],
          }),
        ),
      ).toBe('PLAN_REVISION_REQUIRED');
      await upsert(rafal, householdId, {
        portionPolicy: 'PRESERVE',
        participantIds: [asia],
        expectedRevision: itemOf(await readPlan(asia, householdId), dinner.id)!
          .revision,
      });
      const item = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(item.participantIds).toEqual([asia]);
      expect(byPerson(item.portions)).toEqual({ [asia]: 1 });
      expect(item.plannedServings).toBe(1);
      expect(
        await attempt(() =>
          upsert(asia, householdId, {
            portionPolicy: 'PRESERVE',
            portions: [{ userId: asia, servings: 1 }],
          }),
        ),
      ).toBe('VALIDATION_ERROR');
    });

    it('PRESERVE: stara lista nie usuwa osoby dodanej przez drugi telefon', async () => {
      const { asia, rafal, ola, householdId } = await trio('StalePreserve');
      const seen = await allocate(
        asia,
        householdId,
        [
          { userId: asia, servings: 1 },
          { userId: rafal, servings: 1.5 },
        ],
        { participantIds: [asia, rafal] },
      );
      await upsert(rafal, householdId, {
        participantIds: [],
        portionPolicy: 'PRESERVE',
        expectedRevision: seen.revision,
      });
      const before = itemOf(await readPlan(asia, householdId), dinner.id)!;
      for (const token of [{}, { expectedRevision: seen.revision }]) {
        expect(
          await attempt(() =>
            upsert(asia, householdId, {
              participantIds: [asia, rafal],
              portionPolicy: 'PRESERVE',
              ...token,
            }),
          ),
        ).toBe(
          'expectedRevision' in token
            ? 'PLAN_REVISION_CONFLICT'
            : 'PLAN_REVISION_REQUIRED',
        );
        expect(itemOf(await readPlan(asia, householdId), dinner.id)).toEqual(
          before,
        );
      }
      expect(byPerson(before.portions)[ola]).toBe(1);
      const fields = {
        slots: [
          tue({ participantIds: [asia, rafal], portionPolicy: 'PRESERVE' }),
        ],
      };
      for (const dryRun of [true, false]) {
        expect(
          codes(await apply(asia, householdId, { ...fields, dryRun })),
        ).toEqual(['PLAN_REVISION_REQUIRED']);
      }
      expect(itemOf(await readPlan(asia, householdId), dinner.id)).toEqual(
        before,
      );
    });

    it('5. RESET: bez tokenu → PLAN_REVISION_REQUIRED (nic nie zmienione); z tokenem → równy podział, plannedServings zachowane', async () => {
      const { asia, rafal, householdId } = await couple('Reset');
      const seen = await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      expect(
        await attempt(() =>
          upsert(asia, householdId, { portionPolicy: 'RESET' }),
        ),
      ).toBe('PLAN_REVISION_REQUIRED');
      await upsert(asia, householdId, {
        portionPolicy: 'RESET',
        expectedRevision: seen.revision,
      });
      const item = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(item.portions).toEqual([]);
      expect(item.plannedServings).toBe(3);
    });

    it('6. REPLACE: jawne porcje zastępują alokację tylko z tokenem; REPLACE bez porcji = VALIDATION_ERROR', async () => {
      const { asia, rafal, householdId } = await couple('Replace');
      const seen = await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const next = [
        { userId: asia, servings: 0.5 },
        { userId: rafal, servings: 2 },
      ];
      expect(
        await attempt(() =>
          upsert(asia, householdId, {
            portionPolicy: 'REPLACE',
            portions: next,
          }),
        ),
      ).toBe('PLAN_REVISION_REQUIRED');
      expect(
        await attempt(() =>
          upsert(asia, householdId, { portionPolicy: 'REPLACE' }),
        ),
      ).toBe('VALIDATION_ERROR');
      await upsert(asia, householdId, {
        portionPolicy: 'REPLACE',
        portions: next,
        expectedRevision: seen.revision,
      });
      const item = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(item.portions)).toEqual(byPerson(next));
    });

    it('7 + 8. token pozycji: zgodny → zapis; niezgodny → PLAN_REVISION_CONFLICT (409), nic nie zapisane', async () => {
      const { asia, rafal, householdId } = await couple('Token');
      const seen = await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      await upsert(rafal, householdId, {
        portionPolicy: 'PRESERVE',
        participantIds: [rafal],
        expectedRevision: seen.revision,
      });
      const mid = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(mid.portions)).toEqual({ [rafal]: 1.5 });
      expect(
        await attempt(() =>
          upsert(asia, householdId, {
            portionPolicy: 'PRESERVE',
            participantIds: [asia],
            expectedRevision: seen.revision,
          }),
        ),
      ).toBe('PLAN_REVISION_CONFLICT');
      expect(itemOf(await readPlan(asia, householdId), dinner.id)).toEqual(mid);
    });

    it('9 + 10. setPortion równolegle (pod zamkiem): TA SAMA osoba → dokładnie jeden wchodzi; RÓŻNE osoby → obie zmiany zostają', async () => {
      const { asia, rafal, householdId } = await couple('Rownolegle');
      const seen = await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const set =
        (actor: string, userId: string, servings: number, item: Item) => () =>
          weeklyPlans.setPortion(actor, householdId, WEEK_START, {
            planItemId: item.id,
            userId,
            servings,
            expectedRevision: portionToken(item, userId),
          });
      const same = await underWeekLock(householdId, [
        set(asia, rafal, 2.5, seen),
        set(rafal, rafal, 3, seen),
      ]);
      expect([...same].sort()).toEqual(['OK', 'PLAN_REVISION_CONFLICT']);
      const mid = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(mid.portions)[rafal]).toBe(same[0] === 'OK' ? 2.5 : 3);

      const different = await underWeekLock(householdId, [
        set(asia, rafal, 2, mid),
        set(rafal, asia, 0.5, mid),
      ]);
      expect(different).toEqual(['OK', 'OK']);
      const final = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(final.portions)).toEqual({ [asia]: 0.5, [rafal]: 2 });
      expect(final.plannedServings).toBe(3);
    });

    it('11 + 12. audytorium na serwerze: dodana osoba → 1,00, usunięta → znika, zostający zachowują porcję; plannedServings = ceil(Σ)', async () => {
      const { asia, rafal, ola, householdId } = await trio('Audytorium');
      await allocate(
        asia,
        householdId,
        [
          { userId: asia, servings: 1 },
          { userId: rafal, servings: 1.5 },
        ],
        { participantIds: [asia, rafal] },
      );
      await upsert(asia, householdId, {
        portionPolicy: 'PRESERVE',
        participantIds: [],
        expectedRevision: itemOf(await readPlan(asia, householdId), dinner.id)!
          .revision,
      });
      let item = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(item.participantIds).toEqual([]);
      expect(byPerson(item.portions)).toEqual({
        [asia]: 1,
        [rafal]: 1.5,
        [ola]: 1,
      });
      expect(item.plannedServings).toBe(4);
      await upsert(asia, householdId, {
        portionPolicy: 'PRESERVE',
        participantIds: [asia, ola],
        expectedRevision: item.revision,
      });
      item = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(item.portions)).toEqual({ [asia]: 1, [ola]: 1 });
      expect(item.plannedServings).toBe(2);
      // plannedServings sprzeczne z porcjami przy PRESERVE — jawna odmowa.
      expect(
        await attempt(() =>
          upsert(asia, householdId, {
            portionPolicy: 'PRESERVE',
            participantIds: [asia, ola],
            plannedServings: 5,
          }),
        ),
      ).toBe('PLAN_PORTIONS_INVALID');
    });

    it('13 + 14. zamiana dania: PRESERVE i RESET wymagają tokenów źródła i celu', async () => {
      const { asia, rafal, householdId } = await couple('Zamiana');
      await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      expect(
        await attempt(() =>
          upsert(rafal, householdId, {
            recipeId: dinnerB.id,
            replaceRecipeId: dinner.id,
            portionPolicy: 'PRESERVE',
          }),
        ),
      ).toBe('PLAN_REVISION_REQUIRED');
      await upsert(rafal, householdId, {
        recipeId: dinnerB.id,
        replaceRecipeId: dinner.id,
        portionPolicy: 'PRESERVE',
        expectedRevision: itemOf(await readPlan(asia, householdId), dinner.id)!
          .revision,
        expectedTargetRevision: null,
      });
      let plan = await readPlan(asia, householdId);
      expect(plan.items.map((i) => i.recipeId)).toEqual([dinnerB.id]);
      const kept = itemOf(plan, dinnerB.id)!;
      expect(byPerson(kept.portions)).toEqual({ [asia]: 1, [rafal]: 1.5 });

      expect(
        await attempt(() =>
          upsert(asia, householdId, {
            recipeId: dinnerC.id,
            replaceRecipeId: dinnerB.id,
            portionPolicy: 'RESET',
          }),
        ),
      ).toBe('PLAN_REVISION_REQUIRED');
      await upsert(asia, householdId, {
        recipeId: dinnerC.id,
        replaceRecipeId: dinnerB.id,
        portionPolicy: 'RESET',
        expectedRevision: kept.revision,
        expectedTargetRevision: null,
      });
      plan = await readPlan(asia, householdId);
      const reset = itemOf(plan, dinnerC.id)!;
      expect(plan.items.map((i) => i.recipeId)).toEqual([dinnerC.id]);
      expect(reset.portions).toEqual([]);
      expect(reset.plannedServings).toBe(3);
    });

    it('15 + 16. applyWeekPlan: PRESERVE per slot przelicza alokację; dryRun daje TE SAME naruszenia co zapis dla tego samego stanu', async () => {
      const { asia, rafal, householdId } = await couple('Apply');
      await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const cases: Record<string, unknown>[] = [
        { slots: [tue({ participantIds: [asia] })] },
        { slots: [tue({ portionPolicy: 'RESET' })] },
        { slots: [tue({ portionPolicy: 'PRESERVE', plannedServings: 7 })] },
        { slots: [] },
      ];
      for (const fields of cases) {
        const dry = await apply(asia, householdId, { ...fields, dryRun: true });
        const real = await apply(asia, householdId, fields);
        expect(real.applied).toBe(false);
        expect(codes(dry)).toEqual(codes(real));
        expect(codes(real).length).toBeGreaterThan(0);
      }
      expect(codes(await apply(asia, householdId, { slots: [] }))).toEqual([
        'PLAN_REVISION_REQUIRED',
      ]);

      const preserve = {
        slots: [tue({ portionPolicy: 'PRESERVE', participantIds: [rafal] })],
        expectedRevision: (await readPlan(asia, householdId)).revision,
      };
      const dry = await apply(asia, householdId, { ...preserve, dryRun: true });
      expect(dry.violations).toEqual([]);
      expect(dry.changes).toEqual({ created: 0, updated: 1, deleted: 0 });
      const real = await apply(asia, householdId, preserve);
      expect(real.applied).toBe(true);
      const item = itemOf(await readPlan(asia, householdId), dinner.id)!;
      expect(byPerson(item.portions)).toEqual({ [rafal]: 1.5 });
    });

    it('18. revise_proposal zmienia INNĄ pozycję — nietknięta alokacja zostaje bit w bit', async () => {
      const { session, asia, rafal, householdId } = await sessionHome('Revise');
      const item = await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const rowsBefore = await portionRows(item.id);
      const first = await turn(
        session,
        householdId,
        `Plan [[propose:${dinnerB.id}:${WEEK_START}]] [[propose:${dinner.id}:${WEEK_START}]]`,
      );
      const revised = await turn(
        session,
        householdId,
        `Popraw [[revise:${proposalIdOf(first)}:MON:DINNER:${dinnerC.id}]]`,
        first.conversationId,
      );
      const proposalId = proposalIdOf(revised);
      expect(proposalId).not.toBeNull();
      expect((await applyProposal(session, proposalId!)).status).toBe(200);
      expect(
        itemOf(await readPlan(asia, householdId), dinnerC.id, 'MON'),
      ).toBeDefined();
      expect(await portionRows(item.id)).toEqual(rowsBefore);
    });

    it('19. „Cofnij” po propozycji, która zamieniła danie z porcjami, przywraca dokładnie tamtą alokację', async () => {
      const { session, asia, rafal, householdId } = await sessionHome('Undo');
      await allocate(asia, householdId, [
        { userId: asia, servings: 1 },
        { userId: rafal, servings: 1.5 },
      ]);
      const answer = await turn(
        session,
        householdId,
        `Zamień [[swap:TUE:DINNER:${dinnerC.id}]]`,
      );
      const proposalId = proposalIdOf(answer)!;
      expect((await applyProposal(session, proposalId)).status).toBe(200);
      expect(
        itemOf(await readPlan(asia, householdId), dinnerC.id),
      ).toBeDefined();
      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposalId}/undo`)
        .set(auth(session.accessToken))
        .send({})
        .expect(200);
      const restored = await readPlan(asia, householdId);
      expect(restored.items.map((i) => i.recipeId)).toEqual([dinner.id]);
      expect(byPerson(itemOf(restored, dinner.id)!.portions)).toEqual({
        [asia]: 1,
        [rafal]: 1.5,
      });
    });

    it('20 + 21. lista zakupów i bilans liczą KOŃCOWĄ alokację (po przeliczeniu audytorium)', async () => {
      const { asia, rafal, ola, householdId } = await trio('Zakupy');
      await allocate(
        asia,
        householdId,
        [
          { userId: asia, servings: 1 },
          { userId: rafal, servings: 1.5 },
        ],
        { participantIds: [asia, rafal] },
      );
      const amounts = async () =>
        new Map(
          (
            await shoppingLists.getShoppingListState(
              asia,
              householdId,
              WEEK_START,
            )
          ).items.map((i) => [i.productKey, i.totalAmount]),
        );
      const before = await amounts();
      await upsert(asia, householdId, {
        portionPolicy: 'PRESERVE',
        participantIds: [],
        expectedRevision: itemOf(await readPlan(asia, householdId), dinner.id)!
          .revision,
      });
      const after = await amounts();
      // Σ porcji 2,5 → 3,5: każdy produkt rośnie w tej proporcji (co do
      // zaokrąglenia jednostek sklepowych).
      const ratios = [...before]
        .filter(([, amount]) => amount >= 50)
        .map(([key, amount]) => after.get(key)! / amount);
      expect(ratios.length).toBeGreaterThan(0);
      for (const ratio of ratios) expect(ratio).toBeCloseTo(3.5 / 2.5, 1);

      const recipe = await prisma.recipe.findUniqueOrThrow({
        where: { id: dinner.id },
        select: { nutritionKcal: true, servings: true },
      });
      const balance = await weeklyPlans.weeklyBalance(
        asia,
        householdId,
        WEEK_START,
        ola,
      );
      const tuesday = balance.days.find((d) => d.dayOfWeek === 'TUE')!;
      expect(tuesday.planned.kcal).toBe(
        Math.round((recipe.nutritionKcal / Math.max(1, recipe.servings)) * 1),
      );
    });
  });
});
