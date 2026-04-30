import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/// Confirms a recipe exists. The `_householdId` is reserved for future
/// authorisation but isn't used yet (recipes are currently global).
export async function ensureRecipeForHousehold(
  prisma: PrismaService,
  recipeId: string,
  _householdId: string,
) {
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: { id: true },
  });
  if (!recipe) {
    throw new NotFoundException('Recipe not found');
  }
  return recipe;
}

/// Confirms the caller is a member of the target household, throwing
/// ForbiddenException if not. Used as a permission gate at the top of
/// every state-changing service method.
export async function ensureMembership(
  prisma: PrismaService,
  userId: string,
  householdId: string,
) {
  const membership = await prisma.membership.findUnique({
    where: { userId_householdId: { userId, householdId } },
  });
  if (!membership) {
    throw new ForbiddenException('User is not a member of this household');
  }
  return membership;
}
