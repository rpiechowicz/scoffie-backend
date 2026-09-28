import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AgentToolContext,
  AgentToolExecutor,
} from '../src/agent/tools/agent-tool-executor';
import { AgentCard } from '../src/agent/cards/agent-cards';
import { createTurnMemo } from '../src/agent/turn-memo';

/**
 * „Z rybą” / „bez ryby” w narzędziach asystenta (noc 27/28.09, M12).
 *
 * Składniki w katalogu to gatunki (łosoś, dorsz), więc słowo-kategoria po
 * nazwie nie trafiało niczego: `suggest_meals` z `include_ingredients:
 * ["ryba"]` oddawał „za mało dań” przy 15 kolacjach rybnych w katalogu,
 * a „bez ryby” niczego nie wykluczało. Kategoria idzie teraz po tagu diety.
 */
const WEEK_START = '2026-10-12';
jest.setTimeout(120_000);

describe('kategorie składników w narzędziach asystenta (M12)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let executor: AgentToolExecutor;
  let who: { userId: string; householdId: string; conversationId: string };
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

    const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
    const user = await prisma.user.create({
      data: {
        displayName: `Kategorie ${stamp}`,
        email: `m12-${stamp}@offline.local`,
        authProvider: 'DEV',
        preferences: { create: { calorieGoal: 2000 } },
      },
      select: { id: true },
    });
    const household = await prisma.household.create({
      data: { name: `Dom M12 ${stamp}`, createdById: user.id },
      select: { id: true },
    });
    await prisma.membership.create({
      data: { userId: user.id, householdId: household.id, role: 'OWNER' },
    });
    const conversation = await prisma.agentConversation.create({
      data: { userId: user.id, householdId: household.id },
    });
    who = {
      userId: user.id,
      householdId: household.id,
      conversationId: conversation.id,
    };
  });

  afterAll(async () => {
    await prisma.household.deleteMany({ where: { id: who.householdId } });
    await prisma.user.deleteMany({ where: { id: who.userId } });
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await moduleRef.close();
  });

  const context = (cards: AgentCard[]): AgentToolContext => ({
    ...who,
    catalogIndex: {},
    turnId: randomUUID(),
    proposalMode: true,
    dates: { weekStart: WEEK_START, clientToday: WEEK_START },
    collectCard: (card) => cards.push(card),
    memo: createTurnMemo(),
  });

  const suggest = (extra: Record<string, unknown>) => ({
    week_start: WEEK_START,
    day_of_week: 'FRI',
    meal_type: 'DINNER',
    count: 3,
    include_ingredients: [],
    for_user_ids: [],
    diet: 'NONE',
    must_have_tags: [],
    prefer_tags: [],
    avoid_ingredients: [],
    max_prep_minutes: 0,
    ...extra,
  });

  const optionRecipeIds = (cards: AgentCard[]) =>
    (cards[0] as unknown as { options: { recipeId: string }[] }).options.map(
      (option) => option.recipeId,
    );

  it('suggest_meals „z rybą” → karta z samymi daniami rybnymi', async () => {
    const cards: AgentCard[] = [];
    const result = await executor.execute(
      'suggest_meals',
      suggest({ include_ingredients: ['ryba'] }),
      context(cards),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.endsTurn).toBe(true);
    const ids = optionRecipeIds(cards);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const tagged = await prisma.recipe.findMany({
      where: { id: { in: ids } },
      select: { dietTags: true },
    });
    expect(tagged.every((recipe) => recipe.dietTags.includes('FISH'))).toBe(
      true,
    );
  });

  it('suggest_meals „bez ryby” → żadnego dania rybnego w karcie', async () => {
    const cards: AgentCard[] = [];
    const result = await executor.execute(
      'suggest_meals',
      suggest({ avoid_ingredients: ['ryby'], count: 4 }),
      context(cards),
    );
    expect(result.ok && result.endsTurn).toBe(true);
    const tagged = await prisma.recipe.findMany({
      where: { id: { in: optionRecipeIds(cards) } },
      select: { dietTags: true },
    });
    expect(tagged.length).toBeGreaterThanOrEqual(2);
    expect(tagged.some((recipe) => recipe.dietTags.includes('FISH'))).toBe(
      false,
    );
  });
});
