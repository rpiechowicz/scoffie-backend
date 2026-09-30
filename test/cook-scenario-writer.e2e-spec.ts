import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  resolveGoldenContent,
  type GoldenScenarioFile,
} from '../src/recipes/cook-scenario/cook-scenario.golden';
import { parseCookScenarioContent } from '../src/recipes/cook-scenario/cook-scenario.validate';
import type { WriteOutcome } from '../src/recipes/cook-scenario/writer/writer.pipeline';
import {
  loadWriterRecipe,
  saveWrittenScenario,
} from '../src/recipes/cook-scenario/writer/writer.store';
import { ZERO_USAGE } from '../src/recipes/cook-scenario/writer/writer.types';

/**
 * Zapis wyników systemu pisania (E3a) na żywej bazie:
 * - przepis i podpis z jednej migawki;
 * - nowa wersja VALIDATED/SKIPPED nie rusza opublikowanego scenariusza,
 *   `Recipe.cookScenarioVersion` ani logu katalogu — telefon nic nie widzi;
 * - przepis zmieniony w trakcie pisania = wersja STALE.
 */
const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, '..', 'prisma', 'catalog', 'cook-scenarios-pl-v1.json'),
    'utf8',
  ),
) as GoldenScenarioFile;
const KOTLET = GOLDEN.scenarios[0];

describe('System pisania scenariuszy — zapis (E2E)', () => {
  const prisma = new PrismaClient();
  const created: string[] = [];

  const outcome = (
    status: WriteOutcome['status'],
    content: WriteOutcome['content'],
  ): WriteOutcome => ({
    status,
    content,
    skipReason: status === 'SKIPPED' ? 'Samo złożenie.' : null,
    review:
      status === 'VALIDATED' ? { score: 5, issues: [], summary: 'ok' } : null,
    warnings: [],
    attempts: [],
    usage: ZERO_USAGE,
  });

  const maxRevision = async (): Promise<bigint> => {
    const rows = await prisma.$queryRaw<{ max: bigint | null }[]>`
      SELECT MAX("revision") AS "max" FROM "CatalogChange" WHERE "recipeId" = ${KOTLET.recipeId}::uuid`;
    return rows[0]?.max ?? 0n;
  };

  const kotletContent = async () => {
    const loaded = (await loadWriterRecipe(prisma, KOTLET.recipeId))!;
    const byName = new Map(
      loaded.recipe.ingredients.map((row) => [row.name, row.ingredientId]),
    );
    const resolved = resolveGoldenContent(KOTLET.content, (name) =>
      byName.get(name),
    );
    return parseCookScenarioContent(resolved.content).content!;
  };

  afterAll(async () => {
    if (created.length) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Recipe" WHERE "id" = ${KOTLET.recipeId}::uuid FOR UPDATE`;
        await tx.recipeCookScenario.deleteMany({
          where: { id: { in: created } },
        });
      });
    }
    await prisma.$disconnect();
  });

  it('czyta przepis z krokami i podpisem liczonym przez bazę', async () => {
    const loaded = await loadWriterRecipe(prisma, KOTLET.recipeId);
    expect(loaded).not.toBeNull();
    const [{ signature }] = await prisma.$queryRaw<{ signature: string }[]>`
      SELECT recipe_content_signature(${KOTLET.recipeId}::uuid) AS "signature"`;
    expect(loaded!.signature).toBe(signature);
    expect(loaded!.recipe.instructions.length).toBeGreaterThan(0);
    expect(loaded!.recipe.ingredients.length).toBeGreaterThan(0);
    expect(
      await loadWriterRecipe(prisma, '00000000-0000-4000-8000-000000000000'),
    ).toBeNull();
  });

  it('VALIDATED i SKIPPED to nowe wersje, a telefon i log katalogu nic nie widzą', async () => {
    const before = await prisma.recipe.findUniqueOrThrow({
      where: { id: KOTLET.recipeId },
      select: { cookScenarioVersion: true },
    });
    const publishedBefore = await prisma.recipeCookScenario.findMany({
      where: { recipeId: KOTLET.recipeId, status: 'PUBLISHED' },
      select: { id: true },
    });
    const revisionBefore = await maxRevision();
    const last = await prisma.recipeCookScenario.aggregate({
      where: { recipeId: KOTLET.recipeId },
      _max: { version: true },
    });
    const { signature } = (await loadWriterRecipe(prisma, KOTLET.recipeId))!;

    const validated = await prisma.$transaction((tx) =>
      saveWrittenScenario(tx, {
        recipeId: KOTLET.recipeId,
        signature,
        outcome: outcome('VALIDATED', null),
        generator: { source: 'writer', test: true },
      }),
    );
    const skipped = await prisma.$transaction((tx) =>
      saveWrittenScenario(tx, {
        recipeId: KOTLET.recipeId,
        signature,
        outcome: outcome('SKIPPED', null),
        generator: { source: 'writer', test: true },
      }),
    );
    expect(validated).toEqual({
      version: (last._max.version ?? 0) + 1,
      status: 'VALIDATED',
    });
    expect(skipped).toEqual({
      version: validated.version + 1,
      status: 'SKIPPED',
    });

    const rows = await prisma.recipeCookScenario.findMany({
      where: {
        recipeId: KOTLET.recipeId,
        version: { in: [validated.version, skipped.version] },
      },
      orderBy: { version: 'asc' },
    });
    created.push(...rows.map((row) => row.id));
    expect(
      rows.map((row) => [
        row.status,
        row.recipeContentHash,
        row.content,
        row.skipReason,
      ]),
    ).toEqual([
      ['VALIDATED', signature, null, null],
      ['SKIPPED', signature, null, 'Samo złożenie.'],
    ]);
    expect(rows[0].publishedAt).toBeNull();

    const after = await prisma.recipe.findUniqueOrThrow({
      where: { id: KOTLET.recipeId },
      select: { cookScenarioVersion: true },
    });
    expect(after.cookScenarioVersion).toBe(before.cookScenarioVersion);
    expect(
      await prisma.recipeCookScenario.findMany({
        where: { recipeId: KOTLET.recipeId, status: 'PUBLISHED' },
        select: { id: true },
      }),
    ).toEqual(publishedBefore);
    expect(await maxRevision()).toBe(revisionBefore);
  });

  it('treść zapisuje się w całości, a przepis zmieniony w trakcie pisania = STALE', async () => {
    const content = await kotletContent();
    const saved = await prisma.$transaction((tx) =>
      saveWrittenScenario(tx, {
        recipeId: KOTLET.recipeId,
        signature: 'md5:przepis-sprzed-zmiany',
        outcome: outcome('VALIDATED', content),
        generator: { source: 'writer', test: true },
      }),
    );
    expect(saved.status).toBe('STALE');
    const row = await prisma.recipeCookScenario.findUniqueOrThrow({
      where: {
        recipeId_version: { recipeId: KOTLET.recipeId, version: saved.version },
      },
    });
    created.push(row.id);
    expect(row.content).toEqual(content);
    expect(row.recipeContentHash).toBe('md5:przepis-sprzed-zmiany');
    expect(row.validationReport).toMatchObject({
      outcome: 'VALIDATED',
      recipeChangedDuringWrite: true,
    });
  });
});
