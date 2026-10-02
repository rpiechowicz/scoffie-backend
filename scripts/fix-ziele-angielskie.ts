/**
 * „zioło angielskie” → „ziele angielskie” (2.10.2026) — jednorazowa poprawka
 * nazwy przyprawy w bazie (prod: przez `railway ssh`).
 *
 * W JEDNEJ transakcji:
 * 1. `Ingredient`: nowa nazwa i klucz (`ziele angielskie`), stara nazwa zostaje
 *    jako `IngredientAlias` — pliki i generatory sprzed poprawki dalej się
 *    importują (słownik importu i panelu czyta aliasy).
 * 2. `RecipeIngredient.name` w przepisach z tym składnikiem — trigger logu
 *    katalogu wysyła je telefonom zwykłą deltą.
 * 3. Scenariusze Gotuj tych przepisów: tekst kroków z „zioło angielskie”
 *    dostaje nową wersję (`publishCookScenario`, bez modelu — za darmo),
 *    reszta tylko nowy `inputHash` w raporcie. Podpis przepisu
 *    (`recipe_content_signature`) liczy się z id składników, więc rename
 *    niczego nie postarza; `inputHash` systemu pisania obejmuje nazwy i bez
 *    przeniesienia system pisania uznałby te przepisy za nienapisane (płatny
 *    przebieg). Przenosimy go TYLKO z wierszy, które były aktualne przed
 *    poprawką (stary odcisk = stary przepis).
 *
 * Idempotentny: bez składnika „ziolo angielskie” kończy się bez zmian.
 * `--dry-run` liczy wszystko i wycofuje transakcję. Zapis wymaga
 * ZIELE_FIX_CONFIRM=<dzisiejsza data RRRR-MM-DD>.
 *
 * Lokalnie, na bazie zbudowanej z repo, `--export-file <plik>` przepisuje też
 * plik `cook-scenarios:export` (nazwy, tekst, przenośny odcisk) — tylko wpisy
 * zgodne ze starym przepisem.
 *
 *   pnpm exec tsx scripts/fix-ziele-angielskie.ts --dry-run
 *   ZIELE_FIX_CONFIRM=2026-10-02 pnpm exec tsx scripts/fix-ziele-angielskie.ts
 */
import { readFile, writeFile } from 'node:fs/promises';
import { Prisma, PrismaClient } from '@prisma/client';
import { publishCookScenario } from '../src/recipes/cook-scenario/cook-scenario.publish';
import {
  readWriterRecipe,
  writerInputHash,
} from '../src/recipes/cook-scenario/writer/writer.store';
import {
  parseExportFile,
  portableInputHash,
} from '../src/recipes/cook-scenario/writer/writer.transfer';

const OLD_NAME = 'zioło angielskie';
const OLD_KEY = 'ziolo angielskie';
const NEW_NAME = 'ziele angielskie';
const NEW_KEY = 'ziele angielskie';
const FIX_TAG = 'ziele-angielskie-2026-10-02';

/** Formy w tekście kroków (mianownik, dopełniacz, narzędnik, celownik). */
const TEXT_FIXES: Array<[RegExp, string]> = [
  [/ziele angielskie \(zioło angielskie\)/g, 'ziele angielskie'],
  [/ziele\/zioło angielskie/g, 'ziele angielskie'],
  [/([Zz])ioło angielskie/g, '$1iele angielskie'],
  [/([Zz])ioła angielskiego/g, '$1iela angielskiego'],
  [/([Zz])iołem angielskim/g, '$1ielem angielskim'],
  [/([Zz])iołu angielskiemu/g, '$1ielu angielskiemu'],
];

function fixText(value: string): string {
  return TEXT_FIXES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

/** Każdy napis w treści przez `fixText`; klucze i liczby bez zmian. */
function fixDeep(value: unknown): unknown {
  if (typeof value === 'string') return fixText(value);
  if (Array.isArray(value)) return value.map(fixDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fixDeep(item)]),
    );
  }
  return value;
}

class DryRun extends Error {}

type Summary = {
  recipes: number;
  ingredientRows: number;
  republished: string[];
  rehashed: number;
  drafts: number;
  skippedStale: number;
  exportEntries: number;
};

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const dryRun = args.includes('--dry-run');
  const exportAt = args.indexOf('--export-file');
  const exportPath = exportAt >= 0 ? args[exportAt + 1] : null;
  const today = new Date().toISOString().slice(0, 10);
  if (!dryRun && process.env.ZIELE_FIX_CONFIRM !== today) {
    throw new Error(
      `zapis wymaga ZIELE_FIX_CONFIRM=${today} (albo --dry-run, żeby tylko policzyć)`,
    );
  }
  const exportFile = exportPath
    ? parseExportFile(JSON.parse(await readFile(exportPath, 'utf8')))
    : null;

  const prisma = new PrismaClient();
  const summary: Summary = {
    recipes: 0,
    ingredientRows: 0,
    republished: [],
    rehashed: 0,
    drafts: 0,
    skippedStale: 0,
    exportEntries: 0,
  };
  try {
    await prisma.$transaction(
      async (tx) => {
        const old = await tx.ingredient.findUnique({
          where: { normalizedName: OLD_KEY },
          select: { id: true, name: true },
        });
        if (!old) {
          console.log(`brak składnika „${OLD_KEY}” — nic do zrobienia`);
          return;
        }
        const clash = await tx.ingredient.findFirst({
          where: { OR: [{ name: NEW_NAME }, { normalizedName: NEW_KEY }] },
          select: { id: true },
        });
        if (clash) {
          throw new Error(
            `„${NEW_NAME}” już istnieje jako osobny składnik (${clash.id}) — to scalenie, nie zmiana nazwy`,
          );
        }

        const recipeIds = (
          await tx.$queryRaw<{ id: string }[]>`
            SELECT r."id" FROM "Recipe" r
             WHERE EXISTS (SELECT 1 FROM "RecipeIngredient" ri
                            WHERE ri."recipeId" = r."id" AND ri."ingredientId" = ${old.id}::uuid)
             ORDER BY r."id"
               FOR UPDATE`
        ).map((row) => row.id);
        summary.recipes = recipeIds.length;

        const before = new Map<string, { writer: string; portable: string }>();
        for (const id of recipeIds) {
          const recipe = await readWriterRecipe(tx, id);
          if (recipe) {
            before.set(id, {
              writer: writerInputHash(recipe),
              portable: portableInputHash(recipe),
            });
          }
        }

        await tx.ingredient.update({
          where: { id: old.id },
          data: { name: NEW_NAME, normalizedName: NEW_KEY },
        });
        await tx.ingredientAlias.upsert({
          where: { normalizedAlias: OLD_KEY },
          create: {
            ingredientId: old.id,
            alias: OLD_NAME,
            normalizedAlias: OLD_KEY,
          },
          update: { ingredientId: old.id },
        });
        const renamed = await tx.recipeIngredient.updateMany({
          where: { ingredientId: old.id },
          data: { name: NEW_NAME },
        });
        summary.ingredientRows = renamed.count;

        const portableAfter = new Map<string, string>();
        for (const id of recipeIds) {
          const recipe = await readWriterRecipe(tx, id);
          const was = before.get(id);
          if (!recipe || !was) continue;
          const newHash = writerInputHash(recipe);
          portableAfter.set(id, portableInputHash(recipe));
          const rows = await tx.recipeCookScenario.findMany({
            where: { recipeId: id, status: { in: ['PUBLISHED', 'VALIDATED'] } },
            select: {
              id: true,
              status: true,
              rulesVersion: true,
              content: true,
              generator: true,
              validationReport: true,
            },
            orderBy: { version: 'asc' },
          });
          for (const row of rows) {
            const report = (row.validationReport ?? {}) as Prisma.JsonObject;
            if (report.inputHash !== was.writer) {
              summary.skippedStale += 1;
              continue;
            }
            const content = fixDeep(row.content);
            const changed =
              JSON.stringify(content) !== JSON.stringify(row.content);
            const nextReport = {
              ...report,
              inputHash: newHash,
              textFix: FIX_TAG,
            };
            if (row.status === 'PUBLISHED' && changed) {
              await publishCookScenario(tx, {
                recipeId: id,
                content,
                rulesVersion: row.rulesVersion,
                generator: {
                  ...((row.generator ?? {}) as Prisma.JsonObject),
                  textFix: FIX_TAG,
                },
                validationReport: nextReport,
              });
              summary.republished.push(recipe.title);
            } else {
              await tx.recipeCookScenario.update({
                where: { id: row.id },
                data: {
                  ...(changed
                    ? { content: content as Prisma.InputJsonValue }
                    : {}),
                  validationReport: nextReport,
                },
              });
              if (row.status === 'PUBLISHED') summary.rehashed += 1;
              else summary.drafts += 1;
            }
          }
        }

        if (exportFile && exportPath && !dryRun) {
          for (const entry of exportFile.scenarios) {
            const was = before.get(entry.recipeId);
            const now = portableAfter.get(entry.recipeId);
            if (!was || !now || entry.portableHash !== was.portable) continue;
            entry.content = fixDeep(entry.content);
            entry.portableHash = now;
            summary.exportEntries += 1;
          }
          await writeFile(
            exportPath,
            // Ten sam układ co `cook-scenarios:export` — diff tylko w wpisach.
            `${JSON.stringify(exportFile, null, 1)}\n`,
            'utf8',
          );
        }

        if (dryRun) throw new DryRun();
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    [
      dryRun ? 'PRÓBA (wycofana)' : 'ZAPISANE',
      `przepisy ${summary.recipes}`,
      `wiersze składnika ${summary.ingredientRows}`,
      `nowe wersje Gotuj ${summary.republished.length}`,
      `sam odcisk ${summary.rehashed}`,
      `szkice ${summary.drafts}`,
      `nieaktualne pominięte ${summary.skippedStale}`,
      ...(exportPath ? [`wpisy pliku ${summary.exportEntries}`] : []),
    ].join(' · '),
  );
  if (summary.republished.length) {
    console.log(`nowe wersje: ${summary.republished.join(', ')}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
