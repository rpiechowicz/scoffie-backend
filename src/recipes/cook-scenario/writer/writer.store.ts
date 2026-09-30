import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HttpStatus } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AppException } from '../../../common/app-exception';
import { COOK_SCENARIO_RULES_VERSION } from '../cook-scenario.types';
import type { WriteOutcome } from './writer.pipeline';
import type { WriterRecipe } from './writer.types';

/**
 * Przepis dla systemu pisania + podpis jego treści z TEJ SAMEJ migawki
 * (REPEATABLE READ). Podpis zapisujemy przy wersji (`recipeContentHash`,
 * po nim baza unieważnia opublikowany scenariusz), a przy zapisie
 * porównujemy CAŁE wejście modelu — patrz `saveWrittenScenario`.
 */
export async function loadWriterRecipe(
  prisma: PrismaClient,
  recipeId: string,
): Promise<{ recipe: WriterRecipe; signature: string } | null> {
  return prisma.$transaction(
    async (tx) => {
      const recipe = await readWriterRecipe(tx, recipeId);
      if (!recipe) return null;
      const [{ signature }] = await tx.$queryRaw<{ signature: string }[]>`
        SELECT recipe_content_signature(${recipeId}::uuid) AS "signature"`;
      return { recipe, signature };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** Wszystko, co widzą autor i recenzent — w transakcji wołającego. */
async function readWriterRecipe(
  tx: Prisma.TransactionClient,
  recipeId: string,
): Promise<WriterRecipe | null> {
  const row = await tx.recipe.findUnique({
    where: { id: recipeId },
    select: {
      id: true,
      title: true,
      description: true,
      servings: true,
      mealType: true,
      difficulty: true,
      prepTimeMinutes: true,
      dishType: true,
      equipment: true,
      sourceInstructions: true,
      ingredients: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          ingredientId: true,
          name: true,
          amount: true,
          unit: true,
          department: true,
        },
      },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    servings: row.servings,
    mealType: row.mealType,
    difficulty: row.difficulty,
    prepTimeMinutes: row.prepTimeMinutes,
    dishType: row.dishType,
    equipment: row.equipment,
    instructions: instructionLines(row.sourceInstructions),
    ingredients: row.ingredients,
  };
}

/** `sourceInstructions`: `[{ step, text }]` albo lista napisów. */
export function instructionLines(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const text = (item as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface SaveWrittenInput {
  /** Przepis z `loadWriterRecipe` — dokładnie to, co widział model. */
  recipe: WriterRecipe;
  /** Podpis z tej samej migawki. */
  signature: string;
  outcome: WriteOutcome;
  generator: Prisma.InputJsonValue;
}

/**
 * Zapisuje wynik systemu pisania jako NOWĄ wersję (VALIDATED / REJECTED /
 * SKIPPED, albo STALE, gdy przepis zmienił się w trakcie). Nigdy nie
 * publikuje i nie rusza `Recipe.cookScenarioVersion` — telefon nic nie widzi.
 *
 * Najpierw blokada wiersza przepisu (jak `publishCookScenario`): numer
 * wersji liczony pod blokadą, a reguła migracji E2 mówi, że wiersze
 * scenariuszy zmienia tylko ten, kto trzyma przepis.
 *
 * „Zmienił się” = zmieniło się COKOLWIEK z wejścia modelu, nie tylko pola
 * podpisu (review Codexa, E3a runda 1): nazwa składnika, opis, czas, sprzęt
 * też kształtują treść i walidatory (np. bezpieczeństwo drobiu czyta nazwy).
 * Pod blokadą czytamy przepis jeszcze raz i porównujemy w całości.
 */
export async function saveWrittenScenario(
  tx: Prisma.TransactionClient,
  input: SaveWrittenInput,
): Promise<{ version: number; status: string }> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Recipe" WHERE "id" = ${input.recipe.id}::uuid FOR UPDATE`;
  if (locked.length === 0) {
    throw new AppException(
      'RECIPE_NOT_FOUND',
      'Nie znaleziono przepisu.',
      HttpStatus.NOT_FOUND,
    );
  }
  const [{ signature }] = await tx.$queryRaw<{ signature: string }[]>`
    SELECT recipe_content_signature(${input.recipe.id}::uuid) AS "signature"`;
  const current = await readWriterRecipe(tx, input.recipe.id);
  const changed =
    signature !== input.signature || !isDeepStrictEqual(current, input.recipe);
  const status = changed ? 'STALE' : input.outcome.status;

  const last = await tx.recipeCookScenario.aggregate({
    where: { recipeId: input.recipe.id },
    _max: { version: true },
  });
  const version = (last._max.version ?? 0) + 1;
  const { outcome } = input;
  await tx.recipeCookScenario.create({
    data: {
      recipeId: input.recipe.id,
      version,
      status,
      recipeContentHash: input.signature,
      rulesVersion: COOK_SCENARIO_RULES_VERSION,
      content: outcome.content
        ? (outcome.content as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      skipReason: outcome.skipReason,
      generator: input.generator,
      validationReport: {
        outcome: outcome.status,
        inputHash: writerInputHash(input.recipe),
        recipeChangedDuringWrite: changed,
        review: outcome.review,
        warnings: outcome.warnings,
        attempts: outcome.attempts,
        usage: outcome.usage,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  return { version, status };
}

/**
 * Odcisk CAŁEGO wejścia modelu. Podpis bazy (`recipe_content_signature`)
 * obejmuje tylko pola, od których zależą ilości i kroki; nazwy składników,
 * opis czy sprzęt też zmieniają treść i walidatory (np. bezpieczeństwo
 * drobiu czyta nazwy). Zapisywany przy każdej wersji systemu pisania.
 */
export function writerInputHash(recipe: WriterRecipe): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(recipe)).digest('hex')}`;
}

/**
 * Czy przepis ma już wynik systemu pisania DLA SWOJEJ OBECNEJ TREŚCI
 * (review Codexa, E3a runda 4). Wersje robocze nie dostają STALE od
 * triggera (ten pilnuje tylko PUBLISHED), więc „jest wiersz” to za mało:
 * wiersz liczy się tylko przy tych samych zasadach, tym samym podpisie
 * i — dla wyników systemu pisania — tym samym odcisku wejścia. Wzorzec
 * pisany ręcznie (PUBLISHED bez odcisku) liczy się po podpisie, który
 * trigger trzyma w ryzach.
 */
export async function hasCurrentWrite(
  prisma: PrismaClient,
  loaded: { recipe: WriterRecipe; signature: string },
): Promise<boolean> {
  const rows = await prisma.recipeCookScenario.findMany({
    where: {
      recipeId: loaded.recipe.id,
      rulesVersion: COOK_SCENARIO_RULES_VERSION,
      recipeContentHash: loaded.signature,
      status: { in: ['VALIDATED', 'REJECTED', 'SKIPPED', 'PUBLISHED'] },
    },
    select: { status: true, validationReport: true },
  });
  const hash = writerInputHash(loaded.recipe);
  return rows.some((row) => {
    const report = row.validationReport as { inputHash?: unknown } | null;
    if (typeof report?.inputHash === 'string') return report.inputHash === hash;
    return row.status === 'PUBLISHED';
  });
}
