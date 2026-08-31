import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
const IMAGE_HOUSEHOLD_NAME = (
  process.env.IMAGE_HOUSEHOLD_NAME ?? 'Home'
).trim();
const IMAGE_RECIPE_LIMIT = Number(process.env.IMAGE_RECIPE_LIMIT ?? '0') || 0;
const IMAGE_OVERWRITE_EXISTING =
  process.env.IMAGE_OVERWRITE_EXISTING === 'true';

function buildImageUrl(
  recipeId: string,
  title: string,
  description: string | null,
): string {
  const prompt = [
    'professional food photo',
    title,
    description ?? '',
    IMAGE_GENERATOR_STYLE,
    'no text, no watermark, plated dish, appetizing',
  ]
    .filter(Boolean)
    .join(', ');

  if (IMAGE_GENERATOR_PROVIDER === 'pollinations') {
    const encodedPrompt = encodeURIComponent(prompt);
    const query = IMAGE_GENERATOR_QUERY ? `&${IMAGE_GENERATOR_QUERY}` : '';
    const seed = `${IMAGE_GENERATOR_SEED_PREFIX}-${recipeId}`;
    return `${IMAGE_GENERATOR_BASE_URL}/${encodedPrompt}?seed=${encodeURIComponent(seed)}${query}`;
  }

  return '';
}

function extractImagePrompt(sourceMeta: unknown): string | null {
  if (
    !sourceMeta ||
    typeof sourceMeta !== 'object' ||
    Array.isArray(sourceMeta)
  ) {
    return null;
  }

  const prompt = (sourceMeta as Record<string, unknown>).imagePrompt;
  return typeof prompt === 'string' && prompt.trim().length > 0
    ? prompt.trim()
    : null;
}

async function main() {
  let householdId: string | undefined;
  let householdLabel = 'all households';

  if (IMAGE_HOUSEHOLD_NAME.length > 0) {
    const household = await prisma.household.findFirst({
      where: { name: IMAGE_HOUSEHOLD_NAME },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });

    if (household) {
      householdId = household.id;
      householdLabel = `"${household.name}" (${household.id})`;
    } else {
      console.warn(
        `[generate:recipe:images] Household "${IMAGE_HOUSEHOLD_NAME}" not found. Falling back to all households.`,
      );
    }
  }

  const recipes = await prisma.recipe.findMany({
    where: {
      ...(householdId ? { householdId } : {}),
      ...(IMAGE_OVERWRITE_EXISTING
        ? {}
        : { OR: [{ imageUrl: null }, { imageUrl: '' }] }),
    },
    orderBy: { createdAt: 'asc' },
    take: IMAGE_RECIPE_LIMIT > 0 ? IMAGE_RECIPE_LIMIT : undefined,
    select: {
      id: true,
      title: true,
      description: true,
      imageUrl: true,
      sourceMeta: true,
    },
  });

  let updated = 0;
  for (const recipe of recipes) {
    const promptOverride = extractImagePrompt(recipe.sourceMeta);
    const imageUrl = promptOverride
      ? buildImageUrl(recipe.id, promptOverride, null)
      : buildImageUrl(recipe.id, recipe.title, recipe.description);
    if (!imageUrl) continue;

    if (
      !IMAGE_OVERWRITE_EXISTING &&
      recipe.imageUrl &&
      recipe.imageUrl.trim()
    ) {
      continue;
    }

    await prisma.recipe.update({
      where: { id: recipe.id },
      data: { imageUrl },
    });
    updated += 1;
  }

  console.log(
    `Generated image URLs for ${updated} recipes in ${householdLabel}.`,
  );
}

main()
  .catch((error) => {
    console.error('Image URL generation failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
