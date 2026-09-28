import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AgentToolContext,
  AgentToolExecutor,
} from '../src/agent/tools/agent-tool-executor';
import { createTurnMemo } from '../src/agent/turn-memo';

/**
 * N4-1 (noc 26/27.09, decyzja nocy 27/28.09 — do akceptacji): podmiana dania
 * w propozycji, w której slot ma uczestnika, który NIE jest już domownikiem.
 *
 * `onMemberLeft` czyści uczestnictwo w zapisanym planie, ale propozycja
 * PENDING (TTL 72 h) trzyma stary skład. Przed poprawką `normalizeParticipants`
 * liczył obcego jak domownika: dom {A, B}, slot [A, X] → 2 ≥ 2 → „Wspólne”,
 * czyli danie A podmieniało się jako danie całego domu. Teraz narzędzie
 * odmawia i mówi, że propozycja jest nieaktualna — tak samo jak build/suggest
 * odmawiają obcych `for_user_ids`.
 */
const WEEK_START = '2026-10-12';
jest.setTimeout(120_000);

describe('replace_plan_item — uczestnik spoza domu w propozycji (N4-1)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let executor: AgentToolExecutor;
  const users: string[] = [];
  const households: string[] = [];
  const original: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [key, value] of Object.entries({
      AI_CONSENT_REQUIRED: 'false',
      AI_TIER_OVERRIDE: 'PRO',
      AI_PLANNER_PER_USER_PORTIONS: 'false',
    })) {
      original[key] = process.env[key];
      process.env[key] = value;
    }
    original.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    executor = moduleRef.get(AgentToolExecutor);
  });

  afterAll(async () => {
    await prisma.household.deleteMany({ where: { id: { in: households } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await moduleRef.close();
  });

  const user = async (label: string) => {
    const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
    const created = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `n41-${label}-${stamp}@offline.local`,
        authProvider: 'DEV',
        preferences: { create: { calorieGoal: 2000 } },
      },
      select: { id: true },
    });
    users.push(created.id);
    return created.id;
  };

  it('slot propozycji z byłym domownikiem → odmowa „propozycja nieaktualna”, bez nowej propozycji', async () => {
    const a = await user('a');
    const b = await user('b');
    const departed = await user('byly');
    const household = await prisma.household.create({
      data: { name: `Dom N4-1 ${randomUUID().slice(0, 6)}`, createdById: a },
      select: { id: true },
    });
    households.push(household.id);
    await prisma.membership.createMany({
      data: [
        { userId: a, householdId: household.id, role: 'OWNER' },
        { userId: b, householdId: household.id, role: 'MEMBER' },
      ],
    });
    const conversation = await prisma.agentConversation.create({
      data: { userId: a, householdId: household.id },
    });
    const context = (): AgentToolContext => ({
      userId: a,
      householdId: household.id,
      catalogIndex: {},
      conversationId: conversation.id,
      turnId: randomUUID(),
      proposalMode: true,
      dates: { weekStart: WEEK_START, clientToday: WEEK_START },
      collectCard: () => undefined,
      memo: createTurnMemo(),
    });

    const built = await executor.execute(
      'build_meal_plan',
      {
        week_start: WEEK_START,
        days: ['WED'],
        meal_types: [],
        for_user_ids: [],
        diet: 'NONE',
        must_have_tags: [],
        prefer_tags: [],
        avoid_ingredients: [],
        max_prep_minutes: 0,
        day_kcal_target: 0,
      },
      context(),
    );
    expect(built.ok).toBe(true);
    const proposalId = built.ok
      ? (built.data as { proposalId?: string }).proposalId
      : undefined;
    expect(proposalId).toBeDefined();

    // Stary skład w propozycji: kolacja dla A i osoby, która odeszła z domu.
    const proposal = await prisma.agentProposal.findUniqueOrThrow({
      where: { id: proposalId },
      select: { action: true },
    });
    const action = proposal.action as {
      slots: {
        dayOfWeek: string;
        mealType: string;
        participantIds?: string[];
      }[];
    };
    const dinner = action.slots.find(
      (slot) => slot.dayOfWeek === 'WED' && slot.mealType === 'DINNER',
    );
    expect(dinner).toBeDefined();
    dinner!.participantIds = [a, departed];
    await prisma.agentProposal.update({
      where: { id: proposalId },
      data: { action: action as never },
    });
    const before = await prisma.agentProposal.count({
      where: { conversationId: conversation.id },
    });

    const replaced = await executor.execute(
      'replace_plan_item',
      {
        week_start: WEEK_START,
        day_of_week: 'WED',
        meal_type: 'DINNER',
        proposal_id: proposalId,
        similar_kcal: false,
        diet: 'NONE',
        must_have_tags: [],
        prefer_tags: [],
        avoid_ingredients: [],
        max_prep_minutes: 0,
      },
      context(),
    );

    expect(replaced.ok).toBe(false);
    if (replaced.ok) return;
    expect(replaced.error.code).toBe('VALIDATION_ERROR');
    expect(replaced.error.message).toMatch(/nie należą już do domu/);
    // Identyfikatory byłego domownika nie idą do modelu.
    expect(JSON.stringify(replaced.error)).not.toContain(departed);
    expect(
      await prisma.agentProposal.count({
        where: { conversationId: conversation.id },
      }),
    ).toBe(before);
  });
});
