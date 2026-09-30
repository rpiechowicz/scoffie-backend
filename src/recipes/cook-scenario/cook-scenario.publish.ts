import { isDeepStrictEqual } from 'node:util';
import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { recipeContentHash } from './cook-scenario.hash';
import {
  checkScenarioAgainstRecipe,
  parseCookScenarioContent,
} from './cook-scenario.validate';

export interface PublishCookScenarioInput {
  recipeId: string;
  content: unknown;
  rulesVersion: string;
  /** Skąd treść: `{ source: 'golden' }`, później `{ source: 'model', model, promptVersion }`. */
  generator: Prisma.InputJsonValue;
}

export interface PublishCookScenarioResult {
  recipeId: string;
  version: number;
  /** `false` = obowiązująca wersja ma już tę treść dla tego przepisu (nic nie zapisano). */
  changed: boolean;
}

/**
 * Publikuje scenariusz przepisu — WYŁĄCZNIE w transakcji wołającego (`tx`).
 *
 * Kolejność:
 * 1. blokada wiersza przepisu (`FOR UPDATE`) — dwie publikacje tego samego
 *    przepisu idą po kolei, więc numer wersji i „jeden PUBLISHED” się nie
 *    rozjadą (częściowy indeks unikalny jest drugą siatką);
 * 2. kształt + zgodność z przepisem — przy błędzie 400 z listą, nic się nie
 *    zapisuje;
 * 3. ta sama treść i ten sam odcisk co obowiązująca wersja → bez zapisu
 *    (loader jest idempotentny, a log katalogu nie dostaje pustej zmiany);
 * 4. dotychczasowy PUBLISHED → RETIRED, nowy wiersz PUBLISHED z kolejną
 *    wersją, `Recipe.cookScenarioVersion` = nowa wersja. Ta ostatnia zmiana
 *    przesuwa log katalogu (trigger `Recipe_catalog_change`) — telefony
 *    dowiadują się o trybie Gotuj zwykłą deltą. Blokada wiersza to DML,
 *    nie `LOCK TABLE`, więc reguły ADR catalog-change-commit-order trzymają.
 */
export async function publishCookScenario(
  tx: Prisma.TransactionClient,
  input: PublishCookScenarioInput,
): Promise<PublishCookScenarioResult> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Recipe" WHERE "id" = ${input.recipeId}::uuid FOR UPDATE`;
  if (locked.length === 0) {
    throw new AppException(
      'RECIPE_NOT_FOUND',
      'Nie znaleziono przepisu.',
      HttpStatus.NOT_FOUND,
    );
  }
  const recipe = await tx.recipe.findUniqueOrThrow({
    where: { id: input.recipeId },
    select: {
      id: true,
      title: true,
      servings: true,
      sourceInstructions: true,
      ingredients: {
        select: { ingredientId: true, name: true, amount: true, unit: true },
      },
    },
  });

  const parsed = parseCookScenarioContent(input.content);
  const errors = parsed.content
    ? checkScenarioAgainstRecipe(parsed.content, recipe)
    : parsed.errors;
  if (!parsed.content || errors.length > 0) {
    throw new AppException(
      'VALIDATION_ERROR',
      'Scenariusz nie przechodzi walidacji.',
      HttpStatus.BAD_REQUEST,
      errors,
    );
  }

  const hash = recipeContentHash(recipe);
  const current = await tx.recipeCookScenario.findFirst({
    where: { recipeId: recipe.id, status: 'PUBLISHED' },
    select: { id: true, version: true, recipeContentHash: true, content: true },
  });
  if (
    current &&
    current.recipeContentHash === hash &&
    isDeepStrictEqual(current.content, parsed.content)
  ) {
    return { recipeId: recipe.id, version: current.version, changed: false };
  }

  const last = await tx.recipeCookScenario.aggregate({
    where: { recipeId: recipe.id },
    _max: { version: true },
  });
  const version = (last._max.version ?? 0) + 1;
  if (current) {
    await tx.recipeCookScenario.update({
      where: { id: current.id },
      data: { status: 'RETIRED' },
    });
  }
  await tx.recipeCookScenario.create({
    data: {
      recipeId: recipe.id,
      version,
      status: 'PUBLISHED',
      recipeContentHash: hash,
      rulesVersion: input.rulesVersion,
      content: parsed.content as unknown as Prisma.InputJsonValue,
      generator: input.generator,
      publishedAt: new Date(),
    },
  });
  await tx.recipe.update({
    where: { id: recipe.id },
    data: { cookScenarioVersion: version },
  });
  return { recipeId: recipe.id, version, changed: true };
}
