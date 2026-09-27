/**
 * Pomiar kosztu zapisu katalogu przed/po N2-1. NIE jest częścią runtime.
 * Uruchamiany na jednorazowej bazie (kopia świeżo zmigrowanej) — wynik JSON
 * na stdout. Ścieżka odczytu (`head` + delta) liczona tymi samymi zapytaniami
 * co `CatalogSyncService`.
 *
 *   DATABASE_URL=… pnpm exec ts-node --transpile-only benchmark/catalog-change-commit-order/write-bench.ts <etykieta>
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2));
};
const now = () => Number(process.hrtime.bigint()) / 1e6;
const time = async <T>(fn: () => Promise<T>) => {
  const t0 = now();
  const value = await fn();
  return { ms: now() - t0, value };
};

async function main() {
  const label = process.argv[2] ?? '?';
  const stamp = randomUUID().slice(0, 8);
  const author = await prisma.user.create({
    data: { displayName: `bench ${stamp}`, authProvider: 'DEV' },
    select: { id: true },
  });
  const house = await prisma.household.create({
    data: { name: `bench ${stamp}`, createdById: author.id },
    select: { id: true },
  });
  const ingredientIds = (
    await prisma.ingredient.findMany({ take: 5, select: { id: true } })
  ).map((r) => r.id);

  const out: Record<string, unknown> = { label };

  // Bulk createMany 1000 (jedna instrukcja, jedna transakcja).
  const ids = Array.from({ length: 1000 }, () => randomUUID());
  const create = await time(() =>
    prisma.recipe.createMany({
      data: ids.map((id, i) => ({
        id,
        title: `bench ${stamp} ${i}`,
        mealType: 'DINNER' as const,
        suitableMealTypes: ['DINNER' as const],
        isCatalog: true,
        isActive: true,
        authorId: author.id,
        householdId: house.id,
        nutritionKcal: 500,
        servings: 2,
      })),
    }),
  );
  out.createMany1000Ms = Number(create.ms.toFixed(1));

  // 1. Pojedynczy UPDATE przepisu (autocommit), 200 razy.
  const single: number[] = [];
  for (let i = 0; i < 200; i += 1) {
    const { ms } = await time(() =>
      prisma.recipe.update({ where: { id: ids[i] }, data: { title: `s ${i} ${stamp}` } }),
    );
    single.push(ms);
  }
  out.singleUpdate = { p50: pct(single, 50), p95: pct(single, 95) };

  // 2. 100 i 1000 przepisów jedną instrukcją (jedna transakcja).
  for (const n of [100, 1000]) {
    const runs: number[] = [];
    for (let r = 0; r < 5; r += 1) {
      const { ms } = await time(() =>
        prisma.$executeRaw(
          Prisma.sql`UPDATE "Recipe" SET "title" = "title" || '.' WHERE "id" = ANY(${ids.slice(0, n)}::uuid[])`,
        ),
      );
      runs.push(ms);
    }
    out[`bulkUpdate${n}`] = { p50: pct(runs, 50), max: pct(runs, 100) };
  }

  // 3. Przepis + składniki (jak panel: podmiana linii), 50 razy.
  const nested: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    const { ms } = await time(() =>
      prisma.recipe.update({
        where: { id: ids[i] },
        data: {
          title: `n ${i} ${stamp}`,
          ingredients: {
            deleteMany: {},
            create: ingredientIds.map((ingredientId, k) => ({
              ingredientId,
              name: `składnik ${k}`,
              amount: 100 + k,
              unit: 'g',
              normalizedAmount: 100 + k,
              normalizedUnit: 'g',
              department: 'inne',
            })),
          },
        },
      }),
    );
    nested.push(ms);
  }
  out.recipeWithIngredients = { p50: pct(nested, 50), p95: pct(nested, 95) };

  // 4. 10 równoległych zapisujących × 50 pojedynczych UPDATE.
  const perOp: number[] = [];
  const wall = await time(() =>
    Promise.all(
      Array.from({ length: 10 }, (_, w) =>
        (async () => {
          for (let i = 0; i < 50; i += 1) {
            const id = ids[200 + w * 50 + i];
            const { ms } = await time(() =>
              prisma.recipe.update({ where: { id }, data: { title: `p ${w} ${i} ${stamp}` } }),
            );
            perOp.push(ms);
          }
        })(),
      ),
    ),
  );
  out.parallel10x50 = {
    wallMs: Number(wall.ms.toFixed(1)),
    throughputPerSec: Number(((500 / wall.ms) * 1000).toFixed(0)),
    opP50: pct(perOp, 50),
    opP95: pct(perOp, 95),
    opMax: pct(perOp, 100),
  };

  // 4b. 10 równoległych transakcji po 20 przepisów (wiele wierszy na commit).
  const txOp: number[] = [];
  const wall2 = await time(() =>
    Promise.all(
      Array.from({ length: 10 }, (_, w) =>
        (async () => {
          for (let i = 0; i < 5; i += 1) {
            const slice = ids.slice(700 + w * 20, 700 + w * 20 + 20);
            const { ms } = await time(() =>
              prisma.$executeRaw(
                Prisma.sql`UPDATE "Recipe" SET "title" = "title" || '+' WHERE "id" = ANY(${slice}::uuid[])`,
              ),
            );
            txOp.push(ms);
          }
        })(),
      ),
    ),
  );
  out.parallel10tx20rows = {
    wallMs: Number(wall2.ms.toFixed(1)),
    rowsPerSec: Number(((1000 / wall2.ms) * 1000).toFixed(0)),
    txP50: pct(txOp, 50),
    txP95: pct(txOp, 95),
  };

  // 5. Ścieżka odczytu: head + delta ostatnich zmian (zapytania z serwisu).
  const reads: number[] = [];
  const deltas: number[] = [];
  for (let i = 0; i < 50; i += 1) {
    const h = await time(() =>
      prisma.$queryRaw<{ head: bigint }[]>(Prisma.sql`
        SELECT s."epoch"::text AS "epoch", s."minRevision" AS "minRevision",
               COALESCE((SELECT MAX("revision") FROM "CatalogChange"), 0)::bigint AS "head"
        FROM "CatalogSyncState" s WHERE s."id" = 1`),
    );
    reads.push(h.ms);
    const head = h.value[0].head;
    const d = await time(() =>
      prisma.$queryRaw(Prisma.sql`
        SELECT DISTINCT "recipeId" FROM "CatalogChange"
        WHERE "revision" > ${head - 500n} AND "revision" <= ${head}
        ORDER BY "recipeId" LIMIT 201`),
    );
    deltas.push(d.ms);
  }
  out.readHead = { p50: pct(reads, 50), p95: pct(reads, 95) };
  out.readDelta500 = { p50: pct(deltas, 50), p95: pct(deltas, 95) };

  const [log] = await prisma.$queryRaw<{ n: bigint; gaps: bigint }[]>`
    SELECT count(*) AS n, (MAX("revision") - MIN("revision") + 1 - count(*)) AS gaps
    FROM "CatalogChange"`;
  out.logRows = Number(log.n);
  out.logGaps = Number(log.gaps);

  await prisma.recipe.deleteMany({ where: { householdId: house.id } });
  await prisma.household.delete({ where: { id: house.id } });
  await prisma.user.delete({ where: { id: author.id } });
  console.log(JSON.stringify(out));
  await prisma.$disconnect();
}

void main();
