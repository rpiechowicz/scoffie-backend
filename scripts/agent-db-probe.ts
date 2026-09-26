/**
 * Ile zapytań do bazy robią ścieżki asystenta — pomiar LOKALNY, bez modelu.
 *
 * Baseline workstreamu `docs/workstreams/assistant-backend-optimization/`
 * (Etap 0): liczba zapytań i czas na budowie promptu, `find_recipes`,
 * `start_planning` i jednym odpytaniu tury (`GET /agent/turns/:id` na
 * poziomie serwisu — BEZ strażnika JWT, który dokłada swój odczyt konta).
 * Te same liczby mają dać się zmierzyć po Etapach 3–4, żeby porównanie
 * przed/po było na tym samym narzędziu.
 *
 * Nie woła modelu, nie potrzebuje klucza API i nie zapisuje nic poza
 * tymczasowym gospodarstwem, które kasuje na końcu. NIE uruchamiać na
 * produkcji (zakłada użytkowników i dom).
 *
 * Uruchomienie (lokalna baza z katalogiem):
 *   pnpm exec ts-node -r tsconfig-paths/register scripts/agent-db-probe.ts
 *   … --runs 5 --out benchmark/db-probe.json
 */
import { Test } from '@nestjs/testing';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AgentPromptService } from '../src/agent/agent-prompt.service';
import { AgentToolExecutor } from '../src/agent/tools/agent-tool-executor';
import { AgentTurnsService } from '../src/agent/agent-turns.service';
import { AgentCatalogService } from '../src/agent/search/agent-catalog.service';
import { LEGAL_DOCUMENT_VERSIONS } from '../src/common/legal-documents';

const WEEK_START = '2026-09-28';

type QueryEvent = { query: string; duration: number };

/** Klient Prismy, który liczy zapytania (zdarzenia `query`). */
class CountingPrisma extends PrismaService {
  queries = 0;
  dbMs = 0;
  constructor() {
    super({ log: [{ emit: 'event', level: 'query' }] });
    (
      this as unknown as {
        $on(event: 'query', cb: (e: QueryEvent) => void): void;
      }
    ).$on('query', (event) => {
      this.queries += 1;
      this.dbMs += event.duration;
    });
  }
  reset(): void {
    this.queries = 0;
    this.dbMs = 0;
  }
}

type Sample = { queries: number; dbMs: number; wallMs: number };

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function main(): Promise<void> {
  const runs = Math.max(1, Number(flag('runs') ?? '5'));
  process.env.AI_ENABLED = 'true';
  // `getTurn` przechodzi przez `assertEnabled`, który wymaga skonfigurowanego
  // dostawcy; `stub` nim jest, a sonda i tak nie woła modelu.
  process.env.AI_PROVIDER = 'stub';
  process.env.AI_TIER_OVERRIDE ??= 'PRO';
  const prisma = new CountingPrisma();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  await moduleRef.init();
  const prompts = moduleRef.get(AgentPromptService);
  const tools = moduleRef.get(AgentToolExecutor);
  const turns = moduleRef.get(AgentTurnsService);
  const catalog = moduleRef.get(AgentCatalogService);

  // Świat: dwie osoby (Ania ze zgodą i dietą, Bartek bez zgody z alergią),
  // plan na kilka dni — tyle, żeby każda ścieżka miała co czytać.
  const stamp = `${Date.now()}`;
  const ania = await prisma.user.create({
    data: {
      displayName: 'Ania',
      email: `probe-${stamp}-a@agent.local`,
      authProvider: 'DEV',
      preferences: { create: { dietPreference: 'VEGETARIAN' } },
    },
  });
  const bartek = await prisma.user.create({
    data: {
      displayName: 'Bartek',
      email: `probe-${stamp}-b@agent.local`,
      authProvider: 'DEV',
      preferences: { create: { allergens: ['NUTS'] } },
    },
  });
  await prisma.consentEvent.create({
    data: {
      userId: ania.id,
      kind: 'AI_ASSISTANT',
      action: 'GRANTED',
      documentVersion: LEGAL_DOCUMENT_VERSIONS.AI_ASSISTANT,
    },
  });
  const household = await prisma.household.create({
    data: { name: `Sonda ${stamp}`, createdById: ania.id },
  });
  await prisma.membership.createMany({
    data: [
      { userId: ania.id, householdId: household.id, role: 'OWNER' },
      { userId: bartek.id, householdId: household.id, role: 'MEMBER' },
    ],
  });
  const plan = await prisma.weeklyPlan.create({
    data: {
      householdId: household.id,
      weekStart: new Date(`${WEEK_START}T00:00:00.000Z`),
    },
  });
  const dinners = await prisma.recipe.findMany({
    where: {
      isCatalog: true,
      isActive: true,
      suitableMealTypes: { has: 'DINNER' },
    },
    take: 4,
    select: { id: true },
  });
  const days = ['MON', 'TUE', 'WED', 'THU'] as const;
  await prisma.planItem.createMany({
    data: dinners.map((recipe, index) => ({
      weeklyPlanId: plan.id,
      recipeId: recipe.id,
      dayOfWeek: days[index],
      mealType: 'DINNER' as const,
      plannedServings: 2,
    })),
  });
  const conversation = await prisma.agentConversation.create({
    data: { userId: ania.id, householdId: household.id },
  });
  const question = await prisma.agentMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'USER',
      text: 'Co na kolację?',
    },
  });
  const running = await prisma.agentTurn.create({
    data: {
      conversationId: conversation.id,
      userId: ania.id,
      userMessageId: question.id,
      requestId: `probe-${stamp}`,
      draftText: 'Szukam czegoś lekkiego na dzisiejszą kolację…',
      progress: [
        {
          tool: 'find_recipes',
          label: 'Szukam pasujących dań',
          at: new Date().toISOString(),
        },
      ],
    },
  });
  const question2 = await prisma.agentMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'USER',
      text: 'A na obiad?',
    },
  });
  const done = await prisma.agentTurn.create({
    data: {
      conversationId: conversation.id,
      userId: ania.id,
      userMessageId: question2.id,
      requestId: `probe-${stamp}-2`,
      status: 'DONE',
      finishedAt: new Date(),
    },
  });
  await prisma.agentMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'ASSISTANT',
      text: 'Proponuję gulasz.',
      turnId: done.id,
    },
  });

  // Pierwszy odczyt katalogu (zimny indeks w pamięci) — PRZED czymkolwiek,
  // co by go zbudowało.
  prisma.reset();
  const coldStarted = performance.now();
  await catalog.snapshot();
  const coldSnapshot: Sample = {
    queries: prisma.queries,
    dbMs: Math.round(prisma.dbMs),
    wallMs: Math.round(performance.now() - coldStarted),
  };

  const dates = {
    weekStart: WEEK_START,
    clientToday: WEEK_START,
    timeZone: 'Europe/Warsaw',
  };
  const index = (await prompts.build(ania.id, household.id, dates, true))
    .catalogIndex;
  const context = {
    userId: ania.id,
    householdId: household.id,
    catalogIndex: index,
    conversationId: conversation.id,
    turnId: running.id,
    proposalMode: true,
    dates: { weekStart: WEEK_START, clientToday: WEEK_START },
    collectCard: () => undefined,
  };
  const criteria = {
    query: 'coś lekkiego',
    meal_type: 'DINNER',
    tags: [],
    include_ingredients: [],
    exclude_ingredients: [],
    max_prep_minutes: 0,
    max_kcal_per_serving: 0,
    min_protein_per_serving: 0,
    for_user_ids: [],
    sort: 'BEST_FIT',
    limit: 8,
  };

  const paths: Record<string, () => Promise<unknown>> = {
    'prompt.build (search)': () => {
      process.env.AI_CATALOG_MODE = 'search';
      return prompts.build(ania.id, household.id, dates, true);
    },
    'prompt.build (digest)': () => {
      process.env.AI_CATALOG_MODE = 'digest';
      return prompts.build(ania.id, household.id, dates, true);
    },
    find_recipes: () => tools.execute('find_recipes', criteria, context),
    start_planning: () =>
      tools.execute('start_planning', { reason: 'tydzień' }, context),
    'getTurn RUNNING': () => turns.getTurn(ania.id, running.id),
    'getTurn DONE': () => turns.getTurn(ania.id, done.id),
  };

  const results: Record<
    string,
    { samples: Sample[]; median: Sample; promptChars?: number }
  > = {};
  try {
    let started = 0;
    for (const [label, run] of Object.entries(paths)) {
      const samples: Sample[] = [];
      for (let i = 0; i < runs; i += 1) {
        prisma.reset();
        started = performance.now();
        await run();
        samples.push({
          queries: prisma.queries,
          dbMs: Math.round(prisma.dbMs),
          wallMs: Math.round(performance.now() - started),
        });
      }
      results[label] = {
        samples,
        median: {
          queries: median(samples.map((s) => s.queries)),
          dbMs: median(samples.map((s) => s.dbMs)),
          wallMs: median(samples.map((s) => s.wallMs)),
        },
      };
    }
    process.env.AI_CATALOG_MODE = 'search';
    const searchPrompt = await prompts.build(
      ania.id,
      household.id,
      dates,
      true,
    );
    process.env.AI_CATALOG_MODE = 'digest';
    const digestPrompt = await prompts.build(
      ania.id,
      household.id,
      dates,
      true,
    );
    delete process.env.AI_CATALOG_MODE;
    results['prompt.build (search)'].promptChars = searchPrompt.system
      .map((block) => block.text.length)
      .reduce((a, b) => a + b, 0);
    results['prompt.build (digest)'].promptChars = digestPrompt.system
      .map((block) => block.text.length)
      .reduce((a, b) => a + b, 0);

    console.log(`Zimny indeks katalogu: ${JSON.stringify(coldSnapshot)}`);
    console.log(
      'ścieżka                    | zapytań (med) | DB ms (med) | ściana ms (med) | znaki promptu',
    );
    for (const [label, entry] of Object.entries(results)) {
      console.log(
        `${label.padEnd(26)} | ${String(entry.median.queries).padStart(13)} | ` +
          `${String(entry.median.dbMs).padStart(11)} | ${String(entry.median.wallMs).padStart(15)} | ` +
          `${entry.promptChars ?? ''}`,
      );
    }
    const out = flag('out');
    if (out) {
      const path = resolve(process.cwd(), out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify(
          { measuredAt: new Date().toISOString(), runs, coldSnapshot, results },
          null,
          2,
        ),
        'utf8',
      );
      console.log(`Wyniki: ${path}`);
    }
  } finally {
    await prisma.household.deleteMany({ where: { id: household.id } });
    await prisma.user.deleteMany({
      where: { id: { in: [ania.id, bartek.id] } },
    });
    await moduleRef.close();
  }
}

main().catch((error: unknown) => {
  console.error('Sonda nie powiodła się:', error);
  process.exit(1);
});
