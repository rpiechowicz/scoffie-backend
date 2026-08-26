import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MealType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  MEAL_TYPES_IN_DAY_ORDER,
  effectiveSuitableMealTypes,
  isMealType,
} from '../common/meal-types';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { UpdateRecipeFavoriteDto } from './dto/update-recipe-favorite.dto';
import { FindRecipesDto } from './dto/find-recipes.dto';
import { RecipesCacheService } from './recipes-cache.service';

const recipeListSelect = {
  id: true,
  title: true,
  description: true,
  // Para source identyfikuje przepis u zewnętrznego dostawcy (np. Cookidoo:
  // provider "cookidoo" + id "r907015") — klient po niej pokazuje badge
  // Thermomixa i włącza „Gotuj w Thermomixie".
  sourceProvider: true,
  sourceRecipeId: true,
  mealType: true,
  suitableMealTypes: true,
  difficulty: true,
  prepTimeMinutes: true,
  servings: true,
  imageUrl: true,
  sourceMeta: true,
  nutritionKcal: true,
  nutritionProtein: true,
  nutritionFat: true,
  nutritionCarbs: true,
  nutritionFiber: true,
  nutritionSalt: true,
  isActive: true,
  // Skladniki jada z lista, nie tylko ze szczegolami: klient filtruje
  // katalog po diecie i alergenach uzytkownika, a bez nazw i dzialow nie
  // ma z czego tego policzyc. Projekcja jest wezsza niz w `detailSelect`
  // (bez `normalizedAmount` / `ingredientId`), zeby strona listy nie
  // urosla bardziej niz to konieczne.
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

type RecipeListRow = Prisma.RecipeGetPayload<{
  select: typeof recipeListSelect;
}>;

type NormalizedIngredient = {
  normalizedAmount: number;
  normalizedUnit: 'g' | 'ml' | 'szt';
};

type RecipeImageSource = {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  sourceMeta?: Prisma.JsonValue | null;
};

@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recipesCache: RecipesCacheService,
  ) {}

  private readonly autoRecoverMissingUser =
    process.env.AUTO_RECOVER_MISSING_USER === 'true';
  private readonly recoveryHouseholdName =
    process.env.AUTO_RECOVER_HOUSEHOLD_NAME ?? 'Home';
  private readonly imageGeneratorBaseUrl =
    process.env.IMAGE_GENERATOR_BASE_URL ??
    'https://image.pollinations.ai/prompt';
  private readonly imageGeneratorQuery =
    process.env.IMAGE_GENERATOR_QUERY ?? 'width=1200&height=800&nologo=true';
  private readonly imageGeneratorStyle =
    process.env.IMAGE_GENERATOR_STYLE ??
    'ultra realistic food photography, natural light, 50mm lens, shallow depth of field';
  private readonly imageGeneratorSeedPrefix =
    process.env.IMAGE_GENERATOR_SEED_PREFIX ?? 'weekly-meals';
  private readonly r2PublicBaseUrl = (process.env.R2_PUBLIC_BASE_URL ?? '')
    .trim()
    .replace(/\/+$/g, '');
  private static readonly LIQUID_SPOON_UNITS_IN_ML: Record<
    'lyzeczka' | 'lyzka' | 'szczypta',
    number
  > = {
    lyzeczka: 5,
    lyzka: 15,
    szczypta: 0.5,
  };
  private static readonly SPICE_GRAMS_PER_TEASPOON_BY_NAME: Record<
    string,
    number
  > = {
    sol: 6,
    'pieprz czarny': 2.3,
    pieprz: 2.3,
    'papryka slodka mielona': 2.3,
    'papryka ostra mielona': 2.3,
    cynamon: 2.6,
    kurkuma: 2.2,
    kminek: 2.1,
    oregano: 1,
    'tymianek suszony': 1,
    'bazylia suszona': 0.8,
    'imbir mielony': 2.2,
    'czosnek granulowany': 2.8,
    cukier: 4,
    'cukier brazowy': 4,
  };
  private static readonly LIQUID_CONDIMENTS = new Set<string>([
    'ketchup',
    'musztarda',
    'majonez',
    'ocet jablkowy',
    'ocet winny',
    'sos pomidorowy',
    'sos sojowy',
  ]);

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
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

  private normalizeText(value: string): string {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[ł]/g, 'l')
      .replace(/[ą]/g, 'a')
      .replace(/[ć]/g, 'c')
      .replace(/[ę]/g, 'e')
      .replace(/[ń]/g, 'n')
      .replace(/[ó]/g, 'o')
      .replace(/[ś]/g, 's')
      .replace(/[ź]/g, 'z')
      .replace(/[ż]/g, 'z')
      .trim();
  }

  private normalizeIngredientAmount(
    ingredientName: string,
    category: string,
    amount: number,
    unit: string,
  ): NormalizedIngredient {
    const normalizedUnit = this.normalizeText(unit) as
      | 'g'
      | 'kg'
      | 'ml'
      | 'l'
      | 'szt'
      | 'szczypta'
      | 'lyzeczka'
      | 'lyzka';
    if (normalizedUnit === 'g')
      return { normalizedAmount: amount, normalizedUnit: 'g' };
    if (normalizedUnit === 'kg')
      return { normalizedAmount: amount * 1000, normalizedUnit: 'g' };
    if (normalizedUnit === 'ml')
      return { normalizedAmount: amount, normalizedUnit: 'ml' };
    if (normalizedUnit === 'l')
      return { normalizedAmount: amount * 1000, normalizedUnit: 'ml' };
    if (normalizedUnit === 'szt')
      return { normalizedAmount: amount, normalizedUnit: 'szt' };

    const normalizedCategory = this.normalizeText(category);
    if (normalizedCategory !== 'przyprawy i sosy') {
      throw new BadRequestException(
        `Unit "${unit}" is allowed only for category "Przyprawy i sosy".`,
      );
    }

    const spoonFactor =
      normalizedUnit === 'lyzka'
        ? 3
        : normalizedUnit === 'szczypta'
          ? 1 / 16
          : 1;
    const normalizedName = this.normalizeText(ingredientName);

    if (RecipesService.LIQUID_CONDIMENTS.has(normalizedName)) {
      const mlPerUnit = RecipesService.LIQUID_SPOON_UNITS_IN_ML[normalizedUnit];
      return { normalizedAmount: amount * mlPerUnit, normalizedUnit: 'ml' };
    }

    const gramsPerTeaspoon =
      RecipesService.SPICE_GRAMS_PER_TEASPOON_BY_NAME[normalizedName] ?? 2.5;
    return {
      normalizedAmount: amount * gramsPerTeaspoon * spoonFactor,
      normalizedUnit: 'g',
    };
  }

  private readonly listSelect = recipeListSelect;

  private readonly detailSelect = {
    id: true,
    title: true,
    description: true,
    sourceProvider: true,
    sourceRecipeId: true,
    mealType: true,
    suitableMealTypes: true,
    difficulty: true,
    prepTimeMinutes: true,
    servings: true,
    imageUrl: true,
    sourceMeta: true,
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
        ingredientId: true,
        name: true,
        amount: true,
        unit: true,
        normalizedAmount: true,
        normalizedUnit: true,
        department: true,
      },
    },
  } as const;

  private extractImagePrompt(
    sourceMeta?: Prisma.JsonValue | null,
  ): string | null {
    if (
      !sourceMeta ||
      typeof sourceMeta !== 'object' ||
      Array.isArray(sourceMeta)
    ) {
      return null;
    }

    const prompt = sourceMeta.imagePrompt;
    return typeof prompt === 'string' && prompt.trim().length > 0
      ? prompt.trim()
      : null;
  }

  private isLegacyStaticRecipeImageUrl(imageUrl?: string | null): boolean {
    if (!imageUrl || !imageUrl.trim()) return false;

    const normalized = imageUrl.trim();
    if (
      this.r2PublicBaseUrl &&
      normalized.startsWith(`${this.r2PublicBaseUrl}/`)
    ) {
      return false;
    }

    return /(?:^|\/)recipe-images\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpe?g|webp)(?:\?.*)?$/i.test(
      normalized,
    );
  }

  private buildGeneratedImageUrl(recipe: RecipeImageSource): string {
    const prompt =
      this.extractImagePrompt(recipe.sourceMeta) ??
      [
        'professional food photo',
        recipe.title,
        recipe.description ?? '',
        this.imageGeneratorStyle,
        'no text, no watermark, plated dish, appetizing',
      ]
        .filter(Boolean)
        .join(', ');

    const encodedPrompt = encodeURIComponent(prompt);
    const query = this.imageGeneratorQuery
      ? `&${this.imageGeneratorQuery}`
      : '';
    const seed = `${this.imageGeneratorSeedPrefix}-${recipe.id}`;
    return `${this.imageGeneratorBaseUrl}/${encodedPrompt}?seed=${encodeURIComponent(seed)}${query}`;
  }

  private resolveRecipeImageUrl(recipe: RecipeImageSource): string {
    const currentImageUrl = recipe.imageUrl?.trim() ?? '';
    if (
      currentImageUrl &&
      !this.isLegacyStaticRecipeImageUrl(currentImageUrl)
    ) {
      return currentImageUrl;
    }

    return this.buildGeneratedImageUrl(recipe);
  }

  async findAll(userIdentifier: string, filters?: FindRecipesDto) {
    const userId = await this.resolveUserId(userIdentifier);
    const householdId = filters?.householdId;
    const page = Math.max(1, filters?.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters?.limit ?? 24));
    const skip = (page - 1) * limit;
    // Filtr slotu celowo **nie** porównuje `mealType`. Danie należy do
    // jednego slotu bazowego, ale nadaje się do kilku (`suitableMealTypes`) —
    // i to ta lista decyduje, co widać przy dodawaniu posiłku. Wiersze sprzed
    // backfillu mają pustą tablicę, więc alternatywa `OR` łapie je po slocie
    // bazowym; bez tego stary przepis zniknąłby z katalogu.
    const requestedMealType = filters?.mealType;
    const mealTypeFilter: MealType | undefined = isMealType(requestedMealType)
      ? requestedMealType
      : undefined;

    const whereBase: {
      isActive: boolean;
      OR?: Prisma.RecipeWhereInput[];
      id?: { in?: string[]; notIn?: string[] };
    } = {
      isActive: true,
      ...(mealTypeFilter
        ? {
            OR: [
              { suitableMealTypes: { has: mealTypeFilter } },
              {
                mealType: mealTypeFilter,
                suitableMealTypes: { isEmpty: true },
              },
            ],
          }
        : {}),
    };

    let favoriteRecipeIds = new Set<string>();
    let sharedListCacheKey: string | null = null;
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
      } else {
        // For mixed view (all recipes + isFavorite flag), share cache across users/households.
        sharedListCacheKey = this.recipesCache.buildRecipesListKey({
          userId: 'global',
          mealType: filters?.mealType,
          isFavorite: undefined,
          page,
          limit,
        });
      }
    } else if (filters?.isFavorite === true) {
      return [];
    } else {
      // No household context -> recipe list is global and can be shared by all users.
      sharedListCacheKey = this.recipesCache.buildRecipesListKey({
        userId: 'global',
        mealType: filters?.mealType,
        isFavorite: filters?.isFavorite,
        page,
        limit,
      });
    }

    let recipes: RecipeListRow[] | null = null;

    if (sharedListCacheKey) {
      recipes = this.recipesCache.get<RecipeListRow[]>(sharedListCacheKey);
    }

    if (!recipes) {
      recipes = await this.prisma.recipe.findMany({
        where: whereBase,
        orderBy: { createdAt: 'desc' },
        select: this.listSelect,
        skip,
        take: limit,
      });

      if (sharedListCacheKey) {
        this.recipesCache.set(sharedListCacheKey, recipes);
      }
    }

    const mapped = (recipes ?? []).map((recipe) => {
      const { sourceMeta, ...base } = recipe;
      return {
        ...base,
        // Nigdy nie wypuszczamy pustej listy slotów — klient nie musi znać
        // reguły „puste znaczy tyle, co slot bazowy". Normalizacja jest tu,
        // a nie w zapytaniu, bo dotyczy też wierszy z cache'u.
        suitableMealTypes: effectiveSuitableMealTypes(recipe),
        imageUrl: this.resolveRecipeImageUrl(recipe),
        isFavorite: favoriteRecipeIds.has(recipe.id),
      };
    });

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
    const { sourceMeta, ...base } = recipe;
    return {
      ...base,
      suitableMealTypes: effectiveSuitableMealTypes(recipe),
      imageUrl: this.resolveRecipeImageUrl(recipe),
      isFavorite,
    };
  }

  async create(userIdentifier: string, data: CreateRecipeDto) {
    const userId = await this.resolveUserId(userIdentifier);
    await this.ensureMembership(userIdentifier, data.householdId);

    let ingredientById = new Map<
      string,
      { id: string; name: string; category: string }
    >();
    if (data.ingredients?.length) {
      const uniqueIds = Array.from(
        new Set(data.ingredients.map((ingredient) => ingredient.ingredientId)),
      );
      const ingredientRows = await this.prisma.ingredient.findMany({
        where: {
          id: { in: uniqueIds },
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          category: true,
        },
      });
      ingredientById = new Map(
        ingredientRows.map((ingredient) => [ingredient.id, ingredient]),
      );
      if (ingredientById.size !== uniqueIds.length) {
        throw new NotFoundException(
          'One or more ingredients were not found or are inactive',
        );
      }
    }

    const created = await this.prisma.recipe.create({
      data: {
        title: data.title,
        description: data.description,
        mealType: data.mealType,
        // Slot bazowy zawsze wchodzi do listy, nawet gdy klient go nie
        // przysłał — inaczej dałoby się utworzyć przepis, którego nie widać
        // w jego własnej sekcji.
        suitableMealTypes: MEAL_TYPES_IN_DAY_ORDER.filter((type) =>
          new Set<MealType>([
            data.mealType,
            ...(data.suitableMealTypes ?? []),
          ]).has(type),
        ),
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
              create: data.ingredients.map((item) => {
                const ingredient = ingredientById.get(item.ingredientId)!;
                const normalized = this.normalizeIngredientAmount(
                  ingredient.name,
                  ingredient.category,
                  item.amount,
                  item.unit,
                );
                return {
                  ingredientId: ingredient.id,
                  name: ingredient.name,
                  amount: item.amount,
                  unit: item.unit,
                  normalizedAmount: Number(
                    normalized.normalizedAmount.toFixed(4),
                  ),
                  normalizedUnit: normalized.normalizedUnit,
                  department: ingredient.category,
                };
              }),
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
