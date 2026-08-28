import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function env(name: string): string {
  const value = process.env[name];
  if (value && value.trim()) return value.trim();
  return '';
}

const IMAGE_HOUSEHOLD_NAME = process.env.IMAGE_HOUSEHOLD_NAME ?? 'Home';

const R2_REGION = env('R2_REGION') || 'auto';
const R2_BUCKET = env('R2_BUCKET');
const R2_ACCESS_KEY_ID = env('R2_ACCESS_KEY_ID');
const R2_SECRET_ACCESS_KEY = env('R2_SECRET_ACCESS_KEY');
const R2_ACCOUNT_ID = env('R2_ACCOUNT_ID');
const R2_ENDPOINT = env('R2_ENDPOINT');
const R2_PUBLIC_BASE_URL = env('R2_PUBLIC_BASE_URL');
const R2_KEY_PREFIX = (env('R2_KEY_PREFIX') || 'recipe-images').replace(
  /^\/+|\/+$/g,
  '',
);
const R2_OVERWRITE_EXISTING =
  env('R2_OVERWRITE_EXISTING').toLowerCase() === 'true';

function resolvedEndpoint(): string {
  if (R2_ENDPOINT) return R2_ENDPOINT;
  if (!R2_ACCOUNT_ID) {
    throw new Error('Missing R2_ENDPOINT or R2_ACCOUNT_ID');
  }
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function ensureEnv() {
  if (!R2_BUCKET) throw new Error('Missing R2_BUCKET');
  if (!R2_ACCESS_KEY_ID) throw new Error('Missing R2_ACCESS_KEY_ID');
  if (!R2_SECRET_ACCESS_KEY) throw new Error('Missing R2_SECRET_ACCESS_KEY');
  if (!R2_PUBLIC_BASE_URL) {
    throw new Error(
      'Missing R2_PUBLIC_BASE_URL (public bucket/custom domain URL)',
    );
  }
}

function createR2Client() {
  return new S3Client({
    region: R2_REGION,
    endpoint: resolvedEndpoint(),
    // Required for most S3-compatible providers including R2.
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

function inferContentType(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function extractImageFileName(
  recipeId: string,
  imageUrl: string | null,
): string | null {
  if (!imageUrl || !imageUrl.trim()) return `${recipeId}.png`;

  const noQuery = imageUrl.split('?')[0];
  const marker = '/static/recipe-images/';
  const markerIndex = noQuery.indexOf(marker);
  if (markerIndex >= 0) {
    return noQuery.slice(markerIndex + marker.length);
  }

  const last = noQuery.split('/').filter(Boolean).pop();
  if (!last) return `${recipeId}.png`;
  return decodeURIComponent(last);
}

function isAlreadyOnR2Target(imageUrl: string | null): boolean {
  if (!imageUrl || !imageUrl.trim()) return false;
  const current = imageUrl.trim();
  const targetBase = R2_PUBLIC_BASE_URL.replace(/\/+$/g, '');
  return current.startsWith(`${targetBase}/`);
}

async function main() {
  ensureEnv();
  const r2 = createR2Client();

  const household = await prisma.household.findFirst({
    where: { name: IMAGE_HOUSEHOLD_NAME },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  if (!household)
    throw new Error(`Household "${IMAGE_HOUSEHOLD_NAME}" not found.`);

  const recipes = await prisma.recipe.findMany({
    where: { householdId: household.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, imageUrl: true },
  });

  let uploaded = 0;
  let skipped = 0;

  for (const recipe of recipes) {
    if (!R2_OVERWRITE_EXISTING && isAlreadyOnR2Target(recipe.imageUrl)) {
      skipped += 1;
      continue;
    }

    const fileName = extractImageFileName(recipe.id, recipe.imageUrl);
    if (!fileName) {
      skipped += 1;
      continue;
    }

    const localPath = join(process.cwd(), 'public', 'recipe-images', fileName);
    let file: Buffer;
    try {
      file = await readFile(localPath);
    } catch {
      skipped += 1;
      continue;
    }

    const key = `${R2_KEY_PREFIX}/${recipe.id}${extname(fileName).toLowerCase() || '.png'}`;
    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: file,
        ContentType: inferContentType(fileName),
      }),
    );

    await prisma.recipe.update({
      where: { id: recipe.id },
      data: { imageUrl: buildPublicUrl(key) },
    });
    uploaded += 1;
  }

  console.log(
    `Uploaded ${uploaded} recipe images to Cloudflare R2 for household "${household.name}" (${household.id}). Skipped: ${skipped}.`,
  );
}

main()
  .catch((error) => {
    console.error('Cloudflare R2 upload failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
