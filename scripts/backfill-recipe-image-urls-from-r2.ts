import { PrismaClient } from '@prisma/client';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

const prisma = new PrismaClient();

function env(name: string): string {
  const value = process.env[name];
  if (value && value.trim()) return value.trim();
  return '';
}

const IMAGE_HOUSEHOLD_NAME = process.env.IMAGE_HOUSEHOLD_NAME ?? '';

const R2_REGION = env('R2_REGION') || 'auto';
const R2_BUCKET = env('R2_BUCKET');
const R2_ACCESS_KEY_ID = env('R2_ACCESS_KEY_ID');
const R2_SECRET_ACCESS_KEY = env('R2_SECRET_ACCESS_KEY');
const R2_ACCOUNT_ID = env('R2_ACCOUNT_ID');
const R2_ENDPOINT = env('R2_ENDPOINT');
const R2_PUBLIC_BASE_URL = env('R2_PUBLIC_BASE_URL');
const R2_KEY_PREFIX = (env('R2_KEY_PREFIX') || 'recipe-images').replace(/^\/+|\/+$/g, '');

const R2_SYNC_OVERWRITE_EXISTING = env('R2_SYNC_OVERWRITE_EXISTING').toLowerCase() === 'true';
const R2_SYNC_EXTENSIONS = (env('R2_SYNC_EXTENSIONS') || 'png,jpg,jpeg,webp')
  .split(',')
  .map((part) => part.trim().toLowerCase())
  .filter(Boolean);

function resolvedEndpoint(): string {
  if (R2_ENDPOINT) return R2_ENDPOINT;
  if (!R2_ACCOUNT_ID) {
    throw new Error('Missing R2_ENDPOINT or R2_ACCOUNT_ID');
  }
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function ensureEnv(): void {
  if (!R2_BUCKET) throw new Error('Missing R2_BUCKET');
  if (!R2_ACCESS_KEY_ID) throw new Error('Missing R2_ACCESS_KEY_ID');
  if (!R2_SECRET_ACCESS_KEY) throw new Error('Missing R2_SECRET_ACCESS_KEY');
  if (!R2_PUBLIC_BASE_URL) throw new Error('Missing R2_PUBLIC_BASE_URL');
}

function createR2Client(): S3Client {
  return new S3Client({
    region: R2_REGION,
    endpoint: resolvedEndpoint(),
    forcePathStyle: true,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

function buildPublicUrl(key: string): string {
  const encodedKey = key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${R2_PUBLIC_BASE_URL.replace(/\/+$/g, '')}/${encodedKey}`;
}

async function objectExists(r2: S3Client, key: string): Promise<boolean> {
  try {
    await r2.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      }),
    );
    return true;
  } catch (error) {
    const maybe = error as { $metadata?: { httpStatusCode?: number }; name?: string };
    const statusCode = maybe.$metadata?.httpStatusCode;
    if (statusCode === 404 || maybe.name === 'NotFound') return false;
    throw error;
  }
}

async function resolveHouseholdIds() {
  const allHouseholds = await prisma.household.findMany({
    select: { id: true, name: true },
  });

  if (!IMAGE_HOUSEHOLD_NAME.trim()) {
    return allHouseholds;
  }

  const household = await prisma.household.findFirst({
    where: { name: IMAGE_HOUSEHOLD_NAME },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  if (household) return [household];

  console.log(
    `[r2-image-backfill] Household "${IMAGE_HOUSEHOLD_NAME}" not found. Falling back to all households.`,
  );
  return allHouseholds;
}

async function main() {
  ensureEnv();
  const r2 = createR2Client();
  const households = await resolveHouseholdIds();

  if (households.length === 0) {
    console.log(
      `[r2-image-backfill] No household found for IMAGE_HOUSEHOLD_NAME="${IMAGE_HOUSEHOLD_NAME}".`,
    );
    return;
  }

  const householdIds = households.map((item) => item.id);
  const recipes = await prisma.recipe.findMany({
    where: {
      householdId: { in: householdIds },
      ...(R2_SYNC_OVERWRITE_EXISTING ? {} : { OR: [{ imageUrl: null }, { imageUrl: '' }] }),
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  let updated = 0;
  let skippedNoObject = 0;

  for (const recipe of recipes) {
    let foundKey: string | null = null;
    for (const ext of R2_SYNC_EXTENSIONS) {
      const key = `${R2_KEY_PREFIX}/${recipe.id}.${ext}`;
      // eslint-disable-next-line no-await-in-loop
      const exists = await objectExists(r2, key);
      if (exists) {
        foundKey = key;
        break;
      }
    }

    if (!foundKey) {
      skippedNoObject += 1;
      continue;
    }

    await prisma.recipe.update({
      where: { id: recipe.id },
      data: { imageUrl: buildPublicUrl(foundKey) },
    });
    updated += 1;
  }

  console.log(
    `[r2-image-backfill] households=${households.length} scanned=${recipes.length} updated=${updated} missingObject=${skippedNoObject}`,
  );
}

main()
  .catch((error) => {
    console.error('[r2-image-backfill] failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
