import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const IMAGE_GENERATOR_PROVIDER = (process.env.IMAGE_GENERATOR_PROVIDER ?? 'pollinations').toLowerCase();
const IMAGE_GENERATOR_BASE_URL =
  process.env.IMAGE_GENERATOR_BASE_URL ?? 'https://image.pollinations.ai/prompt';
const IMAGE_GENERATOR_QUERY = process.env.IMAGE_GENERATOR_QUERY ?? 'width=1200&height=800&nologo=true';
const IMAGE_GENERATOR_STYLE =
  process.env.IMAGE_GENERATOR_STYLE ??
  'ultra realistic food photography, natural light, 50mm lens, shallow depth of field';
const IMAGE_GENERATOR_SEED_PREFIX = process.env.IMAGE_GENERATOR_SEED_PREFIX ?? 'weekly-meals';
const IMAGE_HOUSEHOLD_NAME = process.env.IMAGE_HOUSEHOLD_NAME ?? 'Home';
const IMAGE_RECIPE_LIMIT = Number(process.env.IMAGE_RECIPE_LIMIT ?? '0') || 0;
const IMAGE_OVERWRITE_EXISTING = process.env.IMAGE_OVERWRITE_EXISTING === 'true';

function buildImageUrl(recipeId: string, title: string, description: string | null): string {
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

async function main() {
  const household = await prisma.household.findFirst({
    where: { name: IMAGE_HOUSEHOLD_NAME },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  if (!household) {
    throw new Error(`Household "${IMAGE_HOUSEHOLD_NAME}" not found.`);
  }

  const recipes = await prisma.recipe.findMany({
    where: {
      householdId: household.id,
      ...(IMAGE_OVERWRITE_EXISTING ? {} : { OR: [{ imageUrl: null }, { imageUrl: '' }] }),
    },
    orderBy: { createdAt: 'asc' },
    take: IMAGE_RECIPE_LIMIT > 0 ? IMAGE_RECIPE_LIMIT : undefined,
    select: {
      id: true,
      title: true,
      description: true,
      imageUrl: true,
    },
  });

  let updated = 0;
  for (const recipe of recipes) {
    const imageUrl = buildImageUrl(recipe.id, recipe.title, recipe.description);
    if (!imageUrl) continue;

    if (!IMAGE_OVERWRITE_EXISTING && recipe.imageUrl && recipe.imageUrl.trim()) {
      continue;
    }

    await prisma.recipe.update({
      where: { id: recipe.id },
      data: { imageUrl },
    });
    updated += 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    `Generated image URLs for ${updated} recipes in household "${household.name}" (${household.id}).`,
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Image URL generation failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
