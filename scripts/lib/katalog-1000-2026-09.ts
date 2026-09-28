/**
 * Partia „Katalog 1000" (28.09.2026): 572 nowe przepisy, katalog 500 → ~1072.
 *
 * Lista zatwierdzona w `prisma/catalog/katalog-1000-lista.md`. Definicje leżą
 * w `scripts/lib/katalog-1000/<część>.ts` (np. `OB-c.ts` = OB-057…OB-084),
 * nowe składniki w polach `ADDITIONS` części. Makro liczy się ze składników
 * tą samą funkcją co serwer (`nutritionColumnsFromIngredients`) — nic nie
 * jest wpisane z ręki, więc `recipes:recompute:nutrition` niczego nie zmieni.
 *
 * Każdy przepis musi dotrzymać obietnic z listy: etykieta „wegańskie” =
 * tagi diet składników bez mięsa, ryb, nabiału, jaj; „bez glutenu” = bez
 * alergenu gluten; „keto” = do 20 g węgli na porcję; „do 30 min” = czas ≤ 30;
 * „airfryer” = sprzęt AIRFRYER i wariant na piekarnik w krokach itd.
 *
 * Uruchomienie:
 *   pnpm exec tsx scripts/lib/katalog-1000-2026-09.ts --part OB-c   # jedna część, bez zapisu
 *   pnpm exec tsx scripts/lib/katalog-1000-2026-09.ts                # wszystko, bez zapisu
 *   pnpm exec tsx scripts/lib/katalog-1000-2026-09.ts --write        # zapis (tylko gdy bez błędów)
 *
 * `--write` dopisuje składniki (txt, tagi, makro), wstawia przepisy do
 * `recipes-catalog-full-v2.json` w formacie eksportu (podmiana po id) i opisy
 * zdjęć do `recipe-image-dishes.json`. Zdjęć brak: `imageUrl` = zaślepka.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLERGEN_IDS } from '../../src/common/allergens';
import { DIET_TAG_IDS } from '../../src/common/diet-tags';
import {
  buildCatalogFile,
  formatCatalogFile,
  withCanonicalKeyOrder,
} from '../../src/recipes/catalog/catalog-export';
import {
  catalogTaxonomyOf,
  overLimitManualSlots,
  type CatalogRecipeInput,
} from '../../src/recipes/catalog/catalog-recipe';
import {
  normalizeIngredientAmount,
  normalizeText,
} from '../../src/recipes/ingredient-amount.util';
import { RECIPE_IMAGE_PLACEHOLDER_URL } from '../../src/recipes/recipe-image-placeholder';
import {
  computeRecipeNutrition,
  nutritionColumnsFromIngredients,
} from '../../src/recipes/recipe-nutrition.util';
import { taxonomyProblems } from '../../src/recipes/recipe-taxonomy';
import { resolveSuitableMealTypes } from '../../src/recipes/suitable-meal-types.util';
import { buildRecipeImagePrompt } from './recipe-images/prompt';
import type { Def, IngredientAddition, MealType } from './katalog-1000/types';

const CATALOG_DIR = join(process.cwd(), 'prisma', 'catalog');
const PARTS_DIR = join(__dirname, 'katalog-1000');
const LIST_PATH = join(CATALOG_DIR, 'katalog-1000-lista.md');
const NUTRITION_PATH = join(CATALOG_DIR, 'ingredient-nutrition-pl-v1.json');
const TAGS_PATH = join(CATALOG_DIR, 'ingredient-tags-pl-v1.json');
const FULL_PATH = join(CATALOG_DIR, 'recipes-catalog-full-v2.json');
const DISHES_PATH = join(CATALOG_DIR, 'recipe-image-dishes.json');

type Section = {
  prefix: string;
  label: string;
  mealTypes: MealType[];
  /** Rozsądny zakres kcal na porcję — poza nim porcja jest źle dobrana. */
  kcal: [number, number];
  /** Dania główne i śniadania na 2 porcje (poza daniami od święta). */
  twoServings: boolean;
};

const SECTIONS: Section[] = [
  {
    prefix: 'SN',
    label: 'Śniadania',
    mealTypes: ['BREAKFAST'],
    kcal: [200, 800],
    twoServings: true,
  },
  {
    prefix: 'DS',
    label: 'Drugie śniadania i lunchboxy',
    mealTypes: ['SECOND_BREAKFAST'],
    kcal: [120, 700],
    twoServings: false,
  },
  {
    prefix: 'OB',
    label: 'Obiady',
    mealTypes: ['LUNCH'],
    kcal: [350, 1000],
    twoServings: true,
  },
  {
    prefix: 'KO',
    label: 'Kolacje',
    mealTypes: ['DINNER'],
    kcal: [250, 900],
    twoServings: true,
  },
  {
    prefix: 'DE',
    label: 'Desery i podwieczorki',
    mealTypes: ['AFTERNOON_SNACK'],
    kcal: [100, 650],
    twoServings: false,
  },
  {
    prefix: 'PR',
    label: 'Przekąski',
    mealTypes: ['SNACK'],
    kcal: [40, 500],
    twoServings: false,
  },
  {
    prefix: 'NA',
    label: 'Napoje',
    mealTypes: ['BREAKFAST', 'SECOND_BREAKFAST', 'AFTERNOON_SNACK', 'SNACK'],
    kcal: [15, 600],
    twoServings: false,
  },
];

/** Część → zakres numerów listy, który ma pokryć. */
const PARTS: Record<string, { prefix: string; from: number; to: number }> = {
  'SN-a': { prefix: 'SN', from: 1, to: 30 },
  'SN-b': { prefix: 'SN', from: 31, to: 60 },
  'SN-c': { prefix: 'SN', from: 61, to: 88 },
  'DS-a': { prefix: 'DS', from: 1, to: 29 },
  'DS-b': { prefix: 'DS', from: 30, to: 57 },
  'OB-a': { prefix: 'OB', from: 1, to: 28 },
  'OB-b': { prefix: 'OB', from: 29, to: 56 },
  'OB-c': { prefix: 'OB', from: 57, to: 84 },
  'OB-d': { prefix: 'OB', from: 85, to: 112 },
  'OB-e': { prefix: 'OB', from: 113, to: 140 },
  'OB-f': { prefix: 'OB', from: 141, to: 168 },
  'OB-g': { prefix: 'OB', from: 169, to: 195 },
  'KO-a': { prefix: 'KO', from: 1, to: 29 },
  'KO-b': { prefix: 'KO', from: 30, to: 58 },
  'KO-c': { prefix: 'KO', from: 59, to: 87 },
  'KO-d': { prefix: 'KO', from: 88, to: 116 },
  'DE-a': { prefix: 'DE', from: 1, to: 24 },
  'DE-b': { prefix: 'DE', from: 25, to: 47 },
  PR: { prefix: 'PR', from: 1, to: 40 },
  NA: { prefix: 'NA', from: 1, to: 29 },
};

/** Krewetki i śledź dozwolone od 28.09.2026 — reszty owoców morza nie proponujemy. */
const FORBIDDEN =
  /homar|krab|małż|malz|kalmar|ośmiorn|osmiorn|surimi|omułk|omulk|langust|ostryg|przegrzeb/i;

/** Sól na porcję: ponad to — błąd (połowa dziennej normy WHO w jednym daniu). */
const SALT_MAX = 3.0;
const SALT_WARN = 2.0;

// ─── lista zatwierdzona: klucz → tytuł + obietnice ───

type Promise = { title: string; labels: string[]; section: string };

const LABEL_CUISINE: Record<string, string> = {
  'kuchnia włoska': 'ITALIAN',
  'kuchnia hiszpańska': 'SPANISH',
  'kuchnia grecka': 'GREEK',
  'kuchnia indyjska': 'INDIAN',
  'kuchnia tajska': 'THAI',
  'kuchnia meksykańska': 'MEXICAN',
  'kuchnia amerykańska': 'AMERICAN',
};
const LABEL_SEASON: Record<string, string> = {
  wiosna: 'SPRING',
  lato: 'SUMMER',
  jesień: 'AUTUMN',
  zima: 'WINTER',
};
const LABEL_EQUIPMENT: Record<string, string> = {
  airfryer: 'AIRFRYER',
  blender: 'BLENDER',
  sokowirówka: 'JUICER',
  gofrownica: 'WAFFLE_MAKER',
  grill: 'GRILL',
};
const LABEL_OCCASION: Record<string, string> = {
  Wigilia: 'CHRISTMAS_EVE',
  'Boże Narodzenie': 'CHRISTMAS',
  Wielkanoc: 'EASTER',
  impreza: 'PARTY',
  majówka: 'BARBECUE',
};
const LABEL_FEATURE: Record<string, string> = {
  'do pudełka': 'LUNCHBOX',
  'dodatek do posiłku': 'SIDE',
};

function loadList(): Map<string, Promise> {
  const list = new Map<string, Promise>();
  let section = '';
  for (const line of readFileSync(LIST_PATH, 'utf8').split('\n')) {
    const heading = /^### (.+)$/.exec(line);
    if (heading) section = heading[1];
    const m = /^- `([A-Z]{2}-\d{3})` (.+) — (.+)$/.exec(line);
    if (m) list.set(m[1], { title: m[2], labels: m[3].split(', '), section });
  }
  return list;
}

// ─── słowniki składników ───

type NutritionEntry = {
  normalizedName: string;
  unit: string;
  kcal: number;
  protein: number;
  carbs: number;
  sugars?: number;
  fat: number;
  saturatedFat?: number;
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

const NUTRITION = JSON.parse(readFileSync(NUTRITION_PATH, 'utf8')) as {
  ingredients: NutritionEntry[];
};
const TAGS = JSON.parse(readFileSync(TAGS_PATH, 'utf8')) as {
  ingredients: TagEntry[];
};
const FULL = JSON.parse(readFileSync(FULL_PATH, 'utf8')) as {
  version: string;
  recipes: CatalogRecipeInput[];
};

/** Stały UUID v4 z klucza listy — poprawka tytułu nie zmienia id. */
function stableUuid(plan: string): string {
  const h = createHash('sha256').update(`katalog-1000:${plan}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(
    (parseInt(h[16], 16) & 0x3) |
    0x8
  ).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type PartModule = { DEFS?: Def[]; ADDITIONS?: IngredientAddition[] };

function loadModule(file: string): PartModule | null {
  const path = join(PARTS_DIR, `${file}.ts`);
  if (!existsSync(path)) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path) as PartModule;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Dopisuje elementy do tablicy najwyższego poziomu bez przeformatowania reszty pliku. */
function appendArrayText(text: string, key: string, extra: unknown[]): string {
  if (extra.length === 0) return text;
  const end = text.lastIndexOf('\n  ]');
  const open = text.indexOf(`\n  "${key}": [\n`);
  if (open < 0 || end < open) throw new Error(`Nie znalazłem tablicy "${key}"`);
  const added = extra
    .map((item) =>
      JSON.stringify(item, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    )
    .join(',\n');
  const out = `${text.slice(0, end)},\n${added}${text.slice(end)}`;
  JSON.parse(out);
  return out;
}

type Built = {
  recipe: CatalogRecipeInput;
  dish: { id: string; vessel: string; dish: string };
  report: string;
};

function buildRecipe(
  def: Def,
  promise: Promise | undefined,
  tagsByNorm: Map<string, TagEntry>,
  nutritionByNorm: Map<string, NutritionEntry>,
  errors: string[],
  warnings: string[],
): Built {
  const where = `[${def.plan}] ${def.title}`;
  const section = SECTIONS.find((s) => def.plan.startsWith(`${s.prefix}-`));
  if (!section) errors.push(`${where}: nieznany prefiks klucza`);
  if (section && !section.mealTypes.includes(def.mealType))
    errors.push(
      `${where}: mealType ${def.mealType} — sekcja ${section.label} dopuszcza ${section.mealTypes.join('/')}`,
    );
  if (!def.title.trim() || def.title.length > 80)
    errors.push(`${where}: tytuł pusty albo dłuższy niż 80 znaków`);
  if (def.description.length < 80 || def.description.length > 320)
    errors.push(`${where}: opis ma ${def.description.length} znaków (80–320)`);
  if (/\d+\s*kcal|przepis na/i.test(def.description))
    errors.push(`${where}: opis bez kcal i bez „przepis na”`);
  if (def.steps.length < 3 || def.steps.length > 10)
    errors.push(`${where}: ${def.steps.length} kroków (3–10)`);
  if (def.steps.some((s) => s.trim().length < 15))
    errors.push(`${where}: krok krótszy niż 15 znaków`);
  if (def.steps.some((s) => /^\s*\d+[.)]/.test(s)))
    errors.push(`${where}: krok zaczyna się od numeru (numeruje import)`);
  if (def.ingredients.length < 3 && def.dishType !== 'DRINK')
    errors.push(`${where}: mniej niż 3 składniki`);
  if (!(def.prepTimeMinutes >= 3 && def.prepTimeMinutes <= 600))
    errors.push(`${where}: czas ${def.prepTimeMinutes} min poza 3–600`);
  if (!(
    Number.isInteger(def.servings) &&
    def.servings >= 1 &&
    def.servings <= 8
  ))
    errors.push(`${where}: porcje ${def.servings} poza 1–8`);
  const festive =
    (def.occasions ?? []).length > 0 ||
    (def.features ?? []).includes('OCCASIONAL');
  if (section?.twoServings && def.servings !== 2 && !festive)
    errors.push(
      `${where}: porcje ${def.servings} — ${section.label} mają 2 porcje (poza daniami od święta)`,
    );
  if (!def.photo || def.photo.length < 30)
    errors.push(`${where}: brak opisu zdjęcia (photo)`);
  if (/[ąćęłńóśźż]/i.test(def.photo))
    errors.push(`${where}: photo po angielsku`);

  // ── taksonomia ──
  const taxonomy = catalogTaxonomyOf({
    cuisine: def.cuisine,
    dishType: def.dishType,
    seasons: def.seasons,
    occasions: def.occasions,
    equipment: def.equipment,
    features: def.features,
  });
  for (const problem of taxonomyProblems({
    cuisine: def.cuisine,
    dishType: def.dishType,
    seasons: def.seasons ?? [],
    occasions: def.occasions ?? [],
    equipment: def.equipment ?? [],
    features: def.features ?? [],
  }))
    errors.push(`${where}: ${problem}`);
  if (!def.cuisine || !def.dishType)
    errors.push(`${where}: kuchnia i rodzaj dania są wymagane`);
  if (taxonomy.features.includes('SIDE') && section?.prefix !== 'NA')
    errors.push(`${where}: SIDE (dodatek) tylko w napojach`);
  if (
    taxonomy.features.includes('OCCASIONAL') &&
    taxonomy.occasions.length === 0
  )
    errors.push(`${where}: OCCASIONAL bez okazji`);
  const stepsText = normalizeText(def.steps.join(' '));
  if (
    taxonomy.equipment.includes('AIRFRYER') &&
    !stepsText.includes('piekarnik')
  )
    errors.push(`${where}: airfryer bez wariantu na piekarnik w krokach`);
  if (
    !taxonomy.equipment.includes('AIRFRYER') &&
    stepsText.includes('airfryer')
  )
    errors.push(`${where}: kroki mówią o airfryerze, a sprzęt go nie ma`);
  if (
    taxonomy.equipment.includes('OVEN') !== stepsText.includes('piekarnik') &&
    !taxonomy.equipment.includes('AIRFRYER')
  )
    warnings.push(
      `${where}: OVEN w sprzęcie ${taxonomy.equipment.includes('OVEN') ? 'bez' : 'a'} piekarnik${taxonomy.equipment.includes('OVEN') ? 'a w krokach' : ' w krokach bez OVEN'}`,
    );

  // ── składniki i makro ──
  const seen = new Set<string>();
  const allergens = new Set<string>();
  const dietTags = new Set<string>();
  const items = def.ingredients.map(([name, amount, unit]) => {
    const norm = normalizeText(name);
    if (seen.has(norm)) errors.push(`${where}: składnik „${name}" dwa razy`);
    seen.add(norm);
    if (FORBIDDEN.test(name))
      errors.push(`${where}: zakazany składnik „${name}"`);
    if (!['g', 'ml', 'szt'].includes(unit))
      errors.push(`${where}: jednostka „${unit}" (tylko g, ml, szt)`);
    if (!(amount > 0)) errors.push(`${where}: ilość „${name}" ≤ 0`);
    const tag = tagsByNorm.get(norm);
    if (!tag)
      errors.push(
        `${where}: nieznany składnik „${name}" (dodaj do ADDITIONS albo użyj nazwy ze słownika)`,
      );
    if (tag && tag.name !== name)
      errors.push(`${where}: pisz „${tag.name}", nie „${name}"`);
    for (const a of tag?.allergens ?? []) allergens.add(a);
    for (const d of tag?.dietTags ?? []) dietTags.add(d);
    const nut = nutritionByNorm.get(norm);
    if (tag && !nut) errors.push(`${where}: brak makro dla „${name}"`);
    if (nut && unit !== 'szt' && nut.unit !== unit)
      errors.push(
        `${where}: „${name}" liczony w ${nut.unit}, a przepis podaje ${unit}`,
      );
    if (unit === 'szt' && nut && !nut.gramsPerPiece)
      errors.push(
        `${where}: „${name}" nie ma wagi sztuki — podaj w ${nut.unit}`,
      );
    let normalized = {
      normalizedAmount: amount,
      normalizedUnit: unit as string,
    };
    try {
      normalized = normalizeIngredientAmount(
        name,
        tag?.category ?? 'inne',
        amount,
        unit,
      );
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
            sugars: nut.sugars ?? 0,
            fat: nut.fat,
            saturatedFat: nut.saturatedFat ?? 0,
            fiber: nut.fiber,
            sodiumMg: nut.sodiumMg ?? 0,
            gramsPerPiece: nut.gramsPerPiece ?? null,
          }
        : null,
    };
  });

  const totals = computeRecipeNutrition(items).totals;
  const columns = nutritionColumnsFromIngredients(items, 0);
  const s = Math.max(1, def.servings);
  const per = {
    kcal: totals.kcal / s,
    protein: totals.protein / s,
    carbs: totals.carbs / s,
    sugars: totals.sugars / s,
    fat: totals.fat / s,
    salt: (totals.sodiumMg * 0.0025) / s,
  };
  if (columns.ok && section) {
    const [min, max] = section.kcal;
    if (per.kcal < min || per.kcal > max)
      errors.push(
        `${where}: ${Math.round(per.kcal)} kcal/porcja poza ${min}–${max} (${section.label})`,
      );
    if (per.salt > SALT_MAX)
      errors.push(
        `${where}: ${round1(per.salt)} g soli/porcja (max ${SALT_MAX})`,
      );
    else if (per.salt > SALT_WARN)
      warnings.push(`${where}: ${round1(per.salt)} g soli/porcja`);
    if (section.prefix === 'OB' && per.protein < 15)
      warnings.push(
        `${where}: tylko ${Math.round(per.protein)} g białka/porcja na obiad`,
      );
  }

  // ── obietnice listy ──
  if (!promise) errors.push(`${where}: klucza nie ma na zatwierdzonej liście`);
  if (promise) {
    if (normalizeText(promise.title) !== normalizeText(def.title))
      warnings.push(`${where}: tytuł różni się od listy („${promise.title}”)`);
    const labels = new Set(promise.labels);
    const expectCuisine = promise.labels
      .map((l) => LABEL_CUISINE[l])
      .find(Boolean);
    if (expectCuisine && def.cuisine !== expectCuisine)
      errors.push(
        `${where}: lista mówi ${expectCuisine}, a kuchnia to ${def.cuisine}`,
      );
    if (!expectCuisine && !['POLISH', 'OTHER'].includes(def.cuisine))
      errors.push(
        `${where}: kuchnia ${def.cuisine} spoza listy — tu POLISH albo OTHER`,
      );
    const need = (
      map: Record<string, string>,
      have: string[],
      what: string,
    ) => {
      for (const l of promise.labels)
        if (map[l] && !have.includes(map[l]))
          errors.push(`${where}: lista obiecuje ${what} ${map[l]}`);
    };
    need(LABEL_SEASON, taxonomy.seasons, 'porę roku');
    need(LABEL_EQUIPMENT, taxonomy.equipment, 'sprzęt');
    need(LABEL_OCCASION, taxonomy.occasions, 'okazję');
    need(LABEL_FEATURE, taxonomy.features, 'cechę');
    const has = (t: string) => dietTags.has(t);
    if (
      labels.has('wegańskie') &&
      (has('MEAT') ||
        has('FISH') ||
        has('CRUSTACEAN') ||
        has('DAIRY') ||
        has('EGG') ||
        has('ANIMAL_OTHER'))
    )
      errors.push(
        `${where}: obiecane wegańskie, a skład ma ${[...dietTags].filter((t) => ['MEAT', 'FISH', 'CRUSTACEAN', 'DAIRY', 'EGG', 'ANIMAL_OTHER'].includes(t)).join(', ')}`,
      );
    if (
      labels.has('wegetariańskie') &&
      (has('MEAT') || has('FISH') || has('CRUSTACEAN'))
    )
      errors.push(`${where}: obiecane wegetariańskie, a skład ma mięso/rybę`);
    if (labels.has('ryba') && !has('FISH'))
      errors.push(`${where}: obiecana ryba, a jej nie ma`);
    if (labels.has('krewetki') && !has('CRUSTACEAN'))
      errors.push(`${where}: obiecane krewetki, a ich nie ma`);
    if (labels.has('bez glutenu') && allergens.has('gluten'))
      errors.push(`${where}: obiecane bez glutenu, a skład ma gluten`);
    if (labels.has('bez mleka') && allergens.has('milk'))
      errors.push(`${where}: obiecane bez mleka, a skład ma nabiał`);
    if (columns.ok) {
      if (labels.has('keto') && per.carbs > 20)
        errors.push(
          `${where}: obiecane keto, a ${Math.round(per.carbs)} g węgli/porcja (max 20)`,
        );
      if (
        labels.has('wysokobiałkowe') &&
        per.kcal > 0 &&
        (per.protein * 4) / per.kcal < 0.2
      )
        errors.push(
          `${where}: obiecane wysokobiałkowe, a białko to ${Math.round(((per.protein * 4) / per.kcal) * 100)}% energii (min 20%)`,
        );
      const light = section?.prefix === 'SN' ? 350 : 450;
      if (labels.has('lekkie') && per.kcal > light)
        errors.push(
          `${where}: obiecane lekkie, a ${Math.round(per.kcal)} kcal/porcja (max ${light})`,
        );
    }
    if (labels.has('do 30 min') && def.prepTimeMinutes > 30)
      errors.push(`${where}: obiecane do 30 min, a ${def.prepTimeMinutes} min`);
  }

  const id = stableUuid(def.plan);
  const nutrition = columns.ok
    ? {
        kcal: columns.columns.nutritionKcal,
        protein: columns.columns.nutritionProtein,
        carbs: columns.columns.nutritionCarbs,
        sugars: columns.columns.nutritionSugars,
        fat: columns.columns.nutritionFat,
        saturatedFat: columns.columns.nutritionSaturatedFat,
        fiber: columns.columns.nutritionFiber,
        salt: columns.columns.nutritionSalt,
        addedSalt: 0,
      }
    : {
        kcal: 0,
        protein: 0,
        carbs: 0,
        sugars: 0,
        fat: 0,
        saturatedFat: 0,
        fiber: 0,
        salt: 0,
        addedSalt: 0,
      };
  const draft: CatalogRecipeInput = {
    id,
    title: def.title,
    description: def.description,
    mealType: def.mealType,
    suitableMealTypes: [def.mealType, ...(def.extraMealTypes ?? [])],
    difficulty: def.difficulty,
    prepTimeMinutes: def.prepTimeMinutes,
    servings: def.servings,
    ...taxonomy,
    nutrition,
    steps: def.steps.map((instruction, i) => ({ step: i + 1, instruction })),
    ingredients: def.ingredients.map(([ingredientName, amount, unit]) => ({
      ingredientName,
      amount,
      unit,
    })),
    image: {
      prompt: buildRecipeImagePrompt(def.photo, def.vessel ?? 'plate'),
      imageUrl: RECIPE_IMAGE_PLACEHOLDER_URL,
    },
  };
  // Sloty jak w imporcie (`catalogRecipeColumns`): ręczne ponad próg wypadają,
  // klasyfikator dokłada swoje.
  const overLimit = overLimitManualSlots(draft);
  if (overLimit.length)
    warnings.push(
      `${where}: pory ${overLimit.join(', ')} ponad próg kcal — wypadają`,
    );
  draft.suitableMealTypes = resolveSuitableMealTypes({
    title: draft.title,
    description: draft.description,
    mealType: draft.mealType,
    prepTimeMinutes: draft.prepTimeMinutes,
    servings: draft.servings,
    nutritionKcal: nutrition.kcal,
    suitableMealTypes: draft.suitableMealTypes?.filter(
      (slot) => !overLimit.includes(slot),
    ),
  }).filter((slot) => !overLimit.includes(slot));

  return {
    recipe: withCanonicalKeyOrder(draft),
    dish: { id, vessel: def.vessel ?? 'plate', dish: def.photo },
    report:
      `${def.plan} ${def.title} · ${Math.round(per.kcal)} kcal · B ${Math.round(per.protein)} / W ${Math.round(per.carbs)} ` +
      `(cukry ${Math.round(per.sugars)}) / T ${Math.round(per.fat)} g · sól ${round1(per.salt)} g · ${def.prepTimeMinutes} min · ` +
      `${def.cuisine}/${def.dishType} · ${[...allergens].sort().join(',') || '—'}`,
  };
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const partArg = args.includes('--part')
    ? args[args.indexOf('--part') + 1]
    : null;
  if (partArg && !PARTS[partArg])
    throw new Error(
      `Nieznana część „${partArg}" (${Object.keys(PARTS).join(', ')})`,
    );

  const errors: string[] = [];
  const warnings: string[] = [];
  const partNames = partArg ? [partArg] : Object.keys(PARTS);
  const list = loadList();
  if (list.size !== 572)
    warnings.push(`lista ma ${list.size} pozycji (oczekiwane 572)`);

  const modules = new Map<string, PartModule>();
  const common = loadModule('skladniki');
  if (common) modules.set('skladniki', common);
  // Składniki dodane w INNYCH częściach też mają być widoczne w --part.
  for (const part of Object.keys(PARTS)) {
    const mod = loadModule(part);
    if (mod) modules.set(part, mod);
    else if (partNames.includes(part))
      (partArg ? errors : warnings).push(`część ${part}: brak pliku`);
  }

  const tagsByNorm = new Map(
    TAGS.ingredients.map((t) => [t.normalizedName, t]),
  );
  const nutritionByNorm = new Map(
    NUTRITION.ingredients.map((n) => [n.normalizedName, n]),
  );
  const categories = new Set(TAGS.ingredients.map((t) => t.category));
  const newTags: TagEntry[] = [];
  const newNutrition: NutritionEntry[] = [];
  const additionSource = new Map<
    string,
    { source: string; addition: IngredientAddition }
  >();

  for (const [source, mod] of modules) {
    for (const addition of mod.ADDITIONS ?? []) {
      const norm = normalizeText(addition.name);
      const where = `${source}: składnik „${addition.name}"`;
      const earlier = additionSource.get(norm);
      if (earlier) {
        const a = earlier.addition.nutrition;
        const b = addition.nutrition;
        if (
          Math.abs(a.kcal - b.kcal) > Math.max(10, a.kcal * 0.1) ||
          a.unit !== b.unit
        )
          errors.push(
            `${where}: zdublowany z ${earlier.source} z innym makro — zostaw jeden wpis`,
          );
        continue;
      }
      additionSource.set(norm, { source, addition });
      const existingTag = tagsByNorm.get(norm);
      if (existingTag && existingTag.name !== addition.name)
        errors.push(`${where}: w katalogu jest jako „${existingTag.name}"`);
      if (nutritionByNorm.has(norm)) {
        const present = nutritionByNorm.get(norm)!;
        if (
          present.kcal !== addition.nutrition.kcal ||
          present.unit !== addition.nutrition.unit
        )
          errors.push(
            `${where}: ma już inne makro w tabeli — użyj istniejącego`,
          );
        continue;
      }
      const n = addition.nutrition;
      if (!['g', 'ml'].includes(n.unit))
        errors.push(`${where}: unit ${n.unit}`);
      const energy = n.protein * 4 + n.carbs * 4 + n.fat * 9 + n.fiber * 2;
      if (
        n.kcal > 20 &&
        Math.abs(energy - n.kcal) > Math.max(25, n.kcal * 0.15)
      )
        errors.push(
          `${where}: ${n.kcal} kcal nie zgadza się z makro (${Math.round(energy)})`,
        );
      if (
        [
          n.kcal,
          n.protein,
          n.carbs,
          n.sugars,
          n.fat,
          n.saturatedFat,
          n.fiber,
          n.sodiumMg,
        ].some((v) => !(v >= 0))
      )
        errors.push(`${where}: ujemna albo brakująca wartość`);
      if (n.sugars > n.carbs + 0.5 || n.saturatedFat > n.fat + 0.5)
        errors.push(`${where}: cukry > węgle albo nasycone > tłuszcz`);
      if (n.protein + n.carbs + n.fat + n.fiber > 101)
        errors.push(`${where}: makro > 100 g na 100 g`);
      if (!existingTag) {
        if (!addition.category || !categories.has(addition.category))
          errors.push(
            `${where}: nowy składnik wymaga category z ${[...categories].join(', ')}`,
          );
        const bad = [
          ...(addition.allergens ?? []).filter(
            (a) => !(ALLERGEN_IDS as readonly string[]).includes(a),
          ),
          ...(addition.dietTags ?? []).filter(
            (d) => !(DIET_TAG_IDS as readonly string[]).includes(d),
          ),
        ];
        if (bad.length)
          errors.push(`${where}: nieznane tagi ${bad.join(', ')}`);
        if (!addition.allergens || !addition.dietTags)
          errors.push(`${where}: nowy składnik wymaga allergens i dietTags`);
        const tag: TagEntry = {
          name: addition.name,
          normalizedName: norm,
          category: addition.category ?? 'inne',
          allergens: [...(addition.allergens ?? [])].sort(),
          dietTags: [...(addition.dietTags ?? [])],
          ...(addition.note ? { note: addition.note } : {}),
        };
        tagsByNorm.set(norm, tag);
        newTags.push(tag);
      }
      const entry: NutritionEntry = {
        normalizedName: norm,
        unit: n.unit,
        kcal: n.kcal,
        protein: n.protein,
        carbs: n.carbs,
        sugars: n.sugars,
        fat: n.fat,
        saturatedFat: n.saturatedFat,
        fiber: n.fiber,
        sodiumMg: n.sodiumMg,
        ...(n.gramsPerPiece ? { gramsPerPiece: n.gramsPerPiece } : {}),
      };
      nutritionByNorm.set(norm, entry);
      newNutrition.push(entry);
    }
  }

  // ─── przepisy ───
  const ours = new Set<string>();
  for (const key of list.keys()) ours.add(stableUuid(key));
  const existingTitles = new Map(
    FULL.recipes
      .filter((r) => !ours.has(r.id ?? ''))
      .map((r) => [normalizeText(r.title), r.id]),
  );
  const built = new Map<string, Built>();
  const titles = new Map<string, string>();
  for (const part of partNames) {
    const range = PARTS[part];
    for (const def of modules.get(part)?.DEFS ?? []) {
      const m = /^([A-Z]{2})-(\d{3})$/.exec(def.plan);
      if (
        !m ||
        m[1] !== range.prefix ||
        +m[2] < range.from ||
        +m[2] > range.to
      ) {
        errors.push(
          `[${def.plan}] ${def.title}: klucz spoza zakresu części ${part}`,
        );
        continue;
      }
      if (built.has(def.plan)) errors.push(`[${def.plan}]: klucz dwa razy`);
      const titleKey = normalizeText(def.title);
      if (existingTitles.has(titleKey))
        errors.push(
          `[${def.plan}] ${def.title}: taki tytuł już jest w katalogu`,
        );
      if (titles.has(titleKey))
        errors.push(
          `[${def.plan}] ${def.title}: tytuł powtarza ${titles.get(titleKey)}`,
        );
      titles.set(titleKey, def.plan);
      built.set(
        def.plan,
        buildRecipe(
          def,
          list.get(def.plan),
          tagsByNorm,
          nutritionByNorm,
          errors,
          warnings,
        ),
      );
    }
    const missing: string[] = [];
    for (let i = range.from; i <= range.to; i++) {
      const key = `${range.prefix}-${String(i).padStart(3, '0')}`;
      if (!built.has(key)) missing.push(key);
    }
    if (missing.length)
      (partArg ? errors : warnings).push(
        `część ${part}: brak ${missing.join(', ')}`,
      );
  }

  for (const b of built.values()) console.log(b.report);
  if (newNutrition.length)
    console.log(
      `\nnowe składniki: ${newNutrition.length} makro, ${newTags.length} nazw`,
    );
  if (warnings.length)
    console.log(`\nUWAGI (${warnings.length}):\n${warnings.join('\n')}`);
  if (errors.length) {
    console.error(`\nBŁĘDY (${errors.length}):\n${errors.join('\n')}`);
    process.exit(1);
  }
  console.log(`\nOK: ${built.size} przepisów bez błędów`);
  if (!write) return;

  // ─── zapis ───
  for (const tag of newTags) {
    const txt = join(CATALOG_DIR, `ingredients-${tag.category}-pl-v1.txt`);
    const raw = readFileSync(txt, 'utf8');
    if (!raw.split('\n').some((l) => normalizeText(l) === tag.normalizedName))
      writeFileSync(
        txt,
        `${raw.endsWith('\n') ? raw : `${raw}\n`}${tag.name}\n`,
      );
  }
  writeFileSync(
    TAGS_PATH,
    appendArrayText(readFileSync(TAGS_PATH, 'utf8'), 'ingredients', newTags),
  );
  writeFileSync(
    NUTRITION_PATH,
    appendArrayText(
      readFileSync(NUTRITION_PATH, 'utf8'),
      'ingredients',
      newNutrition,
    ),
  );

  const oursNow = [...built.values()];
  const ids = new Set(oursNow.map((b) => b.recipe.id));
  const merged = [
    ...FULL.recipes
      .filter((r) => !ids.has(r.id ?? ''))
      .map(withCanonicalKeyOrder),
    ...oursNow.map((b) => b.recipe),
  ];
  writeFileSync(
    FULL_PATH,
    formatCatalogFile({ ...buildCatalogFile(merged), version: FULL.version }),
  );

  const dishes = JSON.parse(readFileSync(DISHES_PATH, 'utf8')) as {
    id: string;
  }[];
  const keptDishes = dishes.filter((d) => !ids.has(d.id));
  writeFileSync(
    DISHES_PATH,
    `${JSON.stringify([...keptDishes, ...oursNow.map((b) => b.dish)], null, 1)}\n`,
  );
  console.log(
    `zapisano: ${newTags.length} nowych składników; katalog ${merged.length} przepisów (${oursNow.length} z partii)`,
  );
}

main();
