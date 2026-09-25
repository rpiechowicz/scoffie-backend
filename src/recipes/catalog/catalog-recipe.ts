/**
 * Zapis przepisu WSPÓLNEGO katalogu — jedna ścieżka dla importu z pliku
 * (`scripts/import-recipes-from-json.ts`) i edycji w panelu
 * (`PUT /admin/catalog/recipes/:id`).
 *
 * Od decyzji D1 (25.09.2026, ROADMAPA §9) źródłem prawdy katalogu jest baza,
 * a `prisma/catalog/recipes-catalog-full-v2.json` jej eksportem. Żeby eksport
 * dało się zaimportować z powrotem bez zmiany ani jednego wiersza, import
 * i panel MUSZĄ liczyć kolumny tą samą funkcją: normalizacja ilości,
 * alergeny i tagi diet (unia tagów składników), sloty (`suitableMealTypes`),
 * kroki, kolejność składników. Stąd ten moduł — bez Nesta, z Prismą tylko
 * jako typem klienta.
 */
import { Difficulty, MealType, Prisma } from '@prisma/client';
import { deriveRecipeTags } from '../../common/diet-tags';
import { MEAL_TYPE_VALUES } from '../../common/meal-types';
import {
  ALLOWED_UNITS,
  normalizeIngredientAmount,
  normalizeText,
} from '../ingredient-amount.util';
import type { IngredientNutritionPer100 } from '../recipe-nutrition.util';
import {
  kcalPerServing,
  resolveSuitableMealTypes,
  snackKcalLimit,
} from '../suitable-meal-types.util';

/** Przepis w pliku katalogu — kształt WEJŚCIA importu i WYJŚCIA eksportu. */
export type CatalogRecipeInput = {
  id?: string;
  /**
   * Wycofanie z katalogu (`Recipe.isActive = false`, panel: „Wycofaj”).
   * Eksport pisze pole WYŁĄCZNIE dla wycofanych; brak = aktywny.
   */
  isActive?: boolean;
  title: string;
  description: string;
  mealType: MealType;
  /**
   * Sloty, w których danie ma sens. Import dokłada do nich podpowiedzi
   * klasyfikatora (`resolveSuitableMealTypes`); pominięte = same podpowiedzi.
   * Eksport pisze zawsze pełną listę z bazy.
   */
  suitableMealTypes?: MealType[];
  difficulty: Difficulty;
  prepTimeMinutes: number;
  servings: number;
  nutrition: {
    kcal: number;
    protein: number;
    carbs: number;
    fat: number;
    fiber: number;
    /** Sól ŁĄCZNIE (g na przepis). */
    salt: number;
    /** Sól DODANA (g na przepis); brak = 0. */
    addedSalt?: number;
  };
  /**
   * Zewnętrzne źródło (np. `cookidoo` + `r56899`) — przeżywa każdy re-import,
   * inaczej znikałby przycisk „Gotuj w Thermomixie”.
   */
  sourceProvider?: string;
  sourceRecipeId?: string;
  steps: Array<{ step: number; instruction: string }>;
  ingredients: Array<{ ingredientName: string; amount: number; unit: string }>;
  image: { prompt: string; imageUrl: string | null };
};

export type CatalogFile = { version: string; recipes: CatalogRecipeInput[] };

/** Plik katalogu w repo (eksport z bazy, wejście bootstrapu świeżej bazy). */
export const CATALOG_FILE_PATH = 'prisma/catalog/recipes-catalog-full-v2.json';

/** Dostawca wpisywany, gdy plik go nie podaje — eksport go pomija. */
export const CATALOG_DEFAULT_SOURCE_PROVIDER = 'manual-json-v1';

/**
 * Ręczny slot z pliku ma prawo przekroczyć próg klasyfikatora o połowę
 * (koktajl 370 kcal jako przekąska to świadoma decyzja redaktora), ale nie
 * dwukrotnie (pierogi 900 kcal jako podwieczorek to błąd w danych).
 */
export const MANUAL_SLOT_KCAL_TOLERANCE = 1.5;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DIFFICULTIES: readonly string[] = ['EASY', 'MEDIUM', 'HARD'];

/** Błąd danych przepisu — z listą konkretów (panel oddaje je jako `details`). */
export class CatalogRecipeError extends Error {
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(details.length ? `${message} ${details.join('; ')}` : message);
    this.name = 'CatalogRecipeError';
  }
}

/**
 * Reguły poprawności przepisu katalogu (dawniej `validateBatch` w imporcie).
 * Zwraca listę naruszeń; pusta = poprawny. Panel waliduje to samo po DTO —
 * reguła „servings 1..8” czy „jednostka z listy” nie może mieć dwóch wersji.
 */
export function validateCatalogRecipe(recipe: CatalogRecipeInput): string[] {
  const problems: string[] = [];
  const title = recipe.title?.trim() ? recipe.title : '(bez tytułu)';
  if (!recipe.id?.trim()) {
    problems.push(
      `"${title}": brak jawnego id (UUID) — import nie nadaje id z puli.`,
    );
  } else if (!UUID_PATTERN.test(recipe.id.trim())) {
    problems.push(`"${title}": id "${recipe.id}" nie jest UUID.`);
  }
  if (!recipe.title?.trim()) problems.push('Tytuł przepisu jest wymagany.');
  if (!MEAL_TYPE_VALUES.includes(recipe.mealType)) {
    problems.push(`"${title}": zły mealType.`);
  }
  if (
    recipe.suitableMealTypes?.some(
      (mealType) => !MEAL_TYPE_VALUES.includes(mealType),
    )
  ) {
    problems.push(`"${title}": zły suitableMealTypes.`);
  }
  if (!DIFFICULTIES.includes(recipe.difficulty)) {
    problems.push(`"${title}": zła trudność.`);
  }
  if (
    recipe.isActive !== undefined &&
    typeof (recipe.isActive as unknown) !== 'boolean'
  ) {
    problems.push(`"${title}": isActive musi być true/false.`);
  }
  // Porcje = na ile osób NAPISANY jest przepis. Katalog długo wymuszał 2,
  // przez co partie na 4 (pierogi, gołąbki) pokazywały 950–1290 kcal „na
  // porcję”. Zakres 1–8 zostawia miejsce na realne wydajności.
  if (
    !Number.isInteger(recipe.servings) ||
    recipe.servings < 1 ||
    recipe.servings > 8
  ) {
    problems.push(
      `"${title}": servings musi być liczbą całkowitą 1..8 (jest ${String(recipe.servings)}).`,
    );
  }
  if (!Number.isInteger(recipe.prepTimeMinutes) || recipe.prepTimeMinutes < 0) {
    problems.push(`"${title}": zły czas przygotowania.`);
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    problems.push(`"${title}": przepis musi mieć kroki.`);
  } else if (
    recipe.steps.some(
      (step) =>
        typeof step?.instruction !== 'string' || !step.instruction.trim(),
    )
  ) {
    problems.push(`"${title}": pusty krok.`);
  }
  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
    problems.push(`"${title}": przepis musi mieć składniki.`);
    return problems;
  }
  for (const ingredient of recipe.ingredients) {
    if (!ingredient.ingredientName?.trim()) {
      problems.push(`"${title}": składnik bez nazwy.`);
      continue;
    }
    if (!(ingredient.amount > 0) || !Number.isFinite(ingredient.amount)) {
      problems.push(
        `"${title}": zła ilość dla "${ingredient.ingredientName}".`,
      );
    }
    if (!ALLOWED_UNITS.has(ingredient.unit)) {
      problems.push(
        `"${title}": zła jednostka "${ingredient.unit}" dla "${ingredient.ingredientName}".`,
      );
    }
  }
  return problems;
}

/** Składnik słownika, na który wskazuje linia przepisu. */
export type CatalogIngredientRef = {
  id: string;
  name: string;
  normalizedName: string;
  category: string;
  allergens: string[];
  dietTags: string[];
  /** `null` = brak makro na 100 g (luka w danych). */
  nutrition: IngredientNutritionPer100 | null;
};

/** Klucz: `normalizeText(nazwa)` składnika albo jego aliasu. */
export type CatalogIngredientLookup = Map<string, CatalogIngredientRef>;

const ingredientRefSelect = {
  id: true,
  name: true,
  normalizedName: true,
  category: true,
  allergens: true,
  dietTags: true,
  nutritionKcalPer100: true,
  nutritionProteinPer100: true,
  nutritionCarbsPer100: true,
  nutritionFatPer100: true,
  nutritionFiberPer100: true,
  nutritionSodiumMgPer100: true,
  gramsPerPiece: true,
} satisfies Prisma.IngredientSelect;

type IngredientRefRow = Prisma.IngredientGetPayload<{
  select: typeof ingredientRefSelect;
}>;

function toIngredientRef(row: IngredientRefRow): CatalogIngredientRef {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalizedName,
    category: row.category,
    allergens: row.allergens,
    dietTags: row.dietTags,
    // Ta sama reguła co w `RecipesService` i recompute: brak kcal na 100 g
    // znaczy „brak danych”, reszta luk liczy się jako 0.
    nutrition:
      row.nutritionKcalPer100 === null
        ? null
        : {
            kcal: row.nutritionKcalPer100,
            protein: row.nutritionProteinPer100 ?? 0,
            carbs: row.nutritionCarbsPer100 ?? 0,
            fat: row.nutritionFatPer100 ?? 0,
            fiber: row.nutritionFiberPer100 ?? 0,
            sodiumMg: row.nutritionSodiumMgPer100 ?? 0,
            gramsPerPiece: row.gramsPerPiece,
          },
  };
}

/**
 * Słownik AKTYWNYCH składników po nazwie i po aliasach. `db` to klient Prismy
 * albo transakcja (panel czyta go w transakcji zapisu).
 */
export async function loadCatalogIngredientLookup(
  db: Prisma.TransactionClient,
): Promise<CatalogIngredientLookup> {
  const [ingredients, aliases] = await Promise.all([
    db.ingredient.findMany({
      where: { isActive: true },
      select: ingredientRefSelect,
    }),
    db.ingredientAlias.findMany({
      where: { ingredient: { isActive: true } },
      select: {
        normalizedAlias: true,
        ingredient: { select: ingredientRefSelect },
      },
    }),
  ]);
  const lookup: CatalogIngredientLookup = new Map();
  for (const ingredient of ingredients) {
    lookup.set(ingredient.normalizedName, toIngredientRef(ingredient));
  }
  // Także po znormalizowanej NAZWIE: panel zamienia klucz na nazwę i szuka
  // po niej, a `normalizedName` nie musi być dokładnie `normalizeText(name)`.
  // Klucz ma pierwszeństwo, więc to niczego nie przesłania.
  for (const ingredient of ingredients) {
    const byName = normalizeText(ingredient.name);
    if (!lookup.has(byName)) lookup.set(byName, toIngredientRef(ingredient));
  }
  for (const alias of aliases) {
    lookup.set(alias.normalizedAlias, toIngredientRef(alias.ingredient));
  }
  return lookup;
}

/** Linia `RecipeIngredient` gotowa do zapisu + dane do makro i tagów. */
export type CatalogIngredientRow = {
  ingredientId: string;
  name: string;
  amount: number;
  unit: string;
  normalizedAmount: number;
  normalizedUnit: 'g' | 'ml' | 'szt';
  department: string;
  /** Do `computeRecipeNutrition` — nie idzie do bazy. */
  nutrition: IngredientNutritionPer100 | null;
  /** Do unii tagów przepisu — nie idzie do bazy. */
  allergens: string[];
  dietTags: string[];
};

/**
 * Linie przepisu → wiersze `RecipeIngredient` (normalizacja ilości do g/ml/szt,
 * nazwa kanoniczna ze słownika). Nieznany składnik, zła jednostka i dwa razy
 * ten sam składnik (`@@unique([recipeId, ingredientId])`) to
 * `CatalogRecipeError` z listą wszystkich problemów naraz.
 */
export function resolveCatalogIngredients(
  recipe: Pick<CatalogRecipeInput, 'title' | 'ingredients'>,
  lookup: CatalogIngredientLookup,
): CatalogIngredientRow[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const rows: CatalogIngredientRow[] = [];
  for (const line of recipe.ingredients) {
    const found = lookup.get(normalizeText(line.ingredientName));
    if (!found) {
      problems.push(`nieznany składnik: ${line.ingredientName}`);
      continue;
    }
    if (seen.has(found.id)) {
      problems.push(`składnik dwa razy: ${found.name}`);
      continue;
    }
    seen.add(found.id);
    let normalized: ReturnType<typeof normalizeIngredientAmount>;
    try {
      normalized = normalizeIngredientAmount(
        found.name,
        found.category,
        line.amount,
        line.unit,
      );
    } catch (error) {
      problems.push(
        `${found.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    rows.push({
      ingredientId: found.id,
      name: found.name,
      amount: line.amount,
      unit: line.unit,
      normalizedAmount: Number(normalized.normalizedAmount.toFixed(4)),
      normalizedUnit: normalized.normalizedUnit,
      department: found.category,
      nutrition: found.nutrition,
      allergens: found.allergens,
      dietTags: found.dietTags,
    });
  }
  if (problems.length > 0) {
    throw new CatalogRecipeError(
      `Przepis "${recipe.title}": złe składniki.`,
      problems,
    );
  }
  return rows;
}

/**
 * Wiersze do `ingredients.create` z `createdAt` rosnącym o 1 ms w kolejności
 * przepisu. Aplikacja, panel i eksport czytają składniki po
 * `[createdAt, id]`; zagnieżdżony `create` dawał WSZYSTKIM liniom ten sam
 * znacznik, więc kolejność wyznaczało losowe UUID — inna w aplikacji niż
 * w pliku i inna po każdym imporcie.
 */
export function ingredientCreateRows(
  rows: CatalogIngredientRow[],
  now: Date = new Date(),
): Prisma.RecipeIngredientUncheckedCreateWithoutRecipeInput[] {
  return rows.map((row, index) => ({
    ingredientId: row.ingredientId,
    name: row.name,
    amount: row.amount,
    unit: row.unit,
    normalizedAmount: row.normalizedAmount,
    normalizedUnit: row.normalizedUnit,
    department: row.department,
    createdAt: new Date(now.getTime() + index),
  }));
}

/** Kolumny `Recipe` liczone z przepisu (bez id, zdjęcia i składników). */
export type CatalogRecipeColumns = {
  title: string;
  description: string;
  mealType: MealType;
  suitableMealTypes: MealType[];
  difficulty: Difficulty;
  prepTimeMinutes: number;
  servings: number;
  nutritionKcal: number;
  nutritionProtein: number;
  nutritionFat: number;
  nutritionCarbs: number;
  nutritionFiber: number;
  nutritionSalt: number;
  nutritionSaltAdded: number;
  allergens: string[];
  dietTags: string[];
  sourceProvider: string;
  sourceRecipeId: string | null;
  sourceInstructions: Array<{ step: number; text: string }>;
  sourceMeta: { imagePrompt: string | null };
  sourceRaw: Prisma.InputJsonValue;
  isCatalog: true;
  isActive: boolean;
};

/**
 * Sloty ręczne z pliku, które przekraczają próg klasyfikatora o więcej niż
 * `MANUAL_SLOT_KCAL_TOLERANCE` — wypadają (przekąska 663 kcal to błąd w
 * danych, nie wyjątek).
 */
export function overLimitManualSlots(
  recipe: Pick<
    CatalogRecipeInput,
    | 'title'
    | 'description'
    | 'mealType'
    | 'prepTimeMinutes'
    | 'servings'
    | 'nutrition'
    | 'suitableMealTypes'
  >,
): MealType[] {
  const kcal = kcalPerServing({
    title: recipe.title,
    description: recipe.description,
    mealType: recipe.mealType,
    prepTimeMinutes: recipe.prepTimeMinutes,
    servings: recipe.servings,
    nutritionKcal: recipe.nutrition.kcal,
  });
  return (recipe.suitableMealTypes ?? []).filter((slot) => {
    const limit = snackKcalLimit(slot);
    return limit !== null && kcal > limit * MANUAL_SLOT_KCAL_TOLERANCE;
  });
}

/**
 * Kolumny przepisu katalogu z wejścia i rozwiązanych składników. Makro
 * bierze z `recipe.nutrition` (import: z pliku; panel: przeliczone ze
 * składników PRZED wywołaniem), alergeny i tagi diet — z unii tagów
 * składników, sloty — z klasyfikatora plus ręczne.
 */
export function catalogRecipeColumns(
  recipe: CatalogRecipeInput,
  rows: CatalogIngredientRow[],
): CatalogRecipeColumns {
  const overLimit = overLimitManualSlots(recipe);
  const tags = deriveRecipeTags(rows);
  return {
    title: recipe.title,
    description: recipe.description,
    mealType: recipe.mealType,
    // Sloty, w których danie ma sens. Plik może je podać wprost; resztę
    // liczy klasyfikator — inaczej każdy import wracałby z katalogiem, w którym
    // II śniadanie i podwieczorek są puste.
    suitableMealTypes: resolveSuitableMealTypes({
      title: recipe.title,
      description: recipe.description,
      mealType: recipe.mealType,
      prepTimeMinutes: recipe.prepTimeMinutes,
      servings: recipe.servings,
      nutritionKcal: recipe.nutrition.kcal,
      suitableMealTypes: recipe.suitableMealTypes?.filter(
        (slot) => !overLimit.includes(slot),
      ),
    }).filter((slot) => !overLimit.includes(slot)),
    difficulty: recipe.difficulty,
    prepTimeMinutes: recipe.prepTimeMinutes,
    servings: recipe.servings,
    nutritionKcal: recipe.nutrition.kcal,
    nutritionProtein: recipe.nutrition.protein,
    nutritionFat: recipe.nutrition.fat,
    nutritionCarbs: recipe.nutrition.carbs,
    nutritionFiber: recipe.nutrition.fiber,
    nutritionSalt: recipe.nutrition.salt,
    nutritionSaltAdded: recipe.nutrition.addedSalt ?? 0,
    allergens: tags.allergens,
    dietTags: tags.dietTags,
    sourceProvider: recipe.sourceProvider ?? CATALOG_DEFAULT_SOURCE_PROVIDER,
    sourceRecipeId: recipe.sourceRecipeId ?? null,
    sourceInstructions: recipe.steps.map((step) => ({
      step: step.step,
      text: step.instruction,
    })),
    sourceMeta: { imagePrompt: recipe.image?.prompt ?? null },
    sourceRaw: JSON.parse(JSON.stringify(recipe)) as Prisma.InputJsonValue,
    // Wspólny katalog — tworzą go wyłącznie import i panel.
    isCatalog: true,
    isActive: recipe.isActive ?? true,
  };
}
