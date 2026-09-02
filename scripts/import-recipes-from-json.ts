import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MealType, PrismaClient } from '@prisma/client';
import { MEAL_TYPE_VALUES } from '../src/common/meal-types';
import { deriveRecipeTags } from '../src/common/diet-tags';
import { resolveSuitableMealTypes } from '../src/recipes/suitable-meal-types.util';
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
  mealType: MealType;
  /**
   * Opcjonalne, ręczne rozszerzenie slotów. Pominięte = import policzy je
   * klasyfikatorem (`resolveSuitableMealTypes`).
   */
  suitableMealTypes?: MealType[];
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
  /**
   * Zewnętrzne źródło przepisu. Podane w JSON-ie (np. "cookidoo" +
   * "r56899" z URL-a przepisu) przeżywa każdy re-import — bez tego pola
   * import nadpisywałby linkowanie do Cookidoo swoim "manual-json-v1"
   * i przycisk „Gotuj w Thermomixie" znikał po każdym odświeżeniu katalogu.
   */
  sourceProvider?: string;
  sourceRecipeId?: string;
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

// Plik importu jest WYMAGANY: domyślna partia testowa wgrana przez pomyłkę
// podmieniała katalog (id sparowane po indeksie z pulą). Każdy przepis w
// pliku musi mieć jawne `id`.
const RECIPE_IMPORT_FILE = (process.env.RECIPE_IMPORT_FILE ?? '').trim();
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
// Gospodarstwo katalogu wskazywane po ID, nie po nazwie: „Home” to domyślna
// nazwa domu każdego użytkownika, więc na świeżej bazie katalog mógł wylądować
// w cudzym gospodarstwie (z botem importu jako OWNER). Na istniejącej bazie
// ustaw ID gospodarstwa, które już trzyma katalog; na świeżej importer
// utworzy gospodarstwo o tym ID.
const RECIPE_IMPORT_HOUSEHOLD_ID =
  process.env.RECIPE_IMPORT_HOUSEHOLD_ID ??
  '22222222-2222-4222-8222-222222222222';
const RECIPE_IMPORT_HOUSEHOLD_NAME =
  process.env.RECIPE_IMPORT_HOUSEHOLD_NAME ?? 'Katalog Weekly Meals';
// Import trafia w istniejący wiersz PO ID, więc plik z id sparowanym z innym
// daniem nie dodaje przepisu — on go PODMIENIA. Wszystko, co trzyma samo id
// (pozycje planu, ulubione, cache katalogu w aplikacji, obrazek w R2 nazwany
// id-em), zostaje wtedy przy starym daniu, a wiersz pod spodem jest już inny:
// użytkownik stuka kafelek A, a do planu wchodzi B. Dokładnie to zrobił
// `recipes-catalog-full-v2.json` z posortowaną pulą id nałożoną po indeksie na
// listę w kolejności tytułów. Zmiana tytułu istniejącego id musi więc być
// świadoma i głośna, a nie skutkiem ubocznym re-importu.
const RECIPE_IMPORT_ALLOW_RETITLE =
  process.env.RECIPE_IMPORT_ALLOW_RETITLE === 'true';
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
    if (!recipe.id?.trim()) {
      throw new Error(
        `Recipe "${recipe.title}" must have an explicit id (UUID) — importer no longer assigns ids from a pool.`,
      );
    }
    if (!isUuid(recipe.id.trim())) {
      throw new Error(
        `Recipe "${recipe.title}" has invalid id "${recipe.id}". Expected UUID.`,
      );
    }
    if (!recipe.title?.trim()) throw new Error('Recipe title is required.');
    if (!MEAL_TYPE_VALUES.includes(recipe.mealType)) {
      throw new Error(`Invalid mealType for recipe "${recipe.title}".`);
    }
    if (
      recipe.suitableMealTypes?.some(
        (mealType) => !MEAL_TYPE_VALUES.includes(mealType),
      )
    ) {
      throw new Error(
        `Invalid suitableMealTypes for recipe "${recipe.title}".`,
      );
    }
    if (!['EASY', 'MEDIUM', 'HARD'].includes(recipe.difficulty)) {
      throw new Error(`Invalid difficulty for recipe "${recipe.title}".`);
    }
    // Porcje = na ile osób NAPISANY jest przepis. Katalog długo wymuszał 2,
    // przez co partie na 4 (pierogi, gołąbki) pokazywały 950–1290 kcal „na
    // porcję”. Zakres 1–8 zostawia miejsce na realne wydajności.
    if (
      !Number.isInteger(recipe.servings) ||
      recipe.servings < 1 ||
      recipe.servings > 8
    ) {
      throw new Error(
        `Recipe "${recipe.title}" must have integer servings in range 1..8 (got ${String(recipe.servings)}).`,
      );
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

  const household = await prisma.household.upsert({
    where: { id: RECIPE_IMPORT_HOUSEHOLD_ID },
    update: {},
    create: {
      id: RECIPE_IMPORT_HOUSEHOLD_ID,
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
      select: {
        id: true,
        name: true,
        category: true,
        normalizedName: true,
        allergens: true,
        dietTags: true,
      },
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
            allergens: true,
            dietTags: true,
          },
        },
      },
    }),
  ]);
  const byName = new Map<
    string,
    {
      id: string;
      name: string;
      category: string;
      allergens: string[];
      dietTags: string[];
    }
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
      allergens: alias.ingredient.allergens,
      dietTags: alias.ingredient.dietTags,
    });
  }
  return byName;
}

async function main(): Promise<void> {
  if (!RECIPE_IMPORT_FILE) {
    throw new Error(
      'RECIPE_IMPORT_FILE is required (e.g. prisma/catalog/recipes-catalog-full-v2.json).',
    );
  }
  const { userId, householdId, householdName } = await ensureImportContext();
  const filePath = join(process.cwd(), RECIPE_IMPORT_FILE);
  const raw = await readFile(filePath, 'utf8');
  const input = JSON.parse(raw) as RecipeBatchInput;
  validateBatch(input);
  if (RECIPE_IMPORT_CLEAR_EXISTING) {
    // Kasowanie katalogu zabiera z planów WSZYSTKICH domów pozycje wskazujące
    // na jego przepisy. Dlatego: najpierw liczby, a zapis tylko z dzisiejszą
    // datą w `RECIPE_IMPORT_CLEAR_CONFIRM` (ten sam wzorzec, co reset kont).
    const [planItems, recipes] = await Promise.all([
      prisma.planItem.count({ where: { recipe: { householdId } } }),
      prisma.recipe.count({ where: { householdId } }),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    console.log(
      `Czyszczenie katalogu: przepisów ${recipes}, pozycji planów do skasowania ${planItems}.`,
    );
    if ((process.env.RECIPE_IMPORT_CLEAR_CONFIRM ?? '').trim() !== today) {
      throw new Error(
        `RECIPE_IMPORT_CLEAR_EXISTING=true wymaga RECIPE_IMPORT_CLEAR_CONFIRM=${today} (dzisiejsza data). Nic nie skasowano.`,
      );
    }
    // Tylko katalog: dawniej `deleteMany()` bez `where` kasował pozycje planu
    // i składniki WSZYSTKICH gospodarstw. Pozycje planu wskazujące na
    // przepisy katalogu i tak by spadły kaskadą przy usunięciu przepisu.
    await prisma.planItem.deleteMany({
      where: { recipe: { householdId } },
    });
    await prisma.recipeIngredient.deleteMany({
      where: { recipe: { householdId } },
    });
    await prisma.recipe.deleteMany({ where: { householdId } });
  }

  const ingredientMap = await resolveIngredientMap();
  const assignedRecipeIds = new Set<string>();

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
    // Tagi przepisu = unia tagów składników z bazy (JSON ich nie ma). Wymaga
    // wgranych tagów składników PRZED importem — patrz bootstrap.
    const recipeTags = deriveRecipeTags(
      recipe.ingredients.map(
        (ingredient) =>
          ingredientMap.get(normalizeText(ingredient.ingredientName))!,
      ),
    );

    // `validateBatch` gwarantuje, że każdy przepis ma jawne UUID.
    const incomingRecipeId = (recipe.id ?? '').trim();
    if (assignedRecipeIds.has(incomingRecipeId)) {
      throw new Error(
        `Duplicate recipe id "${incomingRecipeId}" detected in import input.`,
      );
    }
    assignedRecipeIds.add(incomingRecipeId);
    const existing = await prisma.recipe.findUnique({
      where: { id: incomingRecipeId },
      select: { id: true, title: true, imageUrl: true },
    });

    // Bramka na podmianę dania pod istniejącym id — patrz komentarz przy
    // `RECIPE_IMPORT_ALLOW_RETITLE`. Przerywamy CAŁY import, nie pomijamy
    // wiersza: plik z rozjechaną pulą id psuje zwykle kilkadziesiąt pozycji
    // naraz, a import w połowie zostawiłby katalog w stanie gorszym niż przed.
    if (
      incomingRecipeId &&
      existing &&
      existing.title !== recipe.title &&
      !RECIPE_IMPORT_ALLOW_RETITLE
    ) {
      throw new Error(
        `Recipe id "${incomingRecipeId}" already belongs to "${existing.title}", ` +
          `import wants to overwrite it with "${recipe.title}". ` +
          `Popraw id w pliku importu albo ustaw RECIPE_IMPORT_ALLOW_RETITLE=true, ` +
          `jeśli podmiana dania pod tym id jest zamierzona.`,
      );
    }

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
      // Sloty, w których danie ma sens. JSON może je podać wprost; jeśli nie,
      // liczy je klasyfikator — inaczej każdy import wracałby z katalogiem,
      // w którym II śniadanie i podwieczorek są puste.
      suitableMealTypes: resolveSuitableMealTypes({
        title: recipe.title,
        description: recipe.description,
        mealType: recipe.mealType,
        prepTimeMinutes: recipe.prepTimeMinutes,
        servings: recipe.servings,
        nutritionKcal: recipe.nutrition.kcal,
        suitableMealTypes: recipe.suitableMealTypes,
      }),
      difficulty: recipe.difficulty,
      prepTimeMinutes: recipe.prepTimeMinutes,
      servings: recipe.servings,
      nutritionKcal: recipe.nutrition.kcal,
      nutritionProtein: recipe.nutrition.protein,
      nutritionFat: recipe.nutrition.fat,
      nutritionCarbs: recipe.nutrition.carbs,
      nutritionFiber: recipe.nutrition.fiber,
      nutritionSalt: recipe.nutrition.salt,
      allergens: recipeTags.allergens,
      dietTags: recipeTags.dietTags,
      sourceProvider: recipe.sourceProvider ?? 'manual-json-v1',
      sourceRecipeId: recipe.sourceRecipeId ?? null,
      sourceInstructions: recipe.steps.map((step) => ({
        step: step.step,
        text: step.instruction,
      })),
      sourceMeta: {
        imagePrompt: recipe.image?.prompt ?? null,
      },
      sourceRaw: recipe as unknown as object,
      householdId,
      // Import zasila WSPÓLNY katalog — to jedyne miejsce, które go tworzy.
      isCatalog: true,
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

  console.log(
    `[recipes-import] done. household="${householdName}" created=${created} updated=${updated} totalInput=${input.recipes.length}`,
  );
}

main()
  .catch((error) => {
    console.error('Recipes JSON import failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
