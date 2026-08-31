import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { assertUuid } from '../../common/uuid';
import { PrismaService } from '../../prisma/prisma.service';

/// Sprawdza, że przepis istnieje I WOLNO go wstawić do planu tego
/// gospodarstwa: musi być z katalogu albo należeć do tego domu.
///
/// Do Fazy 0 ten argument nazywał się `_householdId` i był nieużywany, bo
/// wszystkie przepisy w bazie były wspólne. Od `isCatalog` już nie są.
///
/// Bramka UUID siedzi tu, a nie w każdym wołającym: jedna linia chroni każdą
/// ścieżkę, która trafia w kolumnę `@db.Uuid` — inaczej `recipe-uuid-1` z
/// narzędzia asystenta kończyłby się P2023 → 500 zamiast VALIDATION_ERROR.
export async function ensureRecipeForHousehold(
  prisma: PrismaService,
  recipeId: string,
  householdId: string,
) {
  assertUuid(recipeId, 'recipeId');
  assertUuid(householdId, 'householdId');
  // Do slotu wolno wstawić przepis z katalogu albo własny przepis
  // gospodarstwa. Wcześniej ten argument był nieużywany (`_householdId`) i
  // każdy przepis w bazie nadawał się do każdego planu — nieszkodliwe, dopóki
  // wszystkie przepisy były wspólne.
  const recipe = await prisma.recipe.findFirst({
    where: {
      id: recipeId,
      // Wycofany przepis (`recipes:delete` ustawia `isActive = false`) nie ma
      // prawa wejść do planu, choć wiersz nadal istnieje.
      isActive: true,
      OR: [{ isCatalog: true }, { householdId }],
    },
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
