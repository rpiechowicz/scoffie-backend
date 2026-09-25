import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import {
  buildCatalogFile,
  catalogEntryFromRow,
  catalogExportSelect,
  formatCatalogFile,
} from '../src/recipes/catalog/catalog-export';
import {
  CATALOG_FILE_PATH,
  type CatalogFile,
} from '../src/recipes/catalog/catalog-recipe';

/**
 * Obieg D1: plik katalogu → import (bootstrap świeżej bazy w
 * `prisma:migrate:deploy`) → eksport = TEN SAM plik, bajt w bajt.
 *
 * Wymaga bazy zasianej z bieżącego pliku — tak jest w CI (`test:e2e:ci` na
 * pustej bazie po `pnpm prisma:migrate:deploy`). Baza deweloperska zasiana
 * starszym plikiem da tu różnicę; wtedy świeża baza albo `pnpm catalog:export`.
 *
 * Porównujemy przepisy z pliku (po id): inne zestawy e2e zakładają własne
 * przepisy katalogu i sprzątają je po sobie, ale test nie może zależeć od
 * kolejności zestawów.
 */
describe('Eksport katalogu — obieg plik → import → eksport (e2e)', () => {
  const prisma = new PrismaClient();
  const raw = readFileSync(join(__dirname, '..', CATALOG_FILE_PATH), 'utf8');
  const file = JSON.parse(raw) as CatalogFile;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('baza zasiana z pliku oddaje plik bajt w bajt', async () => {
    const ids = file.recipes.map((recipe) => recipe.id ?? '');
    const rows = await prisma.recipe.findMany({
      where: { isCatalog: true, id: { in: ids } },
      select: catalogExportSelect,
    });
    expect(rows).toHaveLength(file.recipes.length);

    const exported = buildCatalogFile(rows.map(catalogEntryFromRow));
    // Najpierw po przepisie — przy różnicy komunikat wskazuje JEDEN wpis,
    // a nie 40 tysięcy linii.
    const byId = new Map(exported.recipes.map((entry) => [entry.id, entry]));
    for (const entry of file.recipes) {
      expect({ id: entry.id, entry: byId.get(entry.id) }).toEqual({
        id: entry.id,
        entry,
      });
    }
    expect(formatCatalogFile(exported)).toBe(raw);
  });
});
