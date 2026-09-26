import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppException } from '../src/common/app-exception';
import { CARDS_CAPABILITY_V1 } from '../src/agent/cards/agent-cards';
import { HouseholdsService } from '../src/households/households.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShoppingListService } from '../src/weekly-plans/services/shopping-list.service';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';

/**
 * Porcje per osoba na żywej bazie (workstream, Etap 2.2): zapis i odczyt
 * alokacji, zgodność wstecz pozycji bez niej, bilans osoby, lista zakupów,
 * planer za włącznikiem, propozycje i zmiany składu domu. Numery w opisach =
 * lista testów obowiązkowych z polecenia Etapu 2.2.
 */
type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

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

/** Tydzień w przeszłości — składu domu nie dotyka (roster liczy od „teraz"). */
const WEEK_START = '2026-08-31';
/** Tydzień w przyszłości — do testów wejścia i wyjścia domownika. */
const FUTURE_WEEK = '2027-01-04';
const CLIENT_TODAY = '2026-09-02';
const DAYS = 'MON,TUE,WED,THU,FRI,SAT,SUN';

describe('Porcje per osoba E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let weeklyPlans: WeeklyPlansService;
  let shopping: ShoppingListService;
  let households: HouseholdsService;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];

  const ENV_KEYS = [
    'AI_ENABLED',
    'AI_PROVIDER',
    'AI_STUB_DELAY_MS',
    'AI_TIER_OVERRIDE',
    'AI_CONSENT_REQUIRED',
    'AI_CARDS_MODE',
    'AI_PLANNER_PER_USER_PORTIONS',
    'THROTTLE_DEFAULT_LIMIT',
    'THROTTLE_IP_LIMIT',
    'THROTTLE_AUTH_LIMIT',
    'THROTTLE_AGENT_MESSAGE_LIMIT',
    'THROTTLE_AGENT_POLL_LIMIT',
  ] as const;
  const original: Record<string, string | undefined> = {};
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  let dinner: { id: string; servings: number; nutritionKcal: number };

  const createUser = async (label: string, calorieGoal: number) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@porcje.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    await prisma.userPreference.create({
      data: { userId: user.id, calorieGoal },
    });
    return user.id;
  };

  /** Dom pary: Asia (1600, sesja HTTP) + Rafał (2600). */
  const couple = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `porcje-${stamp}@porcje.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    await prisma.userPreference.upsert({
      where: { userId: session.user.id },
      create: { userId: session.user.id, calorieGoal: 1600 },
      update: { calorieGoal: 1600 },
    });
    const rafal = await createUser('Rafal', 2600);
    const home = await prisma.household.create({
      data: { name: `${label} ${stamp}`, createdById: session.user.id },
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

  const readItems = async (
    userId: string,
    householdId: string,
    weekStart = WEEK_START,
  ): Promise<Item[]> => {
    const plan = (await weeklyPlans.getByHouseholdAndWeek(
      userId,
      householdId,
      weekStart,
    )) as unknown as { items: Item[] } | null;
    return plan?.items ?? [];
  };

  const code = async (attempt: Promise<unknown>): Promise<string> => {
    try {
      await attempt;
      return 'BRAK_ODMOWY';
    } catch (error) {
      if (error instanceof AppException) {
        return (error.getResponse() as { code: string }).code;
      }
      throw error;
    }
  };

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
    for (const deadline = Date.now() + 15_000; ; ) {
      const row = await prisma.agentTurn.findUniqueOrThrow({
        where: { id: turnId },
      });
      if (row.status !== 'RUNNING') {
        expect(row.status).toBe('DONE');
        break;
      }
      if (Date.now() > deadline) throw new Error(`tura ${turnId} wisi`);
      await sleep(100);
    }
    const answer = await prisma.agentMessage.findFirstOrThrow({
      where: { turnId, role: 'ASSISTANT' },
    });
    return { conversationId: conversation, answer };
  };

  const proposalSlots = async (answer: { card: unknown }) => {
    const proposal = await prisma.agentProposal.findUniqueOrThrow({
      where: { id: (answer.card as { proposalId: string }).proposalId },
    });
    return {
      proposal,
      slots: (proposal.action as { slots: Record<string, unknown>[] })
        .slots as unknown as (Omit<Item, 'id' | 'portions'> & {
        portions?: Portion[];
      })[],
    };
  };

  const byPerson = (portions: Portion[]) =>
    Object.fromEntries(portions.map((p) => [p.userId, p.servings]));

  beforeAll(async () => {
    for (const key of ENV_KEYS) original[key] = process.env[key];
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_STUB_DELAY_MS = '0';
    process.env.AI_TIER_OVERRIDE = 'PRO';
    process.env.AI_CONSENT_REQUIRED = 'false';
    process.env.AI_CARDS_MODE = 'soft';
    process.env.AI_PLANNER_PER_USER_PORTIONS = 'true';
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
    shopping = app.get(ShoppingListService);
    households = app.get(HouseholdsService);

    const found = await prisma.recipe.findFirst({
      where: {
        isCatalog: true,
        isActive: true,
        nutritionKcal: { gt: 0 },
        ingredients: { some: {} },
        OR: [
          { suitableMealTypes: { has: 'DINNER' } },
          { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
        ],
      },
      select: { id: true, servings: true, nutritionKcal: true },
      orderBy: { id: 'asc' },
    });
    if (!found?.nutritionKcal) {
      throw new Error('katalog dev nie ma kolacji z makrami i składnikami');
    }
    dinner = {
      id: found.id,
      servings: found.servings,
      nutritionKcal: found.nutritionKcal,
    };
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

  describe('zapis i odczyt', () => {
    it('10. applyWeekPlan z porcjami: round-trip zachowuje alokację, plannedServings = ceil(Σ)', async () => {
      const { asia, rafal, householdId } = await couple('RoundTrip');
      const portions = [
        { userId: asia, servings: 0.8 },
        { userId: rafal, servings: 1.3 },
      ];
      const result = await weeklyPlans.applyWeekPlan(
        asia,
        householdId,
        WEEK_START,
        {
          slots: [
            {
              dayOfWeek: 'MON',
              mealType: 'DINNER',
              recipeId: dinner.id,
              portions,
            },
          ],
        },
      );
      expect(result.violations).toEqual([]);
      expect(result.applied).toBe(true);

      const [item] = await readItems(asia, householdId);
      expect(byPerson(item.portions)).toEqual({ [asia]: 0.8, [rafal]: 1.3 });
      expect(item.plannedServings).toBe(3);
      expect(item.participantIds).toEqual([]);
      // W bazie liczby całkowite (jednostki 1/20 porcji).
      const rows = await prisma.planItemPortion.findMany({
        where: { planItemId: item.id },
        orderBy: { units: 'asc' },
      });
      expect(rows.map((row) => row.units)).toEqual([16, 26]);

      // Ten sam stan docelowy → zero zmian; inna alokacja → jedna aktualizacja.
      const again = await weeklyPlans.applyWeekPlan(
        asia,
        householdId,
        WEEK_START,
        {
          slots: [
            {
              dayOfWeek: 'MON',
              mealType: 'DINNER',
              recipeId: dinner.id,
              portions,
            },
          ],
        },
      );
      expect(again.changes).toEqual({ created: 0, updated: 0, deleted: 0 });
      const changed = await weeklyPlans.applyWeekPlan(
        asia,
        householdId,
        WEEK_START,
        {
          slots: [
            {
              dayOfWeek: 'MON',
              mealType: 'DINNER',
              recipeId: dinner.id,
              portions: [
                { userId: asia, servings: 0.75 },
                { userId: rafal, servings: 1.35 },
              ],
            },
          ],
        },
      );
      expect(changed.changes).toEqual({ created: 0, updated: 1, deleted: 0 });
      const [after] = await readItems(asia, householdId);
      expect(after.id).toBe(item.id);
      expect(byPerson(after.portions)).toEqual({ [asia]: 0.75, [rafal]: 1.35 });
    });

    it('11. pozycja BEZ porcji (stary klient): round-trip bez alokacji, bilans jak dotąd', async () => {
      const { asia, rafal, householdId } = await couple('Legacy');
      await weeklyPlans.applyWeekPlan(asia, householdId, WEEK_START, {
        slots: [
          {
            dayOfWeek: 'MON',
            mealType: 'DINNER',
            recipeId: dinner.id,
            plannedServings: 3,
          },
        ],
      });
      const [item] = await readItems(asia, householdId);
      expect(item.portions).toEqual([]);
      expect(item.plannedServings).toBe(3);
      const perPortion = dinner.nutritionKcal / dinner.servings;
      for (const member of [asia, rafal]) {
        const balance = await weeklyPlans.weeklyBalance(
          asia,
          householdId,
          WEEK_START,
          member,
        );
        expect(balance.days[0].planned.kcal).toBeCloseTo(perPortion * 1.5, 0);
      }
    });

    it('2. wspólne danie z różnymi porcjami → bilans każdej osoby z JEJ porcji', async () => {
      const { asia, rafal, householdId } = await couple('Bilans');
      await weeklyPlans.applyWeekPlan(asia, householdId, WEEK_START, {
        slots: [
          {
            dayOfWeek: 'MON',
            mealType: 'DINNER',
            recipeId: dinner.id,
            portions: [
              { userId: asia, servings: 0.8 },
              { userId: rafal, servings: 1.3 },
            ],
          },
        ],
      });
      const perPortion = dinner.nutritionKcal / dinner.servings;
      const kcalOf = async (member: string) =>
        (await weeklyPlans.weeklyBalance(asia, householdId, WEEK_START, member))
          .days[0].planned.kcal;
      expect(await kcalOf(asia)).toBeCloseTo(perPortion * 0.8, 0);
      expect(await kcalOf(rafal)).toBeCloseTo(perPortion * 1.3, 0);
    });

    it('alokacja niezgodna z audytorium: applyWeekPlan zwraca naruszenie i NIC nie zapisuje', async () => {
      const { asia, householdId } = await couple('ZlaAlokacja');
      const result = await weeklyPlans.applyWeekPlan(
        asia,
        householdId,
        WEEK_START,
        {
          slots: [
            {
              dayOfWeek: 'MON',
              mealType: 'DINNER',
              recipeId: dinner.id,
              // „Wspólne" = oboje, a porcja jest tylko Asi.
              portions: [{ userId: asia, servings: 1 }],
            },
          ],
        },
      );
      expect(result.applied).toBe(false);
      expect(result.violations.map((v) => v.code)).toEqual([
        'PLAN_PORTIONS_INVALID',
      ]);
      expect(await readItems(asia, householdId)).toEqual([]);
    });

    it('porcja spoza kroku 0,05 odbija się już na walidacji DTO', async () => {
      const { asia, rafal, householdId } = await couple('Krok');
      expect(
        await code(
          weeklyPlans.applyWeekPlan(asia, householdId, WEEK_START, {
            slots: [
              {
                dayOfWeek: 'MON',
                mealType: 'DINNER',
                recipeId: dinner.id,
                portions: [
                  { userId: asia, servings: 0.8 },
                  { userId: rafal, servings: 1.333 },
                ],
              },
            ],
          }),
        ),
      ).toBe('VALIDATION_ERROR');
    });

    it('upsertWeekSlot: porcje imiennego audytorium; zapis bez porcji wraca do równego podziału', async () => {
      const { asia, rafal, householdId } = await couple('Upsert');
      expect(
        await code(
          weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
            dayOfWeek: 'TUE',
            mealType: 'DINNER',
            recipeId: dinner.id,
            participantIds: [asia],
            portions: [
              { userId: asia, servings: 1 },
              { userId: rafal, servings: 1 },
            ],
          }),
        ),
      ).toBe('PLAN_PORTIONS_INVALID');

      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
        portions: [
          { userId: asia, servings: 0.9 },
          { userId: rafal, servings: 1.4 },
        ],
      });
      let [item] = await readItems(asia, householdId);
      expect(byPerson(item.portions)).toEqual({ [asia]: 0.9, [rafal]: 1.4 });
      expect(item.plannedServings).toBe(3);

      // Stary telefon zmienia porcje stepperem: przysyła łączne, bez alokacji.
      await weeklyPlans.upsertWeekSlot(asia, householdId, WEEK_START, {
        dayOfWeek: 'TUE',
        mealType: 'DINNER',
        recipeId: dinner.id,
        plannedServings: 2,
      });
      [item] = await readItems(asia, householdId);
      expect(item.portions).toEqual([]);
      expect(item.plannedServings).toBe(2);
    });
  });

  describe('lista zakupów', () => {
    it('3./12. skaluje się przez Σ porcji — także ułamkowo (0,85 + 1,3 = 2,15)', async () => {
      type Slots = Parameters<WeeklyPlansService['applyWeekPlan']>[3]['slots'];
      const totals = async (build: (asia: string, rafal: string) => Slots) => {
        const { asia, rafal, householdId } = await couple('Zakupy');
        const result = await weeklyPlans.applyWeekPlan(
          asia,
          householdId,
          WEEK_START,
          { slots: build(asia, rafal) },
        );
        expect(result.violations).toEqual([]);
        const state = await shopping.getShoppingListState(
          asia,
          householdId,
          WEEK_START,
        );
        return new Map(
          state.items.map((entry) => [entry.productKey, entry.totalAmount]),
        );
      };
      const base = {
        dayOfWeek: 'MON' as const,
        mealType: 'DINNER' as const,
        recipeId: dinner.id,
      };
      const legacy = await totals(() => [{ ...base, plannedServings: 2 }]);
      const portioned = await totals((asia, rafal) => [
        {
          ...base,
          portions: [
            { userId: asia, servings: 0.85 },
            { userId: rafal, servings: 1.3 },
          ],
        },
      ]);
      expect(legacy.size).toBeGreaterThan(0);
      expect([...portioned.keys()].sort()).toEqual([...legacy.keys()].sort());
      // Σ = 2,15 porcji, NIE ceil(Σ) = 3 i nie równe 2 — dokładnie 1,075 × lista na 2.
      let fractional = false;
      for (const [key, amount] of legacy) {
        const expected = amount * (2.15 / 2);
        const got = portioned.get(key)!;
        expect(Math.abs(got - expected)).toBeLessThanOrEqual(
          Math.max(expected * 0.02, 1),
        );
        if (!Number.isInteger(got)) fractional = true;
        expect(got).toBeLessThan(amount * 1.5);
      }
      // Choć jedna ilość wychodzi ułamkowa — lista nie zaokrągla do porcji.
      expect(fractional || legacy.size === 0).toBe(true);
    });
  });

  describe('planer i propozycje (włącznik AI_PLANNER_PER_USER_PORTIONS)', () => {
    it('9. build_meal_plan: propozycja niesie porcje per osoba, zapis je utrwala', async () => {
      const { session, asia, rafal, householdId } = await couple('Planer');
      const { answer } = await turn(
        session,
        householdId,
        `Ułóż tydzień [[build:${WEEK_START}:${DAYS}]]`,
      );
      expect(answer.kind).toBe('PLAN_WEEK');
      const { proposal, slots } = await proposalSlots(answer);
      expect(slots).toHaveLength(21);
      for (const slot of slots) {
        expect(slot.participantIds ?? []).toEqual([]);
        const portions = byPerson(slot.portions ?? []);
        expect(Object.keys(portions).sort()).toEqual([asia, rafal].sort());
        expect(portions[rafal]).toBeGreaterThanOrEqual(portions[asia]);
      }

      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .expect(200);
      const items = await readItems(asia, householdId);
      expect(items).toHaveLength(21);
      const saved = new Map(
        items.map((item) => [`${item.dayOfWeek}|${item.mealType}`, item]),
      );
      for (const slot of slots) {
        const item = saved.get(`${slot.dayOfWeek}|${slot.mealType}`)!;
        expect(byPerson(item.portions)).toEqual(byPerson(slot.portions ?? []));
      }

      // Bilans dnia każdej osoby blisko JEJ celu (katalog dev, bez modelu).
      for (const [member, goal] of [
        [asia, 1600],
        [rafal, 2600],
      ] as const) {
        const balance = await weeklyPlans.weeklyBalance(
          asia,
          householdId,
          WEEK_START,
          member,
        );
        const worst = Math.max(
          ...balance.days.map(
            (day) => Math.abs(day.planned.kcal - goal) / goal,
          ),
        );
        process.stdout.write(
          `[porcje e2e] ${goal} kcal: najgorszy dzień ${(worst * 100).toFixed(1)} %\n`,
        );
        expect(worst).toBeLessThanOrEqual(0.15);
      }
    });

    it('8. replace_plan_item w propozycji: porcje nietkniętych pozycji bez zmian, nowe danie z porcjami', async () => {
      const { session, asia, rafal, householdId } = await couple('Podmiana');
      const first = await turn(
        session,
        householdId,
        `Ułóż tydzień [[build:${WEEK_START}:${DAYS}]]`,
      );
      const before = await proposalSlots(first.answer);
      const second = await turn(
        session,
        householdId,
        `Środa inaczej ${WEEK_START} [[replace:${before.proposal.id}:WED:DINNER:NONE]]`,
        first.conversationId,
      );
      const after = await proposalSlots(second.answer);
      const key = (slot: { dayOfWeek: string; mealType: string }) =>
        `${slot.dayOfWeek}|${slot.mealType}`;
      const old = new Map(before.slots.map((slot) => [key(slot), slot]));
      for (const slot of after.slots) {
        if (key(slot) === 'WED|DINNER') continue;
        expect(slot).toEqual(old.get(key(slot)));
      }
      const wednesday = after.slots.find((slot) => key(slot) === 'WED|DINNER')!;
      expect(wednesday.recipeId).not.toBe(old.get('WED|DINNER')!.recipeId);
      expect(Object.keys(byPerson(wednesday.portions ?? [])).sort()).toEqual(
        [asia, rafal].sort(),
      );
    });

    it('replace_plan_item w ZAPISANYM planie: podmiana niesie porcje, reszta tygodnia (z porcjami) nietknięta', async () => {
      const { session, asia, rafal, householdId } = await couple('Swap');
      const built = await turn(
        session,
        householdId,
        `Ułóż tydzień [[build:${WEEK_START}:${DAYS}]]`,
      );
      const { proposal } = await proposalSlots(built.answer);
      await request(app.getHttpServer())
        .post(`/agent/proposals/${proposal.id}/apply`)
        .set(auth(session.accessToken))
        .expect(200);
      const before = await readItems(asia, householdId);
      const swapped = await turn(
        session,
        householdId,
        `Inna czwartkowa kolacja ${WEEK_START} [[replace:-:THU:DINNER:NONE]]`,
        built.conversationId,
      );
      expect(swapped.answer.kind).toBe('SWAP');
      const swap = await proposalSlots(swapped.answer);
      await request(app.getHttpServer())
        .post(`/agent/proposals/${swap.proposal.id}/apply`)
        .set(auth(session.accessToken))
        .expect(200);

      const after = await readItems(asia, householdId);
      const key = (item: Item) => `${item.dayOfWeek}|${item.mealType}`;
      const old = new Map(before.map((item) => [key(item), item]));
      for (const item of after) {
        if (key(item) === 'THU|DINNER') continue;
        const prior = old.get(key(item))!;
        expect(item.recipeId).toBe(prior.recipeId);
        expect(byPerson(item.portions)).toEqual(byPerson(prior.portions));
      }
      const thursday = after.find((item) => key(item) === 'THU|DINNER')!;
      expect(thursday.recipeId).not.toBe(old.get('THU|DINNER')!.recipeId);
      expect(Object.keys(byPerson(thursday.portions)).sort()).toEqual(
        [asia, rafal].sort(),
      );
    });

    it('włącznik wyłączony: planer wraca do równego podziału (zgodność ze starym iOS)', async () => {
      process.env.AI_PLANNER_PER_USER_PORTIONS = 'false';
      try {
        const { session, householdId } = await couple('BezWlacznika');
        const { answer } = await turn(
          session,
          householdId,
          `Ułóż dzień [[build:${WEEK_START}:MON]]`,
        );
        const { slots } = await proposalSlots(answer);
        expect(slots.length).toBeGreaterThan(0);
        for (const slot of slots) {
          expect(slot.portions).toBeUndefined();
          expect(Number.isInteger(slot.plannedServings)).toBe(true);
        }
      } finally {
        process.env.AI_PLANNER_PER_USER_PORTIONS = 'true';
      }
    });
  });

  describe('zmiana składu domu', () => {
    it('nowy domownik dostaje 1 porcję we „Wspólnym" z alokacją; wyjście zdejmuje jego porcję', async () => {
      const { asia, rafal, householdId } = await couple('Sklad');
      await weeklyPlans.applyWeekPlan(asia, householdId, FUTURE_WEEK, {
        slots: [
          {
            dayOfWeek: 'MON',
            mealType: 'DINNER',
            recipeId: dinner.id,
            portions: [
              { userId: asia, servings: 0.8 },
              { userId: rafal, servings: 1.3 },
            ],
          },
        ],
      });
      const kuba = await createUser('Kuba', 2000);
      const invitation = await households.createInvitation(
        asia,
        householdId,
        {},
      );
      await households.acceptInvitation(kuba, { token: invitation.token });

      let [item] = await readItems(asia, householdId, FUTURE_WEEK);
      expect(byPerson(item.portions)).toEqual({
        [asia]: 0.8,
        [rafal]: 1.3,
        [kuba]: 1,
      });
      expect(item.plannedServings).toBe(4); // ceil(3,1)

      await households.leave(rafal, householdId);
      [item] = await readItems(asia, householdId, FUTURE_WEEK);
      expect(byPerson(item.portions)).toEqual({ [asia]: 0.8, [kuba]: 1 });
      expect(item.plannedServings).toBe(2); // ceil(1,8)
    });
  });
});
