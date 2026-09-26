/**
 * Metryki odchudzenia asystenta (workstream, Etap 3) — LOKALNIE, bez modelu.
 *
 * Mierzy to, co da się zmierzyć za darmo:
 * - ile narzędzi widzi model i ile waży ich schemat (znaki JSON),
 * - rozmiar instrukcji i bloku trybu w prompcie,
 * - rozmiar wyniku narzędzi (JSON dla modelu) na typowych wywołaniach,
 * - zapytania do bazy i odczyty kontekstu domu (`memberPreferences`) na
 *   typowych przepływach tury: prompt + narzędzia z JEDNEJ tury.
 *
 * Przepływ to lista wywołań narzędzi z tej samej tury (ten sam kontekst
 * i ta sama pamięć tury, jak w `AgentTurnRunner`). Narzędzie, którego nie ma
 * w wersji kodu, pomija się z adnotacją — dzięki temu ten sam skrypt mierzy
 * stan przed i po zmianie.
 *
 * Nie woła modelu i nie zapisuje nic poza tymczasowym domem, który kasuje.
 * NIE uruchamiać na produkcji.
 *
 *   pnpm exec ts-node -r tsconfig-paths/register scripts/agent-thinning-metrics.ts
 *   … --out benchmark/agent-thinning-before.json
 */
import { Test } from '@nestjs/testing';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AgentPromptService } from '../src/agent/agent-prompt.service';
import { AgentToolExecutor } from '../src/agent/tools/agent-tool-executor';
import * as toolsModule from '../src/agent/tools/agent-tools';
import * as promptModule from '../src/agent/agent-system-prompt';
import { HouseholdsService } from '../src/households/households.service';
import * as memoModule from '../src/agent/turn-memo';

const WEEK_START = '2026-09-28';

type QueryEvent = { query: string; duration: number };

class CountingPrisma extends PrismaService {
  queries = 0;
  constructor() {
    super({ log: [{ emit: 'event', level: 'query' }] });
    (
      this as unknown as {
        $on(event: 'query', cb: (e: QueryEvent) => void): void;
      }
    ).$on('query', () => {
      this.queries += 1;
    });
  }
}

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

type Call = { tool: string; input: Record<string, unknown> };

async function main(): Promise<void> {
  process.env.AI_ENABLED = 'true';
  process.env.AI_PROVIDER = 'stub';
  process.env.AI_TIER_OVERRIDE ??= 'PRO';
  process.env.AI_CONSENT_REQUIRED = 'false';
  const prisma = new CountingPrisma();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  await moduleRef.init();
  const prompts = moduleRef.get(AgentPromptService);
  const tools = moduleRef.get(AgentToolExecutor);
  const households = moduleRef.get(HouseholdsService);

  // Licznik odczytów kontekstu domu — ta sama instancja serwisu, której
  // używają prompt, executor i planer.
  let memberReads = 0;
  type MemberRead = HouseholdsService['memberPreferences'];
  const original = households.memberPreferences.bind(households) as MemberRead;
  households.memberPreferences = (userId: string, householdId: string) => {
    memberReads += 1;
    return original(userId, householdId);
  };

  const stamp = `${Date.now()}`;
  const ania = await prisma.user.create({
    data: {
      displayName: 'Ania',
      email: `thin-${stamp}-a@agent.local`,
      authProvider: 'DEV',
      preferences: { create: { calorieGoal: 1800 } },
    },
  });
  const bartek = await prisma.user.create({
    data: {
      displayName: 'Bartek',
      email: `thin-${stamp}-b@agent.local`,
      authProvider: 'DEV',
      preferences: { create: { calorieGoal: 2500, allergens: ['NUTS'] } },
    },
  });
  const household = await prisma.household.create({
    data: { name: `Metryki ${stamp}`, createdById: ania.id },
  });
  await prisma.membership.createMany({
    data: [
      { userId: ania.id, householdId: household.id, role: 'OWNER' },
      { userId: bartek.id, householdId: household.id, role: 'MEMBER' },
    ],
  });
  const conversation = await prisma.agentConversation.create({
    data: { userId: ania.id, householdId: household.id },
  });
  const question = await prisma.agentMessage.create({
    data: { conversationId: conversation.id, role: 'USER', text: 'metryki' },
  });
  const turn = await prisma.agentTurn.create({
    data: {
      conversationId: conversation.id,
      userId: ania.id,
      userMessageId: question.id,
      requestId: `thin-${stamp}`,
    },
  });

  const dates = {
    weekStart: WEEK_START,
    clientToday: WEEK_START,
    timeZone: 'Europe/Warsaw',
  };

  const wishes = {
    diet: 'NONE',
    must_have_tags: [],
    prefer_tags: ['quick'],
    avoid_ingredients: [],
    max_prep_minutes: 25,
  };
  const findDinner = {
    query: '',
    meal_type: 'DINNER',
    tags: ['quick'],
    include_ingredients: [],
    exclude_ingredients: [],
    max_prep_minutes: 25,
    max_kcal_per_serving: 0,
    min_protein_per_serving: 0,
    for_user_ids: [],
    sort: 'BEST_FIT',
    limit: 8,
  };

  // Przepływy „przed" (jak prompt kazał dotąd) i „po" (high-level).
  const flows: Record<string, Call[]> = {
    'kolacja: household + find + offer (przed)': [
      { tool: 'get_household_context', input: {} },
      { tool: 'find_recipes', input: findDinner },
      {
        tool: 'offer_options',
        input: {
          title: 'Trzy szybkie kolacje',
          slot_label: 'Kolacja · poniedziałek',
          options: [{ recipe: '$1' }, { recipe: '$2' }, { recipe: '$3' }],
        },
      },
    ],
    'kolacja: suggest_meals (po)': [
      {
        tool: 'suggest_meals',
        input: {
          week_start: WEEK_START,
          day_of_week: 'MON',
          meal_type: 'DINNER',
          count: 3,
          include_ingredients: [],
          for_user_ids: [],
          ...wishes,
        },
      },
    ],
    'dzień: household + build_meal_plan': [
      { tool: 'get_household_context', input: {} },
      {
        tool: 'build_meal_plan',
        input: {
          week_start: WEEK_START,
          days: ['TUE'],
          meal_types: [],
          for_user_ids: [],
          ...wishes,
          prefer_tags: [],
          max_prep_minutes: 0,
        },
      },
    ],
    'dzień: build_meal_plan': [
      {
        tool: 'build_meal_plan',
        input: {
          week_start: WEEK_START,
          days: ['WED'],
          meal_types: [],
          for_user_ids: [],
          ...wishes,
          prefer_tags: [],
          max_prep_minutes: 0,
        },
      },
    ],
    'pytanie: find_recipes w turze': [
      { tool: 'find_recipes', input: findDinner },
    ],
    'start_planning (handoff)': [
      { tool: 'start_planning', input: { reason: 'tydzień' } },
    ],
  };

  const known = new Set(toolsModule.AGENT_TOOL_NAMES);
  const results: Record<string, unknown> = {};
  try {
    for (const [label, calls] of Object.entries(flows)) {
      if (calls.some((call) => !known.has(call.tool))) {
        results[label] = { skipped: 'narzędzia nie ma w tej wersji kodu' };
        continue;
      }
      prisma.queries = 0;
      memberReads = 0;
      // Pamięć tury istnieje od Etapu 3; w starszym kodzie jej brak = bez pamięci.
      const turnMemo = (
        memoModule as unknown as { createTurnMemo?: () => unknown }
      ).createTurnMemo?.();
      // Szósty argument (pamięć tury) istnieje dopiero po Etapie 3.
      const build = prompts.build.bind(prompts) as unknown as (
        ...args: unknown[]
      ) => ReturnType<AgentPromptService['build']>;
      const prompt = await build(
        ania.id,
        household.id,
        dates,
        true,
        false,
        ...(turnMemo ? [turnMemo] : []),
      );
      const promptQueries = prisma.queries;
      const context = {
        userId: ania.id,
        householdId: household.id,
        catalogIndex: prompt.catalogIndex,
        conversationId: conversation.id,
        turnId: turn.id,
        proposalMode: true,
        dates: { weekStart: WEEK_START, clientToday: WEEK_START },
        collectCard: () => undefined,
        ...(turnMemo ? { memo: turnMemo } : {}),
      };
      const sizes: Record<string, number> = {};
      let lastRefs: string[] = [];
      for (const call of calls) {
        const input = JSON.parse(
          JSON.stringify(call.input).replace(
            /"\$(\d)"/g,
            (_, n: string) => `"${lastRefs[Number(n) - 1] ?? 'R001'}"`,
          ),
        ) as Record<string, unknown>;
        const result = await tools.execute(call.tool, input, context as never);
        const payload = result.ok ? result.data : result.error;
        sizes[call.tool] = JSON.stringify(payload).length;
        const hits = (payload as { hits?: { recipe: string }[] })?.hits;
        if (hits) lastRefs = hits.map((hit) => hit.recipe);
        if (!result.ok) sizes[`${call.tool}:error`] = 1;
      }
      results[label] = {
        dbQueries: prisma.queries,
        promptQueries,
        memberPreferencesReads: memberReads,
        toolResultChars: sizes,
      };
      // Każdy przepływ na czysto — propozycje z poprzedniego nie wiszą.
      await prisma.agentProposal.deleteMany({ where: { turnId: turn.id } });
    }
  } finally {
    await prisma.household.deleteMany({ where: { id: household.id } });
    await prisma.user.deleteMany({
      where: { id: { in: [ania.id, bartek.id] } },
    });
    await moduleRef.close();
  }

  const optionalFields = toolsModule.AGENT_TOOLS.reduce(
    (sum, tool) =>
      sum +
      Object.keys(tool.input_schema.properties).filter(
        (key) => !tool.input_schema.required.includes(key),
      ).length,
    0,
  );
  // Ten sam rachunek, co spec „pól nieobowiązkowych" (limit API: 24).
  type Schema = {
    properties?: Record<string, Schema>;
    required?: string[];
    items?: Schema;
  };
  const countOptional = (schema: Schema | undefined): number => {
    if (!schema) return 0;
    let total = 0;
    const required = new Set(schema.required ?? []);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (!required.has(name)) total += 1;
      total += countOptional(child);
    }
    return total + countOptional(schema.items);
  };
  const summary = {
    optionalFieldsForApiLimit: toolsModule.AGENT_TOOLS.reduce(
      (sum, tool) => sum + countOptional(tool.input_schema as Schema),
      0,
    ),
    measuredAt: new Date().toISOString(),
    modelTools: toolsModule.AGENT_TOOLS.length,
    modelToolNames: toolsModule.AGENT_TOOLS.map((tool) => tool.name),
    triageTools: toolsModule.TRIAGE_TOOLS.length,
    toolSchemaChars: JSON.stringify(toolsModule.AGENT_TOOLS).length,
    topLevelOptionalFields: optionalFields,
    instructionsChars: promptModule.AGENT_INSTRUCTIONS.length,
    proposalModeBlockChars: promptModule.modeBlock(true).length,
    flows: results,
  };
  console.log(JSON.stringify(summary, null, 2));
  const out = flag('out');
  if (out) {
    const path = resolve(process.cwd(), out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(summary, null, 2), 'utf8');
  }
}

void main();
