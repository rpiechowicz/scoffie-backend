/**
 * Sonda skali katalogu i gorących ścieżek (workstream, Etap 4) — bez modelu.
 *
 * Łapie regresje ARCHITEKTONICZNE (3 zapytania → 5003), a nie mikrosekundy:
 * dla każdego rozmiaru katalogu (domyślnie 5000 i 10000) buduje od zera
 * deterministyczny świat w bazie *_scale (`scripts/scale/scale-world.ts`)
 * i mierzy liczbę zapytań, czas i rozmiar odpowiedzi:
 * - pełne pobranie katalogu starym `recipes:findAll` (strony po 100) oraz
 *   synchronizacją `catalog:snapshot` / `catalog:changes` (gdy jest w kodzie),
 * - ścieżki asystenta: prompt, find_recipes, suggest_meals, build_meal_plan,
 *   karta z 3 daniami (odczyt stron dań),
 * - popularność (groupBy po PlanItem),
 * - 20 równoległych odczytów nieaktualnej listy zakupów (ile przebudów),
 * - `getTurn` RUNNING / DONE.
 *
 * NIE uruchamiać na produkcji ani na bazie dev: pisze wyłącznie do bazy,
 * której nazwa kończy się na `_scale` (TRUNCATE na starcie każdego rozmiaru).
 *
 *   SCALE_DATABASE_URL=postgresql://scoffie:scoffie@localhost:5432/scoffie_scale?schema=public \
 *     pnpm catalog:scale-probe --sizes 5000,10000 --out benchmark/catalog-scale-probe.json
 */
import { Test } from '@nestjs/testing';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { execFileSync } from 'child_process';
import { gzipSync } from 'zlib';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RecipesService } from '../src/recipes/recipes.service';
import { AgentPromptService } from '../src/agent/agent-prompt.service';
import { AgentToolExecutor } from '../src/agent/tools/agent-tool-executor';
import { AgentCatalogService } from '../src/agent/search/agent-catalog.service';
import { ShoppingListService } from '../src/weekly-plans/services/shopping-list.service';
import { AgentTurnsService } from '../src/agent/agent-turns.service';
import { createTurnMemo } from '../src/agent/turn-memo';
import * as world from './scale/scale-world';

/** Kształt usługi synchronizacji — probe działa też na kodzie sprzed niej. */
type CatalogSyncLike = {
  snapshot(input: {
    revision?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    revision: string;
    items: { id: string }[];
    nextCursor: string | null;
  }>;
  changes(input: { sinceRevision: string }): Promise<unknown>;
};

type QueryEvent = { query: string; duration: number };
type Sample = { queries: number; ms: number; bytes?: number; extra?: unknown };

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<void> {
  const url = process.env.SCALE_DATABASE_URL ?? '';
  world.assertScaleDatabase(url);
  // Prisma czyta DATABASE_URL przy KONSTRUKCJI klienta (niżej), nie przy imporcie.
  process.env.DATABASE_URL = url;
  process.env.AI_ENABLED = 'true';
  process.env.AI_PROVIDER = 'stub';
  process.env.AI_TIER_OVERRIDE ??= 'PRO';
  process.env.AI_CONSENT_REQUIRED = 'false';
  process.env.RECIPE_IMPORT_HOUSEHOLD_ID = world.SCALE_CATALOG_HOUSEHOLD;
  process.env.AI_CATALOG_MODE = 'search';
  // Synchronizacja katalogu istnieje od Etapu 4 — starszy kod mierzy się bez niej.
  type SyncModule = {
    CatalogSyncService: new (...args: never[]) => CatalogSyncLike;
  };
  let syncModule: SyncModule | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    syncModule = require('../src/recipes/catalog-sync.service') as SyncModule;
  } catch {
    syncModule = null;
  }

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

  const sizes = (flag('sizes') ?? '5000,10000')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => value > 0);
  const households = Number(flag('households') ?? '300');
  const weeks = Number(flag('weeks') ?? '4');
  const commit = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'])
        .toString()
        .trim();
    } catch {
      return 'unknown';
    }
  })();

  const prisma = new CountingPrisma();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  await moduleRef.init();
  const recipes = moduleRef.get(RecipesService);
  const prompts = moduleRef.get(AgentPromptService);
  const tools = moduleRef.get(AgentToolExecutor);
  const catalog = moduleRef.get(AgentCatalogService);
  const shopping = moduleRef.get(ShoppingListService);
  const turns = moduleRef.get(AgentTurnsService);
  const sync: CatalogSyncLike | null = syncModule
    ? moduleRef.get(syncModule.CatalogSyncService)
    : null;

  const measure = async (
    run: () => Promise<unknown>,
    size?: (value: unknown) => number,
  ): Promise<Sample & { value: unknown }> => {
    prisma.queries = 0;
    const started = performance.now();
    const value = await run();
    return {
      queries: prisma.queries,
      ms: Math.round(performance.now() - started),
      ...(size ? { bytes: size(value) } : {}),
      value,
    };
  };
  const strip = ({ value: _value, ...sample }: Sample & { value: unknown }) =>
    sample;
  const json = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

  const results: Record<string, unknown> = {};
  try {
    for (const recipesCount of sizes) {
      const out: Record<string, unknown> = {};
      process.stdout.write(`\n== katalog ${recipesCount} przepisów ==\n`);
      await world.resetScaleWorld(prisma);
      (catalog as unknown as { cached: null }).cached = null;
      (catalog as unknown as { popularity: null }).popularity = null;
      const seedStarted = performance.now();
      const built = await world.seedScaleWorld(prisma, {
        recipes: recipesCount,
        ingredients: 400,
        households,
        weeks,
      });
      out.seedMs = Math.round(performance.now() - seedStarted);
      out.planItems = await prisma.planItem.count();
      const [asia, rafal] = built.probe.userIds;
      const householdId = built.probe.householdId;

      // ── katalog: stary protokół (strony po 100 do końca) ───────────────
      const legacy = await measure(async () => {
        let page = 1;
        let rows = 0;
        let bytes = 0;
        for (;;) {
          const batch = await recipes.findAll(asia, {
            householdId,
            page,
            limit: 100,
          });
          rows += batch.length;
          bytes += json(batch);
          if (batch.length < 100) break;
          page += 1;
        }
        return { pages: page, rows, bytes };
      });
      out.legacyFullCatalog = {
        ...strip(legacy),
        ...(legacy.value as object),
        // iOS przed Etapem 4 przerywał po 40 stronach po 100.
        iosCapRows: Math.min((legacy.value as { rows: number }).rows, 4000),
      };

      // ── katalog: synchronizacja (Etap 4) ───────────────────────────────
      if (sync) {
        const snapshot = await measure(async () => {
          let cursor: string | null = null;
          let revision: string | undefined;
          let rows = 0;
          let bytes = 0;
          // Ile ważyłby transfer z kompresją permessage-deflate/gzip — ESTIMATE
          // (gzip strony JSON), do decyzji o kompresji transportu.
          let gzipBytes = 0;
          let pages = 0;
          const seen = new Set<string>();
          for (;;) {
            const page = await sync.snapshot({
              ...(revision ? { revision } : {}),
              ...(cursor ? { cursor } : {}),
              limit: 500,
            });
            pages += 1;
            revision = page.revision;
            bytes += json(page);
            gzipBytes += gzipSync(JSON.stringify(page)).length;
            for (const item of page.items) seen.add(item.id);
            rows += page.items.length;
            cursor = page.nextCursor;
            if (!cursor) break;
          }
          return { pages, rows, unique: seen.size, bytes, gzipBytes, revision };
        });
        out.syncSnapshot = {
          ...strip(snapshot),
          ...(snapshot.value as object),
        };
        const revision = (snapshot.value as { revision: string }).revision;

        const noChanges = await measure(
          () => sync.changes({ sinceRevision: revision }),
          json,
        );
        out.syncDeltaNoChanges = strip(noChanges);

        const changedId = built.catalogRecipeIds[42];
        await prisma.recipe.update({
          where: { id: changedId },
          data: { title: 'Danie zmienione w sondzie' },
        });
        const oneUpdate = await measure(
          () => sync.changes({ sinceRevision: revision }),
          json,
        );
        const updated = oneUpdate.value as {
          upserts: { id: string }[];
          tombstones: string[];
          revision: string;
        };
        out.syncDeltaOneUpdate = {
          ...strip(oneUpdate),
          upserts: updated.upserts.length,
          tombstones: updated.tombstones.length,
        };

        await prisma.recipe.update({
          where: { id: built.catalogRecipeIds[43] },
          data: { isActive: false },
        });
        const deactivate = await measure(
          () => sync.changes({ sinceRevision: updated.revision }),
          json,
        );
        const deactivated = deactivate.value as {
          upserts: unknown[];
          tombstones: string[];
        };
        out.syncDeltaDeactivate = {
          ...strip(deactivate),
          upserts: deactivated.upserts.length,
          tombstones: deactivated.tombstones.length,
        };
      }

      // ── asystent: prompt i narzędzia w jednej turze ────────────────────
      const conversation = await prisma.agentConversation.create({
        data: { userId: asia, householdId },
      });
      const question = await prisma.agentMessage.create({
        data: { conversationId: conversation.id, role: 'USER', text: 'sonda' },
      });
      const turn = await prisma.agentTurn.create({
        data: {
          conversationId: conversation.id,
          userId: asia,
          userMessageId: question.id,
          requestId: `scale-${recipesCount}`,
          draftText: 'Szukam kolacji…',
        },
      });
      const dates = {
        weekStart: world.SCALE_WEEK_START,
        clientToday: world.SCALE_WEEK_START,
        timeZone: 'Europe/Warsaw',
      };
      const agent: Record<string, Sample> = {};
      const coldCatalog = await measure(() => catalog.snapshot());
      agent.catalogIndexCold = strip(coldCatalog);
      for (const pass of ['cold', 'warm'] as const) {
        const memo = createTurnMemo();
        const prompt = await measure(() =>
          prompts.build(asia, householdId, dates, true, false, memo),
        );
        agent[`prompt.${pass}`] = strip(prompt);
        const context = {
          userId: asia,
          householdId,
          catalogIndex: (
            prompt.value as { catalogIndex: Record<string, string> }
          ).catalogIndex,
          conversationId: conversation.id,
          turnId: turn.id,
          proposalMode: true,
          dates: {
            weekStart: world.SCALE_WEEK_START,
            clientToday: world.SCALE_WEEK_START,
          },
          collectCard: () => undefined,
          memo,
        };
        const wishes = {
          diet: 'NONE',
          must_have_tags: [],
          prefer_tags: [],
          avoid_ingredients: [],
          max_prep_minutes: 0,
        };
        const run = (name: string, input: Record<string, unknown>) =>
          measure(
            () => tools.execute(name, input, context as never),
            (value) =>
              json(
                (value as { data?: unknown; error?: unknown }).data ??
                  (value as { error?: unknown }).error,
              ),
          );
        const find = await run('find_recipes', {
          query: '',
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
        });
        agent[`find_recipes.${pass}`] = strip(find);
        const hits = (
          (find.value as { data?: { hits?: { recipe: string }[] } }).data
            ?.hits ?? []
        ).map((hit) => hit.recipe);
        memo.releaseCard('suggest_meals');
        agent[`suggest_meals.${pass}`] = strip(
          await run('suggest_meals', {
            week_start: world.SCALE_WEEK_START,
            day_of_week: 'WED',
            meal_type: 'DINNER',
            count: 3,
            include_ingredients: [],
            for_user_ids: [],
            ...wishes,
          }),
        );
        memo.releaseCard('suggest_meals');
        agent[`offer_options_3.${pass}`] = strip(
          await run('offer_options', {
            title: 'Do wyboru',
            slot_label: 'Kolacja · środa',
            options: hits.slice(0, 3).map((recipe) => ({ recipe })),
          }),
        );
        memo.releaseCard('offer_options');
        agent[`build_meal_plan_day.${pass}`] = strip(
          await run('build_meal_plan', {
            week_start: world.SCALE_WEEK_START,
            days: ['THU'],
            meal_types: [],
            for_user_ids: [],
            ...wishes,
          }),
        );
        await prisma.agentProposal.deleteMany({ where: { turnId: turn.id } });
      }
      out.agent = agent;

      // ── popularność ────────────────────────────────────────────────────
      (catalog as unknown as { popularity: null }).popularity = null;
      const popularity = await measure(() =>
        (
          catalog as unknown as {
            popularityCounts(): Promise<Map<string, number>>;
          }
        ).popularityCounts(),
      );
      out.popularity = {
        ...strip(popularity),
        recipes: (popularity.value as Map<string, number>).size,
      };
      (catalog as unknown as { popularity: null }).popularity = null;
      const burst = await measure(() =>
        Promise.all(
          Array.from({ length: 10 }, () =>
            (
              catalog as unknown as {
                popularityCounts(): Promise<Map<string, number>>;
              }
            ).popularityCounts(),
          ),
        ),
      );
      out.popularityBurst10 = strip(burst);

      // ── lista zakupów: 20 równoległych odczytów nieaktualnej listy ────
      const proto = Object.getPrototypeOf(shopping) as Record<string, unknown>;
      const original = proto.rebuildShoppingListSnapshot as (
        ...args: unknown[]
      ) => Promise<unknown>;
      let rebuilds = 0;
      proto.rebuildShoppingListSnapshot = function (
        this: unknown,
        ...args: unknown[]
      ): Promise<unknown> {
        rebuilds += 1;
        return original.apply(this, args) as Promise<unknown>;
      };
      try {
        await shopping.getShoppingListState(
          asia,
          householdId,
          world.SCALE_WEEK_START,
        );
        await prisma.shoppingList.updateMany({
          where: { householdId },
          data: { isStale: true },
        });
        rebuilds = 0;
        const concurrent = await measure(() =>
          Promise.all(
            Array.from({ length: 20 }, (_, i) =>
              shopping.getShoppingListState(
                i % 2 ? asia : rafal,
                householdId,
                world.SCALE_WEEK_START,
              ),
            ),
          ),
        );
        out.shoppingStale20 = { ...strip(concurrent), rebuilds };
      } finally {
        proto.rebuildShoppingListSnapshot = original;
      }

      // ── getTurn ────────────────────────────────────────────────────────
      out.getTurnRunning = strip(
        await measure(() => turns.getTurn(asia, turn.id), json),
      );
      await prisma.agentTurn.update({
        where: { id: turn.id },
        data: { status: 'DONE', finishedAt: new Date() },
      });
      await prisma.agentMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'ASSISTANT',
          text: 'Gotowe.',
          turnId: turn.id,
        },
      });
      out.getTurnDone = strip(
        await measure(() => turns.getTurn(asia, turn.id), json),
      );

      results[String(recipesCount)] = out;
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    }
  } finally {
    await moduleRef.close();
  }

  const report = {
    measuredAt: new Date().toISOString(),
    commit,
    households,
    weeks,
    note: 'MEASURED lokalnie (Docker Postgres 16, jeden proces). Liczby zapytań są przenośne, czasy nie.',
    results,
  };
  const out = flag('out');
  if (out) {
    const path = resolve(process.cwd(), out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`\nzapisano ${path}\n`);
  }
}

void main();
