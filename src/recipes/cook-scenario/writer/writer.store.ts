import { HttpStatus } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AppException } from '../../../common/app-exception';
import { COOK_SCENARIO_RULES_VERSION } from '../cook-scenario.types';
import type { WriteOutcome } from './writer.pipeline';
import type { WriterRecipe } from './writer.types';

/**
 * Przepis dla systemu pisania + podpis jego treści z TEJ SAMEJ migawki
 * (REPEATABLE READ). Podpis zapisujemy przy wersji — jeśli przepis zmieni
 * się, zanim model skończy, wersja trafi do bazy jako STALE, a nie jako
 * treść „do przepisu, którego już nie ma”.
 */
export async function loadWriterRecipe(
  prisma: PrismaClient,
  recipeId: string,
): Promise<{ recipe: WriterRecipe; signature: string } | null> {
  return prisma.$transaction(
    async (tx) => {
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
            },
          },
        },
      });
      if (!row) return null;
      const [{ signature }] = await tx.$queryRaw<{ signature: string }[]>`
        SELECT recipe_content_signature(${recipeId}::uuid) AS "signature"`;
      return {
        signature,
        recipe: {
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
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
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
  recipeId: string;
  /** Podpis z `loadWriterRecipe` — treść, do której pisał model. */
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
 */
export async function saveWrittenScenario(
  tx: Prisma.TransactionClient,
  input: SaveWrittenInput,
): Promise<{ version: number; status: string }> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Recipe" WHERE "id" = ${input.recipeId}::uuid FOR UPDATE`;
  if (locked.length === 0) {
    throw new AppException(
      'RECIPE_NOT_FOUND',
      'Nie znaleziono przepisu.',
      HttpStatus.NOT_FOUND,
    );
  }
  const [{ signature }] = await tx.$queryRaw<{ signature: string }[]>`
    SELECT recipe_content_signature(${input.recipeId}::uuid) AS "signature"`;
  const changed = signature !== input.signature;
  const status = changed ? 'STALE' : input.outcome.status;

  const last = await tx.recipeCookScenario.aggregate({
    where: { recipeId: input.recipeId },
    _max: { version: true },
  });
  const version = (last._max.version ?? 0) + 1;
  const { outcome } = input;
  await tx.recipeCookScenario.create({
    data: {
      recipeId: input.recipeId,
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
