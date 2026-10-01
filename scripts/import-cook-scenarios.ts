/**
 * Publikuje scenariusze Gotuj z pliku `cook-scenarios:export` na tej bazie
 * (prod: przez `railway ssh`).
 *
 * Każdy przepis we WŁASNEJ transakcji, pod blokadą przepisu: publikuje tylko,
 * gdy przepis jest tu tym samym wejściem modelu, do którego napisano
 * scenariusz (przenośny odcisk — bez id składników, które różnią się między
 * bazami) — inaczej CHANGED i nic nie zapisuje. Składniki z pliku (po nazwie)
 * dostają id tej bazy. `--dry-run` robi wszystko i wycofuje transakcję. Opublikowanego wzorca pisanego ręcznie nie zastępuje.
 * Idempotentny: ta sama treść = UNCHANGED (log katalogu stoi).
 *
 * Bezpiecznik: bez `--dry-run` wymaga COOK_IMPORT_CONFIRM=<dzisiejsza data
 * RRRR-MM-DD> — świadomy zapis, jak `recipes:import:json`.
 *
 * Uruchomienie:
 *   pnpm cook-scenarios:import --dry-run [plik]
 *   COOK_IMPORT_CONFIRM=2026-10-02 pnpm cook-scenarios:import [plik]
 */
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import {
  DryRunRollback,
  importScenario,
  parseExportFile,
  type ImportOutcome,
} from '../src/recipes/cook-scenario/writer/writer.transfer';

/** Błąd Prismy bywa z pustym `message` — wtedy kod i nazwa klasy. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  const text = error.message.trim().split('\n').at(-1) ?? '';
  return [error.name, typeof code === 'string' ? code : null, text]
    .filter(Boolean)
    .join(' · ');
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const dryRun = args.includes('--dry-run');
  const path =
    args.find((arg) => !arg.startsWith('--')) ??
    'prisma/catalog/cook-scenarios-katalog-pl.json';
  const today = new Date().toISOString().slice(0, 10);
  if (!dryRun && process.env.COOK_IMPORT_CONFIRM !== today) {
    throw new Error(
      `zapis wymaga COOK_IMPORT_CONFIRM=${today} (albo --dry-run, żeby tylko policzyć)`,
    );
  }
  const file = parseExportFile(JSON.parse(await readFile(path, 'utf8')));
  console.log(
    `${dryRun ? 'PRÓBA (bez zapisu)' : 'IMPORT'} · ${file.count} scenariuszy · zasady ${file.rulesVersion} · eksport ${file.exportedAt}`,
  );
  const prisma = new PrismaClient();
  const counts = new Map<ImportOutcome | 'ERROR', number>();
  const notes: string[] = [];
  try {
    for (const entry of file.scenarios) {
      let outcome: ImportOutcome | 'ERROR';
      try {
        outcome = await prisma.$transaction((tx) =>
          importScenario(tx, entry, { exportedAt: file.exportedAt, dryRun }),
        );
      } catch (error) {
        if (error instanceof DryRunRollback) {
          outcome = error.outcome;
          counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
          if (!['PUBLISHED', 'UNCHANGED', 'REPLACED'].includes(outcome)) {
            notes.push(`${outcome} · ${entry.title} (${entry.recipeId})`);
          }
          continue;
        }
        outcome = 'ERROR';
        notes.push(`ERROR · ${entry.title}: ${describeError(error)}`);
      }
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
      if (!['PUBLISHED', 'UNCHANGED', 'REPLACED', 'ERROR'].includes(outcome)) {
        notes.push(`${outcome} · ${entry.title} (${entry.recipeId})`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  if (notes.length) console.log(notes.join('\n'));
  console.log(
    [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([outcome, n]) => `${outcome} ${n}`)
      .join(' · '),
  );
  if (counts.get('ERROR')) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
