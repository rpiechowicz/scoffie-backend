import { PrismaClient, Difficulty, MealType, Prisma } from '@prisma/client';

type SourceNutrient = {
  name: string;
  amount: number;
  unit: string;
};

type SourceIngredient = {
  nameClean?: string;
  originalName?: string;
  name?: string;
  ingredient?: string;
  amount?: number;
  unit?: string;
};

type SourceRecipe = {
  id: number | string;
  title: string;
  summary?: string;
  image?: string;
  readyInMinutes?: number;
  servings?: number;
  dishTypes?: string[];
  extendedIngredients?: SourceIngredient[];
  sourceDifficulty?: string;
  sourceCategory?: string;
  sourceCuisine?: string;
  sourceTags?: string[];
  sourceMeta?: Record<string, unknown>;
  sourceDietary?: Record<string, unknown>;
  sourceStorage?: Record<string, unknown>;
  sourceEquipment?: unknown[];
  sourceInstructions?: unknown[];
  sourceTroubleshooting?: unknown[];
  sourceChefNotes?: string[];
  sourceCulturalContext?: string;
  sourceNutrition?: Record<string, unknown>;
  sourceRaw?: Record<string, unknown>;
  nutrition?: {
    nutrients?: SourceNutrient[];
  };
};

type SourceSearchResponse = {
  results?: unknown;
  data?: unknown;
  recipes?: unknown;
};

const prisma = new PrismaClient();

const RECIPES_API_KEY = process.env.RECIPES_API_KEY ?? '';
const RECIPES_API_PROVIDER = (process.env.RECIPES_API_PROVIDER ?? 'spoonacular').toLowerCase();
const RECIPES_API_BASE_URL = process.env.RECIPES_API_BASE_URL ?? '';
const RECIPES_API_RECIPES_PATH = process.env.RECIPES_API_RECIPES_PATH ?? '/recipes/complexSearch';
const RECIPES_IMPORT_COUNT = Number(process.env.RECIPES_IMPORT_COUNT ?? '50') || 50;
const RECIPES_API_AUTH_MODE = (process.env.RECIPES_API_AUTH_MODE ?? 'query').toLowerCase();
const RECIPES_API_KEY_HEADER = process.env.RECIPES_API_KEY_HEADER ?? 'X-Api-Key';
const RECIPES_API_KEY_QUERY_PARAM = process.env.RECIPES_API_KEY_QUERY_PARAM ?? 'apiKey';
const RECIPES_API_DETAILS_PATH_TEMPLATE =
  process.env.RECIPES_API_DETAILS_PATH_TEMPLATE ?? '/api/v1/recipes/:id';
const RECIPES_IMAGE_FALLBACK_ENABLED = process.env.RECIPES_IMAGE_FALLBACK_ENABLED === 'true';
const RECIPES_IMAGE_FALLBACK_TEMPLATE =
  process.env.RECIPES_IMAGE_FALLBACK_TEMPLATE ??
  'https://placehold.co/1200x800/F3F4F6/111827?text=:title';

const TRANSLATOR_API_KEY = process.env.TRANSLATOR_API_KEY ?? '';
const TRANSLATOR_API_BASE_URL = process.env.TRANSLATOR_API_BASE_URL ?? '';
const TRANSLATOR_AUTH_HEADER = process.env.TRANSLATOR_AUTH_HEADER ?? '';
const TRANSLATOR_MAX_RETRIES = Number(process.env.TRANSLATOR_MAX_RETRIES ?? '4') || 4;
const TRANSLATOR_BASE_DELAY_MS = Number(process.env.TRANSLATOR_BASE_DELAY_MS ?? '1200') || 1200;
const TRANSLATOR_MIN_INTERVAL_MS = Number(process.env.TRANSLATOR_MIN_INTERVAL_MS ?? '250') || 250;
const TRANSLATOR_FAIL_OPEN = process.env.TRANSLATOR_FAIL_OPEN !== 'false';

const IMPORT_CLEAR_EXISTING = process.env.IMPORT_CLEAR_EXISTING === 'true';
const IMPORT_TRANSLATE_ON_INGEST = process.env.IMPORT_TRANSLATE_ON_INGEST === 'true';
const IMPORT_OWNER_USER_ID = process.env.IMPORT_OWNER_USER_ID ?? '11111111-1111-4111-8111-111111111111';
const IMPORT_OWNER_LEGACY_SUB = process.env.IMPORT_OWNER_LEGACY_SUB ?? `legacy-${IMPORT_OWNER_USER_ID}`;
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
  if (RECIPES_API_AUTH_MODE !== 'query' && RECIPES_API_AUTH_MODE !== 'header') {
    throw new Error('RECIPES_API_AUTH_MODE must be "query" or "header".');
  }
}

function stripHtml(input?: string): string {
  if (!input) return '';
  return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.replace(',', '.').match(/(\d+(?:\.\d+)?)/)?.[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickStringList(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const values = value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0);
      if (values.length) return values;
    }
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
  }
  return [];
}

function parseDurationMinutes(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  const iso = /^P(?:\d+D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(v);
  if (iso) {
    const hours = Number(iso[1] ?? '0');
    const minutes = Number(iso[2] ?? '0');
    return Math.max(0, hours * 60 + minutes);
  }
  const plain = Number(v.replace(/[^\d.]/g, ''));
  if (Number.isFinite(plain)) return Math.max(0, Math.round(plain));
  return undefined;
}

function parseIngredientLine(line: string): SourceIngredient {
  const raw = line.trim();
  if (!raw) return { nameClean: 'ingredient', amount: 0, unit: 'szt' };
  const match = raw.match(/^(\d+(?:[.,]\d+)?)(?:\s+([^\s]+))?\s+(.+)$/);
  if (!match) {
    return { nameClean: raw, amount: 0, unit: 'szt' };
  }
  return {
    nameClean: match[3].trim(),
    amount: Number(match[1].replace(',', '.')),
    unit: (match[2] ?? 'szt').trim(),
  };
}

function normalizeIngredients(value: unknown): SourceIngredient[] {
  if (!Array.isArray(value)) return [];
  const out: SourceIngredient[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      out.push(parseIngredientLine(item));
      continue;
    }
    const record = asRecord(item);
    if (!record) continue;
    if (Array.isArray(record.items)) {
      for (const grouped of record.items) {
        const groupedRecord = asRecord(grouped);
        if (!groupedRecord) continue;
        out.push({
          nameClean: pickString(groupedRecord, ['name', 'ingredient', 'originalName']),
          originalName: pickString(groupedRecord, ['originalName', 'name']),
          amount: pickNumber(groupedRecord, ['amount', 'quantity', 'qty']),
          unit: pickString(groupedRecord, ['unit', 'unitShort', 'uom']),
        });
      }
      continue;
    }
    out.push({
      nameClean: pickString(record, ['nameClean', 'name_clean', 'name', 'originalName', 'ingredient']),
      originalName: pickString(record, ['originalName', 'original_name', 'name']),
      amount: pickNumber(record, ['amount', 'quantity', 'qty']),
      unit: pickString(record, ['unit', 'unitShort', 'uom']),
    });
  }
  return out;
}

function normalizeNutrition(value: unknown): SourceRecipe['nutrition'] {
  const nutrition = asRecord(value);
  if (!nutrition) return undefined;

  const nestedPerServing =
    asRecord(nutrition.per_serving) ??
    asRecord(nutrition.perServing) ??
    asRecord(nutrition['per-serving']) ??
    asRecord(nutrition['per serving']);

  const candidates = [nutrition, nestedPerServing].filter(
    (item): item is Record<string, unknown> => Boolean(item),
  );

  if (Array.isArray(nutrition.nutrients)) {
    const nutrients = nutrition.nutrients
      .map((item) => {
        const record = asRecord(item);
        if (!record) return null;
        const name = pickString(record, ['name']);
        const amount = pickNumber(record, ['amount']);
        const unit = pickString(record, ['unit']) ?? '';
        if (!name || amount === undefined) return null;
        return { name, amount, unit };
      })
      .filter((item): item is SourceNutrient => Boolean(item));
    if (nutrients.length) return { nutrients };
  }

  const pickFromCandidates = (keys: string[]) => {
    for (const candidate of candidates) {
      const value = pickNumber(candidate, keys);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const mapped: SourceNutrient[] = [];
  const calories = pickFromCandidates(['calories', 'kcal', 'energy_kcal']);
  const protein = pickFromCandidates(['protein', 'protein_g', 'proteins']);
  const fat = pickFromCandidates(['fat', 'fat_g', 'total_fat_g']);
  const carbs = pickFromCandidates(['carbohydrates', 'carbs', 'carbohydrates_g']);
  const fiber = pickFromCandidates(['fiber', 'fibre', 'fiber_g']);
  const sodium = pickFromCandidates(['sodium', 'sodiumMg', 'sodium_mg']);
  if (calories !== undefined) mapped.push({ name: 'Calories', amount: calories, unit: 'kcal' });
  if (protein !== undefined) mapped.push({ name: 'Protein', amount: protein, unit: 'g' });
  if (fat !== undefined) mapped.push({ name: 'Fat', amount: fat, unit: 'g' });
  if (carbs !== undefined) mapped.push({ name: 'Carbohydrates', amount: carbs, unit: 'g' });
  if (fiber !== undefined) mapped.push({ name: 'Fiber', amount: fiber, unit: 'g' });
  if (sodium !== undefined) mapped.push({ name: 'Sodium', amount: sodium, unit: 'mg' });
  return mapped.length ? { nutrients: mapped } : undefined;
}

function normalizeRecipe(raw: unknown, index: number): SourceRecipe | null {
  const record = asRecord(raw);
  if (!record) return null;

  const title = pickString(record, ['title', 'name']);
  if (!title) return null;

  const meta = asRecord(record.meta);
  const prepFromMeta =
    parseDurationMinutes(meta?.total_time) ??
    parseDurationMinutes(meta?.active_time) ??
    parseDurationMinutes(meta?.passive_time);

  return {
    id: pickString(record, ['id']) ?? pickNumber(record, ['id']) ?? `idx-${index}`,
    title,
    summary: pickString(record, ['summary', 'description']),
    image: pickString(record, ['image', 'image_url', 'photo', 'photo_url']),
    readyInMinutes:
      pickNumber(record, ['readyInMinutes', 'ready_in_minutes', 'totalTimeMinutes', 'cookTime']) ??
      prepFromMeta,
    servings: pickNumber(record, ['servings', 'yield']) ?? pickNumber(meta ?? {}, ['yield_count']),
    dishTypes: pickStringList(record, ['dishTypes', 'dish_types', 'categories', 'tags', 'mealType', 'category']),
    extendedIngredients: normalizeIngredients(record.extendedIngredients ?? record.ingredients),
    sourceDifficulty: pickString(record, ['difficulty']),
    sourceCategory: pickString(record, ['category']),
    sourceCuisine: pickString(record, ['cuisine']),
    sourceTags: pickStringList(record, ['tags']),
    sourceMeta: meta ?? undefined,
    sourceDietary: asRecord(record.dietary) ?? undefined,
    sourceStorage: asRecord(record.storage) ?? undefined,
    sourceEquipment: Array.isArray(record.equipment) ? record.equipment : undefined,
    sourceInstructions: Array.isArray(record.instructions) ? record.instructions : undefined,
    sourceTroubleshooting: Array.isArray(record.troubleshooting) ? record.troubleshooting : undefined,
    sourceChefNotes: pickStringList(record, ['chef_notes']),
    sourceCulturalContext: pickString(record, ['cultural_context']),
    sourceNutrition: asRecord(record.nutrition) ?? asRecord(record.nutrition_summary) ?? undefined,
    sourceRaw: record,
    nutrition: normalizeNutrition(record.nutrition ?? record.nutrition_summary ?? record),
  };
}

function pickNutrient(nutrients: SourceNutrient[] | undefined, name: string): number {
  if (!nutrients?.length) return 0;
  const found = nutrients.find((n) => n.name.toLowerCase() === name.toLowerCase());
  return found?.amount ?? 0;
}

function toTotalNutrition(valuePerServing: number, servings: number, scaleFromPerServing: boolean): number {
  if (!scaleFromPerServing) return valuePerServing;
  return valuePerServing * Math.max(1, servings);
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

function toDifficultyWithSource(readyInMinutes: number | undefined, sourceDifficulty?: string): Difficulty {
  const normalized = (sourceDifficulty ?? '').toLowerCase();
  if (normalized.includes('easy')) return Difficulty.EASY;
  if (normalized.includes('medium')) return Difficulty.MEDIUM;
  if (normalized.includes('hard')) return Difficulty.HARD;
  return toDifficulty(readyInMinutes);
}

function buildImageUrl(recipe: SourceRecipe): string | null {
  if (recipe.image?.trim()) return recipe.image.trim();
  if (!RECIPES_IMAGE_FALLBACK_ENABLED) return null;
  const title = encodeURIComponent((recipe.title || 'Recipe').slice(0, 60));
  const id = encodeURIComponent(String(recipe.id));
  return RECIPES_IMAGE_FALLBACK_TEMPLATE.replace(':title', title).replace(':id', id);
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
  if (!IMPORT_TRANSLATE_ON_INGEST) return cleaned;
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
  const params = new URLSearchParams();
  const headers: Record<string, string> = {};

  if (RECIPES_API_PROVIDER === 'recipe-api') {
    params.set('limit', String(RECIPES_IMPORT_COUNT));
  } else {
    params.set('number', String(RECIPES_IMPORT_COUNT));
    params.set('addRecipeNutrition', 'true');
    params.set('fillIngredients', 'true');
    params.set('instructionsRequired', 'true');
    params.set('sort', 'popularity');
  }

  if (RECIPES_API_AUTH_MODE === 'header') {
    headers[RECIPES_API_KEY_HEADER] = RECIPES_API_KEY;
  } else {
    params.set(RECIPES_API_KEY_QUERY_PARAM, RECIPES_API_KEY);
  }

  const query = params.toString();
  const buildUrl = (path: string) => `${RECIPES_API_BASE_URL}${path}${query ? `?${query}` : ''}`;
  let response = await fetch(buildUrl(RECIPES_API_RECIPES_PATH), {
    headers,
  });

  if (!response.ok && response.status === 404 && RECIPES_API_PROVIDER === 'recipe-api') {
    response = await fetch(buildUrl('/api/v1/recipes'), {
      headers,
    });
  }

  if (!response.ok) {
    throw new Error(`Recipe source request failed: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as SourceSearchResponse;
  const rawList = Array.isArray(json)
    ? json
    : Array.isArray(json.results)
      ? json.results
      : Array.isArray(json.data)
        ? json.data
        : Array.isArray(json.recipes)
          ? json.recipes
          : [];
  const normalizedList = rawList
    .map((item, index) => normalizeRecipe(item, index))
    .filter((item): item is SourceRecipe => Boolean(item));
  const limitedList = normalizedList.slice(0, Math.max(1, RECIPES_IMPORT_COUNT));

  if (RECIPES_API_PROVIDER !== 'recipe-api') {
    return limitedList;
  }

  const detailed: SourceRecipe[] = [];
  for (let index = 0; index < limitedList.length; index += 1) {
    const recipe = limitedList[index];
    const recipeId = String(recipe.id);
    const detailsPath = RECIPES_API_DETAILS_PATH_TEMPLATE.replace(':id', encodeURIComponent(recipeId));
    const detailsUrl = `${RECIPES_API_BASE_URL}${detailsPath}`;
    const detailsResponse = await fetch(detailsUrl, { headers });
    if (!detailsResponse.ok) {
      detailed.push(recipe);
      continue;
    }

    const detailsJson = (await detailsResponse.json()) as { data?: unknown };
    const detailsData = asRecord(detailsJson)?.data ?? detailsJson;
    const normalizedDetails = normalizeRecipe(detailsData, index);
    detailed.push(normalizedDetails ?? recipe);
  }

  return detailed;
}

async function ensureImportHousehold() {
  const user = await prisma.user.upsert({
    where: { id: IMPORT_OWNER_USER_ID },
    update: {
      displayName: IMPORT_OWNER_DISPLAY_NAME,
      email: IMPORT_OWNER_EMAIL,
    },
    create: {
      id: IMPORT_OWNER_USER_ID,
      googleId: IMPORT_OWNER_LEGACY_SUB,
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
      const servingsCount = Math.max(1, recipe.servings ?? 1);
      const scaleNutritionFromPerServing =
        RECIPES_API_PROVIDER === 'recipe-api' ||
        Boolean(asRecord(recipe.sourceNutrition)?.per_serving) ||
        Boolean(asRecord(recipe.sourceNutrition)?.perServing);
      const sodiumMg = pickNutrient(nutrition, 'Sodium');
      const sodiumMgTotal = toTotalNutrition(sodiumMg, servingsCount, scaleNutritionFromPerServing);
      const saltGrams = sodiumMgTotal > 0 ? (sodiumMgTotal * 2.5) / 1000 : 0;

      const created = await prisma.recipe.create({
        data: {
          title: titlePl.slice(0, 120),
          description: descPl.slice(0, 2000),
          sourceProvider: RECIPES_API_PROVIDER,
          sourceRecipeId: String(recipe.id),
          sourceCategory: recipe.sourceCategory ?? null,
          sourceCuisine: recipe.sourceCuisine ?? null,
          sourceTags: recipe.sourceTags ?? [],
          sourceMeta: toJson(recipe.sourceMeta) ?? null,
          sourceDietary: toJson(recipe.sourceDietary) ?? null,
          sourceStorage: toJson(recipe.sourceStorage) ?? null,
          sourceEquipment: toJson(recipe.sourceEquipment) ?? null,
          sourceInstructions: toJson(recipe.sourceInstructions) ?? null,
          sourceTroubleshooting: toJson(recipe.sourceTroubleshooting) ?? null,
          sourceChefNotes: toJson(recipe.sourceChefNotes) ?? null,
          sourceCulturalContext: recipe.sourceCulturalContext ?? null,
          sourceNutrition: toJson(recipe.sourceNutrition) ?? null,
          sourceRaw: toJson(recipe.sourceRaw) ?? null,
          mealType: toMealType(recipe.dishTypes),
          difficulty: toDifficultyWithSource(recipe.readyInMinutes, recipe.sourceDifficulty),
          prepTimeMinutes: Math.max(0, recipe.readyInMinutes ?? 0),
          servings: servingsCount,
          imageUrl: buildImageUrl(recipe),
          nutritionKcal: toTotalNutrition(pickNutrient(nutrition, 'Calories'), servingsCount, scaleNutritionFromPerServing),
          nutritionProtein: toTotalNutrition(
            pickNutrient(nutrition, 'Protein'),
            servingsCount,
            scaleNutritionFromPerServing,
          ),
          nutritionFat: toTotalNutrition(pickNutrient(nutrition, 'Fat'), servingsCount, scaleNutritionFromPerServing),
          nutritionCarbs: toTotalNutrition(
            pickNutrient(nutrition, 'Carbohydrates'),
            servingsCount,
            scaleNutritionFromPerServing,
          ),
          nutritionFiber: toTotalNutrition(
            pickNutrient(nutrition, 'Fiber'),
            servingsCount,
            scaleNutritionFromPerServing,
          ),
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
