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
  DryRunRollback,
  exportValidatedScenarios,
  importScenario,
  portableInputHash,
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
      portableHash: portableInputHash(loaded.recipe),
      review: { score: 4, summary: 'ok' },
    });
    // Plik jest przenośny: składniki po nazwie, bez id tej bazy.
    const raw = JSON.stringify(entry.content);
    expect(raw).not.toContain('ingredientId');
    for (const row of loaded.recipe.ingredients) {
      expect(raw).not.toContain(row.ingredientId);
    }

    // Wzorzec pisany ręcznie jest opublikowany — import go nie zastępuje.
    if (publishedBefore.length) expect(await run(entry)).toBe('GOLDEN');

    // Inny przepis na docelowej bazie (inny odcisk) = nic nie zapisuje.
    expect(await run({ ...entry, portableHash: 'sha256:inny' })).toBe(
      'CHANGED',
    );
    expect(
      await run({ ...entry, recipeId: '00000000-0000-4000-8000-000000000000' }),
    ).toBe('NOT_FOUND');

    // Bez opublikowanego wzorca: próba liczy jak import i wszystko wycofuje.
    await prisma.recipeCookScenario.updateMany({
      where: { id: { in: publishedBefore } },
      data: { status: 'RETIRED' },
    });
    const count = () =>
      prisma.recipeCookScenario.count({ where: { recipeId: KOTLET.recipeId } });
    const before = await count();
    await expect(run(entry, true)).rejects.toMatchObject({
      outcome: 'PUBLISHED',
    });
    await expect(run(entry, true)).rejects.toBeInstanceOf(DryRunRollback);
    expect(await count()).toBe(before);
    expect(await run(entry)).toBe('PUBLISHED');
    const published = await prisma.recipeCookScenario.findFirstOrThrow({
      where: { recipeId: KOTLET.recipeId, status: 'PUBLISHED' },
      select: { content: true, validationReport: true },
    });
    // Nazwy wróciły do id tej bazy — ta sama treść, co napisana.
    expect(published.content).toEqual(content);
    // Opublikowana wersja niesie odcisk TEJ bazy — system pisania uzna ją
    // za aktualny wynik.
    expect(published.validationReport).toMatchObject({
      inputHash: writerInputHash(loaded.recipe),
    });
    expect((await loadWriterRecipe(prisma, KOTLET.recipeId))!.current).toBe(
      true,
    );
    expect(await run(entry)).toBe('UNCHANGED');
  });

  it('przenośny odcisk nie zależy od id składników ani kolejności wierszy', async () => {
    const { recipe } = (await loadWriterRecipe(prisma, KOTLET.recipeId))!;
    const elsewhere = {
      ...recipe,
      ingredients: [...recipe.ingredients].reverse().map((row, index) => ({
        ...row,
        ingredientId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })),
    };
    expect(portableInputHash(elsewhere)).toBe(portableInputHash(recipe));
    expect(writerInputHash(elsewhere)).not.toBe(writerInputHash(recipe));
    const changed = {
      ...recipe,
      ingredients: recipe.ingredients.map((row, index) =>
        index === 0 ? { ...row, amount: row.amount + 1 } : row,
      ),
    };
    expect(portableInputHash(changed)).not.toBe(portableInputHash(recipe));
  });

  it('plik z innych zasad albo niekompletny = odmowa przed czymkolwiek', () => {
    const base = {
      format: 'scoffie-cook-scenarios',
      version: 2,
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
