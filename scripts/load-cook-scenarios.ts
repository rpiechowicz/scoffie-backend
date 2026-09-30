/**
 * Wgrywa scenariusze trybu Gotuj pisane ręcznie (wzorce) z
 * `prisma/catalog/cook-scenarios-pl-v1.json` i publikuje je.
 *
 * Plik trzyma składniki po NAZWIE z przepisu — skrypt zamienia je na
 * `Ingredient.id` tej bazy (`resolveGoldenContent`), a publikację robi
 * `publishCookScenario`: walidacja kształtu i zgodności z przepisem,
 * nowa wersja, `Recipe.cookScenarioVersion`. Każdy przepis we WŁASNEJ
 * transakcji — zły wzorzec jednego przepisu nie blokuje pozostałych.
 *
 * Idempotentny: ta sama treść dla niezmienionego przepisu nic nie zapisuje
 * (i nie przesuwa logu katalogu).
 *
 * Uruchomienie:
 *   pnpm cook-scenarios:load
 *   COOK_SCENARIOS_FILE=inny.json pnpm cook-scenarios:load
 */
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import {
  resolveGoldenContent,
  type GoldenScenarioFile,
} from '../src/recipes/cook-scenario/cook-scenario.golden';
import { publishCookScenario } from '../src/recipes/cook-scenario/cook-scenario.publish';
import { AppException } from '../src/common/app-exception';

const prisma = new PrismaClient();

const FILE =
  process.env.COOK_SCENARIOS_FILE ?? 'prisma/catalog/cook-scenarios-pl-v1.json';

async function main() {
  const file = JSON.parse(await readFile(FILE, 'utf8')) as GoldenScenarioFile;
  let published = 0;
  let unchanged = 0;
  const failures: string[] = [];

  for (const entry of file.scenarios) {
    const label = `${entry.title} (${entry.recipeId})`;
    const ingredients = await prisma.recipeIngredient.findMany({
      where: { recipeId: entry.recipeId },
      select: { ingredientId: true, name: true },
    });
    if (ingredients.length === 0) {
      failures.push(
        `${label}: przepisu nie ma w tej bazie albo nie ma składników`,
      );
      continue;
    }
    const byName = new Map(
      ingredients.map((row) => [row.name, row.ingredientId]),
    );
    const resolved = resolveGoldenContent(entry.content, (name) =>
      byName.get(name),
    );
    if (resolved.errors.length > 0) {
      failures.push(`${label}:\n  - ${resolved.errors.join('\n  - ')}`);
      continue;
    }
    try {
      const result = await prisma.$transaction((tx) =>
        publishCookScenario(tx, {
          recipeId: entry.recipeId,
          content: resolved.content,
          rulesVersion: file.rulesVersion,
          generator: { source: 'golden', file: file.version },
        }),
      );
      if (result.changed) {
        published += 1;
        console.log(`opublikowano v${result.version}: ${label}`);
      } else {
        unchanged += 1;
        console.log(`bez zmian (v${result.version}): ${label}`);
      }
    } catch (error) {
      const details =
        error instanceof AppException && error.details?.length
          ? `\n  - ${error.details.join('\n  - ')}`
          : '';
      failures.push(`${label}: ${(error as Error).message}${details}`);
    }
  }

  console.log(
    `\nopublikowano ${published}, bez zmian ${unchanged}, błędy ${failures.length}`,
  );
  if (failures.length > 0) {
    console.error(`\n${failures.join('\n')}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
