/**
 * Zdjęcia przepisów z Recrafta: generowanie → kontrola → wyśrodkowanie → WebP 100 → R2.
 *
 *   pnpm exec tsx scripts/recraft-recipe-images.ts --ids <id,id,…>
 *   pnpm exec tsx scripts/recraft-recipe-images.ts --all [--concurrency 3]
 *   pnpm exec tsx scripts/recraft-recipe-images.ts --use-raw <id>=<plik>,…
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
  /** Spłaszczenie elipsy brzegu (b/a) — miara kąta kamery. */
  angleRatio?: number;
  /** Żadna próba nie trafiła w kąt; wzięta najwyższa — do przeglądu. */
  angleWeak?: boolean;
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
    /** `id=plik,…` — zatwierdzone zdjęcia: tylko centrowanie i wgranie. */
    useRaw: get('--use-raw')?.split(',').map((s) => s.trim()).filter(Boolean),
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

/**
 * Kąt z promptu model traktuje jak wskazówkę (±10°), a to on najbardziej
 * decyduje o wyglądzie katalogu. Mierzymy go spłaszczeniem elipsy brzegu
 * (k = b/a): zatwierdzony gulasz „55°” ma k ≈ 0,65, burger wybrany przez
 * Rafała 0,5 (wysokie danie zasłania tylny brzeg, więc mierzy się niżej).
 * Poniżej progu — kolejna próba; gdy żadna nie trafi, bierzemy najwyższą
 * i znaczymy `angleWeak` do przeglądu na arkuszach.
 */
const MIN_ANGLE_RATIO = 0.55;
/** Pomiar kąta tylko przy przyzwoicie pewnej elipsie; niżej to szum. */
const MIN_COVERAGE_FOR_ANGLE = 0.5;
const MAX_ATTEMPTS = 4;

type Evaluation = {
  plate: PlateEllipse;
  detection: 'rim' | 'cutout';
  problems: string[];
  framingOk: boolean;
  angleRatio: number | null;
  angleOk: boolean;
};

async function evaluate(raw: Buffer): Promise<Evaluation> {
  const rim = await detectPlate(raw);
  const angleRatio = rim.coverage >= MIN_COVERAGE_FOR_ANGLE ? rim.k : null;
  let plate = rim;
  let detection: Evaluation['detection'] = 'rim';
  let verdict = judgePlate(rim, planCentering(rim));
  if (!verdict.ok) {
    // Brzeg zawiódł (kubek, gruba deska) — druga opinia z wyciętego tła.
    const cutout = await recraftRemoveBackground(raw);
    const fromCutout = await detectFromCutout(cutout, rim.width, rim.height);
    const second = judgePlate(fromCutout, planCentering(fromCutout));
    if (second.ok) {
      plate = fromCutout;
      detection = 'cutout';
      verdict = second;
    } else {
      verdict = {
        ok: false,
        problems: [...verdict.problems, ...second.problems.map((p) => `wycięcie: ${p}`)],
      };
    }
  }
  const angleOk = angleRatio === null || angleRatio >= MIN_ANGLE_RATIO;
  const problems = [...verdict.problems];
  if (!angleOk) problems.push(`kąt za niski (k=${angleRatio?.toFixed(2)})`);
  return { plate, detection, problems, framingOk: verdict.ok, angleRatio, angleOk };
}

async function finish(
  entry: DishEntry,
  r2: S3Client | null,
  prompt: string,
  attempts: ImageState['attempts'],
  raw: Buffer,
  seed: number,
  ev: Evaluation,
): Promise<ImageState> {
  const { webp, plan } = await centerOnPlate(raw, ev.plate);
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
  const { cx, cy, a, b, k, coverage } = ev.plate;
  return {
    status: 'ok',
    prompt,
    attempts,
    seed,
    key,
    url: `${env('R2_PUBLIC_BASE_URL').replace(/\/+$/, '')}/${key}`,
    bytes: webp.length,
    plate: { cx, cy, a, b, k, coverage },
    upscale: plan.upscale,
    detection: ev.detection,
    angleRatio: ev.angleRatio ?? undefined,
    angleWeak: !ev.angleOk || undefined,
    finishedAt: new Date().toISOString(),
  };
}

async function processRecipe(
  entry: DishEntry,
  r2: S3Client | null,
  approvedRaw?: Buffer,
): Promise<ImageState> {
  const prompt = buildRecipeImagePrompt(entry.dish, entry.vessel);
  const attempts: ImageState['attempts'] = [];

  // Zdjęcie wybrane przez Rafała z prób — tylko centrowanie, bez losowania od nowa
  // (Recraft NIE odtwarza obrazka z tego samego ziarna).
  if (approvedRaw) {
    const ev = await evaluate(approvedRaw);
    attempts.push({ seed: -1, problems: ev.problems });
    return finish(entry, r2, prompt, attempts, approvedRaw, -1, { ...ev, angleOk: true });
  }

  let best: { raw: Buffer; seed: number; ev: Evaluation } | null = null;
  for (const seed of SEEDS.slice(0, MAX_ATTEMPTS)) {
    const raw = await recraftGenerate(prompt, seed);
    writeFileSync(join(WORK_DIR, 'raw', `${entry.id}-${seed}.webp`), raw);
    const ev = await evaluate(raw);
    attempts.push({ seed, problems: ev.problems });
    if (!ev.framingOk) continue;
    if (ev.angleOk) return finish(entry, r2, prompt, attempts, raw, seed, ev);
    if (!best || (ev.angleRatio ?? 0) > (best.ev.angleRatio ?? 0)) best = { raw, seed, ev };
  }
  if (best) return finish(entry, r2, prompt, attempts, best.raw, best.seed, best.ev);
  return { status: 'failed', prompt, attempts, finishedAt: new Date().toISOString() };
}

/** Brak środków na koncie Recrafta: stop całego przebiegu, bez oznaczania przepisów jako nieudanych. */
const OUT_OF_CREDITS = /\b402\b|credit|insufficient|balance|payment|quota/i;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dishes = loadDishes();
  const state = loadState();
  for (const dir of ['raw', 'final']) mkdirSync(join(WORK_DIR, dir), { recursive: true });

  const approved = new Map(
    (args.useRaw ?? []).map((pair) => {
      const [id, file] = pair.split('=');
      return [id, readFileSync(file)] as const;
    }),
  );
  const wanted = args.all ? [...dishes.keys()] : (args.ids ?? [...approved.keys()]);
  if (wanted.length === 0) throw new Error('Podaj --ids <id,…>, --use-raw <id=plik,…> albo --all');
  const missing = wanted.filter((id) => !dishes.has(id));
  if (missing.length) throw new Error(`Brak opisu dania dla: ${missing.join(', ')}`);
  const queue = wanted.filter(
    (id) => approved.has(id) || args.force || state[id]?.status !== 'ok',
  );
  const r2 = args.noUpload ? null : createR2();

  console.log(
    `[recipe-images] do zrobienia ${queue.length} z ${wanted.length} (gotowe pomijam), równolegle ${args.concurrency}`,
  );
  let done = 0;
  let stopReason: string | null = null;
  const worker = async () => {
    for (let id = queue.shift(); id && !stopReason; id = queue.shift()) {
      const entry = dishes.get(id)!;
      let result: ImageState;
      try {
        result = await processRecipe(entry, r2, approved.get(id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (OUT_OF_CREDITS.test(message)) {
          stopReason = message;
          console.error(`[recipe-images] STOP — Recraft odmawia (środki?): ${message}`);
          return;
        }
        result = {
          status: 'failed',
          prompt: buildRecipeImagePrompt(entry.dish, entry.vessel),
          attempts: [],
          error: message,
          finishedAt: new Date().toISOString(),
        };
      }
      state[id] = result;
      // Zapis po każdym przepisie: przerwanie w połowie nie gubi zapłaconej pracy.
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
      done += 1;
      const tries = result.attempts.length;
      console.log(
        `[recipe-images] ${done}/${queue.length + done} ${id} ${result.status}` +
          (result.status === 'ok'
            ? ` (próba ${tries}, k=${result.angleRatio?.toFixed(2) ?? '—'}${result.angleWeak ? ' KĄT SŁABY' : ''}, ${Math.round((result.bytes ?? 0) / 1024)} KB)`
            : ` ${result.error ?? result.attempts.map((a) => a.problems.join('; ')).join(' | ')}`),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));

  const all = wanted.map((id) => state[id]);
  const ok = all.filter((s) => s?.status === 'ok');
  const weak = ok.filter((s) => s.angleWeak).length;
  const generations = all.reduce((n, s) => n + (s?.attempts.filter((a) => a.seed >= 0).length ?? 0), 0);
  console.log(
    `[recipe-images] gotowe ${ok.length}/${wanted.length} (słaby kąt ${weak}), nieudane ${wanted.length - ok.length}, generacji ${generations}` +
      (stopReason ? ` — PRZERWANE: ${stopReason}` : ''),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[recipe-images] failed:', error);
    process.exit(1);
  });
}
