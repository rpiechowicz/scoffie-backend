import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { normalizeText } from '../src/common/normalize-text.util';

const prisma = new PrismaClient();

const CATEGORY_BY_FILE: Record<string, string> = {
  'ingredients-warzywa-pl-v1.txt': 'Warzywa',
  'ingredients-owoce-pl-v1.txt': 'Owoce',
  'ingredients-mieso-pl-v1.txt': 'Mięso',
  'ingredients-ryby-owoce-morza-pl-v1.txt': 'Ryby',
  'ingredients-nabial-i-jajko-pl-v1.txt': 'Nabiał',
  'ingredients-piekarnia-pl-v1.txt': 'Piekarnia',
  'ingredients-zboza-i-makarony-pl-v1.txt': 'Zboża i makarony',
  'ingredients-konserwy-i-sloiki-pl-v1.txt': 'Konserwy',
  'ingredients-przyprawy-i-sosy-pl-v1.txt': 'Przyprawy i sosy',
  'ingredients-olej-i-tluszcz-pl-v1.txt': 'Olej i tłuszcze',
  'ingredients-alkohole-pl-v1.txt': 'Alkohole',
  'ingredients-napoje-pl-v1.txt': 'Napoje',
  'ingredients-przekaska-i-slodycz-pl-v1.txt': 'Przekąski i słodycze',
  'ingredients-mrozonka-pl-v1.txt': 'Mrożonki',
  'ingredients-cukiernia-pl-v1.txt': 'Cukiernia',
  'ingredients-chemia-i-gospodarstwo-pl-v1.txt': 'Chemia i gospodarstwo',
  'ingredients-inne-pl-v1.txt': 'Inne',
};

function parseLines(content: string): string[] {
  return content
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('#'));
}

async function main(): Promise<void> {
  const catalogDir = join(process.cwd(), 'prisma', 'catalog');
  const files = await readdir(catalogDir);
  const catalogFiles = files.filter(
    (file) => file.endsWith('.txt') && CATEGORY_BY_FILE[file],
  );

  let processed = 0;
  let upserted = 0;

  for (const fileName of catalogFiles.sort()) {
    const category = CATEGORY_BY_FILE[fileName];
    const fullPath = join(catalogDir, fileName);
    const content = await readFile(fullPath, 'utf8');
    const names = Array.from(new Set(parseLines(content)));

    for (const name of names) {
      const normalizedName = normalizeText(name);
      const existing = await prisma.ingredient.findUnique({
        where: { normalizedName },
        select: { id: true, name: true },
      });

      if (existing) {
        await prisma.ingredient.update({
          where: { id: existing.id },
          data: {
            category,
            isActive: true,
          },
        });

        if (existing.name !== name) {
          await prisma.ingredientAlias.upsert({
            where: { normalizedAlias: normalizedName },
            update: {},
            create: {
              ingredientId: existing.id,
              alias: name,
              normalizedAlias: normalizedName,
            },
          });
        }
      } else {
        await prisma.ingredient.create({
          data: {
            name,
            normalizedName,
            category,
            isActive: true,
          },
        });
      }
      upserted += 1;
    }

    processed += 1;

    console.log(
      `[catalog] loaded ${names.length} ingredients from ${basename(fileName)} -> ${category}`,
    );
  }

  console.log(`[catalog] done. files=${processed}, upserts=${upserted}`);
}

main()
  .catch((error) => {
    console.error('Ingredient catalog load failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
