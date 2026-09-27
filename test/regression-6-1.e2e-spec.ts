import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CARDS_CAPABILITY_V1 } from '../src/agent/cards/agent-cards';
import {
  AgentToolContext,
  AgentToolExecutor,
  AgentToolResult,
} from '../src/agent/tools/agent-tool-executor';
import { AgentCard } from '../src/agent/cards/agent-cards';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';
import { satisfiesDiet } from '../src/recipes/diet-rules.util';
import { splitPlateKcal } from '../src/agent/proposals/agent-proposals.service';

/**
 * Etap 6.1 — regresje z finalnego benchmarku, sprawdzone DETERMINISTYCZNIE:
 * narzędzia wołane tak, jak woła je runner (`AgentToolExecutor.execute`),
 * i pełne tury przez dostawcę `stub`. ZERO wywołań modelu.
 */
type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

const WEEK_START = '2026-10-05';
const CLIENT_TODAY = '2026-10-05';
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

jest.setTimeout(60_000);

describe('Regresje Etapu 6 — naprawy deterministyczne (Etap 6.1)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let executor: AgentToolExecutor;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];

  const ENV = {
    AI_ENABLED: 'true',
    AI_PROVIDER: 'stub',
    AI_STUB_DELAY_MS: '0',
    AI_TIER_OVERRIDE: 'PRO',
    AI_CONSENT_REQUIRED: 'false',
    AI_CARDS_MODE: 'soft',
    AI_TURN_WORKER_POLL_MS: '600000',
    THROTTLE_DEFAULT_LIMIT: '10000',
    THROTTLE_IP_LIMIT: '10000',
    THROTTLE_AUTH_LIMIT: '10000',
    THROTTLE_AGENT_MESSAGE_LIMIT: '10000',
    THROTTLE_AGENT_POLL_LIMIT: '10000',
  } as const;
  const original: Record<string, string | undefined> = {};
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Osoba z profilem (cel kcal) i domem; `extra` = drugi domownik. */
  const household = async (
    label: string,
    calorieGoal: number,
    extra?: { calorieGoal: number },
  ) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const login = async (who: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/dev')
        .send({
          displayName: `${label} ${who} ${stamp}`,
          email: `r61-${who}-${stamp}@regression.local`,
        })
        .expect(201);
      const session = res.body as Session;
      createdUserIds.push(session.user.id);
      if (session.household) createdHouseholdIds.push(session.household.id);
      return session;
    };
    const session = await login('owner');
    const home = await prisma.household.create({
      data: { name: `${label} ${stamp}`, createdById: session.user.id },
    });
    createdHouseholdIds.push(home.id);
    await prisma.membership.create({
      data: { userId: session.user.id, householdId: home.id, role: 'OWNER' },
    });
    await prisma.userPreference.upsert({
      where: { userId: session.user.id },
      create: { userId: session.user.id, calorieGoal },
      update: { calorieGoal },
    });
    let partnerId: string | null = null;
    if (extra) {
      const partner = await login('partner');
      partnerId = partner.user.id;
      await prisma.membership.create({
        data: { userId: partner.user.id, householdId: home.id, role: 'MEMBER' },
      });
      await prisma.userPreference.upsert({
        where: { userId: partner.user.id },
        create: { userId: partner.user.id, calorieGoal: extra.calorieGoal },
        update: { calorieGoal: extra.calorieGoal },
      });
    }
    const conversation = (
      await request(app.getHttpServer())
        .post('/agent/conversations')
        .set(auth(session.accessToken))
        .send({ householdId: home.id })
        .expect(201)
    ).body as { id: string };
    return {
      session,
      userId: session.user.id,
      partnerId,
      householdId: home.id,
      conversationId: conversation.id,
    };
  };

  type Home = Awaited<ReturnType<typeof household>>;

  /** Kontekst narzędzi jak w runnerze (tryb propozycji). */
  const tools = (home: Home) => {
    const cards: AgentCard[] = [];
    const context: AgentToolContext = {
      userId: home.userId,
      householdId: home.householdId,
      catalogIndex: {},
      conversationId: home.conversationId,
      turnId: randomUUID(),
      proposalMode: true,
      dates: { weekStart: WEEK_START, clientToday: CLIENT_TODAY },
      collectCard: (card) => cards.push(card),
    };
    return {
      cards,
      run: (name: string, input: Record<string, unknown>) =>
        executor.execute(name, input, { ...context, turnId: randomUUID() }),
    };
  };

  const wishes = {
    diet: 'NONE',
    must_have_tags: [],
    prefer_tags: [],
    avoid_ingredients: [],
    max_prep_minutes: 0,
  };

  const buildInput = (
    days: string[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    week_start: WEEK_START,
    days,
    meal_types: [],
    for_user_ids: [],
    ...wishes,
    day_kcal_target: 0,
    ...extra,
  });

  const dataOf = <T>(result: AgentToolResult): T => {
    if (!result.ok) {
      throw new Error(
        `narzędzie odmówiło: ${result.error.code} ${result.error.message}`,
      );
    }
    return result.data as T;
  };

  type PlannerData = {
    proposed?: boolean;
    proposalId?: string;
    planner?: {
      status: string;
      perPersonDaily: {
        userId: string;
        avgKcal: number;
        avgTargetKcal: number;
      }[];
      issues: string[];
    };
  };

  const proposalSlots = async (proposalId: string) => {
    const row = await prisma.agentProposal.findUniqueOrThrow({
      where: { id: proposalId },
      select: { action: true, kind: true, card: true },
    });
    const slots = (
      row.action as {
        slots: {
          dayOfWeek: string;
          mealType: string;
          recipeId: string;
          participantIds?: string[];
        }[];
      }
    ).slots;
    return { ...row, slots };
  };

  const turnDone = async (home: Home, text: string) => {
    const accepted = await request(app.getHttpServer())
      .post(`/agent/conversations/${home.conversationId}/messages`)
      .set(auth(home.session.accessToken))
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
        const answer = await prisma.agentMessage.findFirst({
          where: { turnId, role: 'ASSISTANT' },
        });
        const steps = (
          (row.progress as { tool: string; transient?: boolean }[] | null) ?? []
        )
          .filter((step) => !step.transient)
          .map((step) => step.tool);
        return { row, answer, steps };
      }
      if (Date.now() > deadline) throw new Error(`tura ${turnId} wisi`);
      await sleep(100);
    }
  };

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      original[key] = process.env[key];
      process.env[key] = value;
    }
    // Twarda gwarancja „0 wywołań API": bez klucza prawdziwy dostawca nie
    // ma czym się uwierzytelnić, a te testy chodzą wyłącznie na stubie.
    original.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    executor = app.get(AgentToolExecutor);
  });

  afterAll(async () => {
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    for (const key of [...Object.keys(ENV), 'ANTHROPIC_API_KEY']) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await app.close();
  });

  it('g4: limit kcal z ROZMOWY trafia do planera jako cel dnia — profil bez zmian', async () => {
    const home = await household('Limit', 2200);
    const { run } = tools(home);

    const limited = dataOf<PlannerData>(
      await run(
        'build_meal_plan',
        buildInput(['WED'], { day_kcal_target: 1800 }),
      ),
    );
    const me = limited.planner!.perPersonDaily.find(
      (p) => p.userId === home.userId,
    )!;
    expect(me.avgTargetKcal).toBe(1800);
    expect(Math.abs(me.avgKcal - 1800) / 1800).toBeLessThanOrEqual(0.15);

    // A1 (6.1.1): karta pokazuje TEN SAM cel, pod który liczył planer.
    const cardTarget = async (proposalId: string | undefined) =>
      (
        (await proposalSlots(proposalId!)).card as {
          summary: { targetKcalPerDay: number | null };
        }
      ).summary.targetKcalPerDay;
    expect(await cardTarget(limited.proposalId)).toBe(1800);

    const fromProfile = dataOf<PlannerData>(
      await run('build_meal_plan', buildInput(['WED'])),
    );
    expect(
      fromProfile.planner!.perPersonDaily.find((p) => p.userId === home.userId)!
        .avgTargetKcal,
    ).toBe(2200);
    expect(await cardTarget(fromProfile.proposalId)).toBe(2200);

    const profile = await prisma.userPreference.findUniqueOrThrow({
      where: { userId: home.userId },
    });
    expect(profile.calorieGoal).toBe(2200);
  });

  it('g8 (rollout porcji WYŁĄCZONY): jedno danie, bez alokacji — karta nie udaje różnych talerzy', async () => {
    const home = await household('Podzial', 1800, { calorieGoal: 2600 });
    const dish = await prisma.recipe.findFirstOrThrow({
      where: {
        isCatalog: true,
        isActive: true,
        suitableMealTypes: { has: 'DINNER' },
        allergens: { isEmpty: true },
        nutritionKcal: { gt: 0 },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    const { run } = tools(home);
    const result = dataOf<{ proposed: boolean; proposalId: string }>(
      await run('propose_household_split', {
        week_start: WEEK_START,
        day_of_week: 'THU',
        meal_type: 'DINNER',
        recipe: dish.id,
        portions: [],
      }),
    );
    expect(result.proposed).toBe(true);
    const proposal = await proposalSlots(result.proposalId);
    expect(proposal.kind).toBe('HOUSEHOLD_SPLIT');
    const thu = proposal.slots.filter(
      (s) => s.dayOfWeek === 'THU' && s.mealType === 'DINNER',
    );
    expect(thu).toHaveLength(1);
    expect(thu[0].recipeId).toBe(dish.id);
    const portions = (
      proposal.card as { portions: { userId: string; kcal: number }[] }
    ).portions;
    expect(portions.map((p) => p.userId).sort()).toEqual(
      [home.userId, home.partnerId].sort(),
    );
    // Stan docelowy bez alokacji = plan rozliczy obie osoby po równo, więc
    // karta też pokazuje równe talerze (A1 w 6.1.1: jedno źródło prawdy).
    const slot = thu[0] as { portions?: unknown };
    expect(slot.portions).toBeUndefined();
    const mine = portions.find((p) => p.userId === home.userId)!;
    const partner = portions.find((p) => p.userId === home.partnerId)!;
    expect(partner.kcal).toBe(mine.kcal);
  });

  it('g8 (rollout porcji WŁĄCZONY): porcje serwera → stan propozycji → APPLY → PlanItemPortion i bilans = karta', async () => {
    const previous = process.env.AI_PLANNER_PER_USER_PORTIONS;
    process.env.AI_PLANNER_PER_USER_PORTIONS = 'true';
    try {
      const home = await household('PodzialPorcje', 1800, {
        calorieGoal: 2600,
      });
      // Porcje mają krok 0,5 (27.09.2026): przy bardzo sytym daniu obie osoby
      // dostałyby po 0,5 niezależnie od celu. Danie umiarkowane na porcję
      // pozwala sprawdzić, że różne cele dają różne porcje.
      const dinners = await prisma.recipe.findMany({
        where: {
          isCatalog: true,
          isActive: true,
          suitableMealTypes: { has: 'DINNER' },
          allergens: { isEmpty: true },
          nutritionKcal: { gt: 300 },
        },
        orderBy: { id: 'asc' },
        select: { id: true, servings: true, nutritionKcal: true },
      });
      const perServing = (recipe: (typeof dinners)[number]) =>
        (recipe.nutritionKcal ?? 0) / Math.max(1, recipe.servings ?? 1);
      const dish = dinners.find(
        (recipe) => perServing(recipe) >= 450 && perServing(recipe) <= 600,
      );
      if (!dish) throw new Error('katalog bez kolacji 450–600 kcal/porcję');
      const kcalPerServing = Math.round(
        (dish.nutritionKcal ?? 0) / Math.max(1, dish.servings ?? 1),
      );
      const { run } = tools(home);
      const result = dataOf<{ proposed: boolean; proposalId: string }>(
        await run('propose_household_split', {
          week_start: WEEK_START,
          day_of_week: 'THU',
          meal_type: 'DINNER',
          recipe: dish.id,
          portions: [],
        }),
      );
      const proposal = await proposalSlots(result.proposalId);
      const [slot] = proposal.slots.filter(
        (s) => s.dayOfWeek === 'THU' && s.mealType === 'DINNER',
      ) as {
        recipeId: string;
        portions?: { userId: string; servings: number }[];
      }[];
      // Jedno danie, porcje per osoba W STANIE PROPOZYCJI.
      expect(slot.recipeId).toBe(dish.id);
      const servingsOf = new Map(
        (slot.portions ?? []).map((p) => [p.userId, p.servings]),
      );
      expect([...servingsOf.keys()].sort()).toEqual(
        [home.userId, home.partnerId].sort(),
      );
      const mineServings = servingsOf.get(home.userId)!;
      const partnerServings = servingsOf.get(home.partnerId!)!;
      expect(partnerServings).toBeGreaterThan(mineServings);
      // Karta WYLICZONA z tych porcji — nie z proporcji celów.
      const plates = (
        proposal.card as { portions: { userId: string; kcal: number }[] }
      ).portions;
      for (const plate of plates) {
        expect(plate.kcal).toBe(
          splitPlateKcal(kcalPerServing, servingsOf.get(plate.userId)!),
        );
      }

      // Jak `finishDone` w runnerze: propozycja przypięta do odpowiedzi —
      // dopiero taka jest „na ekranie" i da się ją zatwierdzić.
      const message = await prisma.agentMessage.create({
        data: {
          conversationId: home.conversationId,
          role: 'ASSISTANT',
          kind: 'HOUSEHOLD_SPLIT',
          text: 'karta',
          card: proposal.card as never,
        },
      });
      await prisma.agentProposal.update({
        where: { id: result.proposalId },
        data: { messageId: message.id },
      });

      // Klik „Zatwierdź" — plan zapisany z alokacją.
      await request(app.getHttpServer())
        .post(`/agent/proposals/${result.proposalId}/apply`)
        .set(auth(home.session.accessToken))
        .send({})
        .expect(200);
      const stored = await prisma.planItemPortion.findMany({
        where: {
          planItem: {
            weeklyPlan: { householdId: home.householdId },
            dayOfWeek: 'THU',
            mealType: 'DINNER',
          },
        },
        select: { userId: true, units: true },
      });
      const units = new Map(stored.map((row) => [row.userId, row.units]));
      expect(units.get(home.userId)).toBe(Math.round(mineServings * 20));
      expect(units.get(home.partnerId!)).toBe(Math.round(partnerServings * 20));
      expect(units.get(home.partnerId!)!).toBeGreaterThan(
        units.get(home.userId)!,
      );

      // Bilans po zapisie widzi te same porcje, co karta (±5 kcal zaokrąglenia).
      const weeklyPlans = app.get(WeeklyPlansService);
      const thuKcal = async (memberId: string) =>
        (
          await weeklyPlans.weeklyBalance(
            home.userId,
            home.householdId,
            WEEK_START,
            memberId,
          )
        ).days.find((day) => day.dayOfWeek === 'THU')!.planned.kcal;
      for (const plate of plates) {
        expect(
          Math.abs((await thuKcal(plate.userId)) - plate.kcal),
        ).toBeLessThanOrEqual(5);
      }
    } finally {
      if (previous === undefined)
        delete process.env.AI_PLANNER_PER_USER_PORTIONS;
      else process.env.AI_PLANNER_PER_USER_PORTIONS = previous;
    }
  });

  it('g9: twardy limit 5 min — żadne dłuższe danie w propozycji, status PARTIAL/UNSAT z jednoznacznym powodem', async () => {
    const home = await household('Czas', 2200);
    const { run } = tools(home);
    const data = dataOf<PlannerData>(
      await run('build_meal_plan', buildInput(DAYS, { max_prep_minutes: 5 })),
    );
    expect(data.planner!.status).not.toBe('OK');
    expect(data.planner!.issues.join(' ')).toMatch(/czas przygotowania|5 min/i);
    if (data.proposalId) {
      const proposal = await proposalSlots(data.proposalId);
      const recipes = await prisma.recipe.findMany({
        where: { id: { in: proposal.slots.map((s) => s.recipeId) } },
        select: { prepTimeMinutes: true },
      });
      expect(recipes.every((r) => (r.prepTimeMinutes ?? 0) <= 5)).toBe(true);
    }
  });

  it('g11: edycja przepisu KATALOGOWEGO — jawny wynik „tylko do odczytu", tura kończy się wyjaśnieniem serwera, bez kopii i bez zmiany planu', async () => {
    const home = await household('Katalog', 2200);
    const dish = await prisma.recipe.findFirstOrThrow({
      where: {
        isCatalog: true,
        isActive: true,
        suitableMealTypes: { has: 'DINNER' },
      },
      orderBy: { id: 'asc' },
      select: { id: true, servings: true, title: true },
    });
    await app
      .get(WeeklyPlansService)
      .applyWeekPlan(home.userId, home.householdId, WEEK_START, {
        slots: [{ dayOfWeek: 'MON', mealType: 'DINNER', recipeId: dish.id }],
      } as never);

    const { run } = tools(home);
    const direct = await run('update_recipe', {
      recipe_id: dish.id,
      servings: 8,
    });
    expect(direct).toMatchObject({
      ok: true,
      endsTurn: true,
      data: { updated: false, readOnly: true },
    });
    expect(direct.ok && direct.turnText).toMatch(/katalog/i);

    // Pełna tura (stub): jedno narzędzie, zdanie serwera, nic więcej.
    const { answer, steps } = await turnDone(
      home,
      `Zmień przepis [[update-recipe:${dish.id}:8]]`,
    );
    expect(steps).toEqual(['update_recipe']);
    expect(answer?.text).toMatch(/katalog/i);
    const after = await prisma.recipe.findUniqueOrThrow({
      where: { id: dish.id },
    });
    expect(after.servings).toBe(dish.servings);
    expect(
      await prisma.recipe.count({ where: { householdId: home.householdId } }),
    ).toBe(0);
    expect(
      await prisma.agentProposal.count({
        where: { householdId: home.householdId },
      }),
    ).toBe(0);
  });

  it('g13-pokaz-inne: druga prośba o dania na TEN SAM posiłek daje nowe dania — serwer pamięta poprzednią kartę', async () => {
    const home = await household('Inne', 2200);
    const first = await turnDone(
      home,
      'Co na kolację? [[suggest:MON:DINNER:-]]',
    );
    const second = await turnDone(home, 'Pokaż inne. [[suggest:MON:DINNER:-]]');
    const ids = (message: typeof first.answer) =>
      (
        (message?.card as { options?: { recipeId: string }[] } | null)
          ?.options ?? []
      ).map((option) => option.recipeId);
    const a = ids(first.answer);
    const b = ids(second.answer);
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(b.length).toBeGreaterThanOrEqual(2);
    expect(b.filter((id) => a.includes(id))).toEqual([]);
  });

  it('g13-pokaz-inne przy MAŁEJ puli: bez powtórek podanych jako nowe, na końcu jawne „nowych propozycji zabrakło"', async () => {
    const home = await household('MalaPula', 2200);
    const { run, cards } = tools(home);
    // Zawężenie do małej puli: pierwszy zestaw życzeń, który daje kartę
    // i wyczerpuje się w oknie historii (5 kart).
    const attempts: Record<string, unknown>[] = [
      { include_ingredients: ['łosoś'] },
      { include_ingredients: ['krewetki'] },
      { include_ingredients: ['tofu'] },
      { include_ingredients: ['dorsz'] },
      { include_ingredients: ['kurczak'], must_have_tags: ['soup'] },
    ];
    let verified = false;
    for (const extra of attempts) {
      const input = {
        week_start: WEEK_START,
        day_of_week: 'TUE',
        meal_type: 'DINNER',
        count: 3,
        for_user_ids: [],
        include_ingredients: [],
        ...wishes,
        ...extra,
      };
      const seen: string[] = [];
      let exhausted: AgentToolResult | null = null;
      for (let round = 0; round < 5 && !exhausted; round += 1) {
        const before = cards.length;
        const result = await run('suggest_meals', input);
        const data = result.ok
          ? (result.data as { exhausted?: boolean; proposed?: boolean })
          : null;
        if (data?.exhausted) {
          exhausted = result;
          expect(cards.length).toBe(before); // żadnej karty ze starymi daniami
          break;
        }
        if (!result.ok || data?.proposed === false) break; // pula za mała od początku
        const card = cards[cards.length - 1] as unknown as {
          eyebrow: string;
          options: { recipeId: string }[];
        };
        const ids = card.options.map((option) => option.recipeId);
        expect(ids.filter((id) => seen.includes(id))).toEqual([]);
        seen.push(...ids);
        // Jak runner: karta w historii rozmowy.
        await prisma.agentMessage.create({
          data: {
            conversationId: home.conversationId,
            role: 'ASSISTANT',
            kind: 'OPTIONS',
            text: 'karta',
            card: card as never,
          },
        });
      }
      if (!exhausted || seen.length === 0) continue;
      expect(exhausted).toMatchObject({ ok: true, endsTurn: true });
      expect(exhausted.ok && exhausted.turnText).toMatch(
        /Nie mam już nowych propozycji/,
      );
      verified = true;
      break;
    }
    expect(verified).toBe(true);
  });

  it('g13-zmiana-w-propozycji: „tylko kolacja wegetariańska" — B1 i L1 zostają, D2 spełnia dietę', async () => {
    const home = await household('Zmiana', 2200);
    const { run } = tools(home);
    const first = dataOf<PlannerData>(
      await run('build_meal_plan', buildInput(['WED'])),
    );
    expect(first.proposalId).toBeDefined();
    const before = await proposalSlots(first.proposalId!);
    const replaced = dataOf<PlannerData>(
      await run('replace_plan_item', {
        week_start: WEEK_START,
        day_of_week: 'WED',
        meal_type: 'DINNER',
        proposal_id: first.proposalId,
        similar_kcal: false,
        ...wishes,
        diet: 'VEGETARIAN',
      }),
    );
    const after = await proposalSlots(replaced.proposalId!);
    const pick = (slots: typeof before.slots, meal: string) =>
      slots.find((s) => s.dayOfWeek === 'WED' && s.mealType === meal)?.recipeId;
    expect(pick(after.slots, 'BREAKFAST')).toBe(
      pick(before.slots, 'BREAKFAST'),
    );
    expect(pick(after.slots, 'LUNCH')).toBe(pick(before.slots, 'LUNCH'));
    const dinner = await prisma.recipe.findUniqueOrThrow({
      where: { id: pick(after.slots, 'DINNER')! },
      select: { dietTags: true, ingredients: { select: { id: true } } },
    });
    expect(
      satisfiesDiet('VEGETARIAN', {
        dietTags: dinner.dietTags,
        hasIngredientData: dinner.ingredients.length > 0,
        perServing: null,
      }),
    ).toBe(true);
    expect(pick(after.slots, 'DINNER')).not.toBe(pick(before.slots, 'DINNER'));
  });
});
