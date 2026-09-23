/**
 * Adresy zdjęć przepisów KATALOGU: `recipes-catalog-full-v2.json` → baza.
 *
 *   pnpm exec tsx scripts/sync-catalog-image-urls.ts            # tylko pokazuje
 *   pnpm exec tsx scripts/sync-catalog-image-urls.ts --apply    # zapisuje
 *
 * Na prod nie importujemy całego `full-v2` (przebudowałoby składniki starych
 * przepisów), a SQL z 500 wierszami nie wkleja się w shell Railwaya na
 * telefonie — stąd krótki skrypt, uruchamiany przez `railway ssh` siecią
 * prywatną. Rusza WYŁĄCZNIE `imageUrl` przepisów z `isCatalog = true`, po id,
 * i tylko tam, gdzie adres się różni; przepisów domów nie dotyka.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const CATALOG_FILE = 'prisma/catalog/recipes-catalog-full-v2.json';

type Catalog = {
  recipes: Array<{ id: string; image?: { imageUrl?: string } }>;
};

async function main() {
  const apply = process.argv.includes('--apply');
  const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) as Catalog;
  const wanted = new Map(
    catalog.recipes
      .filter((r) => r.image?.imageUrl?.startsWith('https://'))
      .map((r) => [r.id, r.image!.imageUrl!]),
  );

  const prisma = new PrismaClient();
  try {
    const current = await prisma.recipe.findMany({
      where: { isCatalog: true, id: { in: [...wanted.keys()] } },
      select: { id: true, imageUrl: true },
    });
    const changes = current.filter((r) => r.imageUrl !== wanted.get(r.id));
    const missing = wanted.size - current.length;
    console.log(
      `[sync-catalog-image-urls] w katalogu ${wanted.size}, w bazie ${current.length} (brak ${missing}), do zmiany ${changes.length}${apply ? '' : ' — PODGLĄD, dodaj --apply'}`,
    );
    for (const r of changes.slice(0, 3)) {
      console.log(`  ${r.id}: ${r.imageUrl} → ${wanted.get(r.id)}`);
    }
    if (!apply || changes.length === 0) return;

    await prisma.$transaction(
      changes.map((r) =>
        prisma.recipe.update({
          where: { id: r.id },
          data: { imageUrl: wanted.get(r.id)! },
        }),
      ),
    );
    console.log(`[sync-catalog-image-urls] zapisane: ${changes.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[sync-catalog-image-urls] failed:', error);
  process.exit(1);
});
