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

function ensureEnv() {
  if (!TRANSLATOR_API_KEY) throw new Error('Missing TRANSLATOR_API_KEY.');
  if (!TRANSLATOR_API_BASE_URL) throw new Error('Missing TRANSLATOR_API_BASE_URL.');
  if (!TRANSLATOR_AUTH_HEADER) throw new Error('Missing TRANSLATOR_AUTH_HEADER.');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const asDate = new Date(headerValue);
  const ms = asDate.getTime() - Date.now();
  if (Number.isFinite(ms) && ms > 0) return ms;
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
          `[translate-instructions] fallback to original text after ${attempt + 1} attempts (${response.status} ${response.statusText})`,
        );
        return cleaned;
      }
      throw new Error(`Translator request failed: ${response.status} ${response.statusText}`);
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const backoffMs = TRANSLATOR_BASE_DELAY_MS * (attempt + 1);
    await sleep(Math.max(backoffMs, retryAfterMs ?? 0));
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

function looksLikeIdentifier(value: string): boolean {
  return /^[a-f0-9-]{32,}$/i.test(value) || /^[A-Z0-9_]{2,}$/.test(value);
}

async function translateInstructions(value: unknown): Promise<unknown> {
  if (typeof value === 'string') {
    if (!value.trim() || looksLikeIdentifier(value)) return value;
    return translateText(value);
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await translateInstructions(item));
    }
    return out;
  }

  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    // We only need to translate user-facing step content and helper cues.
    if (
      ['text', 'instruction', 'phase', 'action', 'visual', 'tactile', 'notes', 'name'].includes(
        key.toLowerCase(),
      )
    ) {
      out[key] = await translateInstructions(inner);
      continue;
    }
    // Keep non-user-facing fields as-is.
    out[key] = inner;
  }
  return out;
}

async function getHouseholdFilter(): Promise<{ householdId?: string }> {
  if (!TRANSLATE_HOUSEHOLD_NAME || TRANSLATE_HOUSEHOLD_NAME === '*') return {};
  const household = await prisma.household.findFirst({
    where: { name: TRANSLATE_HOUSEHOLD_NAME },
    orderBy: { createdAt: 'asc' },
  });
  if (!household) throw new Error(`Household "${TRANSLATE_HOUSEHOLD_NAME}" not found.`);
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
      sourceInstructions: true,
    },
    orderBy: { createdAt: 'asc' },
    take: TRANSLATE_RECIPE_LIMIT > 0 ? TRANSLATE_RECIPE_LIMIT : undefined,
  });

  let updated = 0;
  for (const recipe of recipes) {
    if (!recipe.sourceInstructions) continue;
    const translated = await translateInstructions(recipe.sourceInstructions);
    if (JSON.stringify(translated) === JSON.stringify(recipe.sourceInstructions)) continue;

    await prisma.recipe.update({
      where: { id: recipe.id },
      data: {
        sourceInstructions: toJson(translated) ?? Prisma.DbNull,
      },
    });
    updated += 1;
    // eslint-disable-next-line no-console
    console.log(`[translate-instructions] updated: ${recipe.title}`);
  }

  // eslint-disable-next-line no-console
  console.log(`Processed ${recipes.length} recipes. Updated instructions in ${updated} recipes.`);
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Instruction translation failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
