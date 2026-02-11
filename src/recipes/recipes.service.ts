import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { UpdateRecipeFavoriteDto } from './dto/update-recipe-favorite.dto';
import { FindRecipesDto } from './dto/find-recipes.dto';

@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly autoRecoverMissingUser = process.env.AUTO_RECOVER_MISSING_USER === 'true';
  private readonly recoveryHouseholdName = process.env.AUTO_RECOVER_HOUSEHOLD_NAME ?? 'Home';

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private async recoverMissingUserById(userId: string): Promise<string | null> {
    if (!this.autoRecoverMissingUser || !this.isUuid(userId)) return null;

    const recovered = await this.prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        googleId: `legacy-${userId}`,
        displayName: 'Recovered User',
        email: null,
      },
      select: { id: true },
    });

    const household = await this.prisma.household.findFirst({
      where: { name: this.recoveryHouseholdName },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (household) {
      await this.prisma.membership.upsert({
        where: {
          userId_householdId: {
            userId: recovered.id,
            householdId: household.id,
          },
        },
        update: {},
        create: {
          userId: recovered.id,
          householdId: household.id,
          role: 'MEMBER',
        },
      });
    }

    return recovered.id;
  }

  private async resolveUserId(userIdentifier: string): Promise<string> {
    const byId = await this.prisma.user.findUnique({
      where: { id: userIdentifier },
      select: { id: true },
    });
    if (byId) return byId.id;

    const byGoogleId = await this.prisma.user.findUnique({
      where: { googleId: userIdentifier },
      select: { id: true },
    });
    if (byGoogleId) return byGoogleId.id;

    const recovered = await this.recoverMissingUserById(userIdentifier);
    if (recovered) return recovered;

    throw new ForbiddenException('User not found');
  }

  private async ensureMembership(userIdentifier: string, householdId: string) {
    const userId = await this.resolveUserId(userIdentifier);
    const membership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId, householdId } },
    });
    if (!membership) {
      throw new ForbiddenException('User is not a member of this household');
    }
  }

  async findAll(userIdentifier: string, filters?: FindRecipesDto) {
    const userId = await this.resolveUserId(userIdentifier);
    const householdId = filters?.householdId;
    const include = {
      ingredients: {
        orderBy: { createdAt: 'asc' as const },
      },
    };
    const whereBase = {
      isActive: true,
      ...(filters?.mealType ? { mealType: filters.mealType } : {}),
      ...(typeof filters?.isFavorite === 'boolean' ? { isFavorite: filters.isFavorite } : {}),
    };

    if (householdId) {
      await this.ensureMembership(userId, householdId);
      return this.prisma.recipe.findMany({
        where: { ...whereBase, householdId },
        orderBy: { createdAt: 'desc' },
        include,
      });
    }

    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { householdId: true },
    });
    const householdIds = memberships.map((m) => m.householdId);

    return this.prisma.recipe.findMany({
      where: { ...whereBase, householdId: { in: householdIds } },
      orderBy: { createdAt: 'desc' },
      include,
    });
  }

  async findById(userIdentifier: string, id: string) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id },
      include: {
        ingredients: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!recipe) {
      throw new NotFoundException('Recipe not found');
    }
    await this.ensureMembership(userIdentifier, recipe.householdId);
    return recipe;
  }

  async create(userIdentifier: string, data: CreateRecipeDto) {
    const userId = await this.resolveUserId(userIdentifier);
    await this.ensureMembership(userIdentifier, data.householdId);
    return this.prisma.recipe.create({
      data: {
        title: data.title,
        description: data.description,
        mealType: data.mealType,
        difficulty: data.difficulty,
        prepTimeMinutes: data.prepTimeMinutes,
        servings: data.servings,
        imageUrl: data.imageUrl,
        nutritionKcal: data.nutritionKcal ?? 0,
        nutritionProtein: data.nutritionProtein ?? 0,
        nutritionFat: data.nutritionFat ?? 0,
        nutritionCarbs: data.nutritionCarbs ?? 0,
        nutritionFiber: data.nutritionFiber ?? 0,
        nutritionSalt: data.nutritionSalt ?? 0,
        householdId: data.householdId,
        authorId: userId,
        ingredients: data.ingredients?.length
          ? {
              create: data.ingredients.map((ingredient) => ({
                name: ingredient.name,
                amount: ingredient.amount,
                unit: ingredient.unit,
                department: ingredient.department,
              })),
            }
          : undefined,
      },
      include: {
        ingredients: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  async setFavorite(userIdentifier: string, data: UpdateRecipeFavoriteDto) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id: data.recipeId },
      select: {
        id: true,
        householdId: true,
      },
    });
    if (!recipe) {
      throw new NotFoundException('Recipe not found');
    }

    await this.ensureMembership(userIdentifier, recipe.householdId);

    await this.prisma.recipe.update({
      where: { id: data.recipeId },
      data: {
        isFavorite: data.isFavorite,
      },
    });

    return this.findById(userIdentifier, data.recipeId);
  }
}
