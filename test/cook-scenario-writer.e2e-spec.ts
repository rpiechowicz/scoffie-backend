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
  publishWrittenScenario,
  saveWrittenScenario,
  writerInputHash,
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

  // Stan wzorca sprzed testu — publikacja (ostatni test) zmienia wersję na
  // przepisie, więc przywracamy go w całości, jak cook-scenario.e2e.
  let versionBefore: number | null = null;
  let idsBefore: string[] = [];

  beforeAll(async () => {
    versionBefore = (
      await prisma.recipe.findUniqueOrThrow({
        where: { id: KOTLET.recipeId },
        select: { cookScenarioVersion: true },
      })
    ).cookScenarioVersion;
    idsBefore = (
      await prisma.recipeCookScenario.findMany({
        where: { recipeId: KOTLET.recipeId },
        select: { id: true },
      })
    ).map((row) => row.id);
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Recipe" WHERE "id" = ${KOTLET.recipeId}::uuid FOR UPDATE`;
      await tx.recipeCookScenario.deleteMany({
        where: { recipeId: KOTLET.recipeId, id: { notIn: idsBefore } },
      });
      if (versionBefore !== null) {
        await tx.recipeCookScenario.updateMany({
          where: { recipeId: KOTLET.recipeId, version: versionBefore },
          data: { status: 'PUBLISHED' },
        });
      }
      await tx.recipe.update({
        where: { id: KOTLET.recipeId },
        data: { cookScenarioVersion: versionBefore },
      });
    });
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
    const { recipe, signature } = (await loadWriterRecipe(
      prisma,
      KOTLET.recipeId,
    ))!;

    const validated = await prisma.$transaction((tx) =>
      saveWrittenScenario(tx, {
        recipe,
        signature,
        outcome: outcome('VALIDATED', null),
        generator: { source: 'writer', test: true },
      }),
    );
    const skipped = await prisma.$transaction((tx) =>
      saveWrittenScenario(tx, {
        recipe,
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
    const { recipe } = (await loadWriterRecipe(prisma, KOTLET.recipeId))!;
    const saved = await prisma.$transaction((tx) =>
      saveWrittenScenario(tx, {
        recipe,
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

  // Pola spoza podpisu też kształtują treść i walidatory (np. nazwa składnika
  // decyduje o regule dla drobiu) — zmiana w trakcie pisania = STALE.
  it.each([
    [
      'nazwa składnika',
      async () => {
        const row = await prisma.recipeIngredient.findFirstOrThrow({
          where: { recipeId: KOTLET.recipeId, name: 'filet z kurczaka' },
          select: { id: true, name: true },
        });
        await prisma.recipeIngredient.update({
          where: { id: row.id },
          data: { name: 'filet z indyka' },
        });
        return () =>
          prisma.recipeIngredient.update({
            where: { id: row.id },
            data: { name: row.name },
          });
      },
    ],
    [
      'czas przygotowania',
      async () => {
        const row = await prisma.recipe.findUniqueOrThrow({
          where: { id: KOTLET.recipeId },
          select: { prepTimeMinutes: true },
        });
        await prisma.recipe.update({
          where: { id: KOTLET.recipeId },
          data: { prepTimeMinutes: row.prepTimeMinutes + 5 },
        });
        return () =>
          prisma.recipe.update({
            where: { id: KOTLET.recipeId },
            data: { prepTimeMinutes: row.prepTimeMinutes },
          });
      },
    ],
  ])(
    'zmiana poza podpisem w trakcie pisania (%s) = STALE',
    async (_label, change) => {
      const { recipe, signature } = (await loadWriterRecipe(
        prisma,
        KOTLET.recipeId,
      ))!;
      const restore = await change();
      try {
        const saved = await prisma.$transaction((tx) =>
          saveWrittenScenario(tx, {
            recipe,
            signature,
            outcome: outcome('VALIDATED', null),
            generator: { source: 'writer', test: true },
          }),
        );
        const row = await prisma.recipeCookScenario.findUniqueOrThrow({
          where: {
            recipeId_version: {
              recipeId: KOTLET.recipeId,
              version: saved.version,
            },
          },
          select: { id: true, status: true, recipeContentHash: true },
        });
        created.push(row.id);
        // Podpis się nie zmienił — to porównanie całego wejścia złapało zmianę.
        expect(row.recipeContentHash).toBe(signature);
        expect(saved.status).toBe('STALE');
      } finally {
        await restore();
      }
    },
  );
  it('„już napisany” tylko dla obecnej treści: zmiana nazwy albo ilości po zapisie = do ponowienia', async () => {
    const loaded = (await loadWriterRecipe(prisma, KOTLET.recipeId))!;
    const saved = await prisma.$transaction((tx) =>
      saveWrittenScenario(tx, {
        recipe: loaded.recipe,
        signature: loaded.signature,
        outcome: outcome('VALIDATED', null),
        generator: { source: 'writer', test: true },
      }),
    );
    const row = await prisma.recipeCookScenario.findUniqueOrThrow({
      where: {
        recipeId_version: { recipeId: KOTLET.recipeId, version: saved.version },
      },
      select: { id: true, validationReport: true },
    });
    created.push(row.id);
    expect(row.validationReport).toMatchObject({
      inputHash: writerInputHash(loaded.recipe),
    });
    const current = async () =>
      (await loadWriterRecipe(prisma, KOTLET.recipeId))!.current;
    expect(await current()).toBe(true);

    const chicken = await prisma.recipeIngredient.findFirstOrThrow({
      where: { recipeId: KOTLET.recipeId, name: 'filet z kurczaka' },
      select: { id: true, name: true, amount: true },
    });
    try {
      // Nazwa jest poza podpisem bazy — łapie ją odcisk wejścia.
      await prisma.recipeIngredient.update({
        where: { id: chicken.id },
        data: { name: 'filet z indyka' },
      });
      expect(await current()).toBe(false);
      await prisma.recipeIngredient.update({
        where: { id: chicken.id },
        data: { name: chicken.name, amount: chicken.amount + 20 },
      });
      expect(await current()).toBe(false);
    } finally {
      await prisma.recipeIngredient.update({
        where: { id: chicken.id },
        data: { name: chicken.name, amount: chicken.amount },
      });
    }
    expect(await current()).toBe(true);

    // Wiersz bez odcisku wejścia (np. wzorzec pisany ręcznie) nie jest
    // „aktualnym wynikiem” — bez względu na status.
    // (wszystkie wiersze tego pliku — wcześniejsze testy też zapisały
    // wyniki dla obecnej treści).
    await prisma.recipeCookScenario.updateMany({
      where: { id: { in: created } },
      data: { validationReport: { outcome: 'VALIDATED' } },
    });
    expect(await current()).toBe(false);
  });

  describe('publikacja wersji VALIDATED (dla panelu, E3c)', () => {
    const saveValidated = async (extra: Partial<WriteOutcome> = {}) => {
      const loaded = (await loadWriterRecipe(prisma, KOTLET.recipeId))!;
      const content = await kotletContent();
      const saved = await prisma.$transaction((tx) =>
        saveWrittenScenario(tx, {
          recipe: loaded.recipe,
          signature: loaded.signature,
          outcome: { ...outcome('VALIDATED', content), ...extra },
          generator: { source: 'writer', test: true },
        }),
      );
      const row = await prisma.recipeCookScenario.findUniqueOrThrow({
        where: {
          recipeId_version: {
            recipeId: KOTLET.recipeId,
            version: saved.version,
          },
        },
        select: { id: true },
      });
      created.push(row.id);
      return row.id;
    };
    const statusOf = async (id: string) =>
      (
        await prisma.recipeCookScenario.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        })
      ).status;
    const recipeVersion = async () =>
      (
        await prisma.recipe.findUniqueOrThrow({
          where: { id: KOTLET.recipeId },
          select: { cookScenarioVersion: true },
        })
      ).cookScenarioVersion;

    it('przepis zmieniony po napisaniu (nazwa składnika) = STALE, nie publikuje', async () => {
      const id = await saveValidated();
      const chicken = await prisma.recipeIngredient.findFirstOrThrow({
        where: { recipeId: KOTLET.recipeId, name: 'filet z kurczaka' },
        select: { id: true, name: true },
      });
      const before = await recipeVersion();
      await prisma.recipeIngredient.update({
        where: { id: chicken.id },
        data: { name: 'filet z indyka' },
      });
      try {
        await expect(
          prisma.$transaction((tx) => publishWrittenScenario(tx, id)),
        ).resolves.toEqual({ published: false, reason: 'STALE' });
        expect(await statusOf(id)).toBe('STALE');
        expect(await recipeVersion()).toBe(before);
      } finally {
        await prisma.recipeIngredient.update({
          where: { id: chicken.id },
          data: { name: chicken.name },
        });
      }
      // STALE zostaje — po przywróceniu nazwy i tak trzeba napisać od nowa.
      await expect(
        prisma.$transaction((tx) => publishWrittenScenario(tx, id)),
      ).resolves.toEqual({ published: false, reason: 'NOT_VALIDATED' });
    });

    it('wersja z odwodu (ocena poniżej progu) nie publikuje się bez świadomej zgody', async () => {
      const id = await saveValidated({
        review: { score: 3, issues: [], summary: 'drobiazgi' },
        belowThreshold: true,
      });
      const before = await recipeVersion();
      await expect(
        prisma.$transaction((tx) => publishWrittenScenario(tx, id)),
      ).resolves.toEqual({ published: false, reason: 'BELOW_THRESHOLD' });
      expect(await statusOf(id)).toBe('VALIDATED');
      expect(await recipeVersion()).toBe(before);
    });

    it('zmienione kroki przepisu = STALE', async () => {
      const id = await saveValidated();
      const before = await prisma.recipe.findUniqueOrThrow({
        where: { id: KOTLET.recipeId },
        select: { sourceInstructions: true },
      });
      const steps = before.sourceInstructions as Array<{
        step: number;
        text: string;
      }>;
      await prisma.recipe.update({
        where: { id: KOTLET.recipeId },
        data: {
          sourceInstructions: steps.map((step, i) =>
            i === 0
              ? { ...step, text: step.text + ' Dodatkowe zdanie.' }
              : step,
          ),
        },
      });
      try {
        await expect(
          prisma.$transaction((tx) => publishWrittenScenario(tx, id)),
        ).resolves.toEqual({ published: false, reason: 'STALE' });
      } finally {
        await prisma.recipe.update({
          where: { id: KOTLET.recipeId },
          data: { sourceInstructions: steps },
        });
      }
    });

    it('niezmieniony przepis = publikacja z odciskiem wejścia; SKIPPED się nie publikuje', async () => {
      const id = await saveValidated();
      const result = await prisma.$transaction((tx) =>
        publishWrittenScenario(tx, id),
      );
      expect(result).toMatchObject({ published: true, changed: true });
      if (!result.published) throw new Error('nie opublikowano');
      const published = await prisma.recipeCookScenario.findUniqueOrThrow({
        where: {
          recipeId_version: {
            recipeId: KOTLET.recipeId,
            version: result.version,
          },
        },
        select: { status: true, validationReport: true },
      });
      const loaded = (await loadWriterRecipe(prisma, KOTLET.recipeId))!;
      expect(published.status).toBe('PUBLISHED');
      expect(published.validationReport).toMatchObject({
        inputHash: writerInputHash(loaded.recipe),
        publishedFrom: id,
      });
      expect(await recipeVersion()).toBe(result.version);
      // Opublikowana wersja z odciskiem to „aktualny wynik” dla wznowień.
      expect(loaded.current).toBe(true);

      const skipped = await prisma.$transaction((tx) =>
        saveWrittenScenario(tx, {
          recipe: loaded.recipe,
          signature: loaded.signature,
          outcome: outcome('SKIPPED', null),
          generator: { source: 'writer', test: true },
        }),
      );
      const skippedRow = await prisma.recipeCookScenario.findUniqueOrThrow({
        where: {
          recipeId_version: {
            recipeId: KOTLET.recipeId,
            version: skipped.version,
          },
        },
        select: { id: true },
      });
      await expect(
        prisma.$transaction((tx) => publishWrittenScenario(tx, skippedRow.id)),
      ).resolves.toEqual({ published: false, reason: 'NOT_VALIDATED' });
    });
  });
});
