import { PrismaClient, Difficulty, MealType } from '@prisma/client';

type SourceNutrient = {
  name: string;
  amount: number;
  unit: string;
};

type SourceIngredient = {
  nameClean?: string;
  originalName?: string;
  amount?: number;
  unit?: string;
};

type SourceRecipe = {
  id: number;
  title: string;
  summary?: string;
  image?: string;
  readyInMinutes?: number;
  servings?: number;
  dishTypes?: string[];
  extendedIngredients?: SourceIngredient[];
  nutrition?: {
    nutrients?: SourceNutrient[];
  };
};

type SourceSearchResponse = {
  results: SourceRecipe[];
};

const prisma = new PrismaClient();

const RECIPES_API_KEY = process.env.RECIPES_API_KEY ?? '';
const RECIPES_API_BASE_URL = process.env.RECIPES_API_BASE_URL ?? '';
const RECIPES_API_RECIPES_PATH = process.env.RECIPES_API_RECIPES_PATH ?? '/recipes/complexSearch';
const RECIPES_IMPORT_COUNT = Number(process.env.RECIPES_IMPORT_COUNT ?? '50') || 50;

const TRANSLATOR_API_KEY = process.env.TRANSLATOR_API_KEY ?? '';
const TRANSLATOR_API_BASE_URL = process.env.TRANSLATOR_API_BASE_URL ?? '';
const TRANSLATOR_AUTH_HEADER = process.env.TRANSLATOR_AUTH_HEADER ?? '';
const TRANSLATOR_MAX_RETRIES = Number(process.env.TRANSLATOR_MAX_RETRIES ?? '4') || 4;
const TRANSLATOR_BASE_DELAY_MS = Number(process.env.TRANSLATOR_BASE_DELAY_MS ?? '1200') || 1200;
const TRANSLATOR_MIN_INTERVAL_MS = Number(process.env.TRANSLATOR_MIN_INTERVAL_MS ?? '250') || 250;
const TRANSLATOR_FAIL_OPEN = process.env.TRANSLATOR_FAIL_OPEN !== 'false';

const IMPORT_CLEAR_EXISTING = process.env.IMPORT_CLEAR_EXISTING === 'true';
const IMPORT_OWNER_GOOGLE_ID = process.env.IMPORT_OWNER_GOOGLE_ID ?? 'import-bot-google-id';
const IMPORT_OWNER_DISPLAY_NAME = process.env.IMPORT_OWNER_DISPLAY_NAME ?? 'Import Bot';
const IMPORT_OWNER_EMAIL = process.env.IMPORT_OWNER_EMAIL ?? 'import-bot@example.com';
const IMPORT_HOUSEHOLD_NAME = process.env.IMPORT_HOUSEHOLD_NAME ?? 'Home';

function ensureEnv() {
  if (!RECIPES_API_KEY) {
    throw new Error('Missing RECIPES_API_KEY.');
  }
  if (!RECIPES_API_BASE_URL) {
    throw new Error('Missing RECIPES_API_BASE_URL.');
  }
}

function stripHtml(input?: string): string {
  if (!input) return '';
  return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickNutrient(nutrients: SourceNutrient[] | undefined, name: string): number {
  if (!nutrients?.length) return 0;
  const found = nutrients.find((n) => n.name.toLowerCase() === name.toLowerCase());
  return found?.amount ?? 0;
}

function toMealType(dishTypes: string[] | undefined): MealType {
  const joined = (dishTypes ?? []).join(' ').toLowerCase();
  if (joined.includes('breakfast') || joined.includes('brunch')) return MealType.BREAKFAST;
  if (joined.includes('lunch')) return MealType.LUNCH;
  return MealType.DINNER;
}

function toDifficulty(readyInMinutes: number | undefined): Difficulty {
  const value = readyInMinutes ?? 0;
  if (value <= 20) return Difficulty.EASY;
  if (value <= 45) return Difficulty.MEDIUM;
  return Difficulty.HARD;
}

function toDepartment(name: string): string {
  const n = name.toLowerCase();
  if (/(milk|cheese|yogurt|cream|butter|feta|parmesan)/.test(n)) return 'Nabiał';
  if (/(chicken|beef|pork|ham|bacon|turkey)/.test(n)) return 'Mięso';
  if (/(salmon|tuna|fish|shrimp|cod)/.test(n)) return 'Ryby';
  if (/(tomato|onion|pepper|broccoli|carrot|spinach|cucumber|garlic|potato|pumpkin)/.test(n))
    return 'Warzywa';
  if (/(apple|banana|orange|berry|strawberry|blueberry|lemon|lime)/.test(n)) return 'Owoce';
  if (/(rice|pasta|oat|flour|bread|quinoa|couscous)/.test(n)) return 'Zboża i makarony';
  if (/(olive oil|oil|vinegar|soy sauce|ketchup|mustard|salt|pepper|spice)/.test(n))
    return 'Przyprawy i sosy';
  return 'Inne';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastTranslatorCallAt = 0;
const translationCache = new Map<string, string>();

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }
  const asDate = new Date(headerValue);
  const ms = asDate.getTime() - Date.now();
  if (Number.isFinite(ms) && ms > 0) {
    return ms;
  }
  return null;
}

async function throttleTranslatorCalls() {
  const elapsed = Date.now() - lastTranslatorCallAt;
  if (elapsed < TRANSLATOR_MIN_INTERVAL_MS) {
    await sleep(TRANSLATOR_MIN_INTERVAL_MS - elapsed);
  }
  lastTranslatorCallAt = Date.now();
}

async function translateToPolish(text: string): Promise<string> {
  const cleaned = text.trim();
  if (!cleaned) return cleaned;
  if (!TRANSLATOR_API_KEY || !TRANSLATOR_API_BASE_URL || !TRANSLATOR_AUTH_HEADER) return cleaned;
  const cached = translationCache.get(cleaned);
  if (cached) return cached;

  for (let attempt = 0; attempt <= TRANSLATOR_MAX_RETRIES; attempt += 1) {
    await throttleTranslatorCalls();
    const response = await fetch(TRANSLATOR_API_BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `${TRANSLATOR_AUTH_HEADER} ${TRANSLATOR_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        text: cleaned,
        target_lang: 'PL',
        source_lang: 'EN',
      }),
    });

    if (response.ok) {
      const json = (await response.json()) as { translations?: { text: string }[] };
      const translated = json.translations?.[0]?.text?.trim() || cleaned;
      translationCache.set(cleaned, translated);
      return translated;
    }

    const shouldRetry = response.status === 429 || response.status >= 500;
    if (!shouldRetry || attempt === TRANSLATOR_MAX_RETRIES) {
      if (TRANSLATOR_FAIL_OPEN) {
        // eslint-disable-next-line no-console
        console.warn(
          `[translate] fallback to EN after ${attempt + 1} attempts (${response.status} ${response.statusText})`,
        );
        return cleaned;
      }
      throw new Error(`Translator request failed: ${response.status} ${response.statusText}`);
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const backoffMs = TRANSLATOR_BASE_DELAY_MS * (attempt + 1);
    const waitMs = Math.max(backoffMs, retryAfterMs ?? 0);
    await sleep(waitMs);
  }

  return cleaned;
}

async function fetchSourceRecipes(): Promise<SourceRecipe[]> {
  const params = new URLSearchParams({
    apiKey: RECIPES_API_KEY,
    number: String(RECIPES_IMPORT_COUNT),
    addRecipeNutrition: 'true',
    fillIngredients: 'true',
    instructionsRequired: 'true',
    sort: 'popularity',
  });
  const url = `${RECIPES_API_BASE_URL}${RECIPES_API_RECIPES_PATH}?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Recipe source request failed: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as SourceSearchResponse;
  return json.results ?? [];
}

async function ensureImportHousehold() {
  const user = await prisma.user.upsert({
    where: { googleId: IMPORT_OWNER_GOOGLE_ID },
    update: {
      displayName: IMPORT_OWNER_DISPLAY_NAME,
      email: IMPORT_OWNER_EMAIL,
    },
    create: {
      googleId: IMPORT_OWNER_GOOGLE_ID,
      displayName: IMPORT_OWNER_DISPLAY_NAME,
      email: IMPORT_OWNER_EMAIL,
    },
  });

  const existingHousehold = await prisma.household.findFirst({
    where: { name: IMPORT_HOUSEHOLD_NAME },
    orderBy: { createdAt: 'asc' },
  });

  const household =
    existingHousehold ??
    (await prisma.household.create({
      data: {
        name: IMPORT_HOUSEHOLD_NAME,
        createdById: user.id,
      },
    }));

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

  return { user, household };
}

async function main() {
  ensureEnv();

  const { user, household } = await ensureImportHousehold();

  if (IMPORT_CLEAR_EXISTING) {
    await prisma.recipe.deleteMany({ where: { householdId: household.id } });
  }

  const recipes = await fetchSourceRecipes();

  let imported = 0;
  let skipped = 0;
  for (const recipe of recipes) {
    try {
      const rawTitle = recipe.title || 'Untitled recipe';
      const rawDescription = stripHtml(recipe.summary);
      const titlePl = await translateToPolish(rawTitle);
      const descPl = await translateToPolish(rawDescription);

      const nutrition = recipe.nutrition?.nutrients ?? [];
      const sodiumMg = pickNutrient(nutrition, 'Sodium');
      const saltGrams = sodiumMg > 0 ? (sodiumMg * 2.5) / 1000 : 0;

      const created = await prisma.recipe.create({
        data: {
          title: titlePl.slice(0, 120),
          description: descPl.slice(0, 2000),
          mealType: toMealType(recipe.dishTypes),
          difficulty: toDifficulty(recipe.readyInMinutes),
          prepTimeMinutes: Math.max(0, recipe.readyInMinutes ?? 0),
          servings: Math.max(1, recipe.servings ?? 1),
          imageUrl: recipe.image ?? null,
          nutritionKcal: pickNutrient(nutrition, 'Calories'),
          nutritionProtein: pickNutrient(nutrition, 'Protein'),
          nutritionFat: pickNutrient(nutrition, 'Fat'),
          nutritionCarbs: pickNutrient(nutrition, 'Carbohydrates'),
          nutritionFiber: pickNutrient(nutrition, 'Fiber'),
          nutritionSalt: saltGrams,
          isActive: true,
          isFavorite: false,
          authorId: user.id,
          householdId: household.id,
        },
      });

      const ingredients = recipe.extendedIngredients ?? [];
      if (ingredients.length) {
        const translatedIngredients = [];
        for (const ing of ingredients) {
          const nameRaw = (ing.nameClean || ing.originalName || 'ingredient').trim();
          const namePl = await translateToPolish(nameRaw);
          const unitRaw = (ing.unit || 'szt').trim();
          const unit = unitRaw.length ? unitRaw : 'szt';
          translatedIngredients.push({
            recipeId: created.id,
            name: namePl.slice(0, 120),
            amount: Math.max(0, ing.amount ?? 0),
            unit: unit.slice(0, 32),
            department: toDepartment(nameRaw),
          });
        }
        await prisma.recipeIngredient.createMany({
          data: translatedIngredients,
        });
      }

      imported += 1;
    } catch (error) {
      skipped += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[import] skipped recipe sourceId=${recipe.id} title="${recipe.title}" because:`,
        error,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `Imported ${imported} recipes into household "${household.name}" (${household.id}). Skipped: ${skipped}.`,
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Import failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
