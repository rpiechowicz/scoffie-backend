import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { assertUuid } from '../../common/uuid';
import { PrismaService } from '../../prisma/prisma.service';

/// Confirms a recipe exists. The `_householdId` is reserved for future
/// authorisation but isn't used yet (recipes are currently global).
///
/// Bramka UUID siedzi tu, a nie w każdym wołającym: jedna linia chroni każdą
/// ścieżkę, która trafia w kolumnę `@db.Uuid` — inaczej `recipe-uuid-1` z
/// narzędzia asystenta kończyłby się P2023 → 500 zamiast VALIDATION_ERROR.
export async function ensureRecipeForHousehold(
  prisma: PrismaService,
  recipeId: string,
  _householdId: string,
) {
  assertUuid(recipeId, 'recipeId');
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: { id: true },
  });
  if (!recipe) {
    throw new AppException(
      'RECIPE_NOT_FOUND',
      'Recipe not found',
      HttpStatus.NOT_FOUND,
    );
  }
  return recipe;
}

/// Confirms the caller is a member of the target household, throwing
/// ForbiddenException if not. Used as a permission gate at the top of
/// every state-changing service method.
///
/// `householdId` przechodzi przez `assertUuid` PRZED pierwszym zapytaniem —
/// każda metoda serwisu planu i listy zakupów zaczyna od tej bramki, więc to
/// jedno miejsce zamyka P2023 dla całego modułu. `userId` nie jest
/// sprawdzany: pochodzi z tokenu albo z `actorId`, które już go zweryfikowały.
export async function ensureMembership(
  prisma: PrismaService,
  userId: string,
  householdId: string,
) {
  assertUuid(householdId, 'householdId');
  const membership = await prisma.membership.findUnique({
    where: { userId_householdId: { userId, householdId } },
  });
  if (!membership) {
    throw new AppException(
      'NOT_HOUSEHOLD_MEMBER',
      'User is not a member of this household',
      HttpStatus.FORBIDDEN,
    );
  }
  return membership;
}
