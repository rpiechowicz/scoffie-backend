import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { UpdateRecipeFavoriteDto } from './dto/update-recipe-favorite.dto';

@Injectable()
export class RecipesService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureMembership(userId: string, householdId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId, householdId } },
    });
    if (!membership) {
      throw new ForbiddenException('User is not a member of this household');
    }
  }

  async findAll(userId: string, householdId?: string) {
    const include = {
      ingredients: {
        orderBy: { createdAt: 'asc' as const },
      },
    };

    if (householdId) {
      await this.ensureMembership(userId, householdId);
      return this.prisma.recipe.findMany({
        where: { householdId },
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
      where: { householdId: { in: householdIds } },
      orderBy: { createdAt: 'desc' },
      include,
    });
  }

  async findById(userId: string, id: string) {
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
    await this.ensureMembership(userId, recipe.householdId);
    return recipe;
  }

  async create(userId: string, data: CreateRecipeDto) {
    await this.ensureMembership(userId, data.householdId);
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

  async setFavorite(userId: string, data: UpdateRecipeFavoriteDto) {
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

    await this.ensureMembership(userId, recipe.householdId);

    await this.prisma.recipe.update({
      where: { id: data.recipeId },
      data: {
        isFavorite: data.isFavorite,
      },
    });

    return this.findById(userId, data.recipeId);
  }
}
