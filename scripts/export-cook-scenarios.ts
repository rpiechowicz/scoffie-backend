/**
 * Eksport scenariuszy Gotuj napisanych lokalnie (system pisania, E3) do
 * pliku, który `cook-scenarios:import` publikuje na innej bazie (prod).
 *
 * Bierze AKTUALNE wersje VALIDATED katalogu (te same zasady, podpis bazy
 * i odcisk wejścia modelu), bez wersji z odwodu. Plik niesie podpis
 * i odcisk każdego przepisu — import publikuje tylko tam, gdzie przepis
 * na docelowej bazie jest dokładnie tym samym wejściem.
 *
 * Uruchomienie (baza lokalna z wynikami pisania):
 *   pnpm cook-scenarios:export [plik]
 *   (domyślnie prisma/catalog/cook-scenarios-katalog-pl.json)
 */
import { writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { exportValidatedScenarios } from '../src/recipes/cook-scenario/writer/writer.transfer';

const OUT = process.argv[2] ?? 'prisma/catalog/cook-scenarios-katalog-pl.json';

async function main() {
  const prisma = new PrismaClient();
  try {
    const file = await exportValidatedScenarios(prisma);
    await writeFile(OUT, `${JSON.stringify(file, null, 1)}\n`);
    console.log(
      `wyeksportowano ${file.count} scenariuszy (zasady ${file.rulesVersion}) → ${OUT}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
