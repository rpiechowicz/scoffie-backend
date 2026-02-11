import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const TRANSLATOR_API_KEY = process.env.TRANSLATOR_API_KEY ?? '';
const TRANSLATOR_API_BASE_URL = process.env.TRANSLATOR_API_BASE_URL ?? '';
const TRANSLATOR_AUTH_HEADER = process.env.TRANSLATOR_AUTH_HEADER ?? '';
const TRANSLATOR_MAX_RETRIES = Number(process.env.TRANSLATOR_MAX_RETRIES ?? '4') || 4;
const TRANSLATOR_BASE_DELAY_MS = Number(process.env.TRANSLATOR_BASE_DELAY_MS ?? '1200') || 1200;
const TRANSLATOR_MIN_INTERVAL_MS = Number(process.env.TRANSLATOR_MIN_INTERVAL_MS ?? '250') || 250;
const TRANSLATOR_FAIL_OPEN = process.env.TRANSLATOR_FAIL_OPEN !== 'false';

const TRANSLATE_HOUSEHOLD_NAME = process.env.TRANSLATE_HOUSEHOLD_NAME ?? 'Home';
const TRANSLATE_RECIPE_LIMIT = Number(process.env.TRANSLATE_RECIPE_LIMIT ?? '0') || 0;
const TRANSLATE_SOURCE_LANG = process.env.TRANSLATE_SOURCE_LANG ?? 'EN';
const TRANSLATE_TARGET_LANG = process.env.TRANSLATE_TARGET_LANG ?? 'PL';
const TRANSLATE_SOURCE_DETAIL_FIELDS = process.env.TRANSLATE_SOURCE_DETAIL_FIELDS !== 'false';

function ensureEnv() {
  if (!TRANSLATOR_API_KEY) {
    throw new Error('Missing TRANSLATOR_API_KEY.');
  }
  if (!TRANSLATOR_API_BASE_URL) {
    throw new Error('Missing TRANSLATOR_API_BASE_URL.');
  }
  if (!TRANSLATOR_AUTH_HEADER) {
    throw new Error('Missing TRANSLATOR_AUTH_HEADER.');
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

let lastTranslatorCallAt = 0;
const translationCache = new Map<string, string>();

async function throttleTranslatorCalls() {
  const elapsed = Date.now() - lastTranslatorCallAt;
  if (elapsed < TRANSLATOR_MIN_INTERVAL_MS) {
    await sleep(TRANSLATOR_MIN_INTERVAL_MS - elapsed);
  }
  lastTranslatorCallAt = Date.now();
}

async function translateText(text: string): Promise<string> {
  const cleaned = text.trim();
  if (!cleaned) return cleaned;
  const cacheKey = `${TRANSLATE_SOURCE_LANG}:${TRANSLATE_TARGET_LANG}:${cleaned}`;
  const cached = translationCache.get(cacheKey);
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
        target_lang: TRANSLATE_TARGET_LANG,
        source_lang: TRANSLATE_SOURCE_LANG,
      }),
    });

    if (response.ok) {
      const json = (await response.json()) as { translations?: { text: string }[] };
      const translated = json.translations?.[0]?.text?.trim() || cleaned;
      translationCache.set(cacheKey, translated);
      return translated;
    }

    const shouldRetry = response.status === 429 || response.status >= 500;
    if (!shouldRetry || attempt === TRANSLATOR_MAX_RETRIES) {
      if (TRANSLATOR_FAIL_OPEN) {
        // eslint-disable-next-line no-console
        console.warn(
          `[translate] fallback to original text after ${attempt + 1} attempts (${response.status} ${response.statusText})`,
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

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

function shouldTranslateKey(key: string): boolean {
  const lower = key.toLowerCase();
  const allowed = new Set([
    'name',
    'description',
    'category',
    'cuisine',
    'notes',
    'reheating',
    'text',
    'phase',
    'action',
    'visual',
    'tactile',
    'symptom',
    'likely_cause',
    'prevention',
    'fix',
    'group_name',
    'preparation',
    'ingredient',
    'tags',
    'flags',
    'not_suitable_for',
    'cultural_context',
    'chef_notes',
    'alternative',
  ]);
  return allowed.has(lower);
}

function looksLikeIdentifier(value: string): boolean {
  return /^[a-f0-9-]{32,}$/i.test(value) || /^[A-Z0-9_]{2,}$/.test(value);
}

async function translateJsonValue(value: unknown, parentKey?: string): Promise<unknown> {
  if (typeof value === 'string') {
    if (!value.trim()) return value;
    if (looksLikeIdentifier(value)) return value;
    if (parentKey && shouldTranslateKey(parentKey)) {
      return translateText(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await translateJsonValue(item, parentKey));
    }
    return out;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    out[key] = await translateJsonValue(inner, key);
  }
  return out;
}

async function getHouseholdFilter(): Promise<{ householdId?: string }> {
  if (!TRANSLATE_HOUSEHOLD_NAME || TRANSLATE_HOUSEHOLD_NAME === '*') {
    return {};
  }
  const household = await prisma.household.findFirst({
    where: { name: TRANSLATE_HOUSEHOLD_NAME },
    orderBy: { createdAt: 'asc' },
  });
  if (!household) {
    throw new Error(`Household "${TRANSLATE_HOUSEHOLD_NAME}" not found.`);
  }
  return { householdId: household.id };
}

async function main() {
  ensureEnv();
  const householdFilter = await getHouseholdFilter();
  const recipes = await prisma.recipe.findMany({
    where: householdFilter.householdId ? { householdId: householdFilter.householdId } : undefined,
    select: {
      id: true,
      title: true,
      description: true,
      sourceCategory: true,
      sourceCuisine: true,
      sourceTags: true,
      sourceMeta: true,
      sourceDietary: true,
      sourceStorage: true,
      sourceEquipment: true,
      sourceInstructions: true,
      sourceTroubleshooting: true,
      sourceChefNotes: true,
      sourceCulturalContext: true,
      ingredients: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: TRANSLATE_RECIPE_LIMIT > 0 ? TRANSLATE_RECIPE_LIMIT : undefined,
  });

  let recipeRowsUpdated = 0;
  let ingredientRowsUpdated = 0;

  for (const recipe of recipes) {
    const translatedTitle = await translateText(recipe.title);
    const translatedDescription = recipe.description ? await translateText(recipe.description) : null;
    const translatedSourceCategory = recipe.sourceCategory
      ? await translateText(recipe.sourceCategory)
      : null;
    const translatedSourceCuisine = recipe.sourceCuisine ? await translateText(recipe.sourceCuisine) : null;
    const translatedSourceTags = recipe.sourceTags?.length
      ? await Promise.all(recipe.sourceTags.map((tag) => translateText(tag)))
      : [];
    const translatedSourceMeta = TRANSLATE_SOURCE_DETAIL_FIELDS
      ? await translateJsonValue(recipe.sourceMeta)
      : recipe.sourceMeta;
    const translatedSourceDietary = TRANSLATE_SOURCE_DETAIL_FIELDS
      ? await translateJsonValue(recipe.sourceDietary)
      : recipe.sourceDietary;
    const translatedSourceStorage = TRANSLATE_SOURCE_DETAIL_FIELDS
      ? await translateJsonValue(recipe.sourceStorage)
      : recipe.sourceStorage;
    const translatedSourceEquipment = TRANSLATE_SOURCE_DETAIL_FIELDS
      ? await translateJsonValue(recipe.sourceEquipment)
      : recipe.sourceEquipment;
    const translatedSourceInstructions = TRANSLATE_SOURCE_DETAIL_FIELDS
      ? await translateJsonValue(recipe.sourceInstructions)
      : recipe.sourceInstructions;
    const translatedSourceTroubleshooting = TRANSLATE_SOURCE_DETAIL_FIELDS
      ? await translateJsonValue(recipe.sourceTroubleshooting)
      : recipe.sourceTroubleshooting;
    const translatedSourceChefNotes = TRANSLATE_SOURCE_DETAIL_FIELDS
      ? await translateJsonValue(recipe.sourceChefNotes)
      : recipe.sourceChefNotes;
    const translatedSourceCulturalContext = recipe.sourceCulturalContext
      ? await translateText(recipe.sourceCulturalContext)
      : null;

    if (
      translatedTitle !== recipe.title ||
      translatedDescription !== recipe.description ||
      translatedSourceCategory !== recipe.sourceCategory ||
      translatedSourceCuisine !== recipe.sourceCuisine ||
      JSON.stringify(translatedSourceTags) !== JSON.stringify(recipe.sourceTags) ||
      JSON.stringify(translatedSourceMeta) !== JSON.stringify(recipe.sourceMeta) ||
      JSON.stringify(translatedSourceDietary) !== JSON.stringify(recipe.sourceDietary) ||
      JSON.stringify(translatedSourceStorage) !== JSON.stringify(recipe.sourceStorage) ||
      JSON.stringify(translatedSourceEquipment) !== JSON.stringify(recipe.sourceEquipment) ||
      JSON.stringify(translatedSourceInstructions) !== JSON.stringify(recipe.sourceInstructions) ||
      JSON.stringify(translatedSourceTroubleshooting) !== JSON.stringify(recipe.sourceTroubleshooting) ||
      JSON.stringify(translatedSourceChefNotes) !== JSON.stringify(recipe.sourceChefNotes) ||
      translatedSourceCulturalContext !== recipe.sourceCulturalContext
    ) {
      await prisma.recipe.update({
        where: { id: recipe.id },
        data: {
          title: translatedTitle.slice(0, 120),
          description: translatedDescription ? translatedDescription.slice(0, 2000) : null,
          sourceCategory: translatedSourceCategory ? translatedSourceCategory.slice(0, 120) : null,
          sourceCuisine: translatedSourceCuisine ? translatedSourceCuisine.slice(0, 120) : null,
          sourceTags: translatedSourceTags,
          sourceMeta: toJson(translatedSourceMeta) ?? Prisma.DbNull,
          sourceDietary: toJson(translatedSourceDietary) ?? Prisma.DbNull,
          sourceStorage: toJson(translatedSourceStorage) ?? Prisma.DbNull,
          sourceEquipment: toJson(translatedSourceEquipment) ?? Prisma.DbNull,
          sourceInstructions: toJson(translatedSourceInstructions) ?? Prisma.DbNull,
          sourceTroubleshooting: toJson(translatedSourceTroubleshooting) ?? Prisma.DbNull,
          sourceChefNotes: toJson(translatedSourceChefNotes) ?? Prisma.DbNull,
          sourceCulturalContext: translatedSourceCulturalContext
            ? translatedSourceCulturalContext.slice(0, 8000)
            : null,
        },
      });
      recipeRowsUpdated += 1;
    }

    for (const ingredient of recipe.ingredients) {
      const translatedName = await translateText(ingredient.name);
      if (translatedName !== ingredient.name) {
        await prisma.recipeIngredient.update({
          where: { id: ingredient.id },
          data: {
            name: translatedName.slice(0, 120),
          },
        });
        ingredientRowsUpdated += 1;
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `Processed ${recipes.length} recipes. Updated recipes: ${recipeRowsUpdated}. Updated ingredients: ${ingredientRowsUpdated}.`,
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Recipe translation failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
