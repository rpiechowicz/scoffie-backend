import { Prisma, type PrismaClient } from '@prisma/client';
import { publishCookScenario } from '../cook-scenario.publish';
import { COOK_SCENARIO_RULES_VERSION } from '../cook-scenario.types';
import {
  loadWriterRecipe,
  readWriterRecipe,
  writerInputHash,
} from './writer.store';

/**
 * Przeniesienie scenariuszy napisanych lokalnie na inną bazę (prod).
 *
 * System pisania działa tylko na bazie lokalnej (kopia katalogu z prod), więc
 * scenariusze trafiają na prod plikiem: eksport bierze z bazy lokalnej
 * AKTUALNE wersje VALIDATED (te same zasady, podpis i odcisk wejścia — jak
 * `--skip-written`), a import na docelowej bazie publikuje każdą TYLKO wtedy,
 * gdy przepis jest tam dokładnie tym samym wejściem modelu (podpis bazy +
 * odcisk całego wejścia, pod blokadą przepisu). Przepis zmieniony na prod po
 * zrobieniu kopii = pominięty, nie publikowany ze starą treścią.
 */
export const COOK_EXPORT_FORMAT = 'scoffie-cook-scenarios';

export interface CookScenarioExportEntry {
  recipeId: string;
  title: string;
  /** `recipe_content_signature` przepisu, do którego napisano scenariusz. */
  recipeContentHash: string;
  /** `writerInputHash` — odcisk CAŁEGO wejścia modelu. */
  inputHash: string;
  content: unknown;
  generator: Prisma.JsonValue;
  review: { score: number; summary: string } | null;
  /** Wersja w bazie źródłowej (ślad). */
  source: { scenarioId: string; version: number };
}

export interface CookScenarioExportFile {
  format: typeof COOK_EXPORT_FORMAT;
  version: 1;
  rulesVersion: string;
  exportedAt: string;
  count: number;
  scenarios: CookScenarioExportEntry[];
}

/**
 * Aktualne wersje VALIDATED katalogu. Wersje z odwodu (`belowThreshold`)
 * zostają — te publikuje się tylko świadomie, z panelu.
 */
export async function exportValidatedScenarios(
  prisma: PrismaClient,
  options: { exportedAt?: Date } = {},
): Promise<CookScenarioExportFile> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT r."id" FROM "Recipe" r
     WHERE r."isCatalog" AND r."isActive"
     ORDER BY r."title", r."id"`;
  const scenarios: CookScenarioExportEntry[] = [];
  for (const { id } of ids) {
    const loaded = await loadWriterRecipe(prisma, id);
    if (loaded?.currentStatus !== 'VALIDATED') continue;
    const inputHash = writerInputHash(loaded.recipe);
    const rows = await prisma.recipeCookScenario.findMany({
      where: {
        recipeId: id,
        rulesVersion: COOK_SCENARIO_RULES_VERSION,
        recipeContentHash: loaded.signature,
        status: 'VALIDATED',
      },
      select: {
        id: true,
        version: true,
        content: true,
        generator: true,
        validationReport: true,
      },
      orderBy: { version: 'desc' },
    });
    const row = rows.find((candidate) => {
      const report = candidate.validationReport as {
        inputHash?: unknown;
      } | null;
      return report?.inputHash === inputHash;
    });
    if (!row || row.content === null) continue;
    const report = row.validationReport as {
      belowThreshold?: unknown;
      review?: { score?: unknown; summary?: unknown } | null;
    };
    if (report.belowThreshold === true) continue;
    scenarios.push({
      recipeId: id,
      title: loaded.recipe.title,
      recipeContentHash: loaded.signature,
      inputHash,
      content: row.content,
      generator: row.generator,
      review:
        typeof report.review?.score === 'number'
          ? {
              score: report.review.score,
              summary: String(report.review.summary ?? ''),
            }
          : null,
      source: { scenarioId: row.id, version: row.version },
    });
  }
  return {
    format: COOK_EXPORT_FORMAT,
    version: 1,
    rulesVersion: COOK_SCENARIO_RULES_VERSION,
    exportedAt: (options.exportedAt ?? new Date()).toISOString(),
    count: scenarios.length,
    scenarios,
  };
}

/** Plik z eksportu, sprawdzony przed importem. */
export function parseExportFile(raw: unknown): CookScenarioExportFile {
  const file = raw as Partial<CookScenarioExportFile> | null;
  if (file?.format !== COOK_EXPORT_FORMAT || file.version !== 1) {
    throw new Error('to nie jest plik eksportu scenariuszy Gotuj (wersja 1)');
  }
  if (file.rulesVersion !== COOK_SCENARIO_RULES_VERSION) {
    throw new Error(
      `plik z zasad ${file.rulesVersion}, kod ma ${COOK_SCENARIO_RULES_VERSION} — import odmawia`,
    );
  }
  if (!Array.isArray(file.scenarios) || file.scenarios.length !== file.count) {
    throw new Error('plik niekompletny (liczba scenariuszy ≠ count)');
  }
  return file as CookScenarioExportFile;
}

export type ImportOutcome =
  | 'PUBLISHED'
  | 'UNCHANGED'
  | 'WOULD_PUBLISH'
  | 'NOT_FOUND'
  | 'CHANGED'
  | 'GOLDEN';

/**
 * Jeden scenariusz z pliku — we WŁASNEJ transakcji wołającego. Pod blokadą
 * przepisu: brak przepisu = NOT_FOUND; inny podpis albo odcisk wejścia =
 * CHANGED (nic nie zapisuje); opublikowany wzorzec pisany ręcznie = GOLDEN
 * (import go nie zastępuje); `dryRun` = WOULD_PUBLISH bez zapisu. Inaczej
 * publikacja przez `publishCookScenario` (walidacja zgodności z przepisem,
 * nowa wersja, `Recipe.cookScenarioVersion`); ta sama treść = UNCHANGED.
 */
export async function importScenario(
  tx: Prisma.TransactionClient,
  entry: CookScenarioExportEntry,
  context: { exportedAt: string; dryRun: boolean },
): Promise<ImportOutcome> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Recipe" WHERE "id" = ${entry.recipeId}::uuid FOR UPDATE`;
  if (locked.length === 0) return 'NOT_FOUND';
  const [{ signature }] = await tx.$queryRaw<{ signature: string | null }[]>`
    SELECT recipe_content_signature(${entry.recipeId}::uuid) AS "signature"`;
  const recipe = await readWriterRecipe(tx, entry.recipeId);
  if (
    !recipe ||
    signature !== entry.recipeContentHash ||
    writerInputHash(recipe) !== entry.inputHash
  ) {
    return 'CHANGED';
  }
  const published = await tx.recipeCookScenario.findFirst({
    where: { recipeId: entry.recipeId, status: 'PUBLISHED' },
    select: { generator: true },
  });
  const source = (published?.generator as { source?: unknown } | null)?.source;
  if (source === 'golden') return 'GOLDEN';
  if (context.dryRun) return 'WOULD_PUBLISH';
  const result = await publishCookScenario(tx, {
    recipeId: entry.recipeId,
    content: entry.content,
    rulesVersion: COOK_SCENARIO_RULES_VERSION,
    generator: {
      ...(entry.generator as Prisma.JsonObject),
      importedAt: context.exportedAt,
    },
    validationReport: {
      outcome: 'VALIDATED',
      inputHash: entry.inputHash,
      review: entry.review,
      importedFrom: { ...entry.source, exportedAt: context.exportedAt },
    },
  });
  return result.changed ? 'PUBLISHED' : 'UNCHANGED';
}
