import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SOURCE_FILE =
  process.env.IMAGE_URL_SOURCE_FILE ?? 'prisma/catalog/recipes-db-v1-import.json';

type SourceRecipe = {
  title: string;
  image?: { imageUrl?: string | null };
};

type SourceBatch = { recipes: SourceRecipe[] };

async function main(): Promise<void> {
  const raw = await readFile(join(process.cwd(), SOURCE_FILE), 'utf8');
  const input = JSON.parse(raw) as SourceBatch;

  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const source of input.recipes) {
    const imageUrl = source.image?.imageUrl?.trim();
    if (!imageUrl) {
      skipped += 1;
      continue;
    }

    const result = await prisma.recipe.updateMany({
      where: { title: source.title },
      data: { imageUrl },
    });

    if (result.count === 0) {
      missing += 1;
      // eslint-disable-next-line no-console
      console.log(`[fix-images] NOT FOUND: "${source.title}"`);
    } else {
      updated += result.count;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[fix-images] done. updated=${updated} missing=${missing} skippedNoUrl=${skipped} totalInput=${input.recipes.length}`,
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Fix recipe image URLs failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
