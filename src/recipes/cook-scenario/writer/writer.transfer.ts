import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { resolveGoldenContent } from '../cook-scenario.golden';
import { publishCookScenario } from '../cook-scenario.publish';
import {
  COOK_SCENARIO_RULES_VERSION,
  type CookScenarioContent,
} from '../cook-scenario.types';
import {
  loadWriterRecipe,
  readWriterRecipe,
  writerInputHash,
} from './writer.store';
import type { WriterRecipe } from './writer.types';

/**
 * Przeniesienie scenariuszy napisanych lokalnie na inną bazę (prod).
 *
 * System pisania działa tylko na bazie lokalnej, a ta jest zbudowana z PLIKU
 * katalogu: `Recipe.id` są wspólne, ale `Ingredient.id` losowe — inne niż na
 * prod (przegląd #269). Dlatego plik jest przenośny jak wzorce
 * (`cook-scenarios-pl-v1.json`): składniki w treści po NAZWIE z przepisu,
 * a „ten sam przepis” rozstrzyga przenośny odcisk wejścia modelu — wszystko,
 * co widział model, bez id składników, ze składnikami w stałej kolejności.
 * Import pod blokadą przepisu liczy ten odcisk na docelowej bazie, zamienia
 * nazwy na tamtejsze id i publikuje; przepis zmieniony po zrobieniu kopii =
 * pominięty, nie publikowany ze starą treścią.
 */
export const COOK_EXPORT_FORMAT = 'scoffie-cook-scenarios';

export interface CookScenarioExportEntry {
  recipeId: string;
  title: string;
  /** `portableInputHash` przepisu, do którego napisano scenariusz. */
  portableHash: string;
  /** Treść ze składnikami po NAZWIE (`ingredient`, `mentions`). */
  content: unknown;
  generator: Prisma.JsonValue;
  review: { score: number; summary: string } | null;
  /** Wersja w bazie źródłowej (ślad). */
  source: { scenarioId: string; version: number };
}

export interface CookScenarioExportFile {
  format: typeof COOK_EXPORT_FORMAT;
  version: 2;
  rulesVersion: string;
  exportedAt: string;
  count: number;
  scenarios: CookScenarioExportEntry[];
}

/**
 * Odcisk wejścia modelu niezależny od bazy: bez `ingredientId`, składniki
 * posortowane po nazwie (kolejność wierszy zależy od historii importów).
 */
export function portableInputHash(recipe: WriterRecipe): string {
  const portable = {
    ...recipe,
    ingredients: recipe.ingredients
      .map((row) => ({
        name: row.name,
        amount: row.amount,
        unit: row.unit,
        department: row.department,
      }))
      .sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.amount - b.amount,
      ),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(portable)).digest('hex')}`;
}

/** Treść z id składników → treść z nazwami (format wzorców). */
export function contentWithNames(
  recipe: WriterRecipe,
  content: CookScenarioContent,
): unknown {
  const names = new Map(
    recipe.ingredients.map((row) => [row.ingredientId, row.name]),
  );
  if (names.size !== new Set(recipe.ingredients.map((r) => r.name)).size) {
    throw new Error('nazwy składników przepisu nie są jednoznaczne');
  }
  const name = (id: string) => {
    const found = names.get(id);
    if (!found) throw new Error(`składnika ${id} nie ma w przepisie`);
    return found;
  };
  return {
    ...content,
    steps: content.steps.map((step) => ({
      ...step,
      ingredients: step.ingredients.map(({ ingredientId, ...rest }) => ({
        ingredient: name(ingredientId),
        ...rest,
      })),
      mentions: step.mentions.map(name),
    })),
  };
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
      portableHash: portableInputHash(loaded.recipe),
      content: contentWithNames(
        loaded.recipe,
        row.content as unknown as CookScenarioContent,
      ),
      generator: row.generator,
      review:
        typeof report.review?.score === 'number'
          ? {
              score: report.review.score,
              summary:
                typeof report.review.summary === 'string'
                  ? report.review.summary
                  : '',
            }
          : null,
      source: { scenarioId: row.id, version: row.version },
    });
  }
  return {
    format: COOK_EXPORT_FORMAT,
    version: 2,
    rulesVersion: COOK_SCENARIO_RULES_VERSION,
    exportedAt: (options.exportedAt ?? new Date()).toISOString(),
    count: scenarios.length,
    scenarios,
  };
}

/** Plik z eksportu, sprawdzony przed importem. */
export function parseExportFile(raw: unknown): CookScenarioExportFile {
  const file = raw as Partial<CookScenarioExportFile> | null;
  if (file?.format !== COOK_EXPORT_FORMAT || file.version !== 2) {
    throw new Error('to nie jest plik eksportu scenariuszy Gotuj (wersja 2)');
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
  | 'REPLACED'
  | 'UNCHANGED'
  | 'NOT_FOUND'
  | 'NOT_CATALOG'
  | 'CHANGED'
  | 'GOLDEN';

/** Wycofuje transakcję próby (`dryRun`) z wynikiem, który by zapadł. */
export class DryRunRollback extends Error {
  constructor(readonly outcome: ImportOutcome) {
    super(`próba: ${outcome}`);
  }
}

/**
 * Jeden scenariusz z pliku — we WŁASNEJ transakcji wołającego. Pod blokadą
 * przepisu: brak przepisu = NOT_FOUND; przepis spoza katalogu albo wycofany = NOT_CATALOG;
 * inny przenośny odcisk wejścia = CHANGED (nic nie zapisuje); opublikowany
 * wzorzec pisany ręcznie = GOLDEN (import go nie zastępuje). Inaczej nazwy
 * składników → id TEJ bazy i `publishCookScenario` (walidacja zgodności
 * z przepisem, nowa wersja, `Recipe.cookScenarioVersion`); ta sama treść =
 * UNCHANGED, podmiana innej opublikowanej wersji = REPLACED. Wersja niesie
 * `inputHash` TEJ bazy — system pisania uzna ją za aktualny wynik.
 * `dryRun`: wszystko to samo, a na końcu wyjątek `DryRunRollback` wycofuje
 * transakcję — liczby próby są te same, co prawdziwego importu.
 */
export async function importScenario(
  tx: Prisma.TransactionClient,
  entry: CookScenarioExportEntry,
  context: { exportedAt: string; dryRun: boolean },
): Promise<ImportOutcome> {
  const outcome = await importInTx(tx, entry, context.exportedAt);
  if (context.dryRun) throw new DryRunRollback(outcome);
  return outcome;
}

async function importInTx(
  tx: Prisma.TransactionClient,
  entry: CookScenarioExportEntry,
  exportedAt: string,
): Promise<ImportOutcome> {
  const locked = await tx.$queryRaw<
    { id: string; isCatalog: boolean; isActive: boolean }[]
  >`
    SELECT "id", "isCatalog", "isActive" FROM "Recipe" WHERE "id" = ${entry.recipeId}::uuid FOR UPDATE`;
  if (locked.length === 0) return 'NOT_FOUND';
  // Jak eksport: tylko aktywne przepisy katalogu.
  if (!locked[0].isCatalog || !locked[0].isActive) return 'NOT_CATALOG';
  const recipe = await readWriterRecipe(tx, entry.recipeId);
  if (!recipe || portableInputHash(recipe) !== entry.portableHash) {
    return 'CHANGED';
  }
  const published = await tx.recipeCookScenario.findFirst({
    where: { recipeId: entry.recipeId, status: 'PUBLISHED' },
    select: { generator: true },
  });
  const source = (published?.generator as { source?: unknown } | null)?.source;
  if (source === 'golden') return 'GOLDEN';
  const byName = new Map(
    recipe.ingredients.map((row) => [row.name, row.ingredientId]),
  );
  const resolved = resolveGoldenContent(entry.content, (name) =>
    byName.get(name),
  );
  if (resolved.errors.length) {
    // Przy zgodnym odcisku nazwy muszą się rozwiązać — inaczej plik zepsuty.
    throw new Error(`nazwy składników: ${resolved.errors.join('; ')}`);
  }
  const result = await publishCookScenario(tx, {
    recipeId: entry.recipeId,
    content: resolved.content,
    rulesVersion: COOK_SCENARIO_RULES_VERSION,
    generator: {
      ...(entry.generator as Prisma.JsonObject),
      exportedAt,
    },
    validationReport: {
      outcome: 'VALIDATED',
      inputHash: writerInputHash(recipe),
      review: entry.review,
      importedFrom: { ...entry.source, exportedAt },
    },
  });
  if (!result.changed) return 'UNCHANGED';
  return published ? 'REPLACED' : 'PUBLISHED';
}
