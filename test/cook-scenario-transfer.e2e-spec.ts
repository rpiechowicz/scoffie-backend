import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  resolveGoldenContent,
  type GoldenScenarioFile,
} from '../src/recipes/cook-scenario/cook-scenario.golden';
import { COOK_SCENARIO_RULES_VERSION } from '../src/recipes/cook-scenario/cook-scenario.types';
import { parseCookScenarioContent } from '../src/recipes/cook-scenario/cook-scenario.validate';
import {
  loadWriterRecipe,
  saveWrittenScenario,
  writerInputHash,
} from '../src/recipes/cook-scenario/writer/writer.store';
import {
  exportValidatedScenarios,
  importScenario,
  parseExportFile,
  type CookScenarioExportEntry,
} from '../src/recipes/cook-scenario/writer/writer.transfer';
import { ZERO_USAGE } from '../src/recipes/cook-scenario/writer/writer.types';

/**
 * Przeniesienie scenariuszy z bazy lokalnej na prod (eksport → import):
 * eksport bierze aktualne VALIDATED, import publikuje tylko przy tym samym
 * wejściu modelu i nie zastępuje wzorca pisanego ręcznie.
 */
const GOLDEN = JSON.parse(
  readFileSync(
    join(__dirname, '..', 'prisma', 'catalog', 'cook-scenarios-pl-v1.json'),
    'utf8',
  ),
) as GoldenScenarioFile;
const KOTLET = GOLDEN.scenarios[0];

describe('Scenariusze Gotuj — eksport i import (E2E)', () => {
  const prisma = new PrismaClient();
  let versionBefore: number | null = null;
  let idsBefore: string[] = [];
  let publishedBefore: string[] = [];

  beforeAll(async () => {
    versionBefore = (
      await prisma.recipe.findUniqueOrThrow({
        where: { id: KOTLET.recipeId },
        select: { cookScenarioVersion: true },
      })
    ).cookScenarioVersion;
    const rows = await prisma.recipeCookScenario.findMany({
      where: { recipeId: KOTLET.recipeId },
      select: { id: true, status: true },
    });
    idsBefore = rows.map((row) => row.id);
    publishedBefore = rows
      .filter((row) => row.status === 'PUBLISHED')
      .map((row) => row.id);
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Recipe" WHERE "id" = ${KOTLET.recipeId}::uuid FOR UPDATE`;
      await tx.recipeCookScenario.deleteMany({
        where: { recipeId: KOTLET.recipeId, id: { notIn: idsBefore } },
      });
      await tx.recipeCookScenario.updateMany({
        where: { id: { in: publishedBefore } },
        data: { status: 'PUBLISHED' },
      });
      await tx.recipe.update({
        where: { id: KOTLET.recipeId },
        data: { cookScenarioVersion: versionBefore },
      });
    });
    await prisma.$disconnect();
  });

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

  const run = (entry: CookScenarioExportEntry, dryRun = false) =>
    prisma.$transaction((tx) =>
      importScenario(tx, entry, { exportedAt: '2026-10-02T00:00:00Z', dryRun }),
    );

  it('eksport → import: tylko ten sam przepis, wzorca nie zastępuje, drugi raz bez zmian', async () => {
    const loaded = (await loadWriterRecipe(prisma, KOTLET.recipeId))!;
    const content = await kotletContent();
    await prisma.$transaction((tx) =>
      saveWrittenScenario(tx, {
        recipe: loaded.recipe,
        signature: loaded.signature,
        outcome: {
          status: 'VALIDATED',
          content,
          skipReason: null,
          review: { score: 4, issues: [], summary: 'ok' },
          warnings: [],
          attempts: [],
          usage: ZERO_USAGE,
        },
        generator: { source: 'writer', test: true },
      }),
    );

    const file = parseExportFile(
      JSON.parse(JSON.stringify(await exportValidatedScenarios(prisma))),
    );
    expect(file.rulesVersion).toBe(COOK_SCENARIO_RULES_VERSION);
    const entry = file.scenarios.find(
      (row) => row.recipeId === KOTLET.recipeId,
    )!;
    expect(entry).toMatchObject({
      recipeContentHash: loaded.signature,
      inputHash: writerInputHash(loaded.recipe),
      review: { score: 4, summary: 'ok' },
    });
    expect(entry.content).toEqual(content);

    // Wzorzec pisany ręcznie jest opublikowany — import go nie zastępuje.
    if (publishedBefore.length) expect(await run(entry)).toBe('GOLDEN');

    // Inny przepis na docelowej bazie (inny odcisk) = nic nie zapisuje.
    expect(await run({ ...entry, inputHash: 'sha256:inny' })).toBe('CHANGED');
    expect(
      await run({ ...entry, recipeId: '00000000-0000-4000-8000-000000000000' }),
    ).toBe('NOT_FOUND');

    // Bez opublikowanego wzorca: próba nic nie zapisuje, import publikuje.
    await prisma.recipeCookScenario.updateMany({
      where: { id: { in: publishedBefore } },
      data: { status: 'RETIRED' },
    });
    const count = () =>
      prisma.recipeCookScenario.count({ where: { recipeId: KOTLET.recipeId } });
    const before = await count();
    expect(await run(entry, true)).toBe('WOULD_PUBLISH');
    expect(await count()).toBe(before);
    expect(await run(entry)).toBe('PUBLISHED');
    const published = await prisma.recipeCookScenario.findFirstOrThrow({
      where: { recipeId: KOTLET.recipeId, status: 'PUBLISHED' },
      select: { content: true, validationReport: true },
    });
    expect(published.content).toEqual(content);
    // Opublikowana wersja niesie odcisk — system pisania uzna ją za aktualną.
    expect(published.validationReport).toMatchObject({
      inputHash: entry.inputHash,
    });
    expect((await loadWriterRecipe(prisma, KOTLET.recipeId))!.current).toBe(
      true,
    );
    expect(await run(entry)).toBe('UNCHANGED');
  });

  it('plik z innych zasad albo niekompletny = odmowa przed czymkolwiek', () => {
    const base = {
      format: 'scoffie-cook-scenarios',
      version: 1,
      rulesVersion: COOK_SCENARIO_RULES_VERSION,
      exportedAt: '2026-10-02T00:00:00Z',
      count: 0,
      scenarios: [],
    };
    expect(() => parseExportFile(base)).not.toThrow();
    expect(() => parseExportFile({ ...base, rulesVersion: 'stare' })).toThrow(
      /zasad/,
    );
    expect(() => parseExportFile({ ...base, count: 3 })).toThrow(
      /niekompletny/,
    );
    expect(() => parseExportFile({ ...base, format: 'inny' })).toThrow();
  });
});
