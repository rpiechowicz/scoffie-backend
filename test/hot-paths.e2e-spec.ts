import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ShoppingListService } from '../src/weekly-plans/services/shopping-list.service';
import { WeeklyPlansService } from '../src/weekly-plans/weekly-plans.service';
import { AgentTurnsService } from '../src/agent/agent-turns.service';
import { AgentToolExecutor } from '../src/agent/tools/agent-tool-executor';
import { AgentPromptService } from '../src/agent/agent-prompt.service';
import { RecipesService } from '../src/recipes/recipes.service';
import { AppException } from '../src/common/app-exception';

/**
 * Gorące ścieżki po Etapie 4 na żywej bazie: przebudowa listy zakupów przy
 * równoległych odczytach, koszt jednego odpytania tury, karta kilku dań bez
 * N+1.
 */
const WEEK_START = '2026-08-31';

describe('Gorące ścieżki E2E (Etap 4)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let shopping: ShoppingListService;
  let weeklyPlans: WeeklyPlansService;
  let turns: AgentTurnsService;
  let tools: AgentToolExecutor;
  let prompts: AgentPromptService;
  let recipes: RecipesService;
  const userIds: string[] = [];
  const householdIds: string[] = [];
  const ENV = ['AI_ENABLED', 'AI_PROVIDER', 'AI_TIER_OVERRIDE'] as const;
  const original: Record<string, string | undefined> = {};

  const home = async (label: string) => {
    const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
    const users = await Promise.all(
      [0, 1].map((k) =>
        prisma.user.create({
          data: {
            displayName: `${label} ${k} ${stamp}`,
            email: `hot-${k}-${stamp}@hot.local`,
            authProvider: 'DEV',
          },
          select: { id: true },
        }),
      ),
    );
    userIds.push(...users.map((u) => u.id));
    const household = await prisma.household.create({
      data: { name: `${label} ${stamp}`, createdById: users[0].id },
      select: { id: true },
    });
    householdIds.push(household.id);
    await prisma.membership.createMany({
      data: users.map((u, k) => ({
        userId: u.id,
        householdId: household.id,
        role: k === 0 ? ('OWNER' as const) : ('MEMBER' as const),
      })),
    });
    return {
      owner: users[0].id,
      member: users[1].id,
      householdId: household.id,
    };
  };

  const dinners = (take: number) =>
    prisma.recipe.findMany({
      where: {
        isCatalog: true,
        isActive: true,
        ingredients: { some: {} },
        OR: [
          { suitableMealTypes: { has: 'DINNER' } },
          { mealType: 'DINNER', suitableMealTypes: { isEmpty: true } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take,
    });

  beforeAll(async () => {
    for (const key of ENV) original[key] = process.env[key];
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    process.env.AI_TIER_OVERRIDE = 'PRO';
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    shopping = moduleRef.get(ShoppingListService);
    weeklyPlans = moduleRef.get(WeeklyPlansService);
    turns = moduleRef.get(AgentTurnsService);
    tools = moduleRef.get(AgentToolExecutor);
    prompts = moduleRef.get(AgentPromptService);
    recipes = moduleRef.get(RecipesService);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    for (const key of ENV) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await moduleRef.close();
  });

  it('20 równoległych odczytów NIEAKTUALNEJ listy zakupów → najwyżej jedna przebudowa', async () => {
    const { owner, member, householdId } = await home('Zakupy');
    const picked = await dinners(3);
    await weeklyPlans.applyWeekPlan(owner, householdId, WEEK_START, {
      slots: picked.map((recipe, i) => ({
        dayOfWeek: (['MON', 'TUE', 'WED'] as const)[i],
        mealType: 'DINNER' as const,
        recipeId: recipe.id,
      })),
    });
    const first = await shopping.getShoppingListState(
      owner,
      householdId,
      WEEK_START,
    );
    expect(first.items.length).toBeGreaterThan(0);
    await prisma.shoppingList.updateMany({
      where: { householdId },
      data: { isStale: true },
    });

    const proto = Object.getPrototypeOf(shopping) as Record<string, unknown>;
    const rebuild = jest.spyOn(
      proto as { rebuildShoppingListSnapshot: () => Promise<unknown> },
      'rebuildShoppingListSnapshot',
    );
    const states = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        shopping.getShoppingListState(
          i % 2 ? owner : member,
          householdId,
          WEEK_START,
        ),
      ),
    );
    expect(rebuild).toHaveBeenCalledTimes(1);
    for (const state of states) {
      expect(state.items.map((item) => item.productKey).sort()).toEqual(
        first.items.map((item) => item.productKey).sort(),
      );
    }
    // Lista znowu świeża: kolejny odczyt nic nie przebudowuje.
    await shopping.getShoppingListState(owner, householdId, WEEK_START);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('getTurn RUNNING = jedno zapytanie (bez rozmowy i członkostwa); po wyjściu z domu 404', async () => {
    const { owner, householdId } = await home('Tura');
    const conversation = await prisma.agentConversation.create({
      data: { userId: owner, householdId },
    });
    const question = await prisma.agentMessage.create({
      data: { conversationId: conversation.id, role: 'USER', text: 'hej' },
    });
    const turn = await prisma.agentTurn.create({
      data: {
        conversationId: conversation.id,
        userId: owner,
        userMessageId: question.id,
        requestId: `hot-${randomUUID()}`,
        draftText: 'Piszę…',
      },
    });
    const findFirst = jest.spyOn(prisma.agentTurn, 'findFirst');
    const membership = jest.spyOn(prisma.membership, 'findUnique');
    const conversationRead = jest.spyOn(prisma.agentConversation, 'findUnique');
    const view = await turns.getTurn(owner, turn.id);
    expect(view.status).toBe('RUNNING');
    expect(view.draftText).toBe('Piszę…');
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(membership).not.toHaveBeenCalled();
    expect(conversationRead).not.toHaveBeenCalled();

    await prisma.membership.deleteMany({
      where: { userId: owner, householdId },
    });
    await expect(turns.getTurn(owner, turn.id)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_TURN_NOT_FOUND' }),
    });
    await expect(turns.getTurn(owner, turn.id)).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it('karta z 3 daniami: jeden odczyt stron dań, bez findById na danie', async () => {
    const { owner, householdId } = await home('Karta');
    const prompt = await prompts.build(
      owner,
      householdId,
      {
        weekStart: WEEK_START,
        clientToday: WEEK_START,
        timeZone: 'Europe/Warsaw',
      },
      true,
    );
    const refById = new Map(
      Object.entries(prompt.catalogIndex).map(([ref, id]) => [id, ref]),
    );
    const picked = await dinners(3);
    const findById = jest.spyOn(recipes, 'findById');
    const cardSides = jest.spyOn(recipes, 'cardSides');
    const recipeReads = jest.spyOn(prisma.recipe, 'findMany');
    const cards: { options?: { recipeId: string }[] }[] = [];
    const result = await tools.execute(
      'offer_options',
      {
        title: 'Do wyboru',
        slot_label: 'Kolacja · środa',
        options: picked.map((recipe) => ({
          recipe: refById.get(recipe.id) ?? recipe.id,
        })),
      },
      {
        userId: owner,
        householdId,
        catalogIndex: prompt.catalogIndex,
        conversationId: randomUUID(),
        turnId: randomUUID(),
        proposalMode: true,
        collectCard: (card) => cards.push(card as never),
      },
    );
    expect(result.ok).toBe(true);
    expect(findById).not.toHaveBeenCalled();
    expect(cardSides).toHaveBeenCalledTimes(1);
    expect(recipeReads).toHaveBeenCalledTimes(1);
    // Kolejność kafelków = kolejność wejścia.
    expect(cards[0].options?.map((option) => option.recipeId)).toEqual(
      picked.map((recipe) => recipe.id),
    );
  });
});
