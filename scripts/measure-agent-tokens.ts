/**
 * Mierzy digest katalogu przez `count_tokens` — krok 4 Fazy 0.
 *
 * Model kosztowy (`docs/plans/weekly-meals-ai-agent/cost-model.md`) stoi na
 * SZACUNKACH: 75 tokenów bazy na linię × 1,3 (tokenizer) × 1,3 (polski) =
 * ~127, czyli 11 534 tokenów digestu i 16 734 całego stałego prefiksu. Digest
 * to najgrubszy składnik prefiksu, a prefiks jedzie w KAŻDYM zapytaniu, więc
 * pomyłka na tej jednej liczbie przesuwa cały rachunek. Ten skrypt zastępuje
 * ją pomiarem tym samym endpointem, którego użyje produkcja.
 *
 * `count_tokens` nie uruchamia modelu — nie ma tokenów wyjściowych, czyli
 * najdroższej pozycji. Pełny przebieg to kilka wywołań na model.
 *
 * Wymaga `ANTHROPIC_API_KEY` w środowisku (patrz `.env.example`). Nic nie
 * zapisuje do bazy ani do plików — drukuje tabelę i gotowy blok do wklejenia
 * w `cost-model.md`.
 *
 * Uruchomienie:
 *   pnpm agent:measure:tokens
 *   pnpm agent:measure:tokens -- --household <uuid>
 *   pnpm agent:measure:tokens -- --models claude-sonnet-5,claude-haiku-4-5
 *   pnpm agent:measure:tokens -- --print-digest
 */
import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import {
  buildCatalogDigest,
  DIGEST_HEADER,
  loadDigestRecipes,
} from '../src/agent/catalog-digest';

const prisma = new PrismaClient();

/** Domyślne gospodarstwo katalogu — to samo, co `RECIPE_IMPORT_HOUSEHOLD_ID`. */
const DEFAULT_CATALOG_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';

const DEFAULT_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'];

/** Z cost-model.md §1: 75 bazy × 1,3 tokenizer × 1,3 polski. */
const ASSUMED_TOKENS_PER_LINE = 75 * 1.3 * 1.3;
const ASSUMED_DIGEST_TOKENS = 11_534;
const ASSUMED_PREFIX_TOKENS = 16_734;

/** $/MTok wejścia — do policzenia, ile digest kosztuje przy odczycie z cache. */
const INPUT_PRICE_PER_MTOK: Record<string, number> = {
  'claude-sonnet-5': 2,
  'claude-opus-5': 5,
  'claude-haiku-4-5': 1,
};
const CACHE_READ_MULTIPLIER = 0.1;

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

/**
 * Koszt samej treści, bez narzutu koperty wiadomości.
 *
 * Pusta wiadomość jest odrzucana (400), a koperta kosztuje kilka tokenów,
 * więc mierzymy różnicowo: dwa razy ta sama treść minus raz. Narzut znosi się
 * sam. Ma to znaczenie przy krótkich fragmentach (nagłówek, jedna linia) —
 * przy całym digeście to szum, ale liczymy tak samo, żeby składniki sumowały
 * się do całości.
 */
async function countContent(
  client: Anthropic,
  model: string,
  text: string,
): Promise<number> {
  const once = await client.messages.countTokens({
    model,
    messages: [{ role: 'user', content: text }],
  });
  const twice = await client.messages.countTokens({
    model,
    messages: [{ role: 'user', content: `${text}\n${text}` }],
  });
  // Druga kopia niesie jeden znak nowej linii więcej — przy tekstach tej skali
  // to poniżej tokena, ale odejmujemy uczciwie.
  return twice.input_tokens - once.input_tokens;
}

async function main(): Promise<void> {
  if (!(process.env.ANTHROPIC_API_KEY ?? '').trim()) {
    console.error(
      'Brak ANTHROPIC_API_KEY. Ustaw go w .env (patrz .env.example) i uruchom ponownie.',
    );
    process.exit(1);
  }

  const householdId = readFlag('household') ?? DEFAULT_CATALOG_HOUSEHOLD;
  const models = (readFlag('models') ?? DEFAULT_MODELS.join(','))
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model.length > 0);

  const recipes = await loadDigestRecipes(prisma, householdId);
  if (recipes.length === 0) {
    console.error(
      `Gospodarstwo ${householdId} nie ma aktywnych przepisów — zły --household?`,
    );
    process.exit(1);
  }

  const digest = buildCatalogDigest(recipes);
  const lines = digest.text.split('\n');
  const longest = lines
    .slice(DIGEST_HEADER.split('\n').length)
    .reduce((a, b) => (b.length > a.length ? b : a), '');

  console.log(
    `Katalog: ${digest.recipeCount} przepisów, gospodarstwo ${householdId}`,
  );
  console.log(`catalogVersion: ${digest.catalogVersion}`);
  console.log(
    `Znaki: ${digest.text.length} (najdłuższa linia: ${longest.length})\n`,
  );

  if (process.argv.includes('--print-digest')) {
    console.log(digest.text);
    console.log('');
  }

  const client = new Anthropic();
  const rows: {
    model: string;
    header: number;
    total: number;
    perRecipe: number;
  }[] = [];

  for (const model of models) {
    const header = await countContent(client, model, DIGEST_HEADER);
    const total = await countContent(client, model, digest.text);
    rows.push({
      model,
      header,
      total,
      perRecipe: (total - header) / digest.recipeCount,
    });
  }

  console.log(
    'model                | nagłówek | CAŁY digest | tok/przepis | vs. szacunek',
  );
  console.log(
    '---------------------|----------|-------------|-------------|-------------',
  );
  for (const row of rows) {
    const share = (100 * row.perRecipe) / ASSUMED_TOKENS_PER_LINE;
    console.log(
      `${row.model.padEnd(20)} | ${String(row.header).padStart(8)} | ` +
        `${String(row.total).padStart(11)} | ${row.perRecipe.toFixed(1).padStart(11)} | ` +
        `${share.toFixed(0).padStart(4)}% z ${ASSUMED_TOKENS_PER_LINE.toFixed(0)}`,
    );
  }

  console.log(
    `\nSzacunek z cost-model.md: ${ASSUMED_TOKENS_PER_LINE.toFixed(0)} tok/linię, ` +
      `digest ${ASSUMED_DIGEST_TOKENS}, cały prefiks ${ASSUMED_PREFIX_TOKENS}.`,
  );

  console.log('\nKoszt jednego ODCZYTU digestu z cache (0,1× stawki wejścia):');
  for (const row of rows) {
    const price = INPUT_PRICE_PER_MTOK[row.model];
    if (price === undefined) continue;
    const usd = (row.total * CACHE_READ_MULTIPLIER * price) / 1_000_000;
    console.log(`  ${row.model.padEnd(20)} $${usd.toFixed(6)} / wywołanie`);
  }

  console.log(
    '\nUWAGA: to pomiar SAMEGO digestu. Schematy narzędzi (~2 500 bazy) i',
  );
  console.log(
    'instrukcje systemowe (~1 500 bazy) zostają szacunkami, dopóki nie powstaną.',
  );
}

main()
  .catch((error: unknown) => {
    console.error('Pomiar tokenów nie powiódł się:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
