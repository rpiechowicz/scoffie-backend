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
import { satisfiesDiet } from '../src/recipes/diet-rules.util';

/**
 * Serwerowy planer na żywej bazie (workstream, Etap 2): katalog dev,
 * dostawca `stub` z markerami `[[build:…]]` i `[[replace:…]]`, zapis przez
 * propozycję i kliknięcie. Numery w opisach = lista testów z polecenia Etapu 2.
 */
type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

const WEEK_START = '2026-08-31';
const CLIENT_TODAY = '2026-09-02';
const DAYS = 'MON,TUE,WED,THU,FRI,SAT,SUN';

const noWishes = {
  diet: null,
  requiredTags: [],
  preferredTags: [],
  avoidIngredients: [],
  maxPrepMinutes: null,
};

describe('Serwerowy planer posiłków E2E', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let planner: AgentMealPlannerService;
  let weeklyPlans: WeeklyPlansService;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  const createdRecipeIds: string[] = [];

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
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /** Świeży dom z jedną osobą (opcjonalnie z preferencjami). */
  const household = async (
    label: string,
    preferences?: { allergens?: string[]; dietPreference?: 'VEGETARIAN' },
  ) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `plan-${stamp}@planner.local`,
      })
      .expect(201);
    const session = res.body as Session;
    createdUserIds.push(session.user.id);
    if (session.household) createdHouseholdIds.push(session.household.id);
    const home = await prisma.household.create({
      data: { name: `${label} ${stamp}`, createdById: session.user.id },
    });
    await prisma.membership.create({
      data: { userId: session.user.id, householdId: home.id, role: 'OWNER' },
    });
    createdHouseholdIds.push(home.id);
    if (preferences) {
      await prisma.userPreference.upsert({
        where: { userId: session.user.id },
        create: { userId: session.user.id, ...preferences },
        update: preferences,
      });
    }
    return { session, householdId: home.id };
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

  const proposalOf = async (answer: { card: unknown }) =>
    prisma.agentProposal.findUniqueOrThrow({
      where: { id: (answer.card as { proposalId: string }).proposalId },
    });
  const slotsOf = (proposal: { action: unknown }) =>
    (proposal.action as { slots: Record<string, unknown>[] }).slots as {
      dayOfWeek: string;
      mealType: string;
      recipeId: string;
      participantIds?: string[];
      plannedServings?: number;
    }[];

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
    await prisma.recipe.deleteMany({ where: { id: { in: createdRecipeIds } } });
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

  it('tura z build_meal_plan: karta tygodnia, 21 pozycji, 10. wynik przechodzi walidatory zapisu i się zapisuje', async () => {
    const { session, householdId } = await household('Tydzien');
    const { answer } = await turn(
      session,
      householdId,
      `Ułóż tydzień [[build:${WEEK_START}:${DAYS}]]`,
    );
    expect(answer.kind).toBe('PLAN_WEEK');
    const proposal = await proposalOf(answer);
    const slots = slotsOf(proposal);
    // Domyślne pory domu: śniadanie, obiad, kolacja × 7.
    expect(slots).toHaveLength(21);
    expect(new Set(slots.map((slot) => slot.recipeId)).size).toBe(21);

    const preview = await weeklyPlans.previewWeekPlan(
      session.user.id,
      householdId,
      WEEK_START,
      { slots: slots as never },
    );
    expect(preview.violations).toEqual([]);

    await request(app.getHttpServer())
      .post(`/agent/proposals/${proposal.id}/apply`)
      .set(auth(session.accessToken))
      .expect(200);
    expect(
      await prisma.planItem.count({ where: { weeklyPlan: { householdId } } }),
    ).toBe(21);
  });

  it('2.–3. alergia i dieta z profilu na żywym katalogu: zero złamań, metryki planera', async () => {
    const { session, householdId } = await household('Profil', {
      allergens: ['gluten'],
      dietPreference: 'VEGETARIAN',
    });
    const outcome = await planner.build({
      userId: session.user.id,
      householdId,
      weekStart: WEEK_START,
      days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
      mealTypes: [],
      forUserIds: [],
      wishes: noWishes,
      seed: 'e2e',
    });
    expect(outcome.draft.items.length).toBeGreaterThan(0);
    expect(outcome.draft.diagnostics.metrics.hardViolations).toBe(0);
    const recipes = await prisma.recipe.findMany({
      where: { id: { in: outcome.draft.items.map((item) => item.recipeId) } },
      select: {
        allergens: true,
        dietTags: true,
        ingredients: { select: { id: true } },
        servings: true,
        nutritionKcal: true,
        nutritionProtein: true,
        nutritionCarbs: true,
      },
    });
    for (const recipe of recipes) {
      expect(recipe.allergens).not.toContain('gluten');
      expect(
        satisfiesDiet('VEGETARIAN', {
          dietTags: recipe.dietTags,
          hasIngredientData: recipe.ingredients.length > 0,
          perServing: null,
        }),
      ).toBe(true);
    }
    // Pomiar do raportu (MEASURED na katalogu dev).
    process.stdout.write(
      `[planer e2e] ${JSON.stringify(outcome.draft.diagnostics.metrics)}\n`,
    );
  });

  it('8.–9. replace_plan_item w propozycji PENDING: tylko środa-kolacja się zmienia, jest wegetariańska', async () => {
    const { session, householdId } = await household('Podmiana');
    const first = await turn(
      session,
      householdId,
      `Ułóż tydzień [[build:${WEEK_START}:${DAYS}]]`,
    );
    const before = await proposalOf(first.answer);
    const second = await turn(
      session,
      householdId,
      `Środa wege, podobnie kalorycznie ${WEEK_START} [[replace:${before.id}:WED:DINNER:VEGETARIAN]]`,
      first.conversationId,
    );
    expect(second.answer.kind).toBe('PLAN_WEEK');
    const after = await proposalOf(second.answer);
    expect(after.id).not.toBe(before.id);

    const key = (slot: { dayOfWeek: string; mealType: string }) =>
      `${slot.dayOfWeek}|${slot.mealType}`;
    const oldSlots = new Map(slotsOf(before).map((slot) => [key(slot), slot]));
    const newSlots = new Map(slotsOf(after).map((slot) => [key(slot), slot]));
    expect([...newSlots.keys()].sort()).toEqual([...oldSlots.keys()].sort());
    for (const [slotKey, slot] of newSlots) {
      if (slotKey === 'WED|DINNER') continue;
      expect(slot).toEqual(oldSlots.get(slotKey));
    }
    const wednesday = newSlots.get('WED|DINNER')!;
    expect(wednesday.recipeId).not.toBe(oldSlots.get('WED|DINNER')!.recipeId);
    const chosen = await prisma.recipe.findUniqueOrThrow({
      where: { id: wednesday.recipeId },
      select: { dietTags: true, suitableMealTypes: true, mealType: true },
    });
    expect(chosen.dietTags).not.toContain('MEAT');
    expect(chosen.dietTags).not.toContain('FISH');
  });

  it('replace_plan_item w ZAPISANYM planie: karta podmiany (przed/po)', async () => {
    const { session, householdId } = await household('Zapisany');
    const built = await turn(
      session,
      householdId,
      `Ułóż tydzień [[build:${WEEK_START}:${DAYS}]]`,
    );
    const proposal = await proposalOf(built.answer);
    await request(app.getHttpServer())
      .post(`/agent/proposals/${proposal.id}/apply`)
      .set(auth(session.accessToken))
      .expect(200);
    const swapped = await turn(
      session,
      householdId,
      `Lżejsza czwartkowa kolacja ${WEEK_START} [[replace:-:THU:DINNER:NONE]]`,
      built.conversationId,
    );
    expect(swapped.answer.kind).toBe('SWAP');
  });

  it('12. prywatny przepis INNEGO domu nie trafia do planu; obcy nie planuje cudzego domu', async () => {
    const owner = await household('Obcy');
    const target = await household('Nasz');
    const foreign = await prisma.recipe.create({
      data: {
        title: `Cudzy idealny obiad ${Date.now()}`,
        householdId: owner.householdId,
        authorId: owner.session.user.id,
        isCatalog: false,
        mealType: 'LUNCH',
        suitableMealTypes: ['BREAKFAST', 'LUNCH', 'DINNER'],
        nutritionKcal: 1300,
        nutritionProtein: 80,
        nutritionFat: 45,
        nutritionCarbs: 145,
        servings: 2,
        prepTimeMinutes: 10,
      },
    });
    createdRecipeIds.push(foreign.id);
    for (const seed of ['a', 'b', 'c']) {
      const outcome = await planner.build({
        userId: target.session.user.id,
        householdId: target.householdId,
        weekStart: WEEK_START,
        days: ['MON', 'TUE', 'WED'],
        mealTypes: [],
        forUserIds: [],
        wishes: noWishes,
        seed,
      });
      expect(outcome.draft.items.map((item) => item.recipeId)).not.toContain(
        foreign.id,
      );
    }
    await expect(
      planner.build({
        userId: owner.session.user.id,
        householdId: target.householdId,
        weekStart: WEEK_START,
        days: ['MON'],
        mealTypes: [],
        forUserIds: [],
        wishes: noWishes,
        seed: 'x',
      }),
    ).rejects.toMatchObject({ code: 'NOT_HOUSEHOLD_MEMBER' });
  });

  it('6. UNSAT na żywej bazie: niemożliwe życzenie → brak karty, powód dla modelu', async () => {
    const { session, householdId } = await household('Niemozliwe');
    const outcome = await planner.build({
      userId: session.user.id,
      householdId,
      weekStart: WEEK_START,
      days: ['MON'],
      mealTypes: ['BREAKFAST'],
      forUserIds: [],
      wishes: { ...noWishes, requiredTags: ['soup', 'pancakes', 'drink'] },
      seed: 'x',
    });
    expect(outcome.draft.status).toBe('UNSAT');
    expect(outcome.draft.items).toHaveLength(0);
    expect(outcome.draft.diagnostics.issues[0]).toMatchObject({
      code: 'NO_CANDIDATES',
    });
  });

  it('audyt 2A: ten sam przepis dwa razy w jednym slocie (dla różnych osób) odrzuca walidator zapisu', async () => {
    const { session, householdId } = await household('Duplikat');
    const dinner = await prisma.recipe.findFirstOrThrow({
      where: {
        isCatalog: true,
        isActive: true,
        suitableMealTypes: { has: 'DINNER' },
      },
      select: { id: true },
    });
    const preview = await weeklyPlans.previewWeekPlan(
      session.user.id,
      householdId,
      WEEK_START,
      {
        slots: [
          {
            dayOfWeek: 'MON',
            mealType: 'DINNER',
            recipeId: dinner.id,
            plannedServings: 1,
          },
          {
            dayOfWeek: 'MON',
            mealType: 'DINNER',
            recipeId: dinner.id,
            plannedServings: 2,
          },
        ],
      },
    );
    expect(preview.violations.map((violation) => violation.code)).toContain(
      'PLAN_SLOT_DUPLICATE',
    );
  });
});
