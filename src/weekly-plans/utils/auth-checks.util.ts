import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

/// `ensureMembership` policzone jeszcze raz W transakcji zapisu, PO zamku
/// tygodnia (`lockWeekForWrite`).
///
/// AUDYT 21.09.2026. Bramka na wejściu metody biegnie przed transakcją, więc
/// żądanie, które ją minęło tuż przed wyrzuceniem domownika, zapisywało potem
/// do domu, w którym tej osoby już nie było. Usunięcie ze składu bierze ten
/// sam zamek (`onMemberLeft` → `lockWeeksForWriteFrom`), więc po nim oba
/// zdarzenia są uszeregowane: kto czekał na zamek, liczy członkostwo już po
/// cudzym zatwierdzeniu (w SERIALIZABLE — po ponowieniu na świeżej migawce).
///
/// `participantIds` to ta sama reguła dla osób WPISYWANYCH do posiłku: bez
/// niej zapis, który przeczekał usunięcie, odtwarzał wiersz uczestnika dla
/// kogoś, kogo `onMemberLeft` dopiero co z planu wyczyścił.
export async function ensureMembershipInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  householdId: string,
  participantIds: readonly string[] = [],
): Promise<void> {
  const wanted = Array.from(new Set([userId, ...participantIds]));
  const present = await tx.membership.findMany({
    where: { householdId, userId: { in: wanted } },
    select: { userId: true },
  });
  const presentIds = new Set(present.map((row) => row.userId));
  if (!presentIds.has(userId)) {
    throw new AppException(
      'NOT_HOUSEHOLD_MEMBER',
      'User is not a member of this household',
      HttpStatus.FORBIDDEN,
    );
  }
  const gone = wanted.filter((id) => !presentIds.has(id));
  if (gone.length > 0) {
    throw new AppException(
      'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
      `Not a household member: ${gone.join(', ')}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}
