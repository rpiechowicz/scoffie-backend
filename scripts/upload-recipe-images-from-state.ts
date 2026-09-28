/**
 * Wgrywa do R2 zdjęcia, które `recraft-recipe-images.ts` zrobiło z `--no-upload`
 * (partia katalogu 1000, 28.09.2026: najpierw przegląd na oko, potem publikacja).
 *
 *   pnpm exec tsx scripts/upload-recipe-images-from-state.ts [--dry-run]
 *
 * Dla każdego przepisu ze stanem `ok` bierze `tmp/recipe-images/final/<id>.webp`
 * i wgrywa go pod `state.key`. Klucz niesie skrót TREŚCI pliku, a pliki mają
 * `Cache-Control: immutable` — dlatego przed wysłaniem sprawdzamy, że skrót
 * pliku zgadza się z kluczem (podmieniony po generacji plik pod starym
 * kluczem zostałby w telefonach i w Cloudflare na rok). Rozjazd = stop, nic
 * nie idzie. Plik, który już leży w R2 z tym samym rozmiarem, jest pomijany,
 * więc przerwany przebieg można puścić jeszcze raz.
 *
 * Potem `apply-recipe-images.ts` wpisuje adresy do katalogu.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { loadState, WORK_DIR } from './recraft-recipe-images';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function existingSize(
  r2: S3Client,
  bucket: string,
  key: string,
): Promise<number | null> {
  try {
    const head = await r2.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return head.ContentLength ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const state = loadState();
  const entries = Object.entries(state).filter(([, s]) => s.status === 'ok');

  // 1. Każdy plik: istnieje i ma skrót z klucza.
  const problems: string[] = [];
  const files = entries.map(([id, s]) => {
    const path = join(WORK_DIR, 'final', `${id}.webp`);
    if (!s.key) problems.push(`${id}: brak klucza w stanie`);
    if (!existsSync(path)) {
      problems.push(`${id}: brak pliku ${path}`);
      return { id, key: s.key ?? '', body: Buffer.alloc(0) };
    }
    const body = readFileSync(path);
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
    if (!s.key?.endsWith(`${id}-${hash}.webp`)) {
      problems.push(`${id}: skrót pliku ${hash} ≠ klucz ${s.key}`);
    }
    return { id, key: s.key!, body };
  });
  if (problems.length) {
    console.error(problems.join('\n'));
    throw new Error(
      `${problems.length} rozjazdów plik ↔ stan — nic nie wysłano`,
    );
  }
  console.log(`[upload] ${files.length} plików zgodnych ze stanem`);
  if (dryRun) return;

  const r2 = new S3Client({
    region: process.env.R2_REGION?.trim() || 'auto',
    endpoint:
      process.env.R2_ENDPOINT?.trim() ||
      `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env('R2_ACCESS_KEY_ID'),
      secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    },
  });
  const bucket = env('R2_BUCKET');

  // 2. Wysyłka po 6 naraz, pomijając to, co już leży.
  let sent = 0;
  let skipped = 0;
  const queue = [...files];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      if ((await existingSize(r2, bucket, f.key)) === f.body.length) {
        skipped += 1;
        continue;
      }
      await r2.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: f.key,
          Body: f.body,
          ContentType: 'image/webp',
          CacheControl: CACHE_CONTROL,
        }),
      );
      sent += 1;
      if (sent % 50 === 0) console.log(`[upload] wysłano ${sent}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`[upload] gotowe: wysłano ${sent}, już było ${skipped}`);
}

main().catch((error) => {
  console.error('[upload] failed:', error);
  process.exit(1);
});
