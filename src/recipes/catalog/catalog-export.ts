/**
 * Eksport katalogu z bazy do `prisma/catalog/recipes-catalog-full-v2.json`
 * (decyzja D1, 25.09.2026: baza = źródło prawdy, plik = jej wierne odbicie
 * w repo, aktualizowane nocnym PR-em z serwisu `catalog-sync`).
 *
 * Eksport oddaje pola WEJŚCIOWE importu, nie wyliczone: bez alergenów i tagów
 * diet (import policzy je z powrotem z tagów składników), za to z makro
 * (import bierze je z pliku), z pełną listą slotów i z `isActive: false`
 * dla wycofanych. Właściwość, której pilnuje test obiegu: plik → import →
 * eksport = ten sam plik, bajt w bajt.
 *
 * Format jest KANONICZNY, bo baza nie pamięta układu dawnego pliku:
 *   - przepisy po porze dnia (`MEAL_TYPES_IN_DAY_ORDER`), potem po tytule
 *     (polski porządek), remis po id — nowy przepis ląduje w swoim miejscu,
 *     a diff PR-a pokazuje tylko jego;
 *   - klucze zawsze w jednej kolejności (`id` pierwsze);
 *   - składniki w kolejności przepisu (`[createdAt, id]`, jak w aplikacji);
 *   - wcięcie 2, LF, znak nowej linii na końcu, tablice napisów w jednej
 *     linii, gdy mieszczą się w 80 kolumnach — czyli dokładnie to, co zostawia
 *     prettier (lint-staged formatuje `*.json`), więc ręczny commit nie
 *     przeformatuje pliku.
 */
import { MealType, Prisma } from '@prisma/client';
import {
  effectiveSuitableMealTypes,
  MEAL_TYPES_IN_DAY_ORDER,
} from '../../common/meal-types';
import { comparePolish } from '../../common/polish-order';
import { stepsFromInstructions } from '../recipe-steps.util';
import {
  CATALOG_DEFAULT_SOURCE_PROVIDER,
  type CatalogFile,
  type CatalogIngredientRow,
  type CatalogRecipeColumns,
  type CatalogRecipeInput,
} from './catalog-recipe';

/** Wersja zapisywana w pliku eksportu. */
export const CATALOG_EXPORT_VERSION = 'v2-baza';

/** Kolumny, z których powstaje wpis pliku (`catalogEntryFromRow`). */
export const catalogExportSelect = {
  id: true,
  isActive: true,
  title: true,
  description: true,
  mealType: true,
  suitableMealTypes: true,
  difficulty: true,
  prepTimeMinutes: true,
  servings: true,
  nutritionKcal: true,
  nutritionProtein: true,
  nutritionCarbs: true,
  nutritionFat: true,
  nutritionFiber: true,
  nutritionSalt: true,
  nutritionSaltAdded: true,
  sourceProvider: true,
  sourceRecipeId: true,
  sourceInstructions: true,
  sourceMeta: true,
  imageUrl: true,
  ingredients: {
    // Ta sama kolejność co w aplikacji i w panelu.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      amount: true,
      unit: true,
      // Nazwa ze SŁOWNIKA, nie migawka z linii: po zmianie nazwy składnika
      // import szuka po aktualnej.
      ingredient: { select: { name: true } },
    },
  },
} satisfies Prisma.RecipeSelect;

export type CatalogExportRow = Prisma.RecipeGetPayload<{
  select: typeof catalogExportSelect;
}>;

/** To, czego `catalogEntryFromRow` potrzebuje — wiersz z bazy albo zapis w locie. */
export type CatalogEntrySource = Omit<CatalogExportRow, 'ingredients'> & {
  ingredients: Array<{
    amount: number;
    unit: string;
    ingredient: { name: string };
  }>;
};

function imagePromptOf(sourceMeta: Prisma.JsonValue | null): string {
  if (
    sourceMeta &&
    typeof sourceMeta === 'object' &&
    !Array.isArray(sourceMeta)
  ) {
    const prompt = (sourceMeta as Record<string, unknown>).imagePrompt;
    if (typeof prompt === 'string') return prompt;
  }
  return '';
}

/**
 * Wiersz `Recipe` → wpis pliku katalogu z kluczami w kanonicznej kolejności.
 *
 * Sloty idą ZAWSZE, pełną listą z bazy (panel je edytuje, to pole bazy, nie
 * pochodna). Import je rozszerza klasyfikatorem (`resolveSuitableMealTypes` =
 * lista ∪ podpowiedzi), a lista z bazy już zawiera podpowiedzi z chwili
 * zapisu — obieg plik → import → eksport jej nie zmienia. Rozjazd pokazuje
 * się dopiero po zmianie progów klasyfikatora i jest wtedy prawdziwą różnicą.
 */
export function catalogEntryFromRow(
  row: CatalogEntrySource,
): CatalogRecipeInput {
  const description = row.description ?? '';
  const provider =
    row.sourceProvider && row.sourceProvider !== CATALOG_DEFAULT_SOURCE_PROVIDER
      ? row.sourceProvider
      : undefined;
  return {
    id: row.id,
    ...(row.isActive ? {} : { isActive: false }),
    title: row.title,
    description,
    mealType: row.mealType,
    suitableMealTypes: effectiveSuitableMealTypes(row),
    difficulty: row.difficulty,
    prepTimeMinutes: row.prepTimeMinutes,
    servings: row.servings,
    nutrition: {
      kcal: row.nutritionKcal,
      protein: row.nutritionProtein,
      carbs: row.nutritionCarbs,
      fat: row.nutritionFat,
      fiber: row.nutritionFiber,
      salt: row.nutritionSalt,
      addedSalt: row.nutritionSaltAdded,
    },
    ...(provider ? { sourceProvider: provider } : {}),
    ...(row.sourceRecipeId ? { sourceRecipeId: row.sourceRecipeId } : {}),
    steps: stepsFromInstructions(row.sourceInstructions).map(
      (instruction, index) => ({ step: index + 1, instruction }),
    ),
    ingredients: row.ingredients.map((line) => ({
      ingredientName: line.ingredient.name,
      amount: line.amount,
      unit: line.unit,
    })),
    image: {
      prompt: imagePromptOf(row.sourceMeta),
      imageUrl: row.imageUrl ?? null,
    },
  };
}

/**
 * Wpis, który wyszedłby z eksportu PO zapisie tych kolumn — bez zapisu.
 * Import porównuje nim plik z bazą, a panel liczy listę zmienionych pól.
 */
export function catalogEntryFromColumns(
  id: string,
  columns: CatalogRecipeColumns,
  rows: readonly CatalogIngredientRow[],
  imageUrl: string | null,
): CatalogRecipeInput {
  return catalogEntryFromRow({
    id,
    isActive: columns.isActive,
    title: columns.title,
    description: columns.description,
    mealType: columns.mealType,
    suitableMealTypes: columns.suitableMealTypes,
    difficulty: columns.difficulty,
    prepTimeMinutes: columns.prepTimeMinutes,
    servings: columns.servings,
    nutritionKcal: columns.nutritionKcal,
    nutritionProtein: columns.nutritionProtein,
    nutritionCarbs: columns.nutritionCarbs,
    nutritionFat: columns.nutritionFat,
    nutritionFiber: columns.nutritionFiber,
    nutritionSalt: columns.nutritionSalt,
    nutritionSaltAdded: columns.nutritionSaltAdded,
    sourceProvider: columns.sourceProvider,
    sourceRecipeId: columns.sourceRecipeId,
    sourceInstructions: columns.sourceInstructions,
    sourceMeta: columns.sourceMeta,
    imageUrl,
    ingredients: rows.map((row) => ({
      amount: row.amount,
      unit: row.unit,
      ingredient: { name: row.name },
    })),
  });
}

const MEAL_ORDER = new Map<MealType, number>(
  MEAL_TYPES_IN_DAY_ORDER.map((mealType, index) => [mealType, index]),
);

/** Kanoniczna kolejność przepisów w pliku: pora dnia → tytuł → id. */
export function compareCatalogEntries(
  a: CatalogRecipeInput,
  b: CatalogRecipeInput,
): number {
  return (
    (MEAL_ORDER.get(a.mealType) ?? 99) - (MEAL_ORDER.get(b.mealType) ?? 99) ||
    comparePolish(
      { text: a.title, id: a.id ?? '' },
      { text: b.title, id: b.id ?? '' },
    )
  );
}

export function buildCatalogFile(
  entries: readonly CatalogRecipeInput[],
): CatalogFile {
  return {
    version: CATALOG_EXPORT_VERSION,
    recipes: [...entries].sort(compareCatalogEntries),
  };
}

const PRINT_WIDTH = 80;

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

/**
 * JSON w układzie, który prettier (parser `json`, szerokość 80) zostawia bez
 * zmian: obiekty zawsze rozpisane, tablica samych prostych wartości w jednej
 * linii, jeśli razem z kluczem, wcięciem i przecinkiem mieści się w 80
 * kolumnach, inaczej element pod elementem.
 */
function render(
  value: unknown,
  indent: string,
  prefixWidth: number,
  trailing: string,
): string {
  if (isPrimitive(value)) return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isPrimitive)) {
      const flat = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
      if (prefixWidth + flat.length + trailing.length <= PRINT_WIDTH) {
        return flat;
      }
    }
    const items = value.map(
      (item, index) =>
        inner +
        render(item, inner, inner.length, index < value.length - 1 ? ',' : ''),
    );
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== undefined,
  );
  if (entries.length === 0) return '{}';
  const lines = entries.map(([key, item], index) => {
    const head = `${inner}${JSON.stringify(key)}: `;
    return (
      head +
      render(item, inner, head.length, index < entries.length - 1 ? ',' : '')
    );
  });
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

/** Tekst pliku katalogu: kanoniczny układ, LF, nowa linia na końcu. */
export function formatCatalogFile(file: CatalogFile): string {
  return `${render(file, '', 0, '')}\n`;
}

export type CatalogChange = {
  id: string;
  title: string;
  /** Pola, które się różnią (klucze wpisu, bez treści). */
  fields: string[];
};

export type CatalogDiff = {
  /** Są w `after`, nie ma ich w `before`. */
  added: CatalogChange[];
  /** Były w `before`, nie ma ich w `after`. */
  removed: CatalogChange[];
  /** Aktywne w `before`, wycofane w `after`. */
  retired: CatalogChange[];
  /** Wycofane w `before`, aktywne w `after`. */
  restored: CatalogChange[];
  /** Pozostałe różnice treści. */
  changed: CatalogChange[];
};

const ENTRY_FIELDS: readonly (keyof CatalogRecipeInput)[] = [
  'title',
  'description',
  'mealType',
  'suitableMealTypes',
  'difficulty',
  'prepTimeMinutes',
  'servings',
  'nutrition',
  'sourceProvider',
  'sourceRecipeId',
  'steps',
  'ingredients',
  'image',
];

function ingredientsKey(
  ingredients: CatalogRecipeInput['ingredients'],
  ignoreOrder: boolean,
): string {
  const lines = ingredients.map((line) =>
    JSON.stringify([line.ingredientName, line.amount, line.unit]),
  );
  return JSON.stringify(ignoreOrder ? [...lines].sort() : lines);
}

/** Czy dwie listy składników są te same (nazwa, ilość, jednostka). */
export function sameIngredientLines(
  a: CatalogRecipeInput['ingredients'],
  b: CatalogRecipeInput['ingredients'],
  options: { ignoreOrder?: boolean } = {},
): boolean {
  return (
    ingredientsKey(a, !!options.ignoreOrder) ===
    ingredientsKey(b, !!options.ignoreOrder)
  );
}

/** Pola wpisu, które się różnią (bez `isActive` — to osobna kategoria). */
export function changedCatalogFields(
  before: CatalogRecipeInput,
  after: CatalogRecipeInput,
  options: { ignoreIngredientOrder?: boolean } = {},
): string[] {
  return ENTRY_FIELDS.filter((field) => {
    if (field === 'ingredients') {
      return (
        ingredientsKey(before.ingredients, !!options.ignoreIngredientOrder) !==
        ingredientsKey(after.ingredients, !!options.ignoreIngredientOrder)
      );
    }
    return JSON.stringify(before[field]) !== JSON.stringify(after[field]);
  });
}

/**
 * Różnice między dwoma zestawami wpisów (po `id`). Wpisy mają być w tym
 * samym, kanonicznym kształcie — np. oba z `catalogEntryFromRow` albo oba
 * z plików eksportu.
 */
export function diffCatalog(
  before: readonly CatalogRecipeInput[],
  after: readonly CatalogRecipeInput[],
  options: { ignoreIngredientOrder?: boolean } = {},
): CatalogDiff {
  const diff: CatalogDiff = {
    added: [],
    removed: [],
    retired: [],
    restored: [],
    changed: [],
  };
  const beforeById = new Map(before.map((entry) => [entry.id ?? '', entry]));
  const afterIds = new Set(after.map((entry) => entry.id ?? ''));
  const sorted = [...after].sort(compareCatalogEntries);
  for (const entry of sorted) {
    const id = entry.id ?? '';
    const previous = beforeById.get(id);
    if (!previous) {
      diff.added.push({ id, title: entry.title, fields: [] });
      continue;
    }
    const wasActive = previous.isActive !== false;
    const isActive = entry.isActive !== false;
    if (wasActive && !isActive) {
      diff.retired.push({ id, title: entry.title, fields: [] });
    } else if (!wasActive && isActive) {
      diff.restored.push({ id, title: entry.title, fields: [] });
    }
    const fields = changedCatalogFields(previous, entry, options);
    if (fields.length > 0) {
      diff.changed.push({ id, title: entry.title, fields });
    }
  }
  for (const entry of [...before].sort(compareCatalogEntries)) {
    if (!afterIds.has(entry.id ?? '')) {
      diff.removed.push({ id: entry.id ?? '', title: entry.title, fields: [] });
    }
  }
  return diff;
}

export function isCatalogDiffEmpty(diff: CatalogDiff): boolean {
  return (
    diff.added.length +
      diff.removed.length +
      diff.retired.length +
      diff.restored.length +
      diff.changed.length ===
    0
  );
}

/**
 * Opis różnic po polsku — treść commita i PR-a bota `catalog-sync` oraz
 * komunikat odmowy importu. Tytuły przepisów (publiczny katalog), bez
 * danych kogokolwiek.
 */
export function describeCatalogDiff(
  diff: CatalogDiff,
  options: { limit?: number } = {},
): string {
  const limit = options.limit ?? 50;
  const sections: Array<[string, CatalogChange[]]> = [
    ['Dodane', diff.added],
    ['Zmienione', diff.changed],
    ['Wycofane', diff.retired],
    ['Przywrócone', diff.restored],
    ['Usunięte z bazy', diff.removed],
  ];
  const lines: string[] = [];
  for (const [label, items] of sections) {
    if (items.length === 0) continue;
    lines.push(`${label} (${items.length}):`);
    for (const item of items.slice(0, limit)) {
      lines.push(
        `- ${item.title}${item.fields.length ? ` [${item.fields.join(', ')}]` : ''}`,
      );
    }
    if (items.length > limit) {
      lines.push(`- … i ${items.length - limit} więcej`);
    }
  }
  return lines.join('\n');
}

/** Jedna linia liczb, np. „zmienione 3, dodane 1, wycofane 0”. */
export function summarizeCatalogDiff(diff: CatalogDiff): string {
  return [
    `zmienione ${diff.changed.length}`,
    `dodane ${diff.added.length}`,
    `wycofane ${diff.retired.length}`,
    ...(diff.restored.length ? [`przywrócone ${diff.restored.length}`] : []),
    ...(diff.removed.length ? [`usunięte ${diff.removed.length}`] : []),
  ].join(', ');
}

/**
 * Ten sam wpis z kluczami w kanonicznej kolejności (jak `catalogEntryFromRow`).
 * Do sprawdzania, czy plik w repo jest w formacie eksportu.
 */
export function withCanonicalKeyOrder(
  entry: CatalogRecipeInput,
): CatalogRecipeInput {
  return {
    id: entry.id,
    ...(entry.isActive === undefined ? {} : { isActive: entry.isActive }),
    title: entry.title,
    description: entry.description,
    mealType: entry.mealType,
    ...(entry.suitableMealTypes === undefined
      ? {}
      : { suitableMealTypes: entry.suitableMealTypes }),
    difficulty: entry.difficulty,
    prepTimeMinutes: entry.prepTimeMinutes,
    servings: entry.servings,
    nutrition: {
      kcal: entry.nutrition.kcal,
      protein: entry.nutrition.protein,
      carbs: entry.nutrition.carbs,
      fat: entry.nutrition.fat,
      fiber: entry.nutrition.fiber,
      salt: entry.nutrition.salt,
      ...(entry.nutrition.addedSalt === undefined
        ? {}
        : { addedSalt: entry.nutrition.addedSalt }),
    },
    ...(entry.sourceProvider === undefined
      ? {}
      : { sourceProvider: entry.sourceProvider }),
    ...(entry.sourceRecipeId === undefined
      ? {}
      : { sourceRecipeId: entry.sourceRecipeId }),
    steps: entry.steps.map((step) => ({
      step: step.step,
      instruction: step.instruction,
    })),
    ingredients: entry.ingredients.map((line) => ({
      ingredientName: line.ingredientName,
      amount: line.amount,
      unit: line.unit,
    })),
    image: { prompt: entry.image.prompt, imageUrl: entry.image.imageUrl },
  };
}

/**
 * Strażnik importu (D1): z różnic `diffCatalog(plik, baza)` wybiera te, które
 * istnieją TYLKO w bazie — przepis, którego plik nie zna (`added`),
 * wycofanie/przywrócenie i każda różnica treści (nie wiadomo, po której
 * stronie zaszła, więc zakładamy gorszy wariant). Przepisy z pliku, których
 * baza nie ma (`removed`), to zwykłe dodanie. Import przechodzi, gdy takich
 * zmian nie ma albo `confirm` = dzisiejsza data (`RECIPE_IMPORT_FROM_JSON_CONFIRM`).
 */
export function importGuard(
  fileVsDatabase: CatalogDiff,
  confirm: string | undefined,
  now: Date = new Date(),
): {
  allowed: boolean;
  confirmed: boolean;
  databaseOnly: CatalogDiff;
  count: number;
  today: string;
} {
  const databaseOnly: CatalogDiff = {
    added: fileVsDatabase.added,
    removed: [],
    retired: fileVsDatabase.retired,
    restored: fileVsDatabase.restored,
    changed: fileVsDatabase.changed,
  };
  const count =
    databaseOnly.added.length +
    databaseOnly.retired.length +
    databaseOnly.restored.length +
    databaseOnly.changed.length;
  const today = now.toISOString().slice(0, 10);
  const confirmed = (confirm ?? '').trim() === today;
  return {
    allowed: count === 0 || confirmed,
    confirmed: count > 0 && confirmed,
    databaseOnly,
    count,
    today,
  };
}
