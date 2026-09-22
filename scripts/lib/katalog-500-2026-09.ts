/**
 * Partia „Katalog 500" (22.09.2026): 355 nowych przepisów, katalog 145 → 500.
 *
 * Lista zatwierdzona w `prisma/catalog/katalog-500-lista.md`. Definicje leżą
 * w `scripts/lib/katalog-500/<część>.ts` (po jednej na zakres listy), a
 * uzupełnienia katalogu składników w `katalog-500/skladniki.ts` i w polach
 * `ADDITIONS` części. Makro liczy się ze składników tą samą funkcją co
 * `recipes:recompute:nutrition` — nic nie jest wpisane z ręki.
 *
 * Uruchomienie:
 *   pnpm exec tsx scripts/lib/katalog-500-2026-09.ts --part sn-a   # jedna część, bez zapisu
 *   pnpm exec tsx scripts/lib/katalog-500-2026-09.ts                # wszystko, bez zapisu
 *   pnpm exec tsx scripts/lib/katalog-500-2026-09.ts --write        # zapis plików
 *
 * `--write` dopisuje składniki do txt, tagów i tabeli makro, zapisuje pięć
 * plików partii i wstawia (albo podmienia po id) przepisy w
 * `recipes-catalog-full-v2.json`. Potem, jak przy poprzednich partiach:
 * `pnpm recipes:recompute:nutrition -- --json-only --write`.
 *
 * Zdjęć brak: `imageUrl` = `RECIPE_IMAGE_PLACEHOLDER_URL`, prompt do
 * Recrafta leży w `image.prompt`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeRecipeNutrition } from '../../src/recipes/recipe-nutrition.util';
import {
  normalizeIngredientAmount,
  normalizeText,
} from '../../src/recipes/ingredient-amount.util';
import { RECIPE_IMAGE_PLACEHOLDER_URL } from '../../src/recipes/recipe-image-placeholder';
import { ALLERGEN_IDS } from '../../src/common/allergens';
import { DIET_TAG_IDS } from '../../src/common/diet-tags';
import { richPhotoPrompt } from './przekaski-i-sniadania-2026-09';
import type { Def, IngredientAddition, MealType } from './katalog-500/types';

const CATALOG_DIR = join(process.cwd(), 'prisma', 'catalog');
const PARTS_DIR = join(__dirname, 'katalog-500');

type Section = {
  prefix: string;
  label: string;
  size: number;
  mealType: MealType;
  batchFile: string;
  /** Rozsądny zakres kcal na porcję — poza nim porcja jest źle dobrana. */
  kcal: [number, number];
};

const SECTIONS: Section[] = [
  { prefix: 'sn', label: 'Śniadania', size: 90, mealType: 'BREAKFAST', batchFile: 'recipes-batch-sniadania-90-v1.json', kcal: [250, 750] },
  { prefix: 'ob', label: 'Obiady', size: 101, mealType: 'LUNCH', batchFile: 'recipes-batch-obiady-101-v1.json', kcal: [400, 1000] },
  { prefix: 'ko', label: 'Kolacje', size: 94, mealType: 'DINNER', batchFile: 'recipes-batch-kolacje-94-v1.json', kcal: [300, 900] },
  { prefix: 'de', label: 'Desery', size: 35, mealType: 'AFTERNOON_SNACK', batchFile: 'recipes-batch-desery-35-v1.json', kcal: [120, 600] },
  { prefix: 'pr', label: 'Przekąski', size: 35, mealType: 'SNACK', batchFile: 'recipes-batch-przekaski-35-v1.json', kcal: [60, 450] },
];

/** Część → zakres numerów listy, który ma pokryć. */
const PARTS: Record<string, { prefix: string; from: number; to: number }> = {
  'sn-a': { prefix: 'sn', from: 1, to: 30 },
  'sn-b': { prefix: 'sn', from: 31, to: 60 },
  'sn-c': { prefix: 'sn', from: 61, to: 90 },
  'ob-a': { prefix: 'ob', from: 1, to: 34 },
  'ob-b': { prefix: 'ob', from: 35, to: 68 },
  'ob-c': { prefix: 'ob', from: 69, to: 101 },
  'ko-a': { prefix: 'ko', from: 1, to: 31 },
  'ko-b': { prefix: 'ko', from: 32, to: 62 },
  'ko-c': { prefix: 'ko', from: 63, to: 94 },
  de: { prefix: 'de', from: 1, to: 35 },
  pr: { prefix: 'pr', from: 1, to: 35 },
};

/** Ustalone z Rafałem 24.08.2026 i 22.09.2026: tych składników nie proponujemy. */
const FORBIDDEN = /krewet|śledź|sledz|homar|krab|małż|malz|kalmar|ośmiorn|osmiorn|surimi|omułk|omulk|langust|ostryg/i;

type NutritionEntry = {
  normalizedName: string;
  unit: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sodiumMg?: number;
  gramsPerPiece?: number | null;
};
type TagEntry = {
  name: string;
  normalizedName: string;
  category: string;
  allergens: string[];
  dietTags: string[];
  note?: string;
};

const NUTRITION_PATH = join(CATALOG_DIR, 'ingredient-nutrition-pl-v1.json');
const TAGS_PATH = join(CATALOG_DIR, 'ingredient-tags-pl-v1.json');
const FULL_PATH = join(CATALOG_DIR, 'recipes-catalog-full-v2.json');

const NUTRITION = JSON.parse(readFileSync(NUTRITION_PATH, 'utf8')) as {
  ingredients: NutritionEntry[];
};
const TAGS = JSON.parse(readFileSync(TAGS_PATH, 'utf8')) as {
  ingredients: TagEntry[];
};
const FULL = JSON.parse(readFileSync(FULL_PATH, 'utf8')) as {
  version: string;
  recipes: { id: string; title: string }[];
};

/** Stały UUID v4 z klucza listy — poprawka tytułu nie zmienia id. */
function stableUuid(plan: string): string {
  const h = createHash('sha256').update(`katalog-500:${plan}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(
    (parseInt(h[16], 16) & 0x3) |
    0x8
  ).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function loadModule(file: string): { DEFS?: Def[]; ADDITIONS?: IngredientAddition[] } | null {
  const path = join(PARTS_DIR, `${file}.ts`);
  if (!existsSync(path)) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

type Built = ReturnType<typeof buildRecipe>;

function buildRecipe(
  def: Def,
  tagsByNorm: Map<string, TagEntry>,
  nutritionByNorm: Map<string, NutritionEntry>,
  errors: string[],
  warnings: string[],
) {
  const where = `[${def.plan}] ${def.title}`;
  const section = SECTIONS.find((s) => def.plan.startsWith(`${s.prefix}-`));
  if (!section) errors.push(`${where}: nieznany prefiks klucza`);
  if (section && def.mealType !== section.mealType)
    errors.push(`${where}: mealType ${def.mealType}, a sekcja ${section.label} to ${section.mealType}`);
  if (!def.title.trim() || def.title.length > 70)
    errors.push(`${where}: tytuł pusty albo dłuższy niż 70 znaków`);
  if (def.description.length < 80 || def.description.length > 320)
    errors.push(`${where}: opis ma ${def.description.length} znaków (80–320)`);
  if (def.steps.length < 3 || def.steps.length > 10)
    errors.push(`${where}: ${def.steps.length} kroków (3–10)`);
  if (def.steps.some((s) => s.trim().length < 15))
    errors.push(`${where}: krok krótszy niż 15 znaków`);
  if (/^\s*\d+[.)]/.test(def.steps.join('\n')))
    errors.push(`${where}: kroki nie mogą zaczynać się od numeru (numeruje import)`);
  if (def.ingredients.length < 3)
    errors.push(`${where}: mniej niż 3 składniki`);
  if (!(def.prepTimeMinutes >= 3 && def.prepTimeMinutes <= 300))
    errors.push(`${where}: czas ${def.prepTimeMinutes} min poza 3–300`);
  if (!(def.servings >= 1 && def.servings <= 8))
    errors.push(`${where}: porcje ${def.servings} poza 1–8`);
  if (def.servings !== 2 && !['de', 'pr'].includes(section?.prefix ?? ''))
    errors.push(`${where}: porcje ${def.servings} — dania główne i śniadania mają 2 porcje`);
  if (!def.photo || def.photo.length < 30)
    errors.push(`${where}: brak opisu zdjęcia (photo)`);

  const seen = new Set<string>();
  const items = def.ingredients.map(([name, amount, unit]) => {
    const norm = normalizeText(name);
    if (seen.has(norm)) errors.push(`${where}: składnik „${name}" dwa razy`);
    seen.add(norm);
    if (FORBIDDEN.test(name)) errors.push(`${where}: zakazany składnik „${name}"`);
    if (!['g', 'ml', 'szt'].includes(unit))
      errors.push(`${where}: jednostka „${unit}" (tylko g, ml, szt)`);
    if (!(amount > 0)) errors.push(`${where}: ilość „${name}" ≤ 0`);
    const tag = tagsByNorm.get(norm);
    if (!tag) errors.push(`${where}: nieznany składnik „${name}" (dodaj do ADDITIONS)`);
    if (tag && tag.name !== name)
      errors.push(`${where}: pisz „${tag.name}", nie „${name}"`);
    const nut = nutritionByNorm.get(norm);
    if (tag && !nut) errors.push(`${where}: brak makro dla „${name}"`);
    if (nut && unit !== 'szt' && nut.unit !== unit)
      errors.push(`${where}: „${name}" liczony w ${nut.unit}, a przepis podaje ${unit}`);
    if (unit === 'szt' && nut && !nut.gramsPerPiece)
      errors.push(`${where}: „${name}" nie ma wagi sztuki — podaj w ${nut.unit}`);
    let normalized = { normalizedAmount: amount, normalizedUnit: unit as 'g' | 'ml' | 'szt' };
    try {
      normalized = normalizeIngredientAmount(name, tag?.category ?? 'inne', amount, unit);
    } catch (error) {
      errors.push(`${where}: ${(error as Error).message}`);
    }
    return {
      name,
      normalizedAmount: normalized.normalizedAmount,
      normalizedUnit: normalized.normalizedUnit,
      nutrition: nut
        ? {
            kcal: nut.kcal,
            protein: nut.protein,
            carbs: nut.carbs,
            fat: nut.fat,
            fiber: nut.fiber,
            sodiumMg: nut.sodiumMg ?? 0,
            gramsPerPiece: nut.gramsPerPiece ?? null,
          }
        : null,
    };
  });

  const result = computeRecipeNutrition(items);
  const addedSalt = def.ingredients.find(([name]) => name === 'sól')?.[1] ?? 0;
  const per = {
    kcal: result.totals.kcal / def.servings,
    protein: result.totals.protein / def.servings,
    carbs: result.totals.carbs / def.servings,
    fat: result.totals.fat / def.servings,
    salt: (result.totals.sodiumMg * 0.0025 + addedSalt) / def.servings,
  };
  const complete = !result.missingNutrition.length && !result.missingPieceWeight.length;
  if (section && complete) {
    const [min, max] = section.kcal;
    if (per.kcal < min || per.kcal > max)
      errors.push(`${where}: ${Math.round(per.kcal)} kcal/porcja poza ${min}–${max} dla ${section.label}`);
    if (section.prefix === 'ob' && per.protein < 20)
      warnings.push(`${where}: tylko ${Math.round(per.protein)} g białka/porcja na obiad`);
    if (per.salt > 4)
      warnings.push(`${where}: ${round1(per.salt)} g soli/porcja`);
  }

  const allergens = new Set<string>();
  for (const [name] of def.ingredients)
    for (const a of tagsByNorm.get(normalizeText(name))?.allergens ?? []) allergens.add(a);

  return {
    recipe: {
      id: stableUuid(def.plan),
      title: def.title,
      description: def.description,
      mealType: def.mealType,
      difficulty: def.difficulty,
      prepTimeMinutes: def.prepTimeMinutes,
      servings: def.servings,
      nutrition: {
        kcal: Math.round(result.totals.kcal),
        protein: Math.round(result.totals.protein),
        carbs: Math.round(result.totals.carbs),
        fat: Math.round(result.totals.fat),
        fiber: Math.round(result.totals.fiber),
        // Sól łączna = sód × 2,5 + dodana; `recipes:recompute:nutrition` liczy tak samo.
        salt: round1(result.totals.sodiumMg * 0.0025 + addedSalt),
        addedSalt: round1(addedSalt),
      },
      steps: def.steps.map((instruction, i) => ({ step: i + 1, instruction })),
      ingredients: def.ingredients.map(([ingredientName, amount, unit]) => ({
        ingredientName,
        amount,
        unit,
      })),
      image: {
        prompt: richPhotoPrompt(def.title, def.photo, def.vessel),
        imageUrl: RECIPE_IMAGE_PLACEHOLDER_URL,
      },
    },
    report: `${def.plan.padEnd(7)} ${def.title} · ${Math.round(per.kcal)} kcal · B ${Math.round(per.protein)} / W ${Math.round(per.carbs)} / T ${Math.round(per.fat)} g · sól ${round1(per.salt)} g · ${def.prepTimeMinutes} min · ${[...allergens].join(',') || '—'}`,
  };
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const partArg = args.includes('--part') ? args[args.indexOf('--part') + 1] : null;
  if (partArg && !PARTS[partArg]) throw new Error(`Nieznana część „${partArg}"`);
  if (partArg && write) throw new Error('--write zapisuje całość, bez --part');

  const errors: string[] = [];
  const warnings: string[] = [];
  const partNames = partArg ? [partArg] : Object.keys(PARTS);

  // ─── składniki ───
  const modules = new Map<string, { DEFS?: Def[]; ADDITIONS?: IngredientAddition[] }>();
  const common = loadModule('skladniki');
  if (common) modules.set('skladniki', common);
  for (const part of partNames) {
    const mod = loadModule(part);
    if (mod) modules.set(part, mod);
    else if (!partArg) warnings.push(`część ${part}: brak pliku`);
    else errors.push(`część ${part}: brak pliku`);
  }

  const tagsByNorm = new Map(TAGS.ingredients.map((t) => [t.normalizedName, t]));
  const nutritionByNorm = new Map(NUTRITION.ingredients.map((n) => [n.normalizedName, n]));
  const categories = new Set(TAGS.ingredients.map((t) => t.category));
  const newTags: TagEntry[] = [];
  const newNutrition: NutritionEntry[] = [];
  const additionSource = new Map<string, { source: string; addition: IngredientAddition }>();

  for (const [source, mod] of modules) {
    for (const addition of mod.ADDITIONS ?? []) {
      const norm = normalizeText(addition.name);
      const where = `${source}: składnik „${addition.name}"`;
      const earlier = additionSource.get(norm);
      if (earlier) {
        const a = earlier.addition.nutrition;
        const b = addition.nutrition;
        if (Math.abs(a.kcal - b.kcal) > Math.max(10, a.kcal * 0.1) || a.unit !== b.unit)
          errors.push(`${where}: zdublowany z ${earlier.source} z innym makro (${a.kcal} vs ${b.kcal} kcal) — zostaw jeden wpis`);
        // Alergeny sumujemy: oznaczamy nadmiarowo.
        const tag = tagsByNorm.get(norm);
        if (tag && addition.allergens)
          for (const x of addition.allergens) if (!tag.allergens.includes(x)) tag.allergens.push(x);
        continue;
      }
      additionSource.set(norm, { source, addition });

      const existingTag = tagsByNorm.get(norm);
      if (existingTag && existingTag.name !== addition.name)
        errors.push(`${where}: w katalogu jest jako „${existingTag.name}"`);
      if (nutritionByNorm.has(norm)) {
        errors.push(`${where}: ma już makro w tabeli`);
        continue;
      }
      const n = addition.nutrition;
      if (!['g', 'ml'].includes(n.unit)) errors.push(`${where}: unit ${n.unit}`);
      const energy = n.protein * 4 + n.carbs * 4 + n.fat * 9 + n.fiber * 2;
      if (n.kcal > 20 && Math.abs(energy - n.kcal) > Math.max(25, n.kcal * 0.15))
        errors.push(`${where}: ${n.kcal} kcal nie zgadza się z makro (${Math.round(energy)} z B/W/T/błonnika)`);
      if ([n.kcal, n.protein, n.carbs, n.fat, n.fiber, n.sodiumMg].some((v) => !(v >= 0)))
        errors.push(`${where}: ujemna albo brakująca wartość`);
      if (n.protein + n.carbs + n.fat + n.fiber > 101)
        errors.push(`${where}: makro > 100 g na 100 g`);

      if (!existingTag) {
        if (!addition.category || !categories.has(addition.category))
          errors.push(`${where}: nowy składnik wymaga category z ${[...categories].join(', ')}`);
        const bad = [
          ...(addition.allergens ?? []).filter((a) => !(ALLERGEN_IDS as readonly string[]).includes(a)),
          ...(addition.dietTags ?? []).filter((d) => !(DIET_TAG_IDS as readonly string[]).includes(d)),
        ];
        if (bad.length) errors.push(`${where}: nieznane tagi ${bad.join(', ')}`);
        if (!addition.allergens || !addition.dietTags)
          errors.push(`${where}: nowy składnik wymaga allergens i dietTags`);
        const tag: TagEntry = {
          name: addition.name,
          normalizedName: norm,
          category: addition.category ?? 'inne',
          allergens: [...(addition.allergens ?? [])],
          dietTags: [...(addition.dietTags ?? [])],
          ...(addition.note ? { note: addition.note } : {}),
        };
        tagsByNorm.set(norm, tag);
        newTags.push(tag);
      } else if (addition.category && addition.category !== existingTag.category) {
        errors.push(`${where}: kategoria ${addition.category}, w katalogu ${existingTag.category}`);
      }
      const entry: NutritionEntry = {
        normalizedName: norm,
        unit: n.unit,
        kcal: n.kcal,
        protein: n.protein,
        carbs: n.carbs,
        fat: n.fat,
        fiber: n.fiber,
        sodiumMg: n.sodiumMg,
        ...(n.gramsPerPiece ? { gramsPerPiece: n.gramsPerPiece } : {}),
      };
      nutritionByNorm.set(norm, entry);
      newNutrition.push(entry);
    }
  }

  // ─── przepisy ───
  const existingTitles = new Map(
    FULL.recipes.map((r) => [normalizeText(r.title), r.id]),
  );
  const built = new Map<string, Built>();
  const titles = new Map<string, string>();
  for (const part of partNames) {
    const range = PARTS[part];
    const defs = modules.get(part)?.DEFS ?? [];
    for (const def of defs) {
      const m = /^([a-z]{2})-(\d+)$/.exec(def.plan);
      if (!m || m[1] !== range.prefix || +m[2] < range.from || +m[2] > range.to) {
        errors.push(`[${def.plan}] ${def.title}: klucz spoza zakresu części ${part} (${range.prefix}-${range.from}…${range.to})`);
        continue;
      }
      if (built.has(def.plan)) errors.push(`[${def.plan}]: klucz dwa razy`);
      const titleKey = normalizeText(def.title);
      const sameTitle = existingTitles.get(titleKey);
      if (sameTitle && sameTitle !== stableUuid(def.plan))
        errors.push(`[${def.plan}] ${def.title}: taki tytuł już jest w katalogu`);
      if (titles.has(titleKey)) errors.push(`[${def.plan}] ${def.title}: tytuł powtarza ${titles.get(titleKey)}`);
      titles.set(titleKey, def.plan);
      built.set(def.plan, buildRecipe(def, tagsByNorm, nutritionByNorm, errors, warnings));
    }
    const missing: string[] = [];
    for (let i = range.from; i <= range.to; i++)
      if (!built.has(`${range.prefix}-${i}`)) missing.push(`${range.prefix}-${i}`);
    if (missing.length) (partArg || write ? errors : warnings).push(`część ${part}: brak ${missing.join(', ')}`);
  }

  for (const b of built.values()) console.log(b.report);
  if (newNutrition.length)
    console.log(`\nuzupełnienia składników: ${newNutrition.length} makro, ${newTags.length} nowych nazw`);
  if (warnings.length) console.log(`\nUWAGI (${warnings.length}):\n${warnings.join('\n')}`);
  if (errors.length) {
    console.error(`\nBŁĘDY (${errors.length}):\n${errors.join('\n')}`);
    process.exit(1);
  }
  console.log(`\nOK: ${built.size} przepisów bez błędów`);
  if (!write) return;

  // ─── zapis ───
  // Składniki: txt (loader katalogu), tagi, makro. Idempotentne — drugi
  // przebieg nie ma już czego dopisać, bo wpisy są w tabelach.
  for (const tag of newTags) {
    const txt = join(CATALOG_DIR, `ingredients-${tag.category}-pl-v1.txt`);
    const lines = readFileSync(txt, 'utf8').split('\n').map((l) => l.trim());
    if (!lines.some((l) => normalizeText(l) === tag.normalizedName)) {
      const raw = readFileSync(txt, 'utf8');
      writeFileSync(txt, `${raw.endsWith('\n') ? raw : `${raw}\n`}${tag.name}\n`);
    }
  }
  TAGS.ingredients.push(...newTags);
  writeFileSync(TAGS_PATH, JSON.stringify(TAGS, null, 2) + '\n');
  NUTRITION.ingredients.push(...newNutrition);
  writeFileSync(NUTRITION_PATH, JSON.stringify(NUTRITION, null, 2) + '\n');

  for (const section of SECTIONS) {
    const recipes = [...built.entries()]
      .filter(([plan]) => plan.startsWith(`${section.prefix}-`))
      .sort(([a], [b]) => +a.split('-')[1] - +b.split('-')[1])
      .map(([, b]) => b.recipe);
    writeFileSync(
      join(CATALOG_DIR, section.batchFile),
      JSON.stringify({ version: section.batchFile.replace(/\.json$/, ''), recipes }, null, 2) + '\n',
    );
  }

  const byId = new Map([...built.values()].map((b) => [b.recipe.id, b.recipe]));
  let replaced = 0;
  FULL.recipes = FULL.recipes.map((r) => {
    const next = byId.get(r.id);
    if (!next) return r;
    byId.delete(r.id);
    replaced += 1;
    return next;
  });
  FULL.recipes.push(...byId.values());
  writeFileSync(FULL_PATH, JSON.stringify(FULL, null, 2) + '\n');
  console.log(
    `zapisano: ${newTags.length} nowych składników, ${newNutrition.length} wpisów makro; ` +
      `pełny katalog: ${byId.size} dodanych, ${replaced} podmienionych, razem ${FULL.recipes.length}`,
  );
}

main();
