import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CARDS_CAPABILITY_V1 } from '../src/agent/cards/agent-cards';
import { HouseholdsService } from '../src/households/households.service';
import { StubAgentProvider } from '../src/agent/providers/stub-agent.provider';
import { AgentPromptService } from '../src/agent/agent-prompt.service';
import { AgentToolExecutor } from '../src/agent/tools/agent-tool-executor';
import { createTurnMemo } from '../src/agent/turn-memo';
import { satisfiesDiet } from '../src/recipes/diet-rules.util';
import { AgentProviderRequest } from '../src/agent/providers/agent-provider';

/**
 * Odchudzony asystent na żywej bazie (workstream, Etap 3): `suggest_meals`
 * przez dostawcę `stub` (`[[suggest:…]]`), jedna karta na turę, chudy
 * `find_recipes`, pamięć tury. Numery w opisach = testy obowiązkowe Etapu 3.
 */
type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

type OptionsCard = {
  kind: string;
  eyebrow: string;
  title: string;
  options: { recipeId: string; title: string; prepTimeMinutes: number }[];
};

const WEEK_START = '2026-08-31';
const CLIENT_TODAY = '2026-09-02';

describe('Odchudzony asystent E2E (Etap 3)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let households: HouseholdsService;
  let stub: StubAgentProvider;
  let prompts: AgentPromptService;
  let executor: AgentToolExecutor;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];

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

  const household = async (
    label: string,
    preferences?: { allergens?: string[]; dietPreference?: 'VEGETARIAN' },
  ) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const res = await request(app.getHttpServer())
      .post('/auth/dev')
      .send({
        displayName: `${label} ${stamp}`,
        email: `thin-${stamp}@thin.local`,
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
    const [answer, turnRow] = await Promise.all([
      prisma.agentMessage.findFirstOrThrow({
        where: { turnId, role: 'ASSISTANT' },
      }),
      prisma.agentTurn.findUniqueOrThrow({ where: { id: turnId } }),
    ]);
    const tools = (
      (turnRow.progress as { tool: string; transient?: boolean }[] | null) ?? []
    )
      .filter((step) => !step.transient)
      .map((step) => step.tool);
    return { conversationId: conversation, answer, tools };
  };

  const recipesOf = (ids: string[]) =>
    prisma.recipe.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        allergens: true,
        dietTags: true,
        mealType: true,
        suitableMealTypes: true,
        prepTimeMinutes: true,
        ingredients: { select: { id: true } },
      },
    });

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
    households = app.get(HouseholdsService);
    stub = app.get(StubAgentProvider);
    prompts = app.get(AgentPromptService);
    executor = app.get(AgentToolExecutor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  it('1./10. „co na kolację?": jedna operacja serwera, karta OPTIONS z 3 różnymi daniami, domownicy czytani RAZ na turę', async () => {
    const { session, householdId } = await household('Kolacja');
    const reads = jest.spyOn(households, 'memberPreferences');
    const { answer, tools } = await turn(
      session,
      householdId,
      'Co zjeść dziś na kolację? [[suggest:WED:DINNER:-]]',
    );
    expect(tools).toEqual(['suggest_meals']);
    expect(answer.kind).toBe('OPTIONS');
    const card = answer.card as unknown as OptionsCard;
    expect(card.eyebrow).toBe('Kolacja · środa');
    expect(card.options).toHaveLength(3);
    const ids = card.options.map((option) => option.recipeId);
    expect(new Set(ids).size).toBe(3);
    for (const recipe of await recipesOf(ids)) {
      const slots =
        recipe.suitableMealTypes.length > 0
          ? recipe.suitableMealTypes
          : [recipe.mealType];
      expect(slots).toContain('DINNER');
    }
    // Prompt + suggest_meals + planer tej samej tury: jeden odczyt domowników.
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('2. alergia i dieta z profilu obowiązują w propozycjach', async () => {
    const { session, householdId } = await household('Profil', {
      allergens: ['gluten'],
      dietPreference: 'VEGETARIAN',
    });
    const { answer } = await turn(
      session,
      householdId,
      'Pomysły na obiad [[suggest:THU:LUNCH:-]]',
    );
    const card = answer.card as unknown as OptionsCard;
    expect(card.options.length).toBeGreaterThanOrEqual(2);
    for (const recipe of await recipesOf(
      card.options.map((option) => option.recipeId),
    )) {
      expect(recipe.allergens).not.toContain('gluten');
      expect(
        satisfiesDiet('VEGETARIAN', {
          dietTags: recipe.dietTags,
          hasIngredientData: recipe.ingredients.length > 0,
          perServing: null,
        }),
      ).toBe(true);
    }
  });

  it('3. „szybkie": każde danie mieści się w 25 minutach (katalog dev ma ich dość)', async () => {
    const { session, householdId } = await household('Szybko');
    const { answer } = await turn(
      session,
      householdId,
      'Daj mi 3 szybkie kolacje [[suggest:FRI:DINNER:quick]]',
    );
    const card = answer.card as unknown as OptionsCard;
    expect(card.title).toContain('szybkie');
    expect(card.options).toHaveLength(3);
    for (const option of card.options) {
      expect(option.prepTimeMinutes).toBeLessThanOrEqual(25);
    }
  });

  it('5. build_meal_plan układa dzień sam — bez propose_week_plan i bez find_recipes', async () => {
    const { session, householdId } = await household('Dzien');
    const { answer, tools } = await turn(
      session,
      householdId,
      `Ułóż mi dzisiaj jedzenie [[build:${WEEK_START}:WED]]`,
    );
    expect(answer.kind).toBe('PLAN_DAY');
    expect(tools).toEqual(['build_meal_plan']);
  });

  it('7. „wybieram drugą": model w następnej turze widzi opcje karty suggest_meals w kolejności kafelków', async () => {
    const { session, householdId } = await household('Wybor');
    const first = await turn(
      session,
      householdId,
      'Co na kolację? [[suggest:WED:DINNER:-]]',
    );
    const card = first.answer.card as unknown as OptionsCard;
    const seen: AgentProviderRequest[] = [];
    const run = stub.run.bind(stub);
    jest.spyOn(stub, 'run').mockImplementation((req) => {
      seen.push(req);
      return run(req);
    });
    await turn(session, householdId, 'Wybieram drugą', first.conversationId);
    const history = seen[0].messages;
    const assistant = history.find((message) => message.role === 'ASSISTANT');
    expect(assistant?.text).toContain('[Karta OPTIONS „Kolacja · środa"');
    // Pozycja 2 w dopisku = drugi kafelek karty (indeks katalogu albo id).
    const catalog = (
      await prompts.build(
        session.user.id,
        householdId,
        {
          weekStart: WEEK_START,
          clientToday: CLIENT_TODAY,
          timeZone: 'Europe/Warsaw',
        },
        true,
      )
    ).catalogIndex;
    const refOf = (id: string) =>
      Object.entries(catalog).find(([, value]) => value === id)?.[0] ?? id;
    expect(assistant?.text).toContain(
      `2) ${refOf(card.options[1].recipeId)} ${card.options[1].title}`,
    );
  });

  it('9. find_recipes oddaje chudy wynik — bez składników, alergenów, tłuszczu, węgli i porcji', async () => {
    const { session, householdId } = await household('Szukaj');
    const prompt = await prompts.build(
      session.user.id,
      householdId,
      {
        weekStart: WEEK_START,
        clientToday: CLIENT_TODAY,
        timeZone: 'Europe/Warsaw',
      },
      true,
    );
    const result = await executor.execute(
      'find_recipes',
      {
        query: 'kurczak',
        meal_type: 'ANY',
        tags: [],
        include_ingredients: [],
        exclude_ingredients: [],
        max_prep_minutes: 0,
        max_kcal_per_serving: 0,
        min_protein_per_serving: 0,
        for_user_ids: [],
        sort: 'BEST_FIT',
        limit: 8,
      },
      {
        userId: session.user.id,
        householdId,
        catalogIndex: prompt.catalogIndex,
        conversationId: randomUUID(),
        turnId: randomUUID(),
        proposalMode: true,
        collectCard: () => undefined,
      },
    );
    if (!result.ok) throw new Error(result.error.message);
    const hits = (result.data as { hits: Record<string, unknown>[] }).hits;
    expect(hits.length).toBeGreaterThan(0);
    const allowed = [
      'recipe',
      'title',
      'slots',
      'tags',
      'kcal',
      'protein',
      'prepMinutes',
      'why',
      'household',
    ];
    for (const hit of hits) {
      for (const key of Object.keys(hit)) expect(allowed).toContain(key);
      expect(hit).not.toHaveProperty('mainIngredients');
      expect(hit).not.toHaveProperty('allergens');
    }
    process.stdout.write(
      `[etap3] find_recipes 8 trafień: ${JSON.stringify(result.data).length} znaków\n`,
    );
  });

  it('12. dwie karty w jednej turze: druga odmówiona (także równolegle), wiadomość niesie jedną kartę', async () => {
    const { session, householdId } = await household('Karty');
    const prompt = await prompts.build(
      session.user.id,
      householdId,
      {
        weekStart: WEEK_START,
        clientToday: CLIENT_TODAY,
        timeZone: 'Europe/Warsaw',
      },
      true,
    );
    const cards: unknown[] = [];
    const context = {
      userId: session.user.id,
      householdId,
      catalogIndex: prompt.catalogIndex,
      conversationId: randomUUID(),
      turnId: randomUUID(),
      proposalMode: true,
      collectCard: (card: unknown) => cards.push(card),
      memo: createTurnMemo(),
    };
    const suggest = (day: string) => ({
      week_start: WEEK_START,
      day_of_week: day,
      meal_type: 'DINNER',
      count: 3,
      include_ingredients: [],
      for_user_ids: [],
      diet: 'NONE',
      must_have_tags: [],
      prefer_tags: [],
      avoid_ingredients: [],
      max_prep_minutes: 0,
    });
    const [a, b] = await Promise.all([
      executor.execute('suggest_meals', suggest('MON'), context as never),
      executor.execute('suggest_meals', suggest('TUE'), context as never),
    ]);
    const outcomes = [a, b].map((result) =>
      result.ok ? 'ok' : result.error.code,
    );
    expect(outcomes.sort()).toEqual(['AI_ONE_CARD_PER_TURN', 'ok']);
    expect(cards).toHaveLength(1);

    // Karta z odmowy nie blokuje: nieudane narzędzie zwalnia rezerwację.
    const fresh = { ...context, memo: createTurnMemo() };
    const invalid = await executor.execute(
      'suggest_meals',
      { ...suggest('MON'), meal_type: 'OBIADOKOLACJA' },
      fresh as never,
    );
    expect(invalid.ok).toBe(false);
    const retry = await executor.execute(
      'suggest_meals',
      suggest('MON'),
      fresh as never,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.endsTurn).toBe(true);
      expect(retry.turnText).toBe(
        'Trzy propozycje na kolację w poniedziałek — wybierz jedną.',
      );
    }
  });
});
