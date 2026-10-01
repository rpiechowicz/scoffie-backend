/**
 * System pisania scenariuszy Gotuj (Etap E3) — uruchamiany ręcznie.
 *
 * Dla każdego przepisu: autor (model) → walidatory twarde → recenzent (model)
 * → wersja VALIDATED / REJECTED / SKIPPED w `RecipeCookScenario`. NIC nie
 * publikuje: telefon nie widzi tych wersji, dopóki ktoś świadomie ich nie
 * opublikuje (panel, E3c, `publishWrittenScenario`).
 *
 * Dwa tryby, ta sama logika (`ScenarioJob`):
 * - na żywo (domyślnie) — wywołanie po wywołaniu, kilka przepisów naraz;
 * - `--batch` — Batch API: rundy paczek dla setek przepisów, pół ceny,
 *   wynik w minutach–godzinach (katalog).
 *
 * Bezpieczniki: tylko baza lokalna (zdalna wymaga COOK_WRITER_ALLOW_REMOTE=1);
 * twardy budżet (`--budget-usd`, rezerwacja najgorszego kosztu przed każdym
 * wywołaniem/paczką); model spoza cennika odrzucany.
 *
 * Uruchomienie:
 *   pnpm cook-scenarios:write --dry-run --pilot 20        # prompt bez API
 *   pnpm cook-scenarios:write --pilot 20 --limit 3        # pierwsze 3 z pilota
 *   pnpm cook-scenarios:write --batch --sample 50         # próba kontrolna
 *   pnpm cook-scenarios:write --batch --all --skip-written --budget-usd 40
 *   pnpm cook-scenarios:write --recipe <id> [--recipe <id>…]
 *   pnpm cook-scenarios:write --resume cook-scenarios-journal.json --budget-usd 60
 * Paczki: dziennik `--journal plik` (domyślnie cook-scenarios-journal.json)
 *   z id paczek w locie i stanem zadań; przerwa (sieć, budżet, proces) →
 *   `--resume` odbiera opłacone paczki i jedzie dalej; `--budget-usd` przy
 *   wznowieniu = łączny limit CAŁEJ serii.
 *   Dziennik ma wyłączną blokadę (`<dziennik>.lock`) — drugi proces odmówi;
 *   blokadę po padniętym procesie zdejmuje świadomie `--break-lock`.
 * Opcje: --limit N (najwyżej N przepisów faktycznie pisanych),
 *   --skip-written (pomija przepisy z aktualnym wynikiem dla obecnej treści),
 *   --concurrency 3 (tryb na żywo), --out raport.json.
 * Bramka jakości (paczki, po każdej rundzie, od 30 wyników): --gate-reject
 *   0.2 (udział REJECTED), --gate-cost 0.1 (średni $ na przepis),
 *   --no-gate. Na końcu: stan CAŁEGO katalogu przy obecnych zasadach.
 * Modele: COOK_WRITER_MODEL, COOK_REVIEWER_MODEL, COOK_WRITER_EFFORT,
 *   COOK_REVIEWER_EFFORT.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient, type Prisma } from '@prisma/client';
import { priceFor } from '../src/config/model-prices';
import {
  resolveGoldenContent,
  type GoldenScenarioFile,
} from '../src/recipes/cook-scenario/cook-scenario.golden';
import { COOK_SCENARIO_RULES_VERSION } from '../src/recipes/cook-scenario/cook-scenario.types';
import {
  checkScenarioAgainstRecipe,
  parseCookScenarioContent,
} from '../src/recipes/cook-scenario/cook-scenario.validate';
import { AnthropicWriterModel } from '../src/recipes/cook-scenario/writer/writer.anthropic';
import {
  AnthropicBatchModel,
  BatchStoppedError,
  runBatchRounds,
  type BatchJournal,
} from '../src/recipes/cook-scenario/writer/writer.batch';
import {
  BudgetedWriterModel,
  BudgetExceededError,
  BudgetGuard,
} from '../src/recipes/cook-scenario/writer/writer.budget';
import { qualityChecks } from '../src/recipes/cook-scenario/writer/writer.checks';
import {
  DEFAULT_WRITER_OPTIONS,
  ScenarioJob,
  writeCookScenario,
  type WriteOutcome,
  type WriterOptions,
} from '../src/recipes/cook-scenario/writer/writer.pipeline';
import {
  buildWriterSystem,
  buildWriterUser,
  COOK_WRITER_PROMPT_VERSION,
  REVIEWER_SYSTEM,
  type WriterExample,
} from '../src/recipes/cook-scenario/writer/writer.prompt';
import { acquireLock } from '../src/recipes/cook-scenario/writer/writer.lock';
import {
  batchReport,
  type ReportEntry,
} from '../src/recipes/cook-scenario/writer/writer.report';
import {
  loadWriterRecipe,
  saveWrittenScenario,
  type LoadedWriterRecipe,
} from '../src/recipes/cook-scenario/writer/writer.store';

const GOLDEN_FILE = 'prisma/catalog/cook-scenarios-pl-v1.json';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

interface Args {
  recipes: string[];
  pilot: number | null;
  sample: number | null;
  all: boolean;
  batch: boolean;
  limit: number | null;
  skipWritten: boolean;
  dryRun: boolean;
  budgetUsd: number;
  concurrency: number;
  out: string | null;
  journal: string | null;
  resume: string | null;
  breakLock: boolean;
  gateReject: number;
  gateCost: number;
  noGate: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    recipes: [],
    pilot: null,
    sample: null,
    all: false,
    batch: false,
    limit: null,
    skipWritten: false,
    dryRun: false,
    budgetUsd: 5,
    concurrency: 3,
    out: null,
    journal: null,
    resume: null,
    breakLock: false,
    gateReject: 0.2,
    gateCost: 0.1,
    noGate: false,
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
    else if (flag === '--sample') args.sample = Math.floor(positive(next()));
    else if (flag === '--all') args.all = true;
    else if (flag === '--batch') args.batch = true;
    else if (flag === '--limit') args.limit = Math.floor(positive(next()));
    else if (flag === '--skip-written') args.skipWritten = true;
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--budget-usd') args.budgetUsd = positive(next());
    else if (flag === '--concurrency')
      args.concurrency = Math.floor(positive(next()));
    else if (flag === '--out') args.out = next();
    else if (flag === '--journal') args.journal = next();
    else if (flag === '--resume') args.resume = next();
    else if (flag === '--break-lock') args.breakLock = true;
    else if (flag === '--gate-reject') args.gateReject = positive(next());
    else if (flag === '--gate-cost') args.gateCost = positive(next());
    else if (flag === '--no-gate') args.noGate = true;
    else throw new Error(`nieznana opcja ${flag}`);
  }
  if (
    !args.resume &&
    !args.recipes.length &&
    !args.pilot &&
    !args.sample &&
    !args.all
  ) {
    throw new Error(
      'podaj --recipe <id>, --pilot <N>, --sample <N>, --all albo --resume <dziennik>',
    );
  }
  // Katalog TYLKO przez Batch API (decyzja Rafała 30.09): bez `--batch`
  // fala poszłaby na żywo — bez rabatu i bez bramki jakości (review
  // Codexa, noc 1.10).
  if (args.all && !args.batch) {
    throw new Error('--all tylko z --batch — katalog idzie przez Batch API');
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

/** Kandydaci (bez wzorca — ten ma scenariusz pisany ręcznie). */
async function selectRecipes(
  prisma: PrismaClient,
  args: Args,
  exampleId: string,
): Promise<string[]> {
  const ids = [...args.recipes];
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
  if (args.sample || args.all) {
    // Próba: kolejność „losowa”, ale zawsze ta sama (skrót id) — próba
    // kontrolna i jej powtórka biorą te same przepisy.
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT r."id" FROM "Recipe" r
       WHERE r."isCatalog" AND r."isActive" AND r."id" <> ${exampleId}::uuid
         AND EXISTS (SELECT 1 FROM "RecipeIngredient" ri WHERE ri."recipeId" = r."id")
       ORDER BY md5(r."id"::text || 'gotuj'), r."id"`;
    const picked = args.all ? rows : rows.slice(0, args.sample ?? 0);
    ids.push(...picked.map((row) => row.id));
  }
  return [...new Set(ids)];
}

/**
 * Dziennik przebiegu paczek na dysku: stan zadań + id paczek w locie +
 * to, czego zapis potrzebuje (podpisy przepisów), + zasady i modele, żeby
 * wznowienie pisało dokładnie tak samo.
 */
type JournalFile = BatchJournal & {
  createdAt: string;
  promptVersion: string;
  rulesVersion: string;
  options: WriterOptions;
  signatures: Record<string, string>;
  /** sha256 promptu autora (z wzorcem) i recenzenta z początku serii. */
  promptHash: string;
};

async function readJournal(path: string): Promise<JournalFile> {
  const journal = JSON.parse(await readFile(path, 'utf8')) as JournalFile;
  if (journal.version !== 1)
    throw new Error(`${path}: nieznana wersja dziennika`);
  if (
    journal.promptVersion !== COOK_WRITER_PROMPT_VERSION ||
    journal.rulesVersion !== COOK_SCENARIO_RULES_VERSION
  ) {
    throw new Error(
      `${path}: dziennik z innych zasad/promptu (${journal.rulesVersion}/${journal.promptVersion}) — wznowienie pisałoby inaczej niż początek serii`,
    );
  }
  return journal;
}

async function writeJournal(path: string, journal: JournalFile) {
  // Zapis przez plik tymczasowy — urwany zapis nie zostawia połowy dziennika
  // — z WYMUSZENIEM na dysk (sync pliku przed zamianą, potem katalogu):
  // zapowiedź paczki musi przetrwać zanik prądu, zanim paczka pójdzie
  // (review Codexa).
  const handle = await open(`${path}.tmp`, 'w');
  try {
    await handle.writeFile(JSON.stringify(journal));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(`${path}.tmp`, path);
  try {
    const dir = await open(dirname(resolve(path)), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // Windows nie pozwala otworzyć katalogu — tam rename jest już trwały
    // na poziomie NTFS (dziennik metadanych).
  }
}

/**
 * Bramka jakości serii (review Codexa, noc 30.09): systemowy problem —
 * np. cała kategoria przepisów odrzucana — ma zatrzymać serię, zanim
 * zapłacimy za cały katalog. Udział REJECTED — od 30 zadań z wynikiem;
 * koszt — po wszystkich zadaniach serii.
 */
function qualityGate(
  jobs: ScenarioJob[],
  args: Args,
  final = false,
): string | null {
  if (!jobs.length) return null;
  // Wydatek WSZYSTKICH zadań serii (także w toku) na przepis — dolna granica
  // końcowej średniej, więc wolno ją sprawdzać od pierwszej rundy. Sama
  // średnia zakończonych byłaby zaniżona: tanie kończą się pierwsze, drogie
  // (poprawki) później (review Codexa, noc 30.09).
  const cost =
    jobs.reduce((sum, job) => sum + job.spentMicroUsd, 0) /
    jobs.length /
    1_000_000;
  // Po ostatniej rundzie koszt nie ma już czego bronić — tylko odrzucenia.
  if (!final && cost > args.gateCost) {
    return `wydatek ${cost.toFixed(3)} $ na przepis serii już teraz (próg ${args.gateCost} $)`;
  }
  const finished = jobs
    .filter((job) => job.hasResult)
    .map((job) => job.outcome());
  if (finished.length < 30) return null;
  const rejected = finished.filter((o) => o.status === 'REJECTED').length;
  if (rejected / finished.length > args.gateReject) {
    return `odrzuconych ${rejected} z ${finished.length} (próg ${Math.round(args.gateReject * 100)}%)`;
  }
  return null;
}

/**
 * Stan CAŁEGO katalogu przy obecnych zasadach (review Codexa, noc 30.09):
 * `--skip-written` pomija przepisy z wcześniejszych serii — także ich
 * REJECTED — więc sam raport serii nie mówi, ile naprawdę zostało.
 */
async function catalogSummary(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.$queryRaw<{ status: string; n: number }[]>`
    SELECT s."status", count(*)::int AS "n" FROM (
      SELECT DISTINCT ON (c."recipeId") c."status"::text AS "status"
        FROM "RecipeCookScenario" c
        JOIN "Recipe" r ON r."id" = c."recipeId"
       WHERE r."isCatalog" AND r."isActive"
         AND c."rulesVersion" = ${COOK_SCENARIO_RULES_VERSION}
         -- tylko wynik dla OBECNEJ treści przepisu (przegląd nocny)
         AND c."recipeContentHash" = recipe_content_signature(c."recipeId")
       ORDER BY c."recipeId", c."version" DESC) s
     GROUP BY 1 ORDER BY 1`;
  const [{ total }] = await prisma.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS "total" FROM "Recipe" r
     WHERE r."isCatalog" AND r."isActive"
       AND EXISTS (SELECT 1 FROM "RecipeIngredient" ri WHERE ri."recipeId" = r."id")`;
  const written = rows.reduce((sum, row) => sum + row.n, 0);
  return `katalog przy zasadach ${COOK_SCENARIO_RULES_VERSION}: ${rows.map((row) => `${row.status} ${row.n}`).join(' · ') || 'nic'} · bez wyniku ${total - written} (z ${total}, łącznie ze wzorcem)`;
}

/** Odcisk promptów serii — wznowienie musi pisać DOKŁADNIE tymi samymi. */
const promptHash = (example: WriterExample) =>
  createHash('sha256')
    .update(buildWriterSystem(example))
    .update('\u0000')
    .update(REVIEWER_SYSTEM)
    .digest('hex');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertLocalDatabase();
  // Wyłączna blokada dziennika PRZED jego odczytem czy utworzeniem — dwa
  // procesy na jednym dzienniku zapłaciłyby podwójnie (writer.lock.ts).
  // Domyślna nazwa z datą (review Codexa, noc 30.09): „.done” pilota nie
  // koliduje z kolejną serią.
  const journalPath =
    args.resume ??
    args.journal ??
    `cook-scenarios-journal-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  // Blokada GLOBALNA (na komputer) przed blokadą dziennika: paczki z konta
  // wysyła naraz jeden przebieg, więc przy wyszukiwaniu paczki o nieznanym
  // wyniku pasująca paczka w toku jest nasza, a nie z innej serii (review
  // Codexa). Kolejność zawsze ta sama — bez zakleszczeń.
  const releaseGlobal =
    args.batch || args.resume
      ? await acquireLock(join(homedir(), '.scoffie-cook-batch.lock'), {
          breakStale: args.breakLock,
        })
      : null;
  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock =
      args.batch || args.resume
        ? await acquireLock(`${journalPath}.lock`, {
            breakStale: args.breakLock,
          })
        : null;
  } catch (error) {
    await releaseGlobal?.();
    throw error;
  }
  const prisma = new PrismaClient();
  try {
    const resumed = args.resume ? await readJournal(args.resume) : null;
    // Wznowienie pisze tymi samymi modelami co początek serii.
    const options = resumed ? resumed.options : writerOptions();
    const example = await loadExample(prisma);
    if (resumed && resumed.promptHash !== promptHash(example)) {
      throw new Error(
        `${args.resume}: prompt serii różni się od obecnego (zmieniony wzorzec albo zasady) — wznowienie pisałoby inaczej niż początek serii; dokończ na starym kodzie albo zacznij nową serię`,
      );
    }
    const ids = resumed
      ? []
      : await selectRecipes(prisma, args, example.recipe.id);
    console.log(
      `${resumed ? `wznowienie ${args.resume} (zadań ${resumed.jobs.length})` : `kandydatów: ${ids.length}`}${args.limit ? ` (napisze najwyżej ${args.limit})` : ''} · ${args.batch || resumed ? 'Batch API' : 'na żywo'} · autor ${options.writerModel}/${options.writerEffort} · recenzent ${options.reviewerModel}/${options.reviewerEffort} · budżet ${args.budgetUsd} $${args.batch || resumed ? (args.noGate ? ' · bramka WYŁĄCZONA' : ` · bramka: odrzucone > ${Math.round(args.gateReject * 100)}%, koszt > ${args.gateCost} $`) : ''}`,
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
    // liczyłby się po stawce zastępczej, która może być za niska. Nowy
    // model = najpierw wpis w src/config/model-prices.ts.
    for (const name of [options.writerModel, options.reviewerModel]) {
      if (!priceFor(name).known) {
        throw new Error(
          `model ${name} nie ma ceny w src/config/model-prices.ts — bez niej budżet nie jest twardy`,
        );
      }
    }
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY jest pusty');
    const client = new Anthropic({ apiKey });
    // Budżet dotyczy CAŁEJ serii: przy wznowieniu startujemy od ROZLICZONEGO
    // (dziennik nie wlicza w nie paczek w locie — ich rezerwacje wracają
    // dokładnie raz, przy odbiorze paczki).
    const budget = new BudgetGuard(
      Math.round(args.budgetUsd * 1_000_000),
      resumed ? resumed.spentMicroUsd : 0,
    );

    const report: ReportEntry[] = [];
    let upToDate = 0;
    const generator = (
      outcome: WriteOutcome,
      transport: string,
    ): Prisma.InputJsonValue => ({
      source: 'writer',
      transport,
      promptVersion: COOK_WRITER_PROMPT_VERSION,
      writerModel: options.writerModel,
      writerEffort: options.writerEffort,
      reviewerModel: options.reviewerModel,
      reviewerEffort: options.reviewerEffort,
      attempts: outcome.attempts.length,
    });
    const save = async (
      loaded: Pick<LoadedWriterRecipe, 'recipe' | 'signature'>,
      outcome: WriteOutcome,
      transport: string,
      jobId?: string,
    ) => {
      const saved = await prisma.$transaction((tx) =>
        saveWrittenScenario(tx, {
          recipe: loaded.recipe,
          signature: loaded.signature,
          outcome,
          generator: generator(outcome, transport),
          jobId,
        }),
      );
      if (saved.duplicate) return;
      const costUsd = outcome.usage.costMicroUsd / 1_000_000;
      report.push({
        recipeId: loaded.recipe.id,
        title: loaded.recipe.title,
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
        `${saved.status.padEnd(9)} v${saved.version} · ${outcome.review ? `${outcome.review.score}/5` : '—'} · prób ${outcome.attempts.length} · ${costUsd.toFixed(3)} $ · ${loaded.recipe.title}`,
      );
    };
    const failed = (
      loaded: Pick<LoadedWriterRecipe, 'recipe'>,
      message: string,
    ) => {
      const overBudget = message === 'budżet wyczerpany';
      report.push({
        recipeId: loaded.recipe.id,
        title: loaded.recipe.title,
        status: overBudget ? 'BUDGET' : 'FAILED',
        failure: message,
      });
      console.log(
        `${overBudget ? 'BUDGET   ' : 'FAILED   '} · ${loaded.recipe.title}: ${message}`,
      );
    };

    let stoppedBatch: BatchStoppedError | null = null;
    if (args.batch || resumed) {
      let jobs: ScenarioJob[];
      const signatures: Record<string, string> = {};
      if (resumed) {
        jobs = resumed.jobs.map((state) =>
          ScenarioJob.restore(state, example, options),
        );
        Object.assign(signatures, resumed.signatures);
      } else {
        if (existsSync(journalPath)) {
          throw new Error(
            `dziennik ${journalPath} już istnieje — wznów (--resume ${journalPath}) albo usuń go świadomie`,
          );
        }
        // Wszystkie przepisy z jednej migawki na przepis; „już napisany”
        // rozstrzyga ta sama migawka, z której piszemy.
        jobs = [];
        for (const id of ids) {
          if (args.limit && jobs.length >= args.limit) break;
          const loaded = await loadWriterRecipe(prisma, id);
          if (!loaded) continue;
          if (args.skipWritten && loaded.current) {
            upToDate += 1;
            continue;
          }
          const job = new ScenarioJob(loaded.recipe, example, options);
          signatures[job.jobId] = loaded.signature;
          jobs.push(job);
        }
      }
      console.log(
        `w paczkach: ${jobs.length} przepisów · dziennik ${journalPath}`,
      );
      const createdAt = resumed?.createdAt ?? new Date().toISOString();
      // Znacznik serii w id pozycji paczek (wyszukiwanie paczki o nieznanym
      // wyniku nie pomyli jej z inną serią).
      const runId = resumed?.runId ?? randomBytes(3).toString('hex');
      try {
        await runBatchRounds(
          jobs,
          new AnthropicBatchModel(client, budget, (line) => console.log(line)),
          {
            // Tylko zadania z wynikiem; nieudane raportujemy na końcu.
            onDone: (job) =>
              save(
                { recipe: job.recipe, signature: signatures[job.jobId] },
                job.outcome(),
                'batch',
                job.jobId,
              ),
            log: (line) => console.log(line),
            persist: (journal) =>
              writeJournal(journalPath, {
                ...journal,
                createdAt,
                promptVersion: COOK_WRITER_PROMPT_VERSION,
                rulesVersion: COOK_SCENARIO_RULES_VERSION,
                options,
                signatures,
                promptHash: promptHash(example),
              }),
            spentMicroUsd: () => budget.spentMicroUsd,
            resume: resumed ?? undefined,
            runId,
            gate: args.noGate
              ? undefined
              : (final) => qualityGate(jobs, args, final),
          },
        );
        // Seria skończona — dziennik zostaje obok jako ślad, pod inną nazwą.
        await rename(journalPath, `${journalPath}.done`);
      } catch (error) {
        if (!(error instanceof BatchStoppedError)) throw error;
        stoppedBatch = error;
      }
      // Raport z CAŁEJ serii (także sprzed wznowienia i zapisów-duplikatów):
      // status i wersja z bazy po kluczu zadania.
      const rows = await prisma.$queryRaw<
        { jobId: string; version: number; status: string }[]
      >`
        SELECT "validationReport"->>'jobId' AS "jobId", "version", "status"::text AS "status"
          FROM "RecipeCookScenario"
         WHERE "validationReport"->>'jobId' = ANY(${jobs.map((job) => job.jobId)}::text[])`;
      report.splice(
        0,
        report.length,
        ...batchReport(jobs, new Map(rows.map((row) => [row.jobId, row]))),
      );
      for (const entry of report) {
        if (entry.failure) {
          console.log(
            `${entry.status.padEnd(9)} · ${entry.title}: ${entry.failure}`,
          );
        }
      }
    } else {
      const model = new BudgetedWriterModel(
        new AnthropicWriterModel(client),
        budget,
      );
      let stopped = false;
      let started = 0;
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
          try {
            const outcome = await writeCookScenario(
              model,
              loaded.recipe,
              example,
              options,
            );
            await save(loaded, outcome, 'live');
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (error instanceof BudgetExceededError) {
              stopped = true;
              failed(loaded, 'budżet wyczerpany');
            } else {
              failed(loaded, message);
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(args.concurrency, ids.length) }, worker),
      );
    }

    const count = (status: string) =>
      report.filter((r) => r.status === status).length;
    console.log(
      `\nVALIDATED ${count('VALIDATED')} · REJECTED ${count('REJECTED')} · SKIPPED ${count('SKIPPED')} · STALE ${count('STALE')} · FAILED ${count('FAILED')} · BUDGET ${count('BUDGET')}${count('PENDING') + count('UNSAVED') ? ` · W TOKU ${count('PENDING')} · NIEZAPISANE ${count('UNSAVED')}` : ''}`,
    );
    console.log(`koszt: ${(budget.spentMicroUsd / 1_000_000).toFixed(3)} $`);
    if (upToDate) {
      console.log(`pominięte (wynik aktualny dla obecnej treści): ${upToDate}`);
    }
    if (count('BUDGET')) {
      console.log(
        `ZATRZYMANO: budżet ${args.budgetUsd} $ nie wystarcza — reszta po doładowaniu (--skip-written dokończy)`,
      );
    }
    if (stoppedBatch) {
      console.log(
        `\nZATRZYMANO: ${stoppedBatch.message}. Stan jest w dzienniku — dokończ: pnpm cook-scenarios:write --resume ${journalPath} --budget-usd <łączny limit serii>`,
      );
      process.exitCode = 2;
    }
    if (args.out) {
      await writeFile(args.out, JSON.stringify(report, null, 2));
      console.log(`raport: ${args.out}`);
    }
    console.log(await catalogSummary(prisma));
  } finally {
    await prisma.$disconnect();
    await releaseLock?.();
    await releaseGlobal?.();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
