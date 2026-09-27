import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AgentToolContext,
  AgentToolExecutor,
  AgentToolResult,
} from '../src/agent/tools/agent-tool-executor';
import { AgentCard } from '../src/agent/cards/agent-cards';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';

/**
 * Spójność „karta → propozycja → zapis → bilans” (noc 26/27.09, N5).
 *
 * Liczba kcal, którą karta pokazuje osobie, musi być tą samą liczbą, którą
 * po kliknięciu „Zapisz” policzy jej bilans dnia. Narzędzia wołane tak, jak
 * woła je runner; ZERO wywołań modelu.
 */
type Session = {
  accessToken: string;
  user: { id: string };
  household: { id: string } | null;
};

const WEEK_START = '2026-10-05';
const CLIENT_TODAY = '2026-10-05';

jest.setTimeout(60_000);

describe('Propozycja = stan po zapisie (N5)', () => {
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
    // Rollout porcji per osoba WYŁĄCZONY — stan produkcji.
    AI_PLANNER_PER_USER_PORTIONS: 'false',
    THROTTLE_DEFAULT_LIMIT: '10000',
    THROTTLE_IP_LIMIT: '10000',
    THROTTLE_AUTH_LIMIT: '10000',
    THROTTLE_AGENT_MESSAGE_LIMIT: '10000',
    THROTTLE_AGENT_POLL_LIMIT: '10000',
  } as const;
  const original: Record<string, string | undefined> = {};
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const household = async (label: string, goals: [number, number]) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const login = async (who: string) => {
      const res = await request(app.getHttpServer())
        .post('/auth/dev')
        .send({
          displayName: `${label} ${who} ${stamp}`,
          email: `n5-${who}-${stamp}@consistency.local`,
        })
        .expect(201);
      const session = res.body as Session;
      createdUserIds.push(session.user.id);
      if (session.household) createdHouseholdIds.push(session.household.id);
      return session;
    };
    const owner = await login('owner');
    const partner = await login('partner');
    const home = await prisma.household.create({
      data: { name: `${label} ${stamp}`, createdById: owner.user.id },
    });
    createdHouseholdIds.push(home.id);
    await prisma.membership.createMany({
      data: [
        { userId: owner.user.id, householdId: home.id, role: 'OWNER' },
        { userId: partner.user.id, householdId: home.id, role: 'MEMBER' },
      ],
    });
    for (const [session, calorieGoal] of [
      [owner, goals[0]],
      [partner, goals[1]],
    ] as const) {
      await prisma.userPreference.upsert({
        where: { userId: session.user.id },
        create: { userId: session.user.id, calorieGoal },
        update: { calorieGoal },
      });
    }
    const conversation = (
      await request(app.getHttpServer())
        .post('/agent/conversations')
        .set(auth(owner.accessToken))
        .send({ householdId: home.id })
        .expect(201)
    ).body as { id: string };
    return {
      session: owner,
      userId: owner.user.id,
      partnerId: partner.user.id,
      householdId: home.id,
      conversationId: conversation.id,
    };
  };

  type Home = Awaited<ReturnType<typeof household>>;

  const run = (
    home: Home,
    name: string,
    input: Record<string, unknown>,
  ): Promise<AgentToolResult> => {
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
    return executor.execute(name, input, context);
  };

  /** Jak `finishDone`: propozycja przypięta do odpowiedzi — da się ją zapisać. */
  const pinToMessage = async (home: Home, proposalId: string) => {
    const proposal = await prisma.agentProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });
    const message = await prisma.agentMessage.create({
      data: {
        conversationId: home.conversationId,
        role: 'ASSISTANT',
        kind: proposal.kind,
        text: 'karta',
        card: proposal.card as never,
      },
    });
    await prisma.agentProposal.update({
      where: { id: proposalId },
      data: { messageId: message.id },
    });
    return proposal;
  };

  const dayKcal = async (home: Home, memberId: string, day: string) =>
    (
      await app
        .get(WeeklyPlansService)
        .weeklyBalance(home.userId, home.householdId, WEEK_START, memberId)
    ).days.find((d) => d.dayOfWeek === day)!.planned.kcal;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      original[key] = process.env[key];
      process.env[key] = value;
    }
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

  it('plan dnia dla pary: kcal dnia na karcie = bilans pytającego po zapisie (także przy porcjach dobranych przez planer)', async () => {
    // Wysokie cele → planer w trybie `tune` ma powód dać parze 3 porcje
    // zamiast 2 (1,5 talerza na osobę).
    const home = await household('KartaBilans', [3200, 3200]);
    const result = await run(home, 'build_meal_plan', {
      week_start: WEEK_START,
      days: ['THU'],
      meal_types: [],
      for_user_ids: [],
      diet: 'NONE',
      must_have_tags: [],
      prefer_tags: [],
      avoid_ingredients: [],
      max_prep_minutes: 0,
      day_kcal_target: 0,
    });
    expect(result.ok).toBe(true);
    const data = (result as { data: { proposalId?: string } }).data;
    expect(data.proposalId).toBeDefined();
    const proposal = await pinToMessage(home, data.proposalId!);
    const slots = (
      proposal.action as {
        slots: {
          dayOfWeek: string;
          plannedServings?: number;
          portions?: unknown[];
        }[];
      }
    ).slots.filter((slot) => slot.dayOfWeek === 'THU');
    expect(slots.length).toBeGreaterThan(0);
    // Flaga OFF: bez alokacji (to sprawdza już regression-6-1 g8).
    expect(slots.every((slot) => !slot.portions)).toBe(true);
    const tuned = slots.filter(
      (slot) =>
        slot.plannedServings !== undefined && slot.plannedServings !== 2,
    );

    const card = proposal.card as {
      kind: string;
      summary?: { kcalTotal: number };
      days?: { dayOfWeek: string; kcalTotal: number }[];
    };
    const cardKcal =
      card.kind === 'PLAN_DAY'
        ? card.summary!.kcalTotal
        : card.days!.find((d) => d.dayOfWeek === 'THU')!.kcalTotal;

    await request(app.getHttpServer())
      .post(`/agent/proposals/${data.proposalId}/apply`)
      .set(auth(home.session.accessToken))
      .send({})
      .expect(200);
    const persisted = await dayKcal(home, home.userId, 'THU');

    // Diagnostyka dla przeglądu: ile pozycji planer „dostroił”.
    console.log(
      `[N5] porcje: ${slots.map((s) => s.plannedServings ?? '-').join(',')} (dostrojone: ${tuned.length}); karta ${cardKcal} kcal, bilans ${Math.round(persisted)} kcal`,
    );
    // ±5 kcal na posiłek zaokrąglenia.
    expect(Math.abs(persisted - cardKcal)).toBeLessThanOrEqual(
      5 * slots.length,
    );
  });
});
