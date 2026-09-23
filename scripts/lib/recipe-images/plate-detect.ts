/**
 * Gdzie na zdjęciu stoi naczynie — i przesunięcie kadru tak, żeby stało na środku.
 *
 * Aplikacja przycina KAŻDE zdjęcie od środka (hero ~1,8:1, karta story 0,84,
 * miniatury 1:1, koło w kalendarzu), więc danie przesunięte o kilka procent
 * wygląda w którymś widoku źle. Model nie trafia w środek sam (chybia o
 * 10–50 px), a `removeBackground` Recrafta bywa zawodne (potrafi wyciąć samo
 * jedzenie bez talerza) — dlatego szukamy brzegu naczynia lokalnie.
 *
 * Ujęcie pod kątem 40°: brzeg okrągłego naczynia to elipsa o poziomej osi.
 * Rozciągamy obraz w pionie o 1/k — elipsa o proporcji k staje się okręgiem —
 * i szukamy okręgu transformatą Hougha z kierunkiem gradientu. Wygrywa k
 * z najlepiej pokrytym obwodem.
 *
 * Kadr TYLKO przesuwamy (przycięcie o kilka procent), nigdy nie powiększamy
 * do docelowej wielkości talerza: detekcja potrafi złapać wewnętrzny brzeg
 * i wtedy „powiększony” talerz ląduje przy krawędzi. Wielkość trzyma prompt.
 */
import sharp from 'sharp';

export const OUTPUT_WIDTH = 1344;
export const OUTPUT_HEIGHT = 768;

export type PlateEllipse = {
  /** Środek i półosie w pikselach źródła. */
  cx: number;
  cy: number;
  a: number;
  b: number;
  /** Proporcja b/a, dla której okrąg wyszedł najlepiej. */
  k: number;
  /** Pokrycie obwodu krawędziami — miara pewności (dobre dopasowania ≥ ~0,9). */
  coverage: number;
  width: number;
  height: number;
};

const WORK_WIDTH = 384;
const RATIOS = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1.0];

type Ring = { x: number; y: number; r: number; coverage: number };

function houghRing(
  gray: Buffer,
  width: number,
  height: number,
  rMin: number,
  rMax: number,
): Ring {
  const size = width * height;
  const gx = new Float32Array(size);
  const gy = new Float32Array(size);
  const mag = new Float32Array(size);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = (dx: number, dy: number) => gray[(y + dy) * width + x + dx];
      const sx =
        -at(-1, -1) - 2 * at(-1, 0) - at(-1, 1) + at(1, -1) + 2 * at(1, 0) + at(1, 1);
      const sy =
        -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
      const i = y * width + x;
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.hypot(sx, sy);
    }
  }
  // Tylko najsilniejsze 12% krawędzi — faktura blatu i jedzenia to szum.
  const threshold = Float32Array.from(mag).sort()[Math.floor(size * 0.88)];

  const votes = new Float32Array(size);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mag[i] < threshold) continue;
      const ux = gx[i] / mag[i];
      const uy = gy[i] / mag[i];
      for (const sign of [1, -1]) {
        for (let r = rMin; r <= rMax; r++) {
          const cx = Math.round(x + sign * ux * r);
          const cy = Math.round(y + sign * uy * r);
          if (cx >= 0 && cy >= 0 && cx < width && cy < height) {
            votes[cy * width + cx] += 1;
          }
        }
      }
    }
  }

  let best = -1;
  let bx = 0;
  let by = 0;
  for (let y = 3; y < height - 3; y++) {
    for (let x = 3; x < width - 3; x++) {
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) sum += votes[(y + dy) * width + x + dx];
      }
      if (sum > best) {
        best = sum;
        bx = x;
        by = y;
      }
    }
  }

  // Promień: krawędzie skierowane promieniście od znalezionego środka.
  const hist = new Float32Array(rMax + 2);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mag[i] < threshold) continue;
      const dx = x - bx;
      const dy = y - by;
      const d = Math.hypot(dx, dy);
      if (d < rMin || d > rMax) continue;
      if (Math.abs((dx * gx[i] + dy * gy[i]) / (d * mag[i])) > 0.9) {
        hist[Math.round(d)] += 1;
      }
    }
  }
  const ringCoverage = (r: number) =>
    (hist[r - 1] + hist[r] + hist[r + 1]) / (2 * Math.PI * r);
  let strongest = rMin + 1;
  for (let r = rMin + 1; r < rMax; r++) {
    if (ringCoverage(r) > ringCoverage(strongest)) strongest = r;
  }
  // Brzeg naczynia to NAJBARDZIEJ ZEWNĘTRZNY silny pierścień, nie krawędź jedzenia.
  let outer = strongest;
  for (let r = rMax - 1; r > strongest; r--) {
    if (ringCoverage(r) > ringCoverage(strongest) * 0.7) {
      outer = r;
      break;
    }
  }
  return { x: bx, y: by, r: outer, coverage: ringCoverage(outer) };
}

export async function detectPlate(image: Buffer): Promise<PlateEllipse> {
  const meta = await sharp(image).metadata();
  if (!meta.width || !meta.height) throw new Error('obrazek bez wymiarów');
  const scale = WORK_WIDTH / meta.width;
  const baseHeight = Math.round(meta.height * scale);

  let best: (Ring & { k: number }) | null = null;
  for (const k of RATIOS) {
    const h = Math.round(baseHeight / k);
    const gray = await sharp(image)
      .resize(WORK_WIDTH, h, { fit: 'fill' })
      .greyscale()
      .blur(1.2)
      .raw()
      .toBuffer();
    const ring = houghRing(
      gray,
      WORK_WIDTH,
      h,
      Math.round(0.15 * WORK_WIDTH),
      Math.round(0.48 * WORK_WIDTH),
    );
    if (!best || ring.coverage > best.coverage) best = { ...ring, k };
  }
  if (!best) throw new Error('nie znaleziono naczynia');

  return {
    cx: best.x / scale,
    cy: (best.y * best.k) / scale,
    a: best.r / scale,
    b: (best.r * best.k) / scale,
    k: best.k,
    coverage: best.coverage,
    width: meta.width,
    height: meta.height,
  };
}

/**
 * Zapas, gdy brzeg nie daje pewnego wyniku: wysoki kubek (brzeg jest u góry,
 * więc centrowanie po nim spycha kubek w dół), gruba deska pod pizzą (kilka
 * elips naraz). Z wyciętego tła bierzemy największą spójną plamę — naczynie
 * z zawartością — i jej prostokąt udaje „elipsę” o pewności 1.
 */
export async function detectFromCutout(
  cutout: Buffer,
  width: number,
  height: number,
): Promise<PlateEllipse> {
  const step = 4;
  const { data, info } = await sharp(cutout)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = Math.floor(info.width / step);
  const h = Math.floor(info.height / step);
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      on[y * w + x] = data[y * step * info.width + x * step] > 128 ? 1 : 0;
    }
  }
  const seen = new Uint8Array(w * h);
  let best: { n: number; x0: number; y0: number; x1: number; y1: number } | null = null;
  for (let start = 0; start < w * h; start++) {
    if (!on[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    const blob = { n: 0, x0: w, y0: h, x1: 0, y1: 0 };
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      blob.n += 1;
      blob.x0 = Math.min(blob.x0, x);
      blob.x1 = Math.max(blob.x1, x);
      blob.y0 = Math.min(blob.y0, y);
      blob.y1 = Math.max(blob.y1, y);
      const next = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of next) {
        if (q >= 0 && q < w * h && on[q] && !seen[q]) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (!best || blob.n > best.n) best = blob;
  }
  if (!best) throw new Error('wycięte tło bez obiektu');
  const x0 = best.x0 * step;
  const x1 = (best.x1 + 1) * step;
  const y0 = best.y0 * step;
  const y1 = (best.y1 + 1) * step;
  return {
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    a: (x1 - x0) / 2,
    b: (y1 - y0) / 2,
    k: (y1 - y0) / Math.max(1, x1 - x0),
    coverage: 1,
    width,
    height,
  };
}

export type CenteringPlan = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Ile trzeba powiększyć wycięte okno do 1344x768. */
  upscale: number;
};

/** Największe okno 16:9 wyśrodkowane na naczyniu, mieszczące się w kadrze. */
export function planCentering(plate: PlateEllipse): CenteringPlan {
  const aspect = OUTPUT_WIDTH / OUTPUT_HEIGHT;
  const halfW = Math.min(plate.cx, plate.width - plate.cx);
  const halfH = Math.min(plate.cy, plate.height - plate.cy);
  const width = Math.floor(Math.min(2 * halfW, 2 * halfH * aspect));
  const height = Math.floor(width / aspect);
  return {
    left: Math.max(0, Math.round(plate.cx - width / 2)),
    top: Math.max(0, Math.round(plate.cy - height / 2)),
    width,
    height,
    upscale: OUTPUT_HEIGHT / height,
  };
}

export type QaVerdict = { ok: boolean; problems: string[] };

/** Progi dobrane na próbach z 23.09.2026 (dobre zdjęcia: pokrycie 0,9–1,5). */
export const QA_LIMITS = {
  minCoverage: 0.8,
  maxOffsetX: 90,
  maxOffsetY: 70,
  minHeightPct: 45,
  maxHeightPct: 86,
  /** Po wyśrodkowaniu talerz ma zostawić margines po bokach okna. */
  maxWidthShareOfWindow: 0.96,
};

export function judgePlate(plate: PlateEllipse, plan: CenteringPlan): QaVerdict {
  const problems: string[] = [];
  const dx = plate.cx - plate.width / 2;
  const dy = plate.cy - plate.height / 2;
  const heightPct = ((2 * plate.b) / plate.height) * 100;
  if (plate.coverage < QA_LIMITS.minCoverage) {
    problems.push(`niepewne wykrycie naczynia (${plate.coverage.toFixed(2)})`);
  }
  if (Math.abs(dx) > QA_LIMITS.maxOffsetX || Math.abs(dy) > QA_LIMITS.maxOffsetY) {
    problems.push(`za duże przesunięcie (${dx.toFixed(0)}, ${dy.toFixed(0)} px)`);
  }
  if (heightPct < QA_LIMITS.minHeightPct || heightPct > QA_LIMITS.maxHeightPct) {
    problems.push(`naczynie ${heightPct.toFixed(0)}% wysokości`);
  }
  if ((2 * plate.a) / plan.width > QA_LIMITS.maxWidthShareOfWindow) {
    problems.push('naczynie dotyka boków kadru');
  }
  return { ok: problems.length === 0, problems };
}
