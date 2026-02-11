import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const IMAGE_HOUSEHOLD_NAME = process.env.IMAGE_HOUSEHOLD_NAME ?? 'Home';
const S3_REGION = process.env.S3_REGION ?? '';
const S3_BUCKET = process.env.S3_BUCKET ?? '';
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? '';
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? '';
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? '';
const S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL ?? '';
const S3_KEY_PREFIX = (process.env.S3_KEY_PREFIX ?? 'recipe-images').replace(/^\/+|\/+$/g, '');
const S3_OVERWRITE_EXISTING = process.env.S3_OVERWRITE_EXISTING === 'true';

function ensureEnv() {
  if (!S3_REGION) throw new Error('Missing S3_REGION');
  if (!S3_BUCKET) throw new Error('Missing S3_BUCKET');
  if (!S3_ACCESS_KEY_ID) throw new Error('Missing S3_ACCESS_KEY_ID');
  if (!S3_SECRET_ACCESS_KEY) throw new Error('Missing S3_SECRET_ACCESS_KEY');
}

function createS3Client() {
  return new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT || undefined,
    forcePathStyle: Boolean(S3_ENDPOINT),
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
  });
}

function buildPublicUrl(key: string): string {
  const encodedKey = key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  if (S3_PUBLIC_BASE_URL.trim()) {
    return `${S3_PUBLIC_BASE_URL.replace(/\/+$/g, '')}/${encodedKey}`;
  }

  if (S3_ENDPOINT.trim()) {
    return `${S3_ENDPOINT.replace(/\/+$/g, '')}/${S3_BUCKET}/${encodedKey}`;
  }

  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${encodedKey}`;
}

function inferContentType(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function extractImageFileName(recipeId: string, imageUrl: string | null): string | null {
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

async function main() {
  ensureEnv();
  const s3 = createS3Client();

  const household = await prisma.household.findFirst({
    where: { name: IMAGE_HOUSEHOLD_NAME },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  if (!household) throw new Error(`Household "${IMAGE_HOUSEHOLD_NAME}" not found.`);

  const recipes = await prisma.recipe.findMany({
    where: { householdId: household.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, imageUrl: true },
  });

  let uploaded = 0;
  let skipped = 0;

  for (const recipe of recipes) {
    if (!S3_OVERWRITE_EXISTING && recipe.imageUrl?.includes('amazonaws.com')) {
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

    const key = `${S3_KEY_PREFIX}/${recipe.id}${extname(fileName).toLowerCase() || '.png'}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
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

  // eslint-disable-next-line no-console
  console.log(
    `Uploaded ${uploaded} recipe images to S3 for household "${household.name}" (${household.id}). Skipped: ${skipped}.`,
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('S3 upload failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
