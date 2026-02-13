import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { UpdateRecipeFavoriteDto } from './dto/update-recipe-favorite.dto';
import { FindRecipesDto } from './dto/find-recipes.dto';
import { RecipesCacheService } from './recipes-cache.service';

@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipesCache: RecipesCacheService,
  ) {}

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

  private readonly listSelect = {
    id: true,
    title: true,
    description: true,
    mealType: true,
    difficulty: true,
    prepTimeMinutes: true,
    servings: true,
    imageUrl: true,
    nutritionKcal: true,
    nutritionProtein: true,
    nutritionFat: true,
    nutritionCarbs: true,
    nutritionFiber: true,
    nutritionSalt: true,
    isActive: true,
  } as const;

  private readonly detailSelect = {
    id: true,
    title: true,
    description: true,
    mealType: true,
    difficulty: true,
    prepTimeMinutes: true,
    servings: true,
    imageUrl: true,
    nutritionKcal: true,
    nutritionProtein: true,
    nutritionFat: true,
    nutritionCarbs: true,
    nutritionFiber: true,
    nutritionSalt: true,
    isActive: true,
    householdId: true,
    sourceInstructions: true,
    ingredients: {
      orderBy: { createdAt: 'asc' as const },
      select: {
        id: true,
        recipeId: true,
        name: true,
        amount: true,
        unit: true,
        department: true,
      },
    },
  } as const;

  async findAll(userIdentifier: string, filters?: FindRecipesDto) {
    const userId = await this.resolveUserId(userIdentifier);
    const householdId = filters?.householdId;
    const page = Math.max(1, filters?.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters?.limit ?? 24));
    const skip = (page - 1) * limit;
    const cacheKey = this.recipesCache.buildRecipesListKey({
      userId,
      householdId,
      mealType: filters?.mealType,
      isFavorite: filters?.isFavorite,
      page,
      limit,
    });
    const cached = this.recipesCache.get<unknown[]>(cacheKey);
    if (cached) return cached;
    const whereBase: {
      isActive: boolean;
      mealType?: FindRecipesDto['mealType'];
      id?: { in?: string[]; notIn?: string[] };
    } = {
      isActive: true,
      ...(filters?.mealType ? { mealType: filters.mealType } : {}),
    };

    let favoriteRecipeIds = new Set<string>();
    if (householdId) {
      await this.ensureMembership(userId, householdId);
      const favorites = await this.prisma.recipeFavorite.findMany({
        where: { householdId },
        select: { recipeId: true },
      });
      favoriteRecipeIds = new Set(favorites.map((f) => f.recipeId));
      if (filters?.isFavorite === true) {
        whereBase.id = { in: Array.from(favoriteRecipeIds) };
      } else if (filters?.isFavorite === false) {
        whereBase.id = { notIn: Array.from(favoriteRecipeIds) };
      }
    } else if (filters?.isFavorite === true) {
      return [];
    }

    const recipes = await this.prisma.recipe.findMany({
      where: whereBase,
      orderBy: { createdAt: 'desc' },
      select: this.listSelect,
      skip,
      take: limit,
    });
    const mapped = recipes.map((recipe) => ({
      ...recipe,
      isFavorite: favoriteRecipeIds.has(recipe.id),
    }));
    this.recipesCache.set(cacheKey, mapped);
    return mapped;
  }

  async findById(userIdentifier: string, id: string, householdId?: string) {
    const recipe = await this.prisma.recipe.findUnique({
      where: { id },
      select: this.detailSelect,
    });
    if (!recipe) {
      throw new NotFoundException('Recipe not found');
    }

    let isFavorite = false;
    if (householdId) {
      await this.ensureMembership(userIdentifier, householdId);
      const favorite = await this.prisma.recipeFavorite.findUnique({
        where: {
          recipeId_householdId: {
            recipeId: recipe.id,
            householdId,
          },
        },
        select: { id: true },
      });
      isFavorite = Boolean(favorite);
    }
    return { ...recipe, isFavorite };
  }

  async create(userIdentifier: string, data: CreateRecipeDto) {
    const userId = await this.resolveUserId(userIdentifier);
    await this.ensureMembership(userIdentifier, data.householdId);
    const created = await this.prisma.recipe.create({
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
    this.recipesCache.invalidateRecipesList();
    return created;
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
    await this.ensureMembership(userIdentifier, data.householdId);

    if (data.isFavorite) {
      await this.prisma.recipeFavorite.upsert({
        where: {
          recipeId_householdId: {
            recipeId: data.recipeId,
            householdId: data.householdId,
          },
        },
        update: {},
        create: {
          recipeId: data.recipeId,
          householdId: data.householdId,
        },
      });
    } else {
      await this.prisma.recipeFavorite.deleteMany({
        where: {
          recipeId: data.recipeId,
          householdId: data.householdId,
        },
      });
    }

    this.recipesCache.invalidateRecipesList();
    return this.findById(userIdentifier, data.recipeId, data.householdId);
  }
}
