/**
 * Wyniki `recraft-recipe-images.ts` → katalog JSON + SQL dla produkcji.
 *
 *   pnpm exec tsx scripts/apply-recipe-images.ts
 *
 * - w `recipes-catalog-full-v2.json` podmienia `image.imageUrl` i `image.prompt`
 *   przepisów ze stanem `ok` (reszta zostaje, jak była);
 * - pisze `tmp/recipe-images/update-prod.sql`: jeden `UPDATE … FROM (VALUES …)`
 *   po `id`, tylko dla przepisów katalogu. Na prod nie importujemy całego
 *   `full-v2` (przebudowałoby składniki starych przepisów), więc adresy idą SQL-em.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadState, WORK_DIR } from './recraft-recipe-images';

const CATALOG_FILE = 'prisma/catalog/recipes-catalog-full-v2.json';

type Catalog = {
  version: unknown;
  recipes: Array<{
    id: string;
    image?: { prompt?: string; imageUrl?: string };
  }>;
};

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

function main() {
  const state = loadState();
  const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) as Catalog;
  const rows: Array<[string, string]> = [];

  for (const recipe of catalog.recipes) {
    const s = state[recipe.id];
    if (s?.status !== 'ok' || !s.url) continue;
    recipe.image = { ...recipe.image, prompt: s.prompt, imageUrl: s.url };
    rows.push([recipe.id, s.url]);
  }

  writeFileSync(CATALOG_FILE, `${JSON.stringify(catalog, null, 2)}\n`);
  // Katalog jest w repo sformatowany Prettierem (krótkie tablice w jednej linii) —
  // bez tego diff to 2300 linii zamiast samych zdjęć.
  execSync(`npx prettier --write ${CATALOG_FILE}`, { stdio: 'ignore' });
  const sql = [
    '-- Nowe zdjęcia przepisów (recraft-recipe-images.ts). Zmienia tylko przepisy katalogu.',
    'UPDATE "Recipe" AS r SET "imageUrl" = v.url',
    'FROM (VALUES',
    rows
      .map(([id, url]) => `  (${sqlString(id)}::uuid, ${sqlString(url)})`)
      .join(',\n'),
    ') AS v(id, url)',
    'WHERE r.id = v.id AND r."isCatalog" = true;',
    '',
  ].join('\n');
  writeFileSync(join(WORK_DIR, 'update-prod.sql'), sql);

  const failed = Object.entries(state).filter(([, s]) => s.status !== 'ok');
  console.log(
    `[apply-recipe-images] katalog: ${rows.length} zdjęć podmienionych; SQL: ${join(WORK_DIR, 'update-prod.sql')}; bez zdjęcia: ${failed.length}`,
  );
}

main();
