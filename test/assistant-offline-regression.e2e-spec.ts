import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AgentToolContext,
  AgentToolExecutor,
  AgentToolResult,
} from '../src/agent/tools/agent-tool-executor';
import {
  AGENT_TOOLS,
  AgentToolDefinition,
  INTERNAL_AGENT_TOOLS,
  START_PLANNING_TOOL,
} from '../src/agent/tools/agent-tools';
import { AgentCard } from '../src/agent/cards/agent-cards';
import { createTurnMemo } from '../src/agent/turn-memo';

/**
 * Regresja asystenta OFFLINE — reguły ogólne (noc 26/27.09, N6).
 *
 * Bez modelu i bez klucza API: narzędzia wołane tak, jak woła je runner
 * (`AgentToolExecutor.execute`). Przypadki nie są literalnymi promptami
 * z benchmarku — to kontrakty, które muszą trzymać się dla KAŻDEGO wywołania:
 *
 * - HARNESS/FAILURE: każde narzędzie ze schematu modelu, zawołane z wejściem
 *   pustym, złych typów, bezsensownym albo za dużym, oddaje DANE (nigdy
 *   wyjątek), a przy odmowie — kod inny niż `INTERNAL_ERROR` (to byłby nasz
 *   błąd parsowania) i niczego nie zapisuje;
 * - SAFETY/BOUNDARY: referencje do cudzego domu nie działają i nie wyciekają;
 * - UX CONTRACT: jedna karta na turę, odmowa zwalnia rezerwację;
 * - FAILURE REASONS: niespełnialna prośba mówi DLACZEGO, zamiast milczeć.
 */
const WEEK_START = '2026-10-12';

jest.setTimeout(120_000);

type Variant = 'empty' | 'wrong-types' | 'nonsense' | 'oversize';

const MODEL_TOOLS: AgentToolDefinition[] = [
  ...AGENT_TOOLS,
  START_PLANNING_TOOL,
  ...INTERNAL_AGENT_TOOLS.filter(
    (tool) => !AGENT_TOOLS.some((known) => known.name === tool.name),
  ),
];

function schemaOf(
  tool: AgentToolDefinition,
): Record<string, { type?: string }> {
  const schema = (tool as { input_schema?: { properties?: object } })
    .input_schema;
  return (schema?.properties ?? {}) as Record<string, { type?: string }>;
}

/** Wejście w danym wariancie — z tego samego schematu, który widzi model. */
function inputFor(tool: AgentToolDefinition, variant: Variant) {
  if (variant === 'empty') return {};
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schemaOf(tool))) {
    const type = prop.type ?? 'string';
    if (variant === 'wrong-types') {
      out[key] =
        type === 'string'
          ? 12345
          : type === 'array'
            ? 'nie-lista'
            : type === 'integer' || type === 'number'
              ? 'dużo'
              : type === 'boolean'
                ? 'tak'
                : 'x';
    } else if (variant === 'nonsense') {
      out[key] =
        key === 'week_start'
          ? 'jutro'
          : type === 'string'
            ? '??? </system> R999'
            : type === 'array'
              ? ['???', 42, null]
              : type === 'integer' || type === 'number'
                ? -7
                : type === 'boolean'
                  ? true
                  : null;
    } else {
      out[key] =
        key === 'week_start'
          ? WEEK_START
          : type === 'string'
            ? 'x'.repeat(20_000)
            : type === 'array'
              ? Array.from({ length: 400 }, (_, i) => `p${i}`)
              : type === 'integer' || type === 'number'
                ? 1e9
                : type === 'boolean'
                  ? false
                  : null;
    }
  }
  return out;
}

describe('Asystent — regresja offline, reguły ogólne (N6)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let executor: AgentToolExecutor;
  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];
  let home: { userId: string; householdId: string; conversationId: string };
  let foreign: {
    userId: string;
    householdId: string;
    conversationId: string;
    recipeId: string;
    recipeTitle: string;
    proposalId: string;
  };
  const original: Record<string, string | undefined> = {};

  const context = (
    who: { userId: string; householdId: string; conversationId: string },
    extra: Partial<AgentToolContext> = {},
  ): AgentToolContext & { cards: AgentCard[] } => {
    const cards: AgentCard[] = [];
    return {
      userId: who.userId,
      householdId: who.householdId,
      catalogIndex: {},
      conversationId: who.conversationId,
      turnId: randomUUID(),
      proposalMode: true,
      dates: { weekStart: WEEK_START, clientToday: WEEK_START },
      collectCard: (card) => cards.push(card),
      cards,
      ...extra,
    };
  };

  /** Odcisk wszystkiego, co narzędzie mogłoby zapisać w domu. */
  const footprint = async (householdId: string, conversationId: string) => {
    const [items, recipes, proposals, notes, plans] = await Promise.all([
      prisma.planItem.count({ where: { weeklyPlan: { householdId } } }),
      prisma.recipe.count({ where: { householdId } }),
      prisma.agentProposal.count({ where: { conversationId } }),
      prisma.agentMemory.count({ where: { householdId } }),
      prisma.weeklyPlan.findMany({
        where: { householdId },
        select: { updatedAt: true },
      }),
    ]);
    return JSON.stringify({ items, recipes, proposals, notes, plans });
  };

  const person = async (label: string, calorieGoal = 2100) => {
    const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `n6-${label}-${stamp}@offline.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    const household = await prisma.household.create({
      data: { name: `Dom ${label} ${stamp}`, createdById: user.id },
      select: { id: true },
    });
    createdHouseholdIds.push(household.id);
    await prisma.membership.create({
      data: { userId: user.id, householdId: household.id, role: 'OWNER' },
    });
    await prisma.userPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, calorieGoal },
      update: { calorieGoal },
    });
    const conversation = await prisma.agentConversation.create({
      data: { userId: user.id, householdId: household.id },
    });
    return {
      userId: user.id,
      householdId: household.id,
      conversationId: conversation.id,
    };
  };

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

    home = await person('dom');
    // Plan w tygodniu — żeby narzędzia czytające plan miały co czytać.
    const dinner = await prisma.recipe.findFirstOrThrow({
      where: {
        isCatalog: true,
        isActive: true,
        suitableMealTypes: { has: 'DINNER' },
        allergens: { isEmpty: true },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    const seeded = await executor.execute(
      'apply_week_plan',
      {
        week_start: WEEK_START,
        dry_run: false,
        slots: [{ day_of_week: 'MON', meal_type: 'DINNER', recipe: dinner.id }],
      },
      context(home, { proposalMode: false }),
    );
    expect(seeded.ok).toBe(true);

    const other = await person('obcy');
    const title = `Tajny przepis ${randomUUID().slice(0, 8)}`;
    const recipe = await prisma.recipe.create({
      data: {
        title,
        mealType: 'DINNER',
        suitableMealTypes: ['DINNER'],
        isCatalog: false,
        isActive: true,
        authorId: other.userId,
        householdId: other.householdId,
        nutritionKcal: 900,
        servings: 2,
      },
      select: { id: true },
    });
    const proposal = await executor.execute(
      'propose_swap',
      {
        week_start: WEEK_START,
        day_of_week: 'TUE',
        meal_type: 'DINNER',
        recipe: dinner.id,
        reason: 'test',
        participant_user_ids: [],
      },
      context(other),
    );
    const proposalId =
      (proposal.ok &&
        (proposal.data as { proposalId?: string } | null)?.proposalId) ||
      (
        await prisma.agentProposal.create({
          data: {
            conversationId: other.conversationId,
            turnId: randomUUID(),
            userId: other.userId,
            householdId: other.householdId,
            kind: 'WEEK_PLAN',
            weekStart: new Date(`${WEEK_START}T00:00:00.000Z`),
            action: { slots: [] },
            card: {},
            baselineHash: 'x',
            expiresAt: new Date(Date.now() + 3_600_000),
          },
          select: { id: true },
        })
      ).id;
    foreign = {
      ...other,
      recipeId: recipe.id,
      recipeTitle: title,
      proposalId,
    };
  });

  afterAll(async () => {
    await prisma.recipe.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await moduleRef.close();
  });

  // ── HARNESS / FAILURE: każde narzędzie × zniekształcone wejście ─────────
  const matrix = MODEL_TOOLS.flatMap((tool) =>
    (['empty', 'wrong-types', 'nonsense', 'oversize'] as Variant[]).map(
      (variant) => [tool.name, variant, tool] as const,
    ),
  );

  describe('HARNESS: zniekształcone wejście → dane, bez wyjątku i bez zapisu', () => {
    it.each(matrix)('%s / %s', async (_name, variant, tool) => {
      const before = await footprint(home.householdId, home.conversationId);
      const ctx = context(home, { memo: createTurnMemo() });
      let result: AgentToolResult | undefined;
      await expect(
        (async () => {
          result = await executor.execute(
            tool.name,
            inputFor(tool, variant),
            ctx,
          );
        })(),
      ).resolves.toBeUndefined();
      expect(typeof result!.ok).toBe('boolean');
      if (!result!.ok) {
        expect(result!.error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
        expect(result!.error.message.length).toBeGreaterThan(0);
        // INTERNAL_ERROR = wyjątek spoza domeny (TypeError przy parsowaniu).
        expect(result!.error.code).not.toBe('INTERNAL_ERROR');
      }
      // Wejście zniekształcone nie zapisuje niczego — ani planu, ani przepisu,
      // ani propozycji, ani notatki.
      expect(await footprint(home.householdId, home.conversationId)).toBe(
        before,
      );
      // Wynik dla modelu nie niesie surowego znacznika z wejścia.
      expect(JSON.stringify(result)).not.toContain('</system>');
    });
  });

  // ── SAFETY / BOUNDARY: cudzy dom ────────────────────────────────────────
  describe('BOUNDARY: referencje do cudzego domu', () => {
    const leaks = (result: AgentToolResult) =>
      JSON.stringify(result).includes(foreign.recipeTitle);

    it('get_recipe_details: cudzy prywatny przepis = nie znaleziono, bez tytułu', async () => {
      const result = await executor.execute(
        'get_recipe_details',
        { recipe: foreign.recipeId },
        context(home),
      );
      expect(result.ok).toBe(false);
      expect(leaks(result)).toBe(false);
    });

    it('update_recipe: cudzego przepisu nie da się zmienić', async () => {
      const result = await executor.execute(
        'update_recipe',
        { recipe_id: foreign.recipeId, title: 'Przejęty' },
        context(home),
      );
      expect(
        result.ok && (result.data as { updated?: boolean })?.updated,
      ).not.toBe(true);
      const row = await prisma.recipe.findUniqueOrThrow({
        where: { id: foreign.recipeId },
      });
      expect(row.title).toBe(foreign.recipeTitle);
      expect(leaks(result)).toBe(false);
    });

    it.each(['propose_swap', 'propose_household_split'])(
      '%s: cudzy przepis nie trafia do propozycji',
      async (tool) => {
        const before = await footprint(home.householdId, home.conversationId);
        const result = await executor.execute(
          tool,
          {
            week_start: WEEK_START,
            day_of_week: 'MON',
            meal_type: 'DINNER',
            recipe: foreign.recipeId,
            reason: 'x',
            participant_user_ids: [],
            portions: [],
          },
          context(home),
        );
        expect(
          result.ok && (result.data as { proposed?: boolean })?.proposed,
        ).not.toBe(true);
        expect(leaks(result)).toBe(false);
        expect(await footprint(home.householdId, home.conversationId)).toBe(
          before,
        );
      },
    );

    it('propose_week_plan: slot z cudzym przepisem = naruszenie, bez propozycji', async () => {
      const before = await footprint(home.householdId, home.conversationId);
      const result = await executor.execute(
        'propose_week_plan',
        {
          week_start: WEEK_START,
          slots: [
            {
              day_of_week: 'WED',
              meal_type: 'DINNER',
              recipe: foreign.recipeId,
            },
          ],
        },
        context(home),
      );
      expect(
        result.ok && (result.data as { proposed?: boolean })?.proposed,
      ).not.toBe(true);
      expect(leaks(result)).toBe(false);
      expect(await footprint(home.householdId, home.conversationId)).toBe(
        before,
      );
    });

    it.each(['revise_proposal', 'replace_plan_item'])(
      '%s: cudza propozycja wygląda jak nieistniejąca',
      async (tool) => {
        const input =
          tool === 'revise_proposal'
            ? {
                proposal_id: foreign.proposalId,
                day_of_week: 'TUE',
                meal_type: 'DINNER',
                recipe: foreign.recipeId,
              }
            : {
                week_start: WEEK_START,
                day_of_week: 'TUE',
                meal_type: 'DINNER',
                proposal_id: foreign.proposalId,
                similar_kcal: false,
                diet: 'NONE',
                must_have_tags: [],
                prefer_tags: [],
                avoid_ingredients: [],
                max_prep_minutes: 0,
              };
        const foreignBefore = await footprint(
          foreign.householdId,
          foreign.conversationId,
        );
        const mine = await executor.execute(tool, input, context(home));
        const missing = await executor.execute(
          tool,
          { ...input, proposal_id: randomUUID() },
          context(home),
        );
        expect(mine.ok).toBe(false);
        expect(missing.ok).toBe(false);
        // Ta sama odpowiedź dla cudzej i nieistniejącej — bez wyroczni istnienia.
        expect(!mine.ok && mine.error.code).toBe(
          !missing.ok && missing.error.code,
        );
        expect(leaks(mine)).toBe(false);
        expect(
          await footprint(foreign.householdId, foreign.conversationId),
        ).toBe(foreignBefore);
      },
    );

    it('get_week_balance: obcy „domownik” = odmowa, nie cudzy bilans', async () => {
      const result = await executor.execute(
        'get_week_balance',
        { week_start: WEEK_START, member_user_id: foreign.userId },
        context(home),
      );
      expect(result.ok).toBe(false);
    });

    it.each(['suggest_meals', 'build_meal_plan'])(
      '%s: for_user_ids z obcą osobą = odmowa, nie plan dla cudzej osoby',
      async (tool) => {
        const before = await footprint(home.householdId, home.conversationId);
        const result = await executor.execute(
          tool,
          {
            week_start: WEEK_START,
            day_of_week: 'WED',
            meal_type: 'DINNER',
            count: 3,
            days: ['WED'],
            meal_types: ['DINNER'],
            include_ingredients: [],
            for_user_ids: [foreign.userId],
            diet: 'NONE',
            must_have_tags: [],
            prefer_tags: [],
            avoid_ingredients: [],
            max_prep_minutes: 0,
            day_kcal_target: 0,
          },
          context(home),
        );
        expect(result.ok).toBe(false);
        expect(await footprint(home.householdId, home.conversationId)).toBe(
          before,
        );
      },
    );
  });

  // ── UX CONTRACT: jedna karta na turę ────────────────────────────────────
  describe('UX: jedna karta na turę', () => {
    const suggest = {
      week_start: WEEK_START,
      day_of_week: 'THU',
      meal_type: 'DINNER',
      count: 3,
      include_ingredients: [],
      for_user_ids: [],
      diet: 'NONE',
      must_have_tags: [],
      prefer_tags: [],
      avoid_ingredients: [],
      max_prep_minutes: 0,
    };
    const question = {
      question: 'Na ile osób?',
      options: ['dwie', 'cztery'],
    };

    it('druga karta w tej samej turze = AI_ONE_CARD_PER_TURN, jedna karta w odpowiedzi', async () => {
      const ctx = context(home, { memo: createTurnMemo() });
      const first = await executor.execute('suggest_meals', suggest, ctx);
      expect(first.ok && first.endsTurn).toBe(true);
      expect(first.ok && first.turnText).toBeTruthy();
      const second = await executor.execute(
        'ask_clarifying_question',
        question,
        ctx,
      );
      expect(!second.ok && second.error.code).toBe('AI_ONE_CARD_PER_TURN');
      expect(ctx.cards).toHaveLength(1);
    });

    it('odmowa karty zwalnia rezerwację — następna karta w turze przechodzi', async () => {
      const ctx = context(home, { memo: createTurnMemo() });
      const refused = await executor.execute(
        'ask_clarifying_question',
        { question: 'x', options: [] },
        ctx,
      );
      expect(refused.ok).toBe(false);
      const next = await executor.execute('suggest_meals', suggest, ctx);
      expect(next.ok && next.endsTurn).toBe(true);
      expect(ctx.cards).toHaveLength(1);
    });

    it('dwie karty wołane RÓWNOLEGLE w jednej rundzie — wygrywa dokładnie jedna', async () => {
      const ctx = context(home, { memo: createTurnMemo() });
      const results = await Promise.all([
        executor.execute('suggest_meals', suggest, ctx),
        executor.execute('ask_clarifying_question', question, ctx),
      ]);
      const winners = results.filter((r) => r.ok && r.endsTurn);
      expect(winners).toHaveLength(1);
      expect(ctx.cards).toHaveLength(1);
    });

    it('narzędzie do odczytu nie zajmuje miejsca karty', async () => {
      const ctx = context(home, { memo: createTurnMemo() });
      const read = await executor.execute(
        'get_week_plan',
        { week_start: WEEK_START },
        ctx,
      );
      expect(read.ok).toBe(true);
      expect(read.ok && read.endsTurn).toBeFalsy();
      const card = await executor.execute('suggest_meals', suggest, ctx);
      expect(card.ok && card.endsTurn).toBe(true);
    });
  });

  // ── FAILURE REASONS: niespełnialna prośba mówi dlaczego ────────────────
  describe('FAILURE REASONS', () => {
    const base = {
      week_start: WEEK_START,
      days: ['FRI'],
      meal_types: ['DINNER'],
      for_user_ids: [],
      diet: 'NONE',
      must_have_tags: [],
      prefer_tags: [],
      avoid_ingredients: [],
      max_prep_minutes: 0,
      day_kcal_target: 0,
    };
    const text = (result: AgentToolResult) =>
      JSON.stringify(result.ok ? result.data : result.error);

    it('twardy limit czasu nie do spełnienia → brak propozycji z powodem „czas”', async () => {
      const before = await footprint(home.householdId, home.conversationId);
      const result = await executor.execute(
        'build_meal_plan',
        { ...base, max_prep_minutes: 1 },
        context(home),
      );
      expect(text(result)).toMatch(/PREP_TIME|czas/i);
      expect(
        result.ok && (result.data as { proposed?: boolean })?.proposed,
      ).not.toBe(true);
      expect(await footprint(home.householdId, home.conversationId)).toBe(
        before,
      );
    });

    it('nieznany wymagany tag → jawny błąd z kodem, nie pusta karta', async () => {
      const result = await executor.execute(
        'build_meal_plan',
        { ...base, must_have_tags: ['nie-ma-takiego-tagu'] },
        context(home),
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.message.length).toBeGreaterThan(0);
    });

    // N6-1 (noc 26/27.09): `suggest_meals` przy UNSAT oddawało ogólne
    // „Zdejmij jedno życzenie”, bez powodu. Poprawka (noc 27/28.09) jest za
    // `AI_PARTIAL_SERVER_TEXT` — zmienia wynik widziany przez model, więc
    // włączenie czeka na live smoke. Oba stany flagi są przypięte.
    const unsatisfiable = {
      week_start: WEEK_START,
      day_of_week: 'FRI',
      meal_type: 'DINNER',
      count: 3,
      include_ingredients: [],
      for_user_ids: [],
      diet: 'VEGAN',
      must_have_tags: ['poultry'],
      prefer_tags: [],
      avoid_ingredients: [],
      max_prep_minutes: 0,
    };
    const withPartialServerText = async <T>(
      value: 'true' | undefined,
      run: () => Promise<T>,
    ): Promise<T> => {
      const previous = process.env.AI_PARTIAL_SERVER_TEXT;
      if (value) process.env.AI_PARTIAL_SERVER_TEXT = value;
      else delete process.env.AI_PARTIAL_SERVER_TEXT;
      try {
        return await run();
      } finally {
        if (previous === undefined) delete process.env.AI_PARTIAL_SERVER_TEXT;
        else process.env.AI_PARTIAL_SERVER_TEXT = previous;
      }
    };

    it('N6-1 (AI_PARTIAL_SERVER_TEXT=true): niespełnialne dania na porę → powód od serwera, koniec tury bez karty', async () => {
      const ctx = context(home, { memo: createTurnMemo() });
      const result = await withPartialServerText('true', () =>
        executor.execute('suggest_meals', unsatisfiable, ctx),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.endsTurn).toBe(true);
      expect(ctx.cards).toHaveLength(0);
      const data = result.data as {
        offered: number;
        unsatisfiable?: boolean;
        removedBy?: Record<string, number>;
      };
      expect(data.offered).toBe(0);
      expect(data.unsatisfiable).toBe(true);
      // Wegańskie danie z drobiem: pula pada na diecie prośby albo tagu.
      expect(
        (data.removedBy?.REQUEST_DIET ?? 0) +
          (data.removedBy?.REQUIRED_TAG ?? 0),
      ).toBeGreaterThan(0);
      expect(result.turnText).toMatch(
        /^Nie znalazłem co najmniej dwóch dań na kolację w piątek — najwięcej odpada przez /,
      );
      expect(result.turnText).toMatch(/dietę z prośby|wymagany rodzaj dania/);
    });

    it('N6-1 flaga wyłączona: jak przed poprawką — podpowiedź dla modelu, tura trwa', async () => {
      const ctx = context(home, { memo: createTurnMemo() });
      const result = await withPartialServerText(undefined, () =>
        executor.execute('suggest_meals', unsatisfiable, ctx),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.endsTurn).toBeFalsy();
      expect(result.turnText).toBeUndefined();
      expect(ctx.cards).toHaveLength(0);
      const data = result.data as Record<string, unknown>;
      expect(data.hint).toEqual(expect.stringContaining('Za mało dań'));
      expect(data).not.toHaveProperty('removedBy');
      expect(data).not.toHaveProperty('unsatisfiable');
    });

    // N8B S0 (noc 27/28.09): plan PARTIAL kończy turę zdaniem serwera z
    // powodami — za `AI_PARTIAL_SERVER_TEXT`. Cel 6000 kcal na jeden dzień
    // jest nieosiągalny porcjami (tune 0,75–1,5×), więc plan jest PARTIAL
    // z KCAL_OUT_OF_TOLERANCE deterministycznie.
    const partialDay = {
      ...base,
      days: ['FRI'],
      meal_types: [],
    };

    it('S0 (AI_PARTIAL_SERVER_TEXT=true): plan PARTIAL → karta + zdanie serwera z powodem, bez rundy modelu', async () => {
      const hungry = await person('glodny-on', 6000);
      const ctx = context(hungry, { memo: createTurnMemo() });
      const result = await withPartialServerText('true', () =>
        executor.execute('build_meal_plan', partialDay, ctx),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as {
        proposed?: boolean;
        planner: { status: string; issues: string[] };
      };
      expect(data.planner.status).toBe('PARTIAL');
      expect(data.proposed).not.toBe(false);
      expect(result.endsTurn).toBe(true);
      // Karta propozycji żyje w bazie (AgentProposal), nie w `collectCard`.
      expect(
        await prisma.agentProposal.count({
          where: { conversationId: hungry.conversationId },
        }),
      ).toBe(1);
      expect(result.turnText).toMatch(
        /^Plan na piątek czeka na zatwierdzenie, ale nie wszystko się udało: .*kalorie tego dnia odbiegają od celu o ponad 10 %/,
      );
      // Bez identyfikatorów i danych osób w zdaniu.
      expect(result.turnText).not.toContain(hungry.userId);
    });

    it('S0 flaga wyłączona: plan PARTIAL → karta bez zdania serwera (model tłumaczy w kolejnej rundzie)', async () => {
      const hungry = await person('glodny-off', 6000);
      const ctx = context(hungry, { memo: createTurnMemo() });
      const result = await withPartialServerText(undefined, () =>
        executor.execute('build_meal_plan', partialDay, ctx),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        (result.data as { planner: { status: string } }).planner.status,
      ).toBe('PARTIAL');
      expect(result.endsTurn).toBe(true);
      expect(result.turnText).toBeUndefined();
    });

    it('podmiana w nieistniejącym slocie planu → jawna odmowa, nie cicha propozycja', async () => {
      const before = await footprint(home.householdId, home.conversationId);
      const result = await executor.execute(
        'replace_plan_item',
        {
          week_start: WEEK_START,
          day_of_week: 'SUN',
          meal_type: 'BREAKFAST',
          proposal_id: '',
          similar_kcal: false,
          diet: 'NONE',
          must_have_tags: [],
          prefer_tags: [],
          avoid_ingredients: [],
          max_prep_minutes: 0,
        },
        context(home),
      );
      const proposed =
        result.ok && (result.data as { proposed?: boolean })?.proposed;
      if (proposed) {
        // Dopuszczalne: dodanie dania do pustego slotu — ale wtedy to nowa
        // propozycja z kartą, a nie zapis planu.
        expect(await footprint(home.householdId, home.conversationId)).not.toBe(
          before,
        );
      } else {
        expect(text(result).length).toBeGreaterThan(2);
      }
      const items = await prisma.planItem.count({
        where: { weeklyPlan: { householdId: home.householdId } },
      });
      expect(items).toBe(1);
    });
  });
});
