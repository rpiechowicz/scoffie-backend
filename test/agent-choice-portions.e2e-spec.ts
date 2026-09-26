import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CARDS_CAPABILITY_V1 } from '../src/agent/cards/agent-cards';
import { AgentMealPlannerService } from '../src/agent/planner/agent-meal-planner.service';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';

/**
 * Porcje per osoba przez CAŁY przepływ wyboru (review Etapu 3, Etap 2.2 + 3):
 * suggest_meals → karta OPTIONS → „Wybieram drugą" → propozycja → zapis →
 * bilans. Model (stub) podaje tylko DANIE (`[[swap:…]]`, `[[revise:…]]`) —
 * porcje liczy serwer. Numery w opisach = testy z polecenia review.
 */
type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};
type Portion = { userId: string; servings: number };
type Slot = {
  dayOfWeek: string;
  mealType: string;
  recipeId: string;
  participantIds?: string[];
  plannedServings?: number;
  portions?: Portion[];
};
type OptionsCard = { options: { recipeId: string }[] };

const WEEK_START = '2026-08-31';
const CLIENT_TODAY = '2026-09-02';
const DAYS = 'MON,TUE,WED,THU,FRI,SAT,SUN';

describe('Porcje per osoba przez wybór z karty E2E (review Etapu 3)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let planner: AgentMealPlannerService;
  let weeklyPlans: WeeklyPlansService;
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
  const perUser = (on: boolean) => {
    process.env.AI_PLANNER_PER_USER_PORTIONS = on ? 'true' : 'false';
  };

  /** Asia (1600, sesja) + Rafał (2600) — ten sam dom. */
  const couple = async (
    label: string,
    asiaPrefs: { dietPreference?: 'VEGETARIAN' } = {},
  ) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `wybor-${stamp}@wybor.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    await prisma.userPreference.upsert({
      where: { userId: session.user.id },
      create: { userId: session.user.id, calorieGoal: 1600, ...asiaPrefs },
      update: { calorieGoal: 1600, ...asiaPrefs },
    });
    const rafal = await prisma.user.create({
      data: {
        displayName: `Rafal ${stamp}`,
        email: `wybor-r-${stamp}@wybor.local`,
        authProvider: 'DEV',
        preferences: { create: { calorieGoal: 2600 } },
      },
      select: { id: true },
    });
    createdUserIds.push(rafal.id);
    const home = await prisma.household.create({
      data: { name: `${label} ${stamp}`, createdById: session.user.id },
    });
    createdHouseholdIds.push(home.id);
    await prisma.membership.createMany({
      data: [
        { userId: session.user.id, householdId: home.id, role: 'OWNER' },
        { userId: rafal.id, householdId: home.id, role: 'MEMBER' },
      ],
    });
    return {
      session,
      asia: session.user.id,
      rafal: rafal.id,
      householdId: home.id,
    };
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
    const proposal = await prisma.agentProposal.findFirst({
      where: { turnId },
      orderBy: { createdAt: 'desc' },
    });
    return { conversationId: conversation, answer, proposal };
  };

  const slotsOf = (proposal: { action: unknown } | null): Slot[] =>
    (proposal?.action as { slots?: Slot[] } | null)?.slots ?? [];
  const wedDinner = (slots: Slot[]) =>
    slots.filter(
      (slot) => slot.dayOfWeek === 'WED' && slot.mealType === 'DINNER',
    );
  const byPerson = (portions: Portion[] = []) =>
    Object.fromEntries(portions.map((p) => [p.userId, p.servings]));
  const applyProposal = (session: Session, id: string) =>
    request(app.getHttpServer())
      .post(`/agent/proposals/${id}/apply`)
      .set(auth(session.accessToken))
      .expect(200);
  const portionRows = (householdId: string) =>
    prisma.planItemPortion.count({
      where: { planItem: { weeklyPlan: { householdId } } },
    });

  /** Pełny tydzień zapisany (build + apply) i druga opcja karty na środową kolację. */
  const plannedWeekAndSecondOption = async (
    home: Awaited<ReturnType<typeof couple>>,
  ) => {
    const built = await turn(
      home.session,
      home.householdId,
      `Ułóż tydzień [[build:${WEEK_START}:${DAYS}]]`,
    );
    await applyProposal(home.session, built.proposal!.id);
    const suggested = await turn(
      home.session,
      home.householdId,
      'Co na środową kolację? [[suggest:WED:DINNER:-]]',
      built.conversationId,
    );
    expect(suggested.answer.kind).toBe('OPTIONS');
    const card = suggested.answer.card as unknown as OptionsCard;
    return {
      conversationId: built.conversationId,
      second: card.options[1].recipeId,
    };
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
    planner = app.get(AgentMealPlannerService);
    weeklyPlans = app.get(WeeklyPlansService);
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

  it('1./8. flaga OFF: suggest → wybór → zapis działa jak dotąd i NIE tworzy alokacji', async () => {
    perUser(false);
    const home = await couple('Wylaczona');
    const { conversationId, second } = await plannedWeekAndSecondOption(home);
    const chosen = await turn(
      home.session,
      home.householdId,
      `Wybieram drugą [[swap:WED:DINNER:${second}]]`,
      conversationId,
    );
    expect(chosen.answer.kind).toBe('SWAP');
    const [slot] = wedDinner(slotsOf(chosen.proposal));
    expect(slot.recipeId).toBe(second);
    expect(slot.portions).toBeUndefined();
    await applyProposal(home.session, chosen.proposal!.id);
    expect(await portionRows(home.householdId)).toBe(0);
  });

  it('2. flaga ON: suggest_meals dla pary 1600/2600 ocenia dania z porcjami per osoba', async () => {
    perUser(true);
    const home = await couple('Ranking');
    const outcome = await planner.suggest({
      userId: home.asia,
      householdId: home.householdId,
      weekStart: WEEK_START,
      dayOfWeek: 'WED',
      mealType: 'DINNER',
      forUserIds: [],
      wishes: {
        diet: null,
        requiredTags: [],
        preferredTags: [],
        avoidIngredients: [],
        maxPrepMinutes: null,
      },
      includeIngredients: [],
      count: 3,
      seed: 'e2e',
    });
    expect(outcome.draft.suggestions).toHaveLength(3);
    for (const suggestion of outcome.draft.suggestions) {
      const portions = byPerson(suggestion.item.portions);
      expect(Object.keys(portions).sort()).toEqual(
        [home.asia, home.rafal].sort(),
      );
      expect(portions[home.rafal]).toBeGreaterThan(portions[home.asia]);
      const kcal = Object.fromEntries(
        suggestion.perPerson.map((entry) => [entry.userId, entry.kcal]),
      );
      expect(kcal[home.rafal]).toBeGreaterThan(kcal[home.asia]);
    }
  });

  it('3./4./5. flaga ON: suggest → „wybieram drugą" → propozycja z porcjami → zapis → bilans blisko celów', async () => {
    perUser(true);
    const home = await couple('Wlaczona');
    const { conversationId, second } = await plannedWeekAndSecondOption(home);
    const chosen = await turn(
      home.session,
      home.householdId,
      `Wybieram drugą [[swap:WED:DINNER:${second}]]`,
      conversationId,
    );
    expect(chosen.answer.kind).toBe('SWAP');
    const [slot] = wedDinner(slotsOf(chosen.proposal));
    expect(slot.recipeId).toBe(second);
    // 3. Porcje policzył serwer — model podał samo danie.
    const portions = byPerson(slot.portions);
    expect(Object.keys(portions).sort()).toEqual(
      [home.asia, home.rafal].sort(),
    );
    expect(portions[home.rafal]).toBeGreaterThan(portions[home.asia]);

    // 4. Zapis utrwala alokację.
    await applyProposal(home.session, chosen.proposal!.id);
    const item = await prisma.planItem.findFirstOrThrow({
      where: {
        weeklyPlan: { householdId: home.householdId },
        dayOfWeek: 'WED',
        mealType: 'DINNER',
      },
      include: { portions: true },
    });
    expect(item.recipeId).toBe(second);
    expect(item.portions).toHaveLength(2);

    // 5. Dzień każdej osoby dalej blisko JEJ celu (przed Etapem 2.2: ~23 %).
    for (const [member, goal] of [
      [home.asia, 1600],
      [home.rafal, 2600],
    ] as const) {
      const balance = await weeklyPlans.weeklyBalance(
        home.asia,
        home.householdId,
        WEEK_START,
        member,
      );
      const wednesday = balance.days.find((day) => day.dayOfWeek === 'WED')!;
      const deviation = Math.abs(wednesday.planned.kcal - goal) / goal;
      process.stdout.write(
        `[wybór e2e] ${goal} kcal: środa po wyborze ${(deviation * 100).toFixed(1)} %\n`,
      );
      expect(deviation).toBeLessThanOrEqual(0.1);
    }
  });

  it('6. flaga ON: wybór w PENDING propozycji — reszta nietknięta, wybrany slot z nowymi porcjami', async () => {
    perUser(true);
    const home = await couple('Pending');
    const built = await turn(
      home.session,
      home.householdId,
      `Ułóż tydzień [[build:${WEEK_START}:${DAYS}]]`,
    );
    const before = slotsOf(built.proposal);
    const suggested = await turn(
      home.session,
      home.householdId,
      'Pokaż 3 inne kolacje na środę [[suggest:WED:DINNER:-]]',
      built.conversationId,
    );
    const second = (suggested.answer.card as unknown as OptionsCard).options[1]
      .recipeId;
    const revised = await turn(
      home.session,
      home.householdId,
      `Wybieram drugą [[revise:${built.proposal!.id}:WED:DINNER:${second}]]`,
      built.conversationId,
    );
    const after = slotsOf(revised.proposal);
    const key = (slot: Slot) => `${slot.dayOfWeek}|${slot.mealType}`;
    const old = new Map(before.map((slot) => [key(slot), slot]));
    for (const slot of after) {
      if (key(slot) === 'WED|DINNER') continue;
      expect(slot).toEqual(old.get(key(slot)));
    }
    const [wed] = wedDinner(after);
    expect(wed.recipeId).toBe(second);
    const portions = byPerson(wed.portions);
    expect(Object.keys(portions).sort()).toEqual(
      [home.asia, home.rafal].sort(),
    );
    expect(portions[home.rafal]).toBeGreaterThan(portions[home.asia]);
  });

  it('wybrane osoby: danie tylko dla Asi — jej porcja od serwera, Rafał zostaje przy swoim z porcją', async () => {
    perUser(true);
    const home = await couple('Osoby');
    const { conversationId, second } = await plannedWeekAndSecondOption(home);
    const standing = await prisma.planItem.findFirstOrThrow({
      where: {
        weeklyPlan: { householdId: home.householdId },
        dayOfWeek: 'WED',
        mealType: 'DINNER',
      },
      include: { portions: true },
    });
    const rafalBefore = standing.portions.find((p) => p.userId === home.rafal);
    const chosen = await turn(
      home.session,
      home.householdId,
      `Tylko dla mnie drugie [[swap:WED:DINNER:${second}:${home.asia}]]`,
      conversationId,
    );
    const slots = wedDinner(slotsOf(chosen.proposal));
    const mine = slots.find((slot) =>
      slot.participantIds?.includes(home.asia),
    )!;
    const his = slots.find((slot) =>
      slot.participantIds?.includes(home.rafal),
    )!;
    expect(mine.recipeId).toBe(second);
    expect(Object.keys(byPerson(mine.portions))).toEqual([home.asia]);
    expect(his.recipeId).toBe(standing.recipeId);
    expect(byPerson(his.portions)[home.rafal]).toBe(
      (rafalBefore?.units ?? 20) / 20,
    );
    await applyProposal(home.session, chosen.proposal!.id);
    expect(await portionRows(home.householdId)).toBeGreaterThan(0);
  });

  it('7. wybrane danie dalej przechodzi filtry twarde — dieta osoby odrzuca mięsne danie', async () => {
    perUser(true);
    const home = await couple('Dieta', { dietPreference: 'VEGETARIAN' });
    const meat = await prisma.recipe.findFirstOrThrow({
      where: {
        isCatalog: true,
        isActive: true,
        dietTags: { has: 'MEAT' },
        OR: [
          { suitableMealTypes: { has: 'DINNER' } },
          { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
        ],
      },
      select: { id: true },
    });
    const chosen = await turn(
      home.session,
      home.householdId,
      `Wybieram to [[swap:WED:DINNER:${meat.id}]]`,
    );
    // Narzędzie odmówiło — propozycji nie ma, karta się nie pojawiła.
    expect(chosen.proposal).toBeNull();
    expect(chosen.answer.kind).toBe('TEXT');
  });
});
