/**
 * Zdjęcia przepisów z Recrafta: generowanie → kontrola → wyśrodkowanie → WebP 100 → R2.
 *
 *   pnpm exec tsx scripts/generate-recipe-images.ts --ids <id,id,…>
 *   pnpm exec tsx scripts/generate-recipe-images.ts --all [--concurrency 3]
 *
 * Opis dania i naczynie: `prisma/catalog/recipe-image-dishes.json`; szablon:
 * `scripts/lib/recipe-images/prompt.ts`. Stan każdego przepisu ląduje w
 * `tmp/recipe-images/state.json` po KAŻDYM przepisie — przerwany przebieg
 * wznawia się od miejsca awarii, a gotowych nie robi drugi raz (chyba że
 * `--force`). Odrzucone przez kontrolę próby idą od nowa z kolejnym ziarnem.
 *
 * Klucz w R2 to `recipe-images/<id>-<skrót treści>.webp`: pliki mają
 * `Cache-Control: immutable` na rok, więc nowe zdjęcie MUSI dostać nowy
 * adres — podmiana pod starym zostałaby w telefonach i w Cloudflare.
 *
 * Skrypt NIE zmienia katalogu ani bazy — to robi `apply-recipe-images.ts`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  buildRecipeImagePrompt,
  RECIPE_IMAGE_VESSELS,
  type RecipeImageVessel,
} from './lib/recipe-images/prompt';
import {
  recraftCrispUpscale,
  recraftRemoveBackground,
  recraftGenerate,
} from './lib/recipe-images/recraft-client';
import {
  detectFromCutout,
  detectPlate,
  judgePlate,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  planCentering,
  type PlateEllipse,
} from './lib/recipe-images/plate-detect';

const DISHES_FILE = 'prisma/catalog/recipe-image-dishes.json';
export const WORK_DIR = 'tmp/recipe-images';
export const STATE_FILE = join(WORK_DIR, 'state.json');
/** Ziarno 99 dało zatwierdzony wariant „A”; kolejne to zapas na poprawki. */
const SEEDS = [99, 4242, 777, 1234, 2024, 31337];
/** Powyżej tego powiększenia wycięte okno idzie przez crispUpscale (ostrość). */
const CRISP_UPSCALE_ABOVE = 1.03;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export type DishEntry = { id: string; vessel: RecipeImageVessel; dish: string };

export type ImageState = {
  status: 'ok' | 'failed';
  prompt: string;
  attempts: Array<{ seed: number; problems: string[] }>;
  seed?: number;
  key?: string;
  url?: string;
  bytes?: number;
  plate?: Pick<PlateEllipse, 'cx' | 'cy' | 'a' | 'b' | 'k' | 'coverage'>;
  upscale?: number;
  detection?: 'rim' | 'cutout';
  error?: string;
  finishedAt: string;
};

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    ids: get('--ids')?.split(',').map((s) => s.trim()).filter(Boolean),
    all: argv.includes('--all'),
    force: argv.includes('--force'),
    noUpload: argv.includes('--no-upload'),
    concurrency: Number(get('--concurrency') ?? 3),
  };
}

export function loadState(): Record<string, ImageState> {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, ImageState>;
}

function loadDishes(): Map<string, DishEntry> {
  const entries = JSON.parse(readFileSync(DISHES_FILE, 'utf8')) as DishEntry[];
  for (const e of entries) {
    if (!RECIPE_IMAGE_VESSELS.includes(e.vessel)) {
      throw new Error(`${e.id}: nieznane naczynie "${e.vessel}"`);
    }
  }
  return new Map(entries.map((e) => [e.id, e]));
}

function createR2(): S3Client {
  return new S3Client({
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
}

async function centerOnPlate(raw: Buffer, plate: PlateEllipse) {
  const plan = planCentering(plate);
  let source = raw;
  let factor = 1;
  if (plan.upscale > CRISP_UPSCALE_ABOVE) {
    source = await recraftCrispUpscale(raw);
    factor = ((await sharp(source).metadata()).width ?? plate.width) / plate.width;
  }
  const webp = await sharp(source)
    .extract({
      left: Math.round(plan.left * factor),
      top: Math.round(plan.top * factor),
      width: Math.floor(plan.width * factor),
      height: Math.floor(plan.height * factor),
    })
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { kernel: 'lanczos3' })
    .webp({ quality: 100, effort: 6, smartSubsample: true })
    .toBuffer();
  return { webp, plan };
}

async function processRecipe(
  entry: DishEntry,
  r2: S3Client | null,
): Promise<ImageState> {
  const prompt = buildRecipeImagePrompt(entry.dish, entry.vessel);
  const attempts: ImageState['attempts'] = [];
  for (const seed of SEEDS) {
    const raw = await recraftGenerate(prompt, seed);
    writeFileSync(join(WORK_DIR, 'raw', `${entry.id}-${seed}.webp`), raw);
    let plate = await detectPlate(raw);
    let verdict = judgePlate(plate, planCentering(plate));
    let detection: 'rim' | 'cutout' = 'rim';
    if (!verdict.ok) {
      // Brzeg zawiódł (kubek, gruba deska) — druga opinia z wyciętego tła.
      const cutout = await recraftRemoveBackground(raw);
      const fromCutout = await detectFromCutout(cutout, plate.width, plate.height);
      const second = judgePlate(fromCutout, planCentering(fromCutout));
      if (second.ok) {
        plate = fromCutout;
        verdict = second;
        detection = 'cutout';
      } else {
        verdict = { ok: false, problems: [...verdict.problems, ...second.problems.map((p) => `wycięcie: ${p}`)] };
      }
    }
    attempts.push({ seed, problems: verdict.problems });
    if (!verdict.ok) continue;

    const { webp, plan } = await centerOnPlate(raw, plate);
    writeFileSync(join(WORK_DIR, 'final', `${entry.id}.webp`), webp);
    const hash = createHash('sha256').update(webp).digest('hex').slice(0, 10);
    const prefix = (process.env.R2_KEY_PREFIX?.trim() || 'recipe-images').replace(/^\/+|\/+$/g, '');
    const key = `${prefix}/${entry.id}-${hash}.webp`;
    if (r2) {
      await r2.send(
        new PutObjectCommand({
          Bucket: env('R2_BUCKET'),
          Key: key,
          Body: webp,
          ContentType: 'image/webp',
          CacheControl: CACHE_CONTROL,
        }),
      );
    }
    return {
      status: 'ok',
      prompt,
      attempts,
      seed,
      key,
      url: `${env('R2_PUBLIC_BASE_URL').replace(/\/+$/, '')}/${key}`,
      bytes: webp.length,
      plate: {
        cx: plate.cx,
        cy: plate.cy,
        a: plate.a,
        b: plate.b,
        k: plate.k,
        coverage: plate.coverage,
      },
      upscale: plan.upscale,
      detection,
      finishedAt: new Date().toISOString(),
    };
  }
  return { status: 'failed', prompt, attempts, finishedAt: new Date().toISOString() };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dishes = loadDishes();
  const state = loadState();
  for (const dir of ['raw', 'final']) mkdirSync(join(WORK_DIR, dir), { recursive: true });

  const wanted = args.all ? [...dishes.keys()] : (args.ids ?? []);
  if (wanted.length === 0) throw new Error('Podaj --ids <id,…> albo --all');
  const missing = wanted.filter((id) => !dishes.has(id));
  if (missing.length) throw new Error(`Brak opisu dania dla: ${missing.join(', ')}`);
  const queue = wanted.filter((id) => args.force || state[id]?.status !== 'ok');
  const r2 = args.noUpload ? null : createR2();

  console.log(
    `[recipe-images] do zrobienia ${queue.length} z ${wanted.length} (gotowe pomijam), równolegle ${args.concurrency}`,
  );
  let done = 0;
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const entry = dishes.get(id)!;
      let result: ImageState;
      try {
        result = await processRecipe(entry, r2);
      } catch (error) {
        result = {
          status: 'failed',
          prompt: buildRecipeImagePrompt(entry.dish, entry.vessel),
          attempts: [],
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date().toISOString(),
        };
      }
      state[id] = result;
      // Zapis po każdym przepisie: przerwanie w połowie nie gubi zapłaconej pracy.
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
      done += 1;
      const tries = result.attempts.length;
      console.log(
        `[recipe-images] ${done}/${wanted.length} ${id} ${result.status}` +
          (result.status === 'ok'
            ? ` (próba ${tries}, ${Math.round((result.bytes ?? 0) / 1024)} KB, x${result.upscale?.toFixed(2)})`
            : ` ${result.error ?? result.attempts.map((a) => a.problems.join('; ')).join(' | ')}`),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));

  const all = wanted.map((id) => state[id]);
  const ok = all.filter((s) => s?.status === 'ok');
  const generations = all.reduce((n, s) => n + (s?.attempts.length ?? 0), 0);
  console.log(
    `[recipe-images] gotowe ${ok.length}/${wanted.length}, nieudane ${wanted.length - ok.length}, generacji ${generations}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[recipe-images] failed:', error);
    process.exit(1);
  });
}
