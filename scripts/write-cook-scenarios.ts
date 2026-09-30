/**
 * System pisania scenariuszy Gotuj (Etap E3a) — uruchamiany ręcznie.
 *
 * Dla każdego przepisu: autor (model) → walidatory twarde → recenzent (model)
 * → wersja VALIDATED / REJECTED / SKIPPED w `RecipeCookScenario`. NIC nie
 * publikuje: telefon nie widzi tych wersji, dopóki ktoś świadomie ich nie
 * opublikuje (panel, E3c).
 *
 * Bezpiecznik: działa tylko na bazie lokalnej. Zdalna (Railway) wymaga
 * jawnego COOK_WRITER_ALLOW_REMOTE=1 — i świadomej decyzji, bo to koszt API
 * i zapis do cudzej bazy.
 *
 * Uruchomienie:
 *   pnpm cook-scenarios:write --dry-run --pilot 20        # prompt bez API
 *   pnpm cook-scenarios:write --pilot 20 --limit 3        # pierwsze 3 z pilota
 *   pnpm cook-scenarios:write --pilot 20 --skip-written   # reszta pilota
 *   pnpm cook-scenarios:write --recipe <id> [--recipe <id>…]
 * Opcje: --budget-usd 5 (twardy limit: wywołanie, na które nie starczy
 *   w najgorszym razie, się nie odbywa), --concurrency 3,
 *   --out raport.json. Modele: COOK_WRITER_MODEL, COOK_REVIEWER_MODEL,
 *   COOK_WRITER_EFFORT, COOK_REVIEWER_EFFORT.
 */
import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  resolveGoldenContent,
  type GoldenScenarioFile,
} from '../src/recipes/cook-scenario/cook-scenario.golden';
import type { CookScenarioContent } from '../src/recipes/cook-scenario/cook-scenario.types';
import {
  checkScenarioAgainstRecipe,
  parseCookScenarioContent,
} from '../src/recipes/cook-scenario/cook-scenario.validate';
import { priceFor } from '../src/config/model-prices';
import { AnthropicWriterModel } from '../src/recipes/cook-scenario/writer/writer.anthropic';
import {
  BudgetedWriterModel,
  BudgetExceededError,
  BudgetGuard,
} from '../src/recipes/cook-scenario/writer/writer.budget';
import { qualityChecks } from '../src/recipes/cook-scenario/writer/writer.checks';
import {
  DEFAULT_WRITER_OPTIONS,
  writeCookScenario,
  type WriterOptions,
} from '../src/recipes/cook-scenario/writer/writer.pipeline';
import {
  buildWriterSystem,
  buildWriterUser,
  COOK_WRITER_PROMPT_VERSION,
  type WriterExample,
} from '../src/recipes/cook-scenario/writer/writer.prompt';
import {
  loadWriterRecipe,
  saveWrittenScenario,
} from '../src/recipes/cook-scenario/writer/writer.store';

const GOLDEN_FILE = 'prisma/catalog/cook-scenarios-pl-v1.json';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

interface Args {
  recipes: string[];
  pilot: number | null;
  limit: number | null;
  skipWritten: boolean;
  dryRun: boolean;
  budgetUsd: number;
  concurrency: number;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    recipes: [],
    pilot: null,
    limit: null,
    skipWritten: false,
    dryRun: false,
    budgetUsd: 5,
    concurrency: 3,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag}: brak wartości`);
      return value;
    };
    const positive = (value: string) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag}: liczba > 0`);
      return n;
    };
    if (flag === '--') continue;
    else if (flag === '--recipe') args.recipes.push(next());
    else if (flag === '--pilot') args.pilot = Math.floor(positive(next()));
    else if (flag === '--limit') args.limit = Math.floor(positive(next()));
    else if (flag === '--skip-written') args.skipWritten = true;
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--budget-usd') args.budgetUsd = positive(next());
    else if (flag === '--concurrency')
      args.concurrency = Math.floor(positive(next()));
    else if (flag === '--out') args.out = next();
    else throw new Error(`nieznana opcja ${flag}`);
  }
  if (!args.recipes.length && !args.pilot) {
    throw new Error('podaj --recipe <id> albo --pilot <N>');
  }
  return args;
}

function assertLocalDatabase() {
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('DATABASE_URL: nie da się odczytać hosta');
  }
  const local = ['localhost', '127.0.0.1', '::1', 'db', 'scoffie-db'];
  if (!local.includes(host) && process.env.COOK_WRITER_ALLOW_REMOTE !== '1') {
    throw new Error(
      `baza ${host} nie jest lokalna — system pisania działa tylko lokalnie (COOK_WRITER_ALLOW_REMOTE=1 świadomie)`,
    );
  }
}

function writerOptions(): WriterOptions {
  const effort = (name: string, fallback: WriterOptions['writerEffort']) => {
    const raw = (process.env[name] ?? '').trim();
    if (!raw) return fallback;
    if (!(EFFORTS as readonly string[]).includes(raw)) {
      throw new Error(`${name}=${raw} — dozwolone: ${EFFORTS.join(', ')}`);
    }
    return raw as WriterOptions['writerEffort'];
  };
  return {
    ...DEFAULT_WRITER_OPTIONS,
    writerModel:
      process.env.COOK_WRITER_MODEL?.trim() ||
      DEFAULT_WRITER_OPTIONS.writerModel,
    reviewerModel:
      process.env.COOK_REVIEWER_MODEL?.trim() ||
      DEFAULT_WRITER_OPTIONS.reviewerModel,
    writerEffort: effort(
      'COOK_WRITER_EFFORT',
      DEFAULT_WRITER_OPTIONS.writerEffort,
    ),
    reviewerEffort: effort(
      'COOK_REVIEWER_EFFORT',
      DEFAULT_WRITER_OPTIONS.reviewerEffort,
    ),
  };
}

/**
 * Wzorzec do promptu: scenariusz kotleta z pliku + przepis z TEJ bazy.
 * Musi przejść te same walidatory co scenariusze modelu — inaczej prompt
 * uczyłby rzeczy, za które potem odrzucamy.
 */
async function loadExample(prisma: PrismaClient): Promise<WriterExample> {
  const file = JSON.parse(
    await readFile(GOLDEN_FILE, 'utf8'),
  ) as GoldenScenarioFile;
  const entry = file.scenarios[0];
  const loaded = await loadWriterRecipe(prisma, entry.recipeId);
  if (!loaded)
    throw new Error(`wzorzec: brak przepisu ${entry.recipeId} w bazie`);
  const byName = new Map(
    loaded.recipe.ingredients.map((row) => [row.name, row.ingredientId]),
  );
  const resolved = resolveGoldenContent(entry.content, (name) =>
    byName.get(name),
  );
  const parsed = parseCookScenarioContent(resolved.content);
  const errors = [...resolved.errors, ...parsed.errors];
  if (parsed.content) {
    errors.push(
      ...checkScenarioAgainstRecipe(parsed.content, loaded.recipe),
      ...qualityChecks(loaded.recipe, parsed.content).errors,
    );
  }
  if (errors.length || !parsed.content) {
    throw new Error(
      `wzorzec nie przechodzi walidatorów:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return { recipe: loaded.recipe, content: parsed.content };
}

async function selectRecipes(
  prisma: PrismaClient,
  args: Args,
  exampleId: string,
): Promise<string[]> {
  let ids = [...args.recipes];
  if (args.pilot) {
    // Pilot: po jednym przepisie z każdego rodzaju dania — deterministycznie.
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (coalesce(r."dishType", '')) r."id"
        FROM "Recipe" r
       WHERE r."isCatalog" AND r."isActive" AND r."id" <> ${exampleId}::uuid
         AND EXISTS (SELECT 1 FROM "RecipeIngredient" ri WHERE ri."recipeId" = r."id")
       ORDER BY coalesce(r."dishType", ''), r."id"`;
    ids.push(...rows.slice(0, args.pilot).map((row) => row.id));
  }
  ids = [...new Set(ids)];
  return ids;
}

interface ReportEntry {
  recipeId: string;
  title: string;
  status: string;
  version?: number;
  score?: number;
  attempts?: number;
  costUsd?: number;
  skipReason?: string | null;
  warnings?: string[];
  review?: unknown;
  errors?: string[];
  content?: CookScenarioContent | null;
  failure?: string;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertLocalDatabase();
  const prisma = new PrismaClient();
  try {
    const options = writerOptions();
    const example = await loadExample(prisma);
    const ids = await selectRecipes(prisma, args, example.recipe.id);
    console.log(
      `kandydatów: ${ids.length}${args.limit ? ` (napisze najwyżej ${args.limit})` : ''} · autor ${options.writerModel}/${options.writerEffort} · recenzent ${options.reviewerModel}/${options.reviewerEffort} · budżet ${args.budgetUsd} $`,
    );

    if (args.dryRun) {
      const system = buildWriterSystem(example);
      console.log(`\n=== SYSTEM (${system.length} znaków) ===\n${system}`);
      const first = ids[0] ? await loadWriterRecipe(prisma, ids[0]) : null;
      if (first) {
        console.log(`\n=== USER ===\n${buildWriterUser(first.recipe)}`);
      }
      return;
    }

    // Twardy limit ma sens tylko przy znanej cenie: model spoza cennika
    // liczyłby się po stawce zastępczej, która może być za niska (review
    // Codexa, E3a runda 3). Nowy model = najpierw wpis w src/config/model-prices.ts.
    for (const name of [options.writerModel, options.reviewerModel]) {
      if (!priceFor(name).known) {
        throw new Error(
          `model ${name} nie ma ceny w src/config/model-prices.ts — bez niej budżet nie jest twardy`,
        );
      }
    }
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY jest pusty');
    // Twardy limit: każde wywołanie modelu rezerwuje najgorszy koszt, zanim
    // pójdzie; bez budżetu wywołanie się nie odbywa (writer.budget.ts).
    const budget = new BudgetGuard(Math.round(args.budgetUsd * 1_000_000));
    const model = new BudgetedWriterModel(
      new AnthropicWriterModel(new Anthropic({ apiKey })),
      budget,
    );

    const report: ReportEntry[] = [];
    let stopped = false;
    let started = 0;
    let upToDate = 0;
    const queue = [...ids];

    const worker = async () => {
      while (queue.length && !stopped) {
        const recipeId = queue.shift()!;
        const loaded = await loadWriterRecipe(prisma, recipeId);
        if (!loaded) {
          report.push({
            recipeId,
            title: '?',
            status: 'FAILED',
            failure: 'brak przepisu',
          });
          continue;
        }
        // „Już napisany” rozstrzyga ta sama migawka, z której piszemy
        // (loadWriterRecipe) — nie osobny odczyt przy wyborze listy.
        if (args.skipWritten && loaded.current) {
          upToDate += 1;
          continue;
        }
        // Sprawdzenie i zwiększenie bez `await` pomiędzy — równoległe
        // wątki nie przekroczą --limit.
        if (args.limit && started >= args.limit) {
          stopped = true;
          break;
        }
        started += 1;
        const { recipe, signature } = loaded;
        try {
          const outcome = await writeCookScenario(
            model,
            recipe,
            example,
            options,
          );
          const generator: Prisma.InputJsonValue = {
            source: 'writer',
            promptVersion: COOK_WRITER_PROMPT_VERSION,
            writerModel: options.writerModel,
            writerEffort: options.writerEffort,
            reviewerModel: options.reviewerModel,
            reviewerEffort: options.reviewerEffort,
            attempts: outcome.attempts.length,
          };
          const saved = await prisma.$transaction((tx) =>
            saveWrittenScenario(tx, {
              recipe,
              signature,
              outcome,
              generator,
            }),
          );
          const costUsd = outcome.usage.costMicroUsd / 1_000_000;
          report.push({
            recipeId,
            title: recipe.title,
            status: saved.status,
            version: saved.version,
            score: outcome.review?.score,
            attempts: outcome.attempts.length,
            costUsd,
            skipReason: outcome.skipReason,
            warnings: outcome.warnings,
            review: outcome.review,
            errors: outcome.attempts.flatMap((a) => a.errors),
            content: outcome.content,
          });
          console.log(
            `${saved.status.padEnd(9)} v${saved.version} · ${outcome.review ? `${outcome.review.score}/5` : '—'} · prób ${outcome.attempts.length} · ${costUsd.toFixed(3)} $ · ${recipe.title}`,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          // Brak budżetu: przepis nie zapisany (bez pełnego przejścia nie ma
          // czego zapisać), a reszta serii staje.
          const overBudget = error instanceof BudgetExceededError;
          if (overBudget) stopped = true;
          report.push({
            recipeId,
            title: recipe.title,
            status: overBudget ? 'BUDGET' : 'FAILED',
            failure: message,
          });
          console.log(
            `${overBudget ? 'BUDGET   ' : 'FAILED   '} · ${recipe.title}: ${message}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(args.concurrency, ids.length) }, worker),
    );

    const count = (status: string) =>
      report.filter((r) => r.status === status).length;
    console.log(
      `\nVALIDATED ${count('VALIDATED')} · REJECTED ${count('REJECTED')} · SKIPPED ${count('SKIPPED')} · STALE ${count('STALE')} · FAILED ${count('FAILED')} · BUDGET ${count('BUDGET')}`,
    );
    console.log(`koszt: ${(budget.spentMicroUsd / 1_000_000).toFixed(3)} $`);
    if (upToDate) {
      console.log(`pominięte (wynik aktualny dla obecnej treści): ${upToDate}`);
    }
    if (count('BUDGET')) {
      console.log(
        `ZATRZYMANO: budżet ${args.budgetUsd} $ nie wystarcza na kolejne wywołanie`,
      );
    }
    if (args.out) {
      await writeFile(args.out, JSON.stringify(report, null, 2));
      console.log(`raport: ${args.out}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
