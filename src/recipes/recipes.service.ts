import {
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MealType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  effectiveSuitableMealTypes,
  isMealType,
} from '../common/meal-types';
import {
  CreateRecipeDto,
  CreateRecipeIngredientDto,
} from './dto/create-recipe.dto';
import { UpdateRecipeFavoriteDto } from './dto/update-recipe-favorite.dto';
import { FindRecipesDto } from './dto/find-recipes.dto';
import { RecipesCacheService } from './recipes-cache.service';
import { AppException } from '../common/app-exception';
import {
  ALLOWED_UNITS,
  normalizeIngredientAmount,
} from './ingredient-amount.util';
import {
  computeRecipeNutrition,
  roundTotalsForStorage,
  type IngredientNutritionPer100,
} from './recipe-nutrition.util';
import { resolveSuitableMealTypes } from './suitable-meal-types.util';

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

/**
 * Wiersz `RecipeIngredient` gotowy do zapisu plus makra źródła (na 100 g/ml),
 * z których liczy się suma przepisu. `nutrition` nie trafia do bazy —
 * `create` je odcina.
 */
type RecipeIngredientRow = {
  ingredientId: string;
  name: string;
  amount: number;
  unit: string;
  normalizedAmount: number;
  normalizedUnit: 'g' | 'ml' | 'szt';
  department: string;
  nutrition: IngredientNutritionPer100 | null;
};

type ResolvedRecipeNutrition = {
  nutritionKcal: number;
  nutritionProtein: number;
  nutritionFat: number;
  nutritionCarbs: number;
  nutritionFiber: number;
  nutritionSalt: number;
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
  // Gospodarstwo katalogu wskazywane po ID, nie po nazwie — „Home” to
  // domyślna nazwa, którą może nosić dom każdego użytkownika.
  private readonly recoveryHouseholdId =
    process.env.AUTO_RECOVER_HOUSEHOLD_ID ??
    process.env.RECIPE_IMPORT_HOUSEHOLD_ID ??
    '22222222-2222-4222-8222-222222222222';
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

    const household = await this.prisma.household.findUnique({
      where: { id: this.recoveryHouseholdId },
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

  /**
   * Składniki przepisu po bramkach, z jednostką bazową i makrami źródła.
   *
   * Normalizator jest TEN SAM, którym pisze importer katalogu
   * (`ingredient-amount.util.ts`). Serwis miał własną kopię tabel łyżeczek,
   * która rozjechała się o jedną pozycję (`przyprawa uniwersalna`: 4 g
   * w utilu, domyślne 2,5 g w kopii) — ten sam składnik ważył inaczej
   * w zależności od tego, którędy wszedł do bazy.
   *
   * Bramki na jednostkę, ilość i duplikaty są tu, a nie tylko w dekoratorach
   * DTO, bo na ścieżce WS `ValidationPipe` nie ma czego zwalidować
   * (koperta payloadu nie ma `@ValidateNested`). Bez nich `unit: 'garść'`
   * na przyprawie przechodziło przez drabinkę g/kg/ml/l/szt, łapało
   * `spoonFactor = 1` i dawało ciche śmieci w gramach, a zduplikowany
   * `ingredientId` kończył się P2002 → INTERNAL_ERROR.
   */
  private async resolveRecipeIngredients(
    items: CreateRecipeIngredientDto[] | undefined,
  ): Promise<RecipeIngredientRow[]> {
    if (!items?.length) return [];

    items.forEach((item, index) => {
      if (typeof item.unit !== 'string' || !ALLOWED_UNITS.has(item.unit)) {
        throw new AppException(
          'VALIDATION_ERROR',
          `Unit "${String(item.unit)}" is not supported (ingredient index ${index}).`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if (
        typeof item.amount !== 'number' ||
        !Number.isFinite(item.amount) ||
        item.amount <= 0
      ) {
        throw new AppException(
          'VALIDATION_ERROR',
          `Ingredient amount must be a positive number (ingredient index ${index}).`,
          HttpStatus.BAD_REQUEST,
        );
      }
    });

    const ids = items.map((item) => item.ingredientId);
    const duplicates = Array.from(
      new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
    );
    if (duplicates.length > 0) {
      // `@@unique([recipeId, ingredientId])` — ten sam składnik dwa razy to
      // błąd wejścia, nie dwa wiersze.
      throw new AppException(
        'VALIDATION_ERROR',
        `Duplicate ingredientId in recipe payload: ${duplicates.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const ingredientRows = await this.prisma.ingredient.findMany({
      where: {
        id: { in: ids },
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        category: true,
        nutritionKcalPer100: true,
        nutritionProteinPer100: true,
        nutritionCarbsPer100: true,
        nutritionFatPer100: true,
        nutritionFiberPer100: true,
        gramsPerPiece: true,
      },
    });
    const ingredientById = new Map(
      ingredientRows.map((ingredient) => [ingredient.id, ingredient]),
    );
    if (ingredientById.size !== ids.length) {
      throw new NotFoundException(
        'One or more ingredients were not found or are inactive',
      );
    }

    return items.map((item) => {
      const ingredient = ingredientById.get(item.ingredientId)!;
      let normalized: ReturnType<typeof normalizeIngredientAmount>;
      try {
        normalized = normalizeIngredientAmount(
          ingredient.name,
          ingredient.category,
          item.amount,
          item.unit,
        );
      } catch (error) {
        // Util rzuca zwykłym `Error` (skrypty polegają na tym, że przerywa
        // import); dla klienta to błąd wejścia, nie 500.
        throw new AppException(
          'VALIDATION_ERROR',
          error instanceof Error
            ? error.message
            : 'Cannot normalize ingredient amount',
          HttpStatus.BAD_REQUEST,
        );
      }
      return {
        ingredientId: ingredient.id,
        name: ingredient.name,
        amount: item.amount,
        unit: item.unit,
        normalizedAmount: Number(normalized.normalizedAmount.toFixed(4)),
        normalizedUnit: normalized.normalizedUnit,
        department: ingredient.category,
        // Ta sama reguła co w `scripts/recompute-recipe-nutrition.ts`: brak
        // kcal na 100 g znaczy „brak danych", reszta luk liczy się jako 0.
        nutrition:
          ingredient.nutritionKcalPer100 === null
            ? null
            : {
                kcal: ingredient.nutritionKcalPer100,
                protein: ingredient.nutritionProteinPer100 ?? 0,
                carbs: ingredient.nutritionCarbsPer100 ?? 0,
                fat: ingredient.nutritionFatPer100 ?? 0,
                fiber: ingredient.nutritionFiberPer100 ?? 0,
                gramsPerPiece: ingredient.gramsPerPiece,
              },
      };
    });
  }

  /**
   * Makra liczy serwer, nie klient.
   *
   * Wartości przysłane w DTO są ignorowane, gdy przepis ma składniki: jedyny
   * przyszły wołający tej metody to asystent, a jego liczby są dokładnie tym,
   * czego walidator nie może brać na wiarę. Składnik bez makr albo sztuka
   * bez `gramsPerPiece` to odmowa, nie zaniżona suma zapisana jako prawda.
   * `nutritionSalt` zostaje z DTO — `Ingredient` nie ma sodu na 100 g, więc
   * nie ma z czego go policzyć (tak samo omija go skrypt przeliczania).
   *
   * Bez składników zostają wartości z DTO (albo zera) — to jedyny przypadek,
   * w którym nie ma z czego liczyć.
   *
   * TODO(update): `recipes:update` ma użyć tej samej pary
   * `resolveRecipeIngredients` + `resolveRecipeNutrition`, inaczej rozjazd
   * wróci od kuchni.
   */
  private resolveRecipeNutrition(
    data: CreateRecipeDto,
    rows: RecipeIngredientRow[],
  ): ResolvedRecipeNutrition {
    const nutritionSalt = data.nutritionSalt ?? 0;
    if (rows.length === 0) {
      return {
        nutritionKcal: data.nutritionKcal ?? 0,
        nutritionProtein: data.nutritionProtein ?? 0,
        nutritionFat: data.nutritionFat ?? 0,
        nutritionCarbs: data.nutritionCarbs ?? 0,
        nutritionFiber: data.nutritionFiber ?? 0,
        nutritionSalt,
      };
    }

    const { totals, missingNutrition, missingPieceWeight } =
      computeRecipeNutrition(rows);
    if (missingNutrition.length > 0 || missingPieceWeight.length > 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Cannot compute recipe nutrition from ingredients.',
        HttpStatus.BAD_REQUEST,
        { missingNutrition, missingPieceWeight },
      );
    }

    const stored = roundTotalsForStorage(totals);
    return {
      nutritionKcal: stored.kcal,
      nutritionProtein: stored.protein,
      nutritionFat: stored.fat,
      nutritionCarbs: stored.carbs,
      nutritionFiber: stored.fiber,
      nutritionSalt,
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
        // `id` jako drugi klucz, bo samo `createdAt` nie porządkuje wierszy
        // jednoznacznie: import wrzuca dziesiątki przepisów w tej samej
        // milisekundzie, a przy remisie Postgres może zwrócić je w innej
        // kolejności przy każdym zapytaniu. Przy stronicowaniu po `skip`
        // znaczy to, że ta sama pozycja potrafi wyjść na dwóch stronach,
        // a inna nie wyjść wcale — czyli katalog z duplikatami i dziurami.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

    // Cała walidacja PRZED `recipe.create`: składniki, jednostki, makra.
    const ingredientRows = await this.resolveRecipeIngredients(
      data.ingredients,
    );
    const nutrition = this.resolveRecipeNutrition(data, ingredientRows);

    const created = await this.prisma.recipe.create({
      data: {
        title: data.title,
        description: data.description,
        mealType: data.mealType,
        // Ta sama reguła co w imporcie: klient może podać sloty wprost, resztę
        // dokłada klasyfikator (progi liczy z POLICZONYCH kcal, więc musi iść
        // po makrach). Slot bazowy wchodzi zawsze — `effectiveSuitableMealTypes`
        // go dopisuje — inaczej dałoby się utworzyć przepis, którego nie widać
        // w jego własnej sekcji.
        suitableMealTypes: resolveSuitableMealTypes({
          title: data.title,
          description: data.description,
          mealType: data.mealType,
          prepTimeMinutes: data.prepTimeMinutes,
          servings: data.servings,
          nutritionKcal: nutrition.nutritionKcal,
          suitableMealTypes: data.suitableMealTypes,
        }),
        difficulty: data.difficulty,
        prepTimeMinutes: data.prepTimeMinutes,
        servings: data.servings,
        imageUrl: data.imageUrl,
        ...nutrition,
        householdId: data.householdId,
        authorId: userId,
        ingredients: ingredientRows.length
          ? {
              create: ingredientRows.map(
                ({ nutrition: _nutrition, ...row }) => row,
              ),
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
