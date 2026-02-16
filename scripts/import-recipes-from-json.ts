import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type RecipeInput = {
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

type NormalizedIngredient = {
  normalizedAmount: number;
  normalizedUnit: 'g' | 'ml' | 'szt';
};

const RECIPE_IMPORT_FILE = process.env.RECIPE_IMPORT_FILE ?? 'prisma/catalog/recipes-batch-test-v1.json';
const RECIPE_IMPORT_CLEAR_EXISTING = process.env.RECIPE_IMPORT_CLEAR_EXISTING === 'true';
const RECIPE_IMPORT_OWNER_USER_ID =
  process.env.RECIPE_IMPORT_OWNER_USER_ID ?? '11111111-1111-4111-8111-111111111111';
const RECIPE_IMPORT_OWNER_LEGACY_SUB =
  process.env.RECIPE_IMPORT_OWNER_LEGACY_SUB ?? `legacy-${RECIPE_IMPORT_OWNER_USER_ID}`;
const RECIPE_IMPORT_OWNER_DISPLAY_NAME = process.env.RECIPE_IMPORT_OWNER_DISPLAY_NAME ?? 'Recipe Import Bot';
const RECIPE_IMPORT_OWNER_EMAIL = process.env.RECIPE_IMPORT_OWNER_EMAIL ?? 'import-bot@example.com';
const RECIPE_IMPORT_HOUSEHOLD_NAME = process.env.RECIPE_IMPORT_HOUSEHOLD_NAME ?? 'Home';

const ALLOWED_UNITS = new Set(['g', 'kg', 'ml', 'l', 'szt', 'szczypta', 'łyżeczka', 'łyżka', 'lyzeczka', 'lyzka']);
const LIQUID_SPOON_UNITS_IN_ML: Record<'lyzeczka' | 'lyzka' | 'szczypta', number> = {
  lyzeczka: 5,
  lyzka: 15,
  szczypta: 0.5,
};
const SPICE_GRAMS_PER_TEASPOON_BY_NAME: Record<string, number> = {
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
const LIQUID_CONDIMENTS = new Set([
  'ketchup',
  'musztarda',
  'majonez',
  'ocet jablkowy',
  'ocet winny',
  'sos pomidorowy',
  'sos sojowy',
]);

function normalizeText(value: string): string {
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

function normalizeIngredientAmount(
  ingredientName: string,
  category: string,
  amount: number,
  unit: string,
): NormalizedIngredient {
  const normalizedUnit = normalizeText(unit) as
    | 'g'
    | 'kg'
    | 'ml'
    | 'l'
    | 'szt'
    | 'szczypta'
    | 'lyzeczka'
    | 'lyzka';

  if (normalizedUnit === 'g') return { normalizedAmount: amount, normalizedUnit: 'g' };
  if (normalizedUnit === 'kg') return { normalizedAmount: amount * 1000, normalizedUnit: 'g' };
  if (normalizedUnit === 'ml') return { normalizedAmount: amount, normalizedUnit: 'ml' };
  if (normalizedUnit === 'l') return { normalizedAmount: amount * 1000, normalizedUnit: 'ml' };
  if (normalizedUnit === 'szt') return { normalizedAmount: amount, normalizedUnit: 'szt' };

  const normalizedCategory = normalizeText(category);
  if (normalizedCategory !== 'przyprawy i sosy') {
    throw new Error(
      `Unit "${unit}" is allowed only for category "Przyprawy i sosy" (ingredient: ${ingredientName})`,
    );
  }

  const spoonFactor = normalizedUnit === 'lyzka' ? 3 : normalizedUnit === 'szczypta' ? 1 / 16 : 1;
  const normalizedName = normalizeText(ingredientName);

  if (LIQUID_CONDIMENTS.has(normalizedName)) {
    const mlPerUnit = LIQUID_SPOON_UNITS_IN_ML[normalizedUnit];
    return { normalizedAmount: amount * mlPerUnit, normalizedUnit: 'ml' };
  }

  const gramsPerTeaspoon = SPICE_GRAMS_PER_TEASPOON_BY_NAME[normalizedName] ?? 2.5;
  return {
    normalizedAmount: amount * gramsPerTeaspoon * spoonFactor,
    normalizedUnit: 'g',
  };
}

function validateBatch(input: RecipeBatchInput): void {
  if (!Array.isArray(input.recipes) || input.recipes.length === 0) {
    throw new Error('Invalid input: "recipes" must be a non-empty array.');
  }

  for (const recipe of input.recipes) {
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
        throw new Error(`Recipe "${recipe.title}" has ingredient with empty name.`);
      }
      if (!(ingredient.amount > 0)) {
        throw new Error(`Recipe "${recipe.title}" has invalid amount for "${ingredient.ingredientName}".`);
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

  return { userId: user.id, householdId: household.id, householdName: household.name };
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
          select: { id: true, name: true, category: true, isActive: true, normalizedName: true },
        },
      },
    }),
  ]);
  const byName = new Map<string, { id: string; name: string; category: string }>();
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

  if (RECIPE_IMPORT_CLEAR_EXISTING) {
    await prisma.planItem.deleteMany();
    await prisma.weeklyPlan.deleteMany();
    await prisma.recipeIngredient.deleteMany();
    await prisma.recipe.deleteMany({ where: { householdId } });
  }

  const ingredientMap = await resolveIngredientMap();

  let created = 0;
  let updated = 0;
  for (const recipe of input.recipes) {
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

    const existing = await prisma.recipe.findFirst({
      where: {
        householdId,
        title: recipe.title,
      },
      select: { id: true },
    });

    const commonData = {
      title: recipe.title,
      description: recipe.description,
      mealType: recipe.mealType,
      difficulty: recipe.difficulty,
      prepTimeMinutes: recipe.prepTimeMinutes,
      servings: recipe.servings,
      imageUrl: recipe.image?.imageUrl ?? null,
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
          ...commonData,
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
