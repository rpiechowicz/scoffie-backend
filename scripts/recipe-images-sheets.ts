/**
 * Arkusze kontrolne gotowych zdjęć: po 16 na stronę, z prowadnicami przycięć,
 * jakie robi aplikacja — czerwony krzyż (środek), żółty kwadrat (miniatury),
 * niebieska ramka 0,84 (karta story), różowe koło (talerz w kalendarzu).
 *
 *   pnpm exec tsx scripts/recipe-images-sheets.ts
 *
 * Wynik: `tmp/recipe-images/sheets/sheet-NN.jpg` + `index.json` (numer → przepis).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadState, WORK_DIR } from './recraft-recipe-images';

const W = 384;
const H = 219;
const COLS = 4;
const PER_SHEET = 16;

function guides(label: string): Buffer {
  const cx = W / 2;
  const cy = H / 2;
  const portrait = Math.round(H * 0.84);
  return Buffer.from(
    `<svg width="${W}" height="${H}">` +
      `<line x1="${cx}" y1="0" x2="${cx}" y2="${H}" stroke="red"/>` +
      `<line x1="0" y1="${cy}" x2="${W}" y2="${cy}" stroke="red"/>` +
      `<rect x="${cx - H / 2}" y="0" width="${H}" height="${H}" fill="none" stroke="yellow" stroke-dasharray="4 3"/>` +
      `<rect x="${cx - portrait / 2}" y="0" width="${portrait}" height="${H}" fill="none" stroke="cyan" stroke-dasharray="2 4"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${H / 2}" fill="none" stroke="magenta" stroke-dasharray="3 3"/>` +
      `<rect width="40" height="18" fill="black"/><text x="3" y="14" font-size="13" fill="white" font-family="Arial">${label}</text>` +
      '</svg>',
  );
}

async function main() {
  const catalog = JSON.parse(
    readFileSync('prisma/catalog/recipes-catalog-full-v2.json', 'utf8'),
  ) as { recipes: Array<{ id: string; title: string }> };
  const titles = new Map(catalog.recipes.map((r) => [r.id, r.title]));
  const state = loadState();
  const ids = Object.keys(state).filter(
    (id) => state[id].status === 'ok' && existsSync(join(WORK_DIR, 'final', `${id}.webp`)),
  );
  const outDir = join(WORK_DIR, 'sheets');
  mkdirSync(outDir, { recursive: true });

  for (let s = 0; s * PER_SHEET < ids.length; s++) {
    const page = ids.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    const tiles = await Promise.all(
      page.map(async (id, i) => ({
        input: await sharp(join(WORK_DIR, 'final', `${id}.webp`))
          .resize(W, H)
          .composite([{ input: guides(String(s * PER_SHEET + i + 1)) }])
          .toBuffer(),
        left: (i % COLS) * W,
        top: Math.floor(i / COLS) * H,
      })),
    );
    await sharp({
      create: {
        width: W * COLS,
        height: H * Math.ceil(page.length / COLS),
        channels: 3,
        background: '#222',
      },
    })
      .composite(tiles)
      .jpeg({ quality: 82 })
      .toFile(join(outDir, `sheet-${String(s + 1).padStart(2, '0')}.jpg`));
  }
  writeFileSync(
    join(outDir, 'index.json'),
    JSON.stringify(
      ids.map((id, i) => ({ n: i + 1, id, title: titles.get(id), seed: state[id].seed })),
      null,
      1,
    ),
  );
  console.log(`[recipe-images-sheets] ${ids.length} zdjęć, ${Math.ceil(ids.length / PER_SHEET)} arkuszy w ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
