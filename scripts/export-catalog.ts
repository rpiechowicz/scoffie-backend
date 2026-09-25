/**
 * Eksport katalogu przepisów z bazy do pliku w repo (decyzja D1, 25.09.2026).
 *
 * Baza jest źródłem prawdy katalogu; `prisma/catalog/recipes-catalog-full-v2.json`
 * to jej wierne odbicie — dla historii w gicie, przeglądu zmian w PR-ze
 * i bootstrapu świeżej bazy. Co noc eksport robi serwis `catalog-sync`
 * (`ops/catalog-sync/`) i otwiera PR do `develop`, gdy coś się zmieniło.
 *
 * Czyta WSZYSTKIE przepisy katalogu (`isCatalog = true`), także wycofane
 * (w pliku `"isActive": false`). Format opisuje `src/recipes/catalog/catalog-export.ts`.
 *
 * Uruchomienie:
 *   pnpm catalog:export                          # nadpisuje plik w repo
 *   pnpm catalog:export -- --out /tmp/k.json     # inny plik docelowy
 *   pnpm catalog:export -- --check               # kod 1, gdy plik ≠ baza (nic nie pisze)
 *   pnpm catalog:export -- --summary /tmp/s.txt  # opis różnic wobec poprzedniej treści pliku
 *
 * Plik `--summary`: pierwsza linia = liczby („zmienione 3, dodane 1, wycofane 0”),
 * potem pusta linia i lista tytułów. Bez różnic plik podsumowania nie powstaje.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  buildCatalogFile,
  catalogEntryFromRow,
  catalogExportSelect,
  describeCatalogDiff,
  diffCatalog,
  formatCatalogFile,
  isCatalogDiffEmpty,
  summarizeCatalogDiff,
} from '../src/recipes/catalog/catalog-export';
import {
  CATALOG_FILE_PATH,
  type CatalogFile,
} from '../src/recipes/catalog/catalog-recipe';

type Options = { out: string; check: boolean; summary: string | null };

function argValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} wymaga ścieżki.`);
  }
  return value;
}

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

function parseArgs(argv: string[]): Options {
  return {
    out: resolvePath(
      argValue(argv, '--out') ??
        process.env.CATALOG_EXPORT_FILE ??
        CATALOG_FILE_PATH,
    ),
    check: argv.includes('--check'),
    summary: (() => {
      const value = argValue(argv, '--summary');
      return value ? resolvePath(value) : null;
    })(),
  };
}

/** Eksport jako tekst pliku — bez zapisu (używa go też test obiegu). */
export async function exportCatalogText(prisma: PrismaClient): Promise<{
  text: string;
  file: CatalogFile;
}> {
  const rows = await prisma.recipe.findMany({
    where: { isCatalog: true },
    select: catalogExportSelect,
  });
  const file = buildCatalogFile(rows.map(catalogEntryFromRow));
  return { text: formatCatalogFile(file), file };
}

async function readPrevious(path: string): Promise<CatalogFile | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CatalogFile;
  } catch {
    // Uszkodzony albo pusty plik — różnice liczymy od zera.
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const { text, file } = await exportCatalogText(prisma);
    const previousText = existsSync(options.out)
      ? await readFile(options.out, 'utf8')
      : null;
    const same = previousText === text;
    const inactive = file.recipes.filter((r) => r.isActive === false).length;
    console.log(
      `[catalog-export] przepisów ${file.recipes.length} (wycofanych ${inactive}), plik ${options.out}: ${same ? 'bez zmian' : 'różni się'}`,
    );

    if (!same && options.summary) {
      const previous = await readPrevious(options.out);
      const diff = diffCatalog(previous?.recipes ?? [], file.recipes);
      // Sam układ pliku (np. pierwszy eksport po zmianie formatu) to też
      // różnica — opisujemy ją, żeby PR nie przyszedł z pustą treścią.
      const body = isCatalogDiffEmpty(diff)
        ? 'Zmiana samego układu pliku (treść przepisów bez zmian).'
        : describeCatalogDiff(diff);
      await writeFile(
        options.summary,
        `${summarizeCatalogDiff(diff)}\n\n${body}\n`,
        'utf8',
      );
      console.log(`[catalog-export] ${summarizeCatalogDiff(diff)}`);
    }

    if (options.check) {
      if (!same) process.exitCode = 1;
      return;
    }
    if (!same) await writeFile(options.out, text, 'utf8');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[catalog-export] błąd:', error);
    process.exit(1);
  });
}
