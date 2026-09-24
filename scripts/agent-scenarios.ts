/**
 * Scenariusze na żywym modelu — hartowanie asystenta i BENCHMARK.
 *
 * `agent-smoke.ts` odpowiada na pytanie „czy to w ogóle działa". Ten skrypt
 * odpowiada na trudniejsze: czy instrukcje i opisy narzędzi TRZYMAJĄ, gdy
 * zadanie jest realne, ile to kosztuje i ile rund zajmuje. Każdy scenariusz
 * zakłada gospodarstwo o konkretnym profilu, zadaje pytanie (albo prowadzi
 * rozmowę), a potem SPRAWDZA WYNIK W BAZIE — bo model, który ładnie opowiada
 * o tym, co zrobił, i model, który to zrobił, to dwie różne rzeczy.
 *
 * Scenariusze są DANYMI i siedzą w `scripts/lib/agent-benchmark-scenarios.ts`.
 * Tutaj jest wyłącznie mechanika: świat, pętla, pomiar, agregacja.
 *
 * CO MIERZY. Dla każdego przebiegu: pass/fail z `verify`, użyte narzędzia,
 * kontrakt narzędziowy (`expectedTools` / `forbiddenTools` / `maxRounds`),
 * `apiCalls`, latencję, tokeny wejścia i wyjścia, tokeny z cache (odczyt i
 * zapis) wraz z trafialnością, koszt i powód zatrzymania. Wyniki jadą do
 * JSON-a, żeby dało się porównać dwa przebiegi (BEFORE/AFTER) i cztery
 * konfiguracje modeli.
 *
 * Kosztuje pieniądze i nie ma prawa chodzić w CI.
 *
 * Uruchomienie (wymaga ANTHROPIC_API_KEY):
 *   pnpm agent:scenarios
 *   pnpm agent:scenarios -- --only g7-domownik-bez-zgody
 *   pnpm agent:scenarios -- --group 4,5,6 --runs 3
 *   pnpm agent:scenarios -- --config A,B,C,D --runs 3 --out wyniki.json
 *   pnpm agent:scenarios -- --list
 */
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { DayOfWeek, MealType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AgentPromptService } from '../src/agent/agent-prompt.service';
import { AgentToolExecutor } from '../src/agent/tools/agent-tool-executor';
import { AnthropicAgentProvider } from '../src/agent/providers/anthropic-agent.provider';
import { AgentMemoryService } from '../src/agent/agent-memory.service';
import { AiEffort, AgentEnv, readAgentEnv } from '../src/config/agent-env';
import { resolveRoute } from '../src/agent/agent-route';
import {
  AgentCallTiming,
  AgentProviderError,
  AgentProviderMessage,
  AgentProviderRequest,
  AgentProviderResult,
} from '../src/agent/providers/agent-provider';
import {
  CARDS_CAPABILITY_V1,
  resolveProposalMode,
} from '../src/agent/cards/agent-cards';
import { AgentCard } from '../src/agent/cards/agent-cards';
import {
  buildCatalogDigest,
  loadDigestRecipes,
} from '../src/agent/catalog-digest';
import { LEGAL_DOCUMENT_VERSIONS } from '../src/common/legal-documents';
import {
  BenchRecipe,
  HANDOFF_REQUIRED_GROUPS,
  HANDOFF_UNNECESSARY_GROUPS,
  PlanRow,
  Scenario,
  ScenarioWorld,
  SCENARIOS,
  SeedSlot,
  ToolCall,
  WEEK_START,
} from './lib/agent-benchmark-scenarios';

/** Scenariusze bywają dłuższe niż zwykła tura — to diagnostyka, nie produkcja. */
const SCENARIO_TIMEOUT_MS = 300_000;

const DEFAULT_CATALOG_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';

/**
 * Konfiguracje do porównania (audyt etapu 2, §Konfiguracje benchmarku).
 *
 * Konfiguracja `C` włącza przekazanie pałeczki Haiku → Sonnet WYŁĄCZNIE dla
 * tego przebiegu: powstaje z `AgentEnv` budowanego tutaj i przepuszczanego
 * przez `resolveRoute`, dokładnie tak jak w produkcyjnym runnerze. Niczego nie
 * ustawia globalnie i nie zmienia domyślnego zachowania dla użytkowników.
 */
type BenchConfig = {
  id: string;
  label: string;
  model: string;
  effort: AiEffort;
  toolsModel: string | null;
  effortTools: AiEffort;
};

const CONFIGS: BenchConfig[] = [
  {
    id: 'A',
    label: 'Sonnet / medium (obecna produkcja)',
    model: 'claude-sonnet-5',
    effort: 'medium',
    toolsModel: null,
    effortTools: 'low',
  },
  {
    id: 'B',
    label: 'Sonnet / low',
    model: 'claude-sonnet-5',
    effort: 'low',
    toolsModel: null,
    effortTools: 'low',
  },
  {
    id: 'C',
    label: 'Haiku CHAT (low) → Sonnet PLANNER (medium)',
    model: 'claude-sonnet-5',
    effort: 'medium',
    toolsModel: 'claude-haiku-4-5',
    effortTools: 'low',
  },
  {
    id: 'D',
    label: 'Haiku / low (wszystko)',
    model: 'claude-haiku-4-5',
    effort: 'low',
    toolsModel: null,
    effortTools: 'low',
  },
];

type RunRecord = {
  scenario: string;
  group: number;
  pyta: string;
  config: string;
  configLabel: string;
  model: string;
  effort: string;
  toolsModel: string | null;
  run: number;
  pass: boolean;
  issues: string[];
  tools: string[];
  /** Czy tura przeszła na planistę (`start_planning`). */
  handoff: boolean;
  apiCalls: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRatio: number;
  costMicroUsd: number;
  stopReason: string | null;
  /** Rozmiar wyniku `get_week_plan` w bajtach — do porównania BEFORE/AFTER. */
  weekPlanPayloadBytes: number | null;
  /** Czas każdego wywołania API: na co poszła latencja (myślenie, narzędzia, tekst). */
  timings: AgentCallTiming[];
  /**
   * Ostatnia odpowiedź, przycięta. NIE służy do oceny (correctness liczy się
   * z bazy i kontraktu narzędzi) — jest po to, żeby dało się zobaczyć, co
   * model naprawdę powiedział, gdy `verify` zgłosi zastrzeżenie.
   */
  answer: string;
  /**
   * Karty tury (rodzaj + treść). Tak samo jak `answer`: nie służy do oceny,
   * tylko do zobaczenia, CZEGO model zażądał, gdy `verify` zgłosi problem —
   * pytanie doprecyzowujące mówi wprost, jakiej danej mu zabrakło.
   */
  cards: { kind: string; payload: Record<string, unknown> }[];
  error: string | null;
};

// ---------------------------------------------------------------------------
// Argumenty
// ---------------------------------------------------------------------------

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function list(name: string): string[] | null {
  const raw = flag(name);
  return raw
    ? raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : null;
}

// ---------------------------------------------------------------------------
// Świat scenariusza
// ---------------------------------------------------------------------------

type Deps = {
  prisma: PrismaService;
  prompts: AgentPromptService;
  tools: AgentToolExecutor;
  provider: AnthropicAgentProvider;
  memory: AgentMemoryService;
  catalog: BenchRecipe[];
  ingredients: Map<string, string>;
};

/**
 * Katalog w kształcie, którego potrzebują scenariusze — z indeksem digestu.
 *
 * Indeks (`R07`) liczymy tym samym `buildCatalogDigest`, którym liczy go
 * prompt: scenariusz, który zakłada plan „po R07", ma widzieć dokładnie to,
 * co za chwilę zobaczy model.
 */
async function loadCatalog(prisma: PrismaService): Promise<BenchRecipe[]> {
  const householdId =
    (process.env.RECIPE_IMPORT_HOUSEHOLD_ID ?? '').trim() ||
    DEFAULT_CATALOG_HOUSEHOLD;
  const digest = buildCatalogDigest(
    await loadDigestRecipes(prisma, householdId),
  );
  const refById = new Map(
    Object.entries(digest.index).map(([ref, id]) => [id, ref]),
  );
  const rows = await prisma.recipe.findMany({
    where: { householdId, isActive: true },
    select: {
      id: true,
      title: true,
      mealType: true,
      suitableMealTypes: true,
      prepTimeMinutes: true,
      servings: true,
      nutritionKcal: true,
      allergens: true,
      dietTags: true,
      ingredients: { select: { ingredientId: true, name: true } },
    },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
  });
  return rows
    .filter((row) => refById.has(row.id))
    .map((row) => {
      const servings = Math.max(1, row.servings ?? 1);
      return {
        id: row.id,
        ref: refById.get(row.id) as string,
        title: row.title,
        mealType: row.mealType,
        // Pusta lista z bazy znaczy „tylko slot bazowy" — ta sama reguła, co
        // w `effectiveSuitableMealTypes`; scenariusz nie ma jej znać.
        suitableMealTypes:
          row.suitableMealTypes.length > 0
            ? row.suitableMealTypes
            : [row.mealType],
        prepTimeMinutes: row.prepTimeMinutes ?? 0,
        servings,
        kcalPerServing: Math.round((row.nutritionKcal ?? 0) / servings),
        allergens: row.allergens,
        dietTags: row.dietTags,
        ingredientIds: row.ingredients.map((entry) => entry.ingredientId),
        ingredientNames: row.ingredients.map((entry) => entry.name),
      };
    });
}

type BuiltWorld = {
  world: ScenarioWorld;
  ownerId: string;
  householdId: string;
  userIds: string[];
  conversationId: string;
};

async function buildWorld(
  deps: Deps,
  scenario: Scenario,
  stamp: string,
): Promise<BuiltWorld> {
  const { prisma } = deps;
  const members: Record<string, { userId: string; displayName: string }> = {};
  const userIds: string[] = [];

  for (const spec of scenario.members) {
    const user = await prisma.user.create({
      data: {
        displayName: spec.displayName,
        email: `bench-${stamp}-${spec.key}@agent.local`,
        authProvider: 'DEV',
        heightCm: 175,
        weightKg: 72,
        yearOfBirth: 1994,
        sex: 'FEMALE',
        preferences: {
          create: {
            dietPreference: spec.dietPreference ?? 'NONE',
            allergens: spec.allergens ?? [],
            calorieGoal: spec.calorieGoal ?? 2000,
            excludedIngredientIds: (spec.excluded ?? [])
              .map((name) => deps.ingredients.get(name.toLowerCase()) ?? null)
              .filter((id): id is string => id !== null),
            ...(spec.maxPrepTimeMinutes
              ? { maxPrepTimeMinutes: spec.maxPrepTimeMinutes }
              : {}),
          },
        },
      },
      select: { id: true },
    });
    members[spec.key] = { userId: user.id, displayName: spec.displayName };
    userIds.push(user.id);
    if (spec.aiConsent) {
      await prisma.consentEvent.create({
        data: {
          userId: user.id,
          kind: 'AI_ASSISTANT',
          action: 'GRANTED',
          documentVersion: LEGAL_DOCUMENT_VERSIONS.AI_ASSISTANT,
          source: 'BENCHMARK',
        },
      });
    }
  }

  const ownerKey = scenario.members[0].key;
  const ownerId = members[ownerKey].userId;
  const household = await prisma.household.create({
    data: {
      name: scenario.householdName ?? `Dom ${scenario.name}`,
      createdById: ownerId,
      ...(scenario.enabledMealTypes
        ? { enabledMealTypes: scenario.enabledMealTypes }
        : {}),
    },
    select: { id: true },
  });
  for (const [index, spec] of scenario.members.entries()) {
    await prisma.membership.create({
      data: {
        userId: members[spec.key].userId,
        householdId: household.id,
        role: index === 0 ? 'OWNER' : 'MEMBER',
      },
    });
  }

  const ownRecipeIds: Record<string, string> = {};
  const world: ScenarioWorld = {
    householdId: household.id,
    members,
    catalog: deps.catalog,
    ownRecipeIds,
    ingredientId: (name) => deps.ingredients.get(name.toLowerCase()) ?? null,
  };

  for (const note of scenario.memoryNotes ?? []) {
    await deps.memory.remember(household.id, ownerId, note, 'PREFERENCE');
  }

  for (const own of scenario.ownRecipes ?? []) {
    // Przepis gospodarstwa musi mieć składnik, inaczej makra są zerem, a
    // scenariusz edycji nie miałby czego przeliczyć.
    const ingredientId = deps.ingredients.get('jajko') ?? null;
    const created = await prisma.recipe.create({
      select: { id: true },
      data: {
        householdId: household.id,
        authorId: ownerId,
        title: own.title,
        mealType: own.mealType,
        difficulty: 'EASY',
        prepTimeMinutes: 10,
        servings: own.servings,
        ...(ingredientId
          ? {
              ingredients: {
                create: {
                  ingredientId,
                  name: 'jajko',
                  amount: 2,
                  unit: 'szt',
                  normalizedAmount: 2,
                  normalizedUnit: 'szt',
                  department: 'INNE',
                },
              },
            }
          : {}),
      },
    });
    ownRecipeIds[own.title] = created.id;
  }

  if (scenario.seed) {
    await seedPlan(prisma, household.id, members, scenario.seed(world));
  }

  const conversation = await prisma.agentConversation.create({
    data: { userId: ownerId, householdId: household.id },
    select: { id: true },
  });

  return {
    world,
    ownerId,
    householdId: household.id,
    userIds,
    conversationId: conversation.id,
  };
}

async function seedPlan(
  prisma: PrismaService,
  householdId: string,
  members: Record<string, { userId: string }>,
  slots: SeedSlot[],
): Promise<void> {
  if (slots.length === 0) return;
  const plan = await prisma.weeklyPlan.create({
    data: { householdId, weekStart: new Date(`${WEEK_START}T00:00:00.000Z`) },
    select: { id: true },
  });
  for (const slot of slots) {
    const participants = (slot.participants ?? []).map(
      (key) => members[key].userId,
    );
    await prisma.planItem.create({
      data: {
        weeklyPlanId: plan.id,
        recipeId: slot.recipeId,
        dayOfWeek: slot.dayOfWeek,
        mealType: slot.mealType,
        plannedServings:
          slot.plannedServings ??
          Math.max(1, participants.length || Object.keys(members).length),
        ...(participants.length > 0
          ? {
              participants: {
                create: participants.map((userId) => ({ userId })),
              },
            }
          : {}),
        ...(slot.eatenBy && slot.eatenBy.length > 0
          ? {
              consumptions: {
                create: slot.eatenBy.map((key) => ({
                  userId: members[key].userId,
                })),
              },
            }
          : {}),
      },
    });
  }
}

async function readPlan(
  prisma: PrismaService,
  householdId: string,
): Promise<PlanRow[]> {
  const items = await prisma.planItem.findMany({
    where: {
      weeklyPlan: {
        householdId,
        weekStart: new Date(`${WEEK_START}T00:00:00.000Z`),
      },
    },
    select: {
      dayOfWeek: true,
      mealType: true,
      recipeId: true,
      plannedServings: true,
      participants: { select: { userId: true } },
      consumptions: { select: { userId: true } },
      recipe: {
        select: {
          title: true,
          allergens: true,
          dietTags: true,
          prepTimeMinutes: true,
          servings: true,
          nutritionKcal: true,
          householdId: true,
          ingredients: { select: { ingredientId: true } },
        },
      },
    },
  });
  return items.map((item) => toPlanRow(item));
}

type RecipeShape = {
  title: string;
  allergens: string[];
  dietTags: string[];
  prepTimeMinutes: number | null;
  servings: number | null;
  nutritionKcal: number | null;
  householdId: string | null;
  ingredients: { ingredientId: string }[];
};

function toPlanRow(item: {
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
  plannedServings: number;
  participants: { userId: string }[];
  consumptions: { userId: string }[];
  recipe: RecipeShape;
}): PlanRow {
  const servings = Math.max(1, item.recipe.servings ?? 1);
  return {
    dayOfWeek: item.dayOfWeek,
    mealType: item.mealType,
    recipeId: item.recipeId,
    plannedServings: item.plannedServings,
    participantIds: item.participants.map((entry) => entry.userId),
    eatenByUserIds: item.consumptions.map((entry) => entry.userId),
    recipe: {
      title: item.recipe.title,
      allergens: item.recipe.allergens,
      dietTags: item.recipe.dietTags,
      prepTimeMinutes: item.recipe.prepTimeMinutes ?? 0,
      kcalPerServing: Math.round((item.recipe.nutritionKcal ?? 0) / servings),
      ingredientIds: item.recipe.ingredients.map((entry) => entry.ingredientId),
      householdId: item.recipe.householdId,
    },
  };
}

/**
 * Stan docelowy tury w trybie propozycji.
 *
 * Przy `AI_CARDS_MODE=off` model zapisuje sam i `target` = plan w bazie.
 * W trybie propozycji nic się jeszcze nie zapisało, a tydzień, który zapisze
 * kliknięcie, leży w `AgentProposal.action.slots`. Scenariusz sprawdza SKUTEK,
 * więc nie ma prawa wiedzieć, którą drogą on powstał.
 */
async function readProposalTarget(
  prisma: PrismaService,
  householdId: string,
): Promise<PlanRow[] | null> {
  const proposal = await prisma.agentProposal.findFirst({
    where: { householdId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { action: true },
  });
  if (!proposal) return null;
  const action = proposal.action as unknown as {
    slots?: {
      dayOfWeek: DayOfWeek;
      mealType: MealType;
      recipeId: string;
      participantIds?: string[];
      plannedServings?: number;
    }[];
  };
  const slots = action.slots ?? [];
  if (slots.length === 0) return [];
  const recipes = await prisma.recipe.findMany({
    where: {
      id: { in: Array.from(new Set(slots.map((slot) => slot.recipeId))) },
    },
    select: {
      id: true,
      title: true,
      allergens: true,
      dietTags: true,
      prepTimeMinutes: true,
      servings: true,
      nutritionKcal: true,
      householdId: true,
      ingredients: { select: { ingredientId: true } },
    },
  });
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  return slots
    .filter((slot) => byId.has(slot.recipeId))
    .map((slot) =>
      toPlanRow({
        dayOfWeek: slot.dayOfWeek,
        mealType: slot.mealType,
        recipeId: slot.recipeId,
        plannedServings: slot.plannedServings ?? 1,
        participants: (slot.participantIds ?? []).map((userId) => ({ userId })),
        consumptions: [],
        recipe: byId.get(slot.recipeId) as RecipeShape,
      }),
    );
}

// ---------------------------------------------------------------------------
// Przebieg na sucho
// ---------------------------------------------------------------------------

/**
 * Dostawca-atrapa (`--dry`): przechodzi scenariusz BEZ ani jednego wywołania
 * modelu, za zero dolarów.
 *
 * PO CO. Scenariusz może być zepsuty na trzy sposoby, które nie mają nic
 * wspólnego z modelem: zły fixture (składnik nazywa się `pieczarka`, nie
 * `pieczarki`), niewykonalne założenie (własny przepis poza planem jest dla
 * modelu nieosiągalny) albo `verify`, które samo się wywraca. Każdy z nich
 * wychodzi dopiero PO opłaceniu tury — trzy z siedmiu zastrzeżeń w baseline
 * 7.09.2026 były właśnie tym, a nie błędem asystenta.
 *
 * Czego to NIE sprawdza: jakości modelu. Po przejściu na sucho `verify`
 * zwykle zgłosi zastrzeżenia (nikt nie ułożył planu) i tak ma być — liczy się
 * to, że świat się zbudował, narzędzia dały się wywołać, a `verify`
 * odpowiedziało listą zamiast wyjątkiem.
 */
function dryRun(request: AgentProviderRequest): Promise<AgentProviderResult> {
  // Jedno CZYTAJĄCE narzędzie, żeby przejść ścieżkę wykonania narzędzi bez
  // dotykania planu. `get_household_context` nie bierze argumentów i niczego
  // nie zapisuje — ta sama sztuczka, co w `STUB_TOOL_MARKER`.
  const readOnly = request.tools.find(
    (tool) => tool.name === 'get_household_context',
  );
  const run = readOnly
    ? request.executeTool('get_household_context', {})
    : Promise.resolve(null);
  return run.then(() => ({
    text: '(przebieg na sucho — model nie był wołany)',
    stopReason: 'dry_run',
    usage: {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
    },
    apiCalls: 0,
    phases: [],
  }));
}

// ---------------------------------------------------------------------------
// Jeden przebieg
// ---------------------------------------------------------------------------

async function runOnce(
  deps: Deps,
  scenario: Scenario,
  config: BenchConfig,
  run: number,
  baseEnv: AgentEnv,
  cardsMode: 'off' | 'soft' | 'strict',
  /** `true` = bez modelu; patrz `dryRun`. */
  dry: boolean,
): Promise<RunRecord> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const built = await buildWorld(deps, scenario, stamp);
  const proposalMode = resolveProposalMode(cardsMode, [CARDS_CAPABILITY_V1]);
  const env: AgentEnv = {
    ...baseEnv,
    model: config.model,
    effort: config.effort,
    toolsModel: config.toolsModel,
    effortTools: config.effortTools,
  };
  const route = resolveRoute(env);

  const calls: ToolCall[] = [];
  const cards: { kind: string; payload: Record<string, unknown> }[] = [];
  const answers: string[] = [];
  const messages: AgentProviderMessage[] = [];
  let apiCalls = 0;
  let latencyMs = 0;
  const timings: AgentCallTiming[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costMicroUsd = 0;
  let stopReason: string | null = null;
  let error: string | null = null;

  const planBefore = await readPlan(deps.prisma, built.householdId);

  try {
    for (const text of scenario.prompts) {
      const prompt = await deps.prompts.build(
        built.ownerId,
        built.householdId,
        {
          weekStart: WEEK_START,
          clientToday: WEEK_START,
          timeZone: 'Europe/Warsaw',
        },
        proposalMode,
        route.promptHandoff,
      );
      messages.push({ role: 'USER', text });
      const started = Date.now();
      let result: AgentProviderResult;
      const call: (
        request: AgentProviderRequest,
      ) => Promise<AgentProviderResult> = dry
        ? dryRun
        : (request) => deps.provider.run(request);
      try {
        result = await call({
          model: route.model,
          effort: route.effort,
          handoff: route.handoff,
          system: prompt.system,
          messages: [...messages],
          tools: route.tools,
          executeTool: async (name, input) => {
            const outcome = await deps.tools.execute(name, input, {
              userId: built.ownerId,
              householdId: built.householdId,
              catalogIndex: prompt.catalogIndex,
              conversationId: built.conversationId,
              turnId: randomUUID(),
              proposalMode,
              collectCard: (card: AgentCard) =>
                cards.push({
                  kind: card.kind,
                  payload: card as unknown as Record<string, unknown>,
                }),
            });
            calls.push({
              name,
              input,
              ok: outcome.ok,
              json: JSON.stringify(outcome),
            });
            return outcome;
          },
          signal: AbortSignal.timeout(SCENARIO_TIMEOUT_MS),
          // Scenariusze mierzą pełny koszt tury — bez sufitu, żeby liczby
          // w cost-model.md nie były przycięte.
          maxTurnCostUsd: null,
        });
      } finally {
        latencyMs += Date.now() - started;
      }
      apiCalls += result.apiCalls;
      timings.push(...(result.timings ?? []));
      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      cacheReadTokens += result.usage.cacheReadTokens;
      cacheWriteTokens += result.usage.cacheWriteTokens;
      costMicroUsd += result.usage.costMicroUsd;
      stopReason = result.stopReason;
      answers.push(result.text);
      messages.push({ role: 'ASSISTANT', text: result.text });
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (caught instanceof AgentProviderError) {
      // Zużycie sprzed błędu też jest rachunkiem — bez niego benchmark
      // pokazywałby, że tury nieudane są darmowe.
      apiCalls += caught.apiCalls ?? 0;
      inputTokens += caught.usage?.inputTokens ?? 0;
      outputTokens += caught.usage?.outputTokens ?? 0;
      cacheReadTokens += caught.usage?.cacheReadTokens ?? 0;
      cacheWriteTokens += caught.usage?.cacheWriteTokens ?? 0;
      costMicroUsd += caught.usage?.costMicroUsd ?? 0;
    }
    stopReason = stopReason ?? 'ERROR';
  }

  const plan = await readPlan(deps.prisma, built.householdId);
  const proposalTarget = proposalMode
    ? await readProposalTarget(deps.prisma, built.householdId)
    : null;
  const notes = (
    await deps.prisma.agentMemory.findMany({
      where: { householdId: built.householdId },
      select: { text: true },
    })
  ).map((row) => row.text);
  const ownRecipes = (
    await deps.prisma.recipe.findMany({
      where: { householdId: built.householdId },
      select: {
        id: true,
        title: true,
        servings: true,
        nutritionKcal: true,
      },
    })
  ).map((row) => ({
    id: row.id,
    title: row.title,
    servings: row.servings ?? 1,
    nutritionKcal: row.nutritionKcal ?? 0,
  }));

  const tools = calls.map((call) => call.name);
  const issues: string[] = [];
  if (error) issues.push(`tura padla: ${error}`);
  else {
    try {
      issues.push(
        ...scenario.verify({
          world: built.world,
          planBefore,
          plan,
          target: proposalTarget ?? plan,
          proposed: proposalTarget !== null,
          answer: answers[answers.length - 1] ?? '',
          answers,
          tools,
          calls,
          cards,
          modelSaw: calls.map((call) => call.json).join('\n'),
          notes,
          ownRecipes,
        }),
      );
    } catch (caught) {
      issues.push(
        `verify wywalilo sie: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
    issues.push(...contractIssues(scenario, tools, apiCalls));
  }

  await deps.prisma.household.deleteMany({ where: { id: built.householdId } });
  await deps.prisma.user.deleteMany({ where: { id: { in: built.userIds } } });

  const weekPlanCall = calls.find((call) => call.name === 'get_week_plan');
  const cacheDenominator = inputTokens + cacheReadTokens + cacheWriteTokens;

  return {
    scenario: scenario.name,
    group: scenario.group,
    pyta: scenario.pyta,
    config: config.id,
    configLabel: config.label,
    model: config.model,
    effort: config.effort,
    toolsModel: config.toolsModel,
    run,
    pass: issues.length === 0,
    issues,
    tools,
    handoff: tools.includes('start_planning'),
    apiCalls,
    latencyMs,
    timings,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitRatio:
      cacheDenominator > 0 ? cacheReadTokens / cacheDenominator : 0,
    costMicroUsd,
    stopReason,
    weekPlanPayloadBytes: weekPlanCall
      ? Buffer.byteLength(weekPlanCall.json, 'utf8')
      : null,
    answer: (answers[answers.length - 1] ?? '').slice(0, 2000),
    cards,
    error,
  };
}

/**
 * Kontrakt narzędziowy: nie golden path, tylko granice kosztu i zachowania.
 *
 * `expectedTools` znaczy „co najmniej jedno z nich", bo do wielu z tych celów
 * prowadzi więcej niż jedna poprawna droga (propozycja albo zapis). Wymóg
 * konkretnej sekwencji mierzyłby nasze wyobrażenie o modelu, nie skuteczność.
 */
function contractIssues(
  scenario: Scenario,
  tools: string[],
  apiCalls: number,
): string[] {
  const issues: string[] = [];
  const used = new Set(tools);
  if (scenario.expectedTools && scenario.expectedTools.length > 0) {
    if (!scenario.expectedTools.some((name) => used.has(name))) {
      issues.push(
        `nie uzyl zadnego z oczekiwanych narzedzi (${scenario.expectedTools.join(' | ')})`,
      );
    }
  }
  for (const name of scenario.forbiddenTools ?? []) {
    if (used.has(name)) issues.push(`uzyl zabronionego narzedzia ${name}`);
  }
  if (scenario.maxRounds !== undefined && apiCalls > scenario.maxRounds) {
    issues.push(`${apiCalls} wywolan API przy sufcie ${scenario.maxRounds}`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Agregacja
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

function median(values: number[]): number {
  return percentile(values, 50);
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

type Aggregate = {
  config: string;
  configLabel: string;
  runs: number;
  passRate: number;
  medianRounds: number;
  p95Rounds: number;
  maxRounds: number;
  medianCostUsd: number;
  p95CostUsd: number;
  medianLatencyMs: number;
  /**
   * Na co poszła latencja wszystkich przebiegów razem (udziały, suma = 1).
   * `wait` to czas do pierwszego bloku każdego wywołania (kolejka, prefill,
   * sieć); `other` to reszta strumienia poza blokami i czas między rundami.
   */
  latencySplit: Record<
    'wait' | 'thinking' | 'toolInput' | 'text' | 'toolsRun' | 'other',
    number
  > | null;
  /** Mediana czasu do pierwszego bloku jednego wywołania API. */
  medianFirstBlockMs: number | null;
  cacheHitRatio: number;
  unnecessaryHandoffRate: number | null;
  missedHandoffRate: number | null;
  byGroup: {
    group: number;
    runs: number;
    passRate: number;
    medianRounds: number;
    medianCostUsd: number;
  }[];
};

function medianOrNull(values: number[]): number | null {
  return values.length === 0 ? null : median(values);
}

/** Udziały składowych w łącznej latencji przebiegów, które mają pomiar. */
function latencySplit(rows: RunRecord[]): Aggregate['latencySplit'] {
  const measured = rows.filter((row) => row.timings.length > 0);
  const total = measured.reduce((sum, row) => sum + row.latencyMs, 0);
  if (total === 0) return null;
  const sum = (pick: (timing: AgentCallTiming) => number) =>
    measured.reduce(
      (acc, row) =>
        acc + row.timings.reduce((inner, timing) => inner + pick(timing), 0),
      0,
    );
  const wait = sum((timing) => timing.firstBlockMs ?? timing.totalMs);
  const thinking = sum((timing) => timing.thinkingMs);
  const toolInput = sum((timing) => timing.toolInputMs);
  const text = sum((timing) => timing.textMs);
  const toolsRun = sum((timing) => timing.toolsRunMs ?? 0);
  const other = total - wait - thinking - toolInput - text - toolsRun;
  return {
    wait: wait / total,
    thinking: thinking / total,
    toolInput: toolInput / total,
    text: text / total,
    toolsRun: toolsRun / total,
    other: other / total,
  };
}

function aggregate(records: RunRecord[]): Aggregate[] {
  const byConfig = new Map<string, RunRecord[]>();
  for (const record of records) {
    byConfig.set(record.config, [
      ...(byConfig.get(record.config) ?? []),
      record,
    ]);
  }
  return [...byConfig.entries()].map(([config, rows]) => {
    const rounds = rows.map((row) => row.apiCalls);
    const costs = rows.map((row) => row.costMicroUsd / 1_000_000);
    // Metryki routingu liczą się TYLKO tam, gdzie przekazanie w ogóle jest
    // możliwe: bez `AI_MODEL_TOOLS` narzędzie `start_planning` nie istnieje,
    // więc zero handoffów nie jest wtedy żadnym wynikiem.
    const routingActive = rows.some((row) => row.toolsModel !== null);
    const proste = rows.filter((row) =>
      HANDOFF_UNNECESSARY_GROUPS.includes(row.group),
    );
    const planistyczne = rows.filter((row) =>
      HANDOFF_REQUIRED_GROUPS.includes(row.group),
    );
    const groups = Array.from(new Set(rows.map((row) => row.group))).sort(
      (a, b) => a - b,
    );
    return {
      config,
      configLabel: rows[0].configLabel,
      runs: rows.length,
      passRate: rows.filter((row) => row.pass).length / rows.length,
      medianRounds: median(rounds),
      p95Rounds: percentile(rounds, 95),
      maxRounds: Math.max(...rounds),
      medianCostUsd: median(costs),
      p95CostUsd: percentile(costs, 95),
      medianLatencyMs: median(rows.map((row) => row.latencyMs)),
      latencySplit: latencySplit(rows),
      medianFirstBlockMs: medianOrNull(
        rows.flatMap((row) =>
          row.timings.flatMap((timing) =>
            timing.firstBlockMs === null ? [] : [timing.firstBlockMs],
          ),
        ),
      ),
      cacheHitRatio: mean(rows.map((row) => row.cacheHitRatio)),
      unnecessaryHandoffRate:
        routingActive && proste.length > 0
          ? proste.filter((row) => row.handoff).length / proste.length
          : null,
      missedHandoffRate:
        routingActive && planistyczne.length > 0
          ? planistyczne.filter((row) => !row.handoff).length /
            planistyczne.length
          : null,
      byGroup: groups.map((group) => {
        const inGroup = rows.filter((row) => row.group === group);
        return {
          group,
          runs: inGroup.length,
          passRate: inGroup.filter((row) => row.pass).length / inGroup.length,
          medianRounds: median(inGroup.map((row) => row.apiCalls)),
          medianCostUsd: median(
            inGroup.map((row) => row.costMicroUsd / 1_000_000),
          ),
        };
      }),
    };
  });
}

function pct(value: number | null): string {
  return value === null ? '  n/d' : `${(value * 100).toFixed(0).padStart(4)}%`;
}

function printSummary(records: RunRecord[]): void {
  const aggregates = aggregate(records);
  console.log(`\n${'='.repeat(118)}\nPODSUMOWANIE`);
  console.log(
    'Konf  pass   rundy p50/p95/max   koszt p50/p95        latencja p50   cache   FP handoff  FN handoff',
  );
  for (const row of aggregates) {
    console.log(
      `  ${row.config}  ${pct(row.passRate)}   ` +
        `${String(row.medianRounds).padStart(3)}/${String(row.p95Rounds).padStart(3)}/${String(row.maxRounds).padStart(3)}      ` +
        `$${row.medianCostUsd.toFixed(4)}/$${row.p95CostUsd.toFixed(4)}   ` +
        `${String(Math.round(row.medianLatencyMs / 1000)).padStart(6)} s   ` +
        `${(row.cacheHitRatio * 100).toFixed(0).padStart(3)}%   ` +
        `${pct(row.unnecessaryHandoffRate)}       ${pct(row.missedHandoffRate)}`,
    );
  }

  for (const row of aggregates) {
    if (!row.latencySplit) continue;
    const split = row.latencySplit;
    console.log(
      `
  ${row.config}: na co poszedl czas: ` +
        `czekanie na 1. blok ${pct(split.wait)}, myslenie ${pct(split.thinking)}, ` +
        `wejscie narzedzi ${pct(split.toolInput)}, tekst ${pct(split.text)}, ` +
        `wykonanie narzedzi ${pct(split.toolsRun)}, reszta ${pct(split.other)}; ` +
        `1. blok p50 ${row.medianFirstBlockMs ?? '-'} ms`,
    );
  }

  for (const row of aggregates) {
    console.log(`\n  ${row.config} — ${row.configLabel}, po grupach:`);
    for (const group of row.byGroup) {
      console.log(
        `    grupa ${String(group.group).padStart(2)}  przebiegow ${String(group.runs).padStart(3)}  ` +
          `pass ${pct(group.passRate)}  rundy p50 ${String(group.medianRounds).padStart(2)}  ` +
          `koszt p50 $${group.medianCostUsd.toFixed(4)}`,
      );
    }
  }

  const failed = records.filter((row) => !row.pass);
  if (failed.length > 0) {
    console.log(`\nZASTRZEZENIA (${failed.length} z ${records.length}):`);
    const byScenario = new Map<string, RunRecord[]>();
    for (const row of failed) {
      const key = `${row.config}/${row.scenario}`;
      byScenario.set(key, [...(byScenario.get(key) ?? []), row]);
    }
    for (const [key, rows] of byScenario) {
      console.log(`  ${key} (${rows.length}×)`);
      for (const issue of Array.from(
        new Set(rows.flatMap((row) => row.issues)),
      )) {
        console.log(`    - ${issue}`);
      }
    }
  }

  const total = records.reduce((sum, row) => sum + row.costMicroUsd, 0);
  console.log(
    `\nLACZNY KOSZT: $${(total / 1_000_000).toFixed(4)} za ${records.length} przebiegow`,
  );
}

// ---------------------------------------------------------------------------
// Wejście
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (has('list')) {
    for (const scenario of SCENARIOS) {
      console.log(
        `  grupa ${String(scenario.group).padStart(2)}  ${scenario.name.padEnd(28)} ${scenario.pyta}`,
      );
    }
    console.log(`\nRazem: ${SCENARIOS.length} scenariuszy`);
    return;
  }

  if (!(process.env.ANTHROPIC_API_KEY ?? '').trim()) {
    console.error('Brak ANTHROPIC_API_KEY — ten skrypt woła prawdziwe API.');
    process.exit(1);
  }

  // PLAN JAWNIE, tak samo jak w `test/agent-tools.e2e-spec.ts`. Bez tego
  // świeże gospodarstwo wpada na PRÓBĘ (jeden zapis planu), więc scenariusze
  // planistyczne mierzyłyby paywall, a nie asystenta. Ustawienie działa
  // wyłącznie w procesie tego skryptu.
  process.env.AI_TIER_OVERRIDE ??= 'PRO';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const prisma = app.get(PrismaService);
  const deps: Deps = {
    prisma,
    prompts: app.get(AgentPromptService),
    tools: app.get(AgentToolExecutor),
    provider: app.get(AnthropicAgentProvider),
    memory: app.get(AgentMemoryService),
    catalog: await loadCatalog(prisma),
    ingredients: new Map(
      (
        await prisma.ingredient.findMany({ select: { id: true, name: true } })
      ).map((row) => [row.name.toLowerCase(), row.id]),
    ),
  };

  const baseEnv = readAgentEnv();
  const runs = Number(flag('runs') ?? '1');
  const only = list('only');
  const groups = list('group')?.map(Number);
  const configIds = list('config') ?? ['A'];
  const modelOverride = flag('model');
  const cardsMode = (flag('cards') ?? baseEnv.cardsMode) as
    | 'off'
    | 'soft'
    | 'strict';
  const concurrency = Math.max(1, Number(flag('concurrency') ?? '3'));
  // Przebieg na sucho: świat, narzędzia i `verify` bez modelu i bez rachunku.
  const dry = has('dry');
  const label = flag('label') ?? 'przebieg';
  const out =
    flag('out') ??
    `benchmark/agent-scenarios-${label}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;

  const chosenConfigs = CONFIGS.filter((config) =>
    configIds.includes(config.id),
  ).map((config) =>
    modelOverride ? { ...config, model: modelOverride } : config,
  );
  if (chosenConfigs.length === 0) {
    console.error(`Nie ma konfiguracji ${configIds.join(', ')}.`);
    process.exit(1);
  }
  const chosen = SCENARIOS.filter(
    (scenario) =>
      (!only || only.includes(scenario.name)) &&
      (!groups || groups.includes(scenario.group)),
  );
  if (chosen.length === 0) {
    console.error('Żaden scenariusz nie pasuje do filtrów.');
    process.exit(1);
  }

  type Job = { scenario: Scenario; config: BenchConfig; run: number };
  const jobs: Job[] = [];
  for (const config of chosenConfigs) {
    for (const scenario of chosen) {
      for (let run = 1; run <= runs; run += 1) {
        jobs.push({ scenario, config, run });
      }
    }
  }

  console.log(
    `Benchmark: ${chosen.length} scenariuszy × ${runs} przebiegow × ${chosenConfigs.length} konfiguracji = ${jobs.length} tur\n` +
      `Tryb kart: ${cardsMode}. Rownolegle: ${concurrency}. Wynik: ${out}\n`,
  );

  const records: RunRecord[] = [];
  let done = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      let record: RunRecord;
      try {
        record = await runOnce(
          deps,
          job.scenario,
          job.config,
          job.run,
          baseEnv,
          cardsMode,
          dry,
        );
      } catch (caught) {
        // Awaria HARNESSU (fixture, baza) — nie wolno jej pomylić z awarią
        // modelu, więc idzie do wyniku z własnym powodem.
        record = {
          scenario: job.scenario.name,
          group: job.scenario.group,
          pyta: job.scenario.pyta,
          config: job.config.id,
          configLabel: job.config.label,
          model: job.config.model,
          effort: job.config.effort,
          toolsModel: job.config.toolsModel,
          run: job.run,
          pass: false,
          issues: [
            `harness: ${caught instanceof Error ? caught.message : String(caught)}`,
          ],
          tools: [],
          handoff: false,
          apiCalls: 0,
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheHitRatio: 0,
          costMicroUsd: 0,
          stopReason: 'HARNESS_ERROR',
          weekPlanPayloadBytes: null,
          timings: [],
          answer: '',
          cards: [],
          error: caught instanceof Error ? caught.message : String(caught),
        };
      }
      records.push(record);
      done += 1;
      if (dry) {
        // Na sucho zastrzeżenia są NORMĄ (nikt nie ułożył planu). Awarią jest
        // wywrócone `verify` albo zepsuty fixture — i tylko to pokazujemy.
        const zepsute = record.issues.filter((issue) =>
          /^(harness:|fixture:|verify wywalilo sie)/.test(issue),
        );
        console.log(
          `[${String(done).padStart(3)}/${jobs.length}] ${record.scenario.padEnd(28)} ` +
            (zepsute.length === 0
              ? 'harness w porzadku'
              : `HARNESS DO POPRAWKI — ${zepsute.join(' | ')}`),
        );
        continue;
      }
      console.log(
        `[${String(done).padStart(3)}/${jobs.length}] ${record.config} ${record.scenario} #${record.run} — ` +
          `${record.pass ? 'w porzadku' : 'ZASTRZEZENIA'}  ` +
          `rund ${record.apiCalls}  $${(record.costMicroUsd / 1_000_000).toFixed(4)}  ` +
          `${Math.round(record.latencyMs / 1000)} s` +
          (record.pass ? '' : `\n      ${record.issues.join('\n      ')}`),
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );

  if (dry) {
    const zepsute = records.filter((record) =>
      record.issues.some((issue) =>
        /^(harness:|fixture:|verify wywalilo sie)/.test(issue),
      ),
    );
    console.log(
      `
NA SUCHO: ${records.length - zepsute.length} z ${records.length} scenariuszy ma sprawny harness.`,
    );
    if (zepsute.length > 0) {
      console.log('DO POPRAWKI PRZED WYDANIEM PIENIEDZY:');
      for (const record of zepsute) {
        console.log(`  ${record.scenario}: ${record.issues.join('; ')}`);
      }
    }
    await app.close();
    return;
  }

  records.sort(
    (a, b) =>
      a.config.localeCompare(b.config) ||
      a.group - b.group ||
      a.scenario.localeCompare(b.scenario) ||
      a.run - b.run,
  );
  printSummary(records);

  const path = resolve(process.cwd(), out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        label,
        startedAt: new Date().toISOString(),
        cardsMode,
        weekStart: WEEK_START,
        scenarios: chosen.length,
        runsPerScenario: runs,
        configs: chosenConfigs,
        aggregates: aggregate(records),
        records,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\nWyniki: ${path}`);

  await app.close();
}

main().catch((error: unknown) => {
  console.error('Scenariusze nie powiodły się:', error);
  process.exit(1);
});
