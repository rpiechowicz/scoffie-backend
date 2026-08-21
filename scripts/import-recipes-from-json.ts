import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  ALLOWED_UNITS,
  normalizeIngredientAmount,
  normalizeText,
} from '../src/recipes/ingredient-amount.util';

const prisma = new PrismaClient();

type RecipeInput = {
  id?: string;
  title: string;
  description: string;
  mealType: 'BREAKFAST' | 'LUNCH' | 'DINNER';
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  prepTimeMinutes: number;
  servings: number;
  nutrition: {
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber: number;
    salt: number;
  };
  steps: Array<{ step: number; instruction: string }>;
  ingredients: Array<{
    ingredientName: string;
    amount: number;
    unit: string;
  }>;
  image: {
    prompt: string;
    imageUrl: string | null;
  };
};

type RecipeBatchInput = {
  version?: string;
  recipes: RecipeInput[];
};

const RECIPE_IMPORT_FILE =
  process.env.RECIPE_IMPORT_FILE ?? 'prisma/catalog/recipes-batch-test-v1.json';
const RECIPE_IMPORT_CLEAR_EXISTING =
  process.env.RECIPE_IMPORT_CLEAR_EXISTING === 'true';
const RECIPE_IMPORT_OWNER_USER_ID =
  process.env.RECIPE_IMPORT_OWNER_USER_ID ??
  '11111111-1111-4111-8111-111111111111';
const RECIPE_IMPORT_OWNER_LEGACY_SUB =
  process.env.RECIPE_IMPORT_OWNER_LEGACY_SUB ??
  `legacy-${RECIPE_IMPORT_OWNER_USER_ID}`;
const RECIPE_IMPORT_OWNER_DISPLAY_NAME =
  process.env.RECIPE_IMPORT_OWNER_DISPLAY_NAME ?? 'Recipe Import Bot';
const RECIPE_IMPORT_OWNER_EMAIL =
  process.env.RECIPE_IMPORT_OWNER_EMAIL ?? 'import-bot@example.com';
const RECIPE_IMPORT_HOUSEHOLD_NAME =
  process.env.RECIPE_IMPORT_HOUSEHOLD_NAME ?? 'Home';
const RECIPE_IMPORT_ID_POOL = process.env.RECIPE_IMPORT_ID_POOL ?? '';
const RECIPE_IMPORT_ID_POOL_FILE =
  process.env.RECIPE_IMPORT_ID_POOL_FILE ??
  'prisma/catalog/recipes-approved-30-image-ids.txt';
const RECIPE_IMPORT_USE_PUBLIC_IMAGE_IDS =
  process.env.RECIPE_IMPORT_USE_PUBLIC_IMAGE_IDS !== 'false';
const RECIPE_IMPORT_BUILD_R2_IMAGE_URLS =
  process.env.RECIPE_IMPORT_BUILD_R2_IMAGE_URLS !== 'false';
const RECIPE_IMPORT_IMAGE_EXTENSION = (
  process.env.RECIPE_IMPORT_IMAGE_EXTENSION ?? 'png'
)
  .trim()
  .replace(/^\./, '')
  .toLowerCase();
const IMAGE_GENERATOR_PROVIDER = (
  process.env.IMAGE_GENERATOR_PROVIDER ?? 'pollinations'
).toLowerCase();
const IMAGE_GENERATOR_BASE_URL =
  process.env.IMAGE_GENERATOR_BASE_URL ??
  'https://image.pollinations.ai/prompt';
const IMAGE_GENERATOR_QUERY =
  process.env.IMAGE_GENERATOR_QUERY ?? 'width=1200&height=800&nologo=true';
const IMAGE_GENERATOR_STYLE =
  process.env.IMAGE_GENERATOR_STYLE ??
  'ultra realistic food photography, natural light, 50mm lens, shallow depth of field';
const IMAGE_GENERATOR_SEED_PREFIX =
  process.env.IMAGE_GENERATOR_SEED_PREFIX ?? 'weekly-meals';
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL ?? '')
  .trim()
  .replace(/\/+$/g, '');
const R2_KEY_PREFIX = (process.env.R2_KEY_PREFIX ?? 'recipe-images')
  .trim()
  .replace(/^\/+|\/+$/g, '');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function parseRecipeIdPoolFromEnv(): string[] {
  if (!RECIPE_IMPORT_ID_POOL.trim()) return [];

  const parsed = RECIPE_IMPORT_ID_POOL.split(/[\s,;]+/g)
    .map((value) => value.trim())
    .filter(Boolean);

  const unique = Array.from(new Set(parsed));
  const invalid = unique.filter((value) => !isUuid(value));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid RECIPE_IMPORT_ID_POOL entries (must be UUID): ${invalid.join(', ')}`,
    );
  }
  return unique;
}

async function parseRecipeIdPoolFromFile(): Promise<string[]> {
  if (!RECIPE_IMPORT_ID_POOL_FILE.trim()) return [];

  const filePath = join(process.cwd(), RECIPE_IMPORT_ID_POOL_FILE);
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const parsed = raw
    .split(/[\s,;]+/g)
    .map((value) => value.trim())
    .filter(Boolean);

  const unique = Array.from(new Set(parsed));
  const invalid = unique.filter((value) => !isUuid(value));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid UUID entries in ${RECIPE_IMPORT_ID_POOL_FILE}: ${invalid.join(', ')}`,
    );
  }
  return unique;
}

async function parseRecipeIdPoolFromPublicImages(): Promise<string[]> {
  if (!RECIPE_IMPORT_USE_PUBLIC_IMAGE_IDS) return [];

  const directoryPath = join(process.cwd(), 'public', 'recipe-images');
  let entries: string[] = [];
  try {
    entries = await readdir(directoryPath);
  } catch {
    return [];
  }

  const ids = entries
    .map((fileName) => {
      const extension = extname(fileName);
      if (!extension) return '';
      return fileName.slice(0, -extension.length);
    })
    .filter((name) => isUuid(name));

  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

async function resolveRecipeIdPool(totalRecipes: number): Promise<string[]> {
  const fromEnv = parseRecipeIdPoolFromEnv();
  if (fromEnv.length > 0) {
    if (fromEnv.length < totalRecipes) {
      throw new Error(
        `RECIPE_IMPORT_ID_POOL contains ${fromEnv.length} UUIDs but ${totalRecipes} recipes are being imported.`,
      );
    }
    if (fromEnv.length > totalRecipes) {
      // eslint-disable-next-line no-console
      console.log(
        `[recipes-import] RECIPE_IMPORT_ID_POOL has more UUIDs (${fromEnv.length}) than recipes (${totalRecipes}); extra values will be ignored.`,
      );
    }
    return fromEnv;
  }

  const fromFile = await parseRecipeIdPoolFromFile();
  if (fromFile.length > 0) {
    if (fromFile.length < totalRecipes) {
      throw new Error(
        `RECIPE_IMPORT_ID_POOL_FILE (${RECIPE_IMPORT_ID_POOL_FILE}) contains ${fromFile.length} UUIDs but ${totalRecipes} recipes are being imported.`,
      );
    }

    if (fromFile.length > totalRecipes) {
      // eslint-disable-next-line no-console
      console.log(
        `[recipes-import] ${RECIPE_IMPORT_ID_POOL_FILE} has more UUIDs (${fromFile.length}) than recipes (${totalRecipes}); extra values will be ignored.`,
      );
    }

    return fromFile;
  }

  const fromPublicImages = await parseRecipeIdPoolFromPublicImages();
  if (fromPublicImages.length === 0) return [];

  if (fromPublicImages.length < totalRecipes) {
    throw new Error(
      `Found ${fromPublicImages.length} UUID-named image files in public/recipe-images but ${totalRecipes} recipes are being imported.`,
    );
  }

  if (fromPublicImages.length > totalRecipes) {
    // eslint-disable-next-line no-console
    console.log(
      `[recipes-import] Found ${fromPublicImages.length} UUID image files for ${totalRecipes} recipes; extra files will be ignored.`,
    );
  }

  return fromPublicImages;
}

function buildR2ImageUrl(recipeId: string): string | null {
  if (!RECIPE_IMPORT_BUILD_R2_IMAGE_URLS) return null;
  if (!R2_PUBLIC_BASE_URL) return null;
  return `${R2_PUBLIC_BASE_URL}/${R2_KEY_PREFIX}/${recipeId}.${RECIPE_IMPORT_IMAGE_EXTENSION}`;
}

function buildGeneratedImageUrl(
  recipeId: string,
  recipe: RecipeInput,
): string | null {
  if (IMAGE_GENERATOR_PROVIDER !== 'pollinations') return null;

  const prompt =
    recipe.image?.prompt?.trim() ||
    [
      'professional food photo',
      recipe.title,
      recipe.description,
      IMAGE_GENERATOR_STYLE,
      'no text, no watermark, plated dish, appetizing',
    ]
      .filter(Boolean)
      .join(', ');

  if (!prompt) return null;

  const encodedPrompt = encodeURIComponent(prompt);
  const query = IMAGE_GENERATOR_QUERY ? `&${IMAGE_GENERATOR_QUERY}` : '';
  const seed = `${IMAGE_GENERATOR_SEED_PREFIX}-${recipeId}`;
  return `${IMAGE_GENERATOR_BASE_URL}/${encodedPrompt}?seed=${encodeURIComponent(seed)}${query}`;
}

function validateBatch(input: RecipeBatchInput): void {
  if (!Array.isArray(input.recipes) || input.recipes.length === 0) {
    throw new Error('Invalid input: "recipes" must be a non-empty array.');
  }

  for (const recipe of input.recipes) {
    if (recipe.id?.trim() && !isUuid(recipe.id.trim())) {
      throw new Error(
        `Recipe "${recipe.title}" has invalid id "${recipe.id}". Expected UUID.`,
      );
    }
    if (!recipe.title?.trim()) throw new Error('Recipe title is required.');
    if (!['BREAKFAST', 'LUNCH', 'DINNER'].includes(recipe.mealType)) {
      throw new Error(`Invalid mealType for recipe "${recipe.title}".`);
    }
    if (!['EASY', 'MEDIUM', 'HARD'].includes(recipe.difficulty)) {
      throw new Error(`Invalid difficulty for recipe "${recipe.title}".`);
    }
    if (recipe.servings !== 2) {
      throw new Error(`Recipe "${recipe.title}" must have servings=2.`);
    }
    if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
      throw new Error(`Recipe "${recipe.title}" must contain steps.`);
    }
    if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
      throw new Error(`Recipe "${recipe.title}" must contain ingredients.`);
    }
    for (const ingredient of recipe.ingredients) {
      if (!ingredient.ingredientName?.trim()) {
        throw new Error(
          `Recipe "${recipe.title}" has ingredient with empty name.`,
        );
      }
      if (!(ingredient.amount > 0)) {
        throw new Error(
          `Recipe "${recipe.title}" has invalid amount for "${ingredient.ingredientName}".`,
        );
      }
      if (!ALLOWED_UNITS.has(ingredient.unit)) {
        throw new Error(
          `Recipe "${recipe.title}" has invalid unit "${ingredient.unit}" for "${ingredient.ingredientName}".`,
        );
      }
    }
  }
}

async function ensureImportContext() {
  const user = await prisma.user.upsert({
    where: { id: RECIPE_IMPORT_OWNER_USER_ID },
    update: {
      displayName: RECIPE_IMPORT_OWNER_DISPLAY_NAME,
      email: RECIPE_IMPORT_OWNER_EMAIL,
    },
    create: {
      id: RECIPE_IMPORT_OWNER_USER_ID,
      googleId: RECIPE_IMPORT_OWNER_LEGACY_SUB,
      displayName: RECIPE_IMPORT_OWNER_DISPLAY_NAME,
      email: RECIPE_IMPORT_OWNER_EMAIL,
    },
    select: { id: true },
  });

  const existingHousehold = await prisma.household.findFirst({
    where: { name: RECIPE_IMPORT_HOUSEHOLD_NAME },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  const household = existingHousehold
    ? existingHousehold
    : await prisma.household.create({
        data: {
          name: RECIPE_IMPORT_HOUSEHOLD_NAME,
          createdById: user.id,
        },
        select: { id: true, name: true },
      });

  await prisma.membership.upsert({
    where: {
      userId_householdId: {
        userId: user.id,
        householdId: household.id,
      },
    },
    update: { role: 'OWNER' },
    create: {
      userId: user.id,
      householdId: household.id,
      role: 'OWNER',
    },
  });

  return {
    userId: user.id,
    householdId: household.id,
    householdName: household.name,
  };
}

async function resolveIngredientMap() {
  const [ingredients, aliases] = await Promise.all([
    prisma.ingredient.findMany({
      where: { isActive: true },
      select: { id: true, name: true, category: true, normalizedName: true },
    }),
    prisma.ingredientAlias.findMany({
      select: {
        normalizedAlias: true,
        ingredient: {
          select: {
            id: true,
            name: true,
            category: true,
            isActive: true,
            normalizedName: true,
          },
        },
      },
    }),
  ]);
  const byName = new Map<
    string,
    { id: string; name: string; category: string }
  >();
  for (const ingredient of ingredients) {
    byName.set(ingredient.normalizedName, ingredient);
  }
  for (const alias of aliases) {
    if (!alias.ingredient.isActive) continue;
    byName.set(alias.normalizedAlias, {
      id: alias.ingredient.id,
      name: alias.ingredient.name,
      category: alias.ingredient.category,
    });
  }
  return byName;
}

async function main(): Promise<void> {
  const { userId, householdId, householdName } = await ensureImportContext();
  const filePath = join(process.cwd(), RECIPE_IMPORT_FILE);
  const raw = await readFile(filePath, 'utf8');
  const input = JSON.parse(raw) as RecipeBatchInput;
  validateBatch(input);
  const recipeIdPool = await resolveRecipeIdPool(input.recipes.length);

  if (RECIPE_IMPORT_CLEAR_EXISTING) {
    await prisma.planItem.deleteMany();
    await prisma.weeklyPlan.deleteMany();
    await prisma.recipeIngredient.deleteMany();
    await prisma.recipe.deleteMany({ where: { householdId } });
  }

  const ingredientMap = await resolveIngredientMap();
  const assignedRecipeIds = new Set<string>();

  let created = 0;
  let updated = 0;
  for (const [index, recipe] of input.recipes.entries()) {
    const mappedIngredients = recipe.ingredients.map((ingredient) => {
      const found = ingredientMap.get(normalizeText(ingredient.ingredientName));
      if (!found) {
        throw new Error(
          `Ingredient "${ingredient.ingredientName}" not found in Ingredient table (recipe: "${recipe.title}").`,
        );
      }
      const normalized = normalizeIngredientAmount(
        found.name,
        found.category,
        ingredient.amount,
        ingredient.unit,
      );

      return {
        ingredientId: found.id,
        name: found.name,
        amount: ingredient.amount,
        unit: ingredient.unit,
        normalizedAmount: Number(normalized.normalizedAmount.toFixed(4)),
        normalizedUnit: normalized.normalizedUnit,
        department: found.category,
      };
    });

    const incomingRecipeId = recipe.id?.trim() || recipeIdPool[index] || null;
    if (incomingRecipeId) {
      if (assignedRecipeIds.has(incomingRecipeId)) {
        throw new Error(
          `Duplicate recipe id "${incomingRecipeId}" detected in import input/pool.`,
        );
      }
      assignedRecipeIds.add(incomingRecipeId);
    }
    const existing = incomingRecipeId
      ? await prisma.recipe.findUnique({
          where: { id: incomingRecipeId },
          select: { id: true, imageUrl: true },
        })
      : await prisma.recipe.findFirst({
          where: {
            householdId,
            title: recipe.title,
          },
          select: { id: true, imageUrl: true },
        });

    const resolvedRecipeId = incomingRecipeId ?? existing?.id ?? null;
    const incomingImageUrl =
      recipe.image?.imageUrl?.trim() ||
      (resolvedRecipeId
        ? buildGeneratedImageUrl(resolvedRecipeId, recipe)
        : null) ||
      (resolvedRecipeId ? buildR2ImageUrl(resolvedRecipeId) : null);

    const commonData = {
      title: recipe.title,
      description: recipe.description,
      mealType: recipe.mealType,
      difficulty: recipe.difficulty,
      prepTimeMinutes: recipe.prepTimeMinutes,
      servings: recipe.servings,
      nutritionKcal: recipe.nutrition.kcal,
      nutritionProtein: recipe.nutrition.protein,
      nutritionFat: recipe.nutrition.fat,
      nutritionCarbs: recipe.nutrition.carbs,
      nutritionFiber: recipe.nutrition.fiber,
      nutritionSalt: recipe.nutrition.salt,
      sourceProvider: 'manual-json-v1',
      sourceInstructions: recipe.steps.map((step) => ({
        step: step.step,
        text: step.instruction,
      })),
      sourceMeta: {
        imagePrompt: recipe.image?.prompt ?? null,
      },
      sourceRaw: recipe as unknown as object,
      householdId,
      authorId: userId,
    };

    if (existing) {
      await prisma.recipe.update({
        where: { id: existing.id },
        data: {
          ...commonData,
          imageUrl: incomingImageUrl ?? existing.imageUrl ?? null,
          ingredients: {
            deleteMany: {},
            create: mappedIngredients,
          },
        },
      });
      updated += 1;
    } else {
      await prisma.recipe.create({
        data: {
          ...(incomingRecipeId ? { id: incomingRecipeId } : {}),
          ...commonData,
          imageUrl: incomingImageUrl,
          ingredients: {
            create: mappedIngredients,
          },
        },
      });
      created += 1;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[recipes-import] done. household="${householdName}" created=${created} updated=${updated} totalInput=${input.recipes.length}`,
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Recipes JSON import failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
