/**
 * Liczenie makro przepisu ze składników.
 *
 * Funkcje są czyste i nie znają Prismy — korzysta z nich zarówno skrypt
 * audytowy (`scripts/audit-recipe-nutrition.ts`), jak i walidacja przy
 * tworzeniu przepisu. Jedno miejsce, jedna definicja "ile ma ten przepis".
 *
 * Konwencja: `Recipe.nutrition*` to wartości dla CAŁEGO przepisu (wszystkie
 * porcje). Klient dzieli przez `servings` — patrz `Recipe.nutritionPerServing`
 * po stronie iOS. Tutaj też liczymy sumę całkowitą.
 */

/** Wartości odżywcze składnika na 100 g (jednostka `g`) lub 100 ml (`ml`). */
export type IngredientNutritionPer100 = {
  kcal: number;
  protein: number;
  /** Węglowodany przyswajalne, bez błonnika (konwencja IŻŻ). */
  carbs: number;
  fat: number;
  fiber: number;
  /** Masa jadalnej części 1 sztuki — wymagana dla jednostki `szt`. */
  gramsPerPiece: number | null;
};

export type RecipeNutritionTotals = {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
};

export type NutritionInputItem = {
  name: string;
  normalizedAmount: number;
  normalizedUnit: string;
  nutrition: IngredientNutritionPer100 | null;
};

export type RecipeNutritionResult = {
  totals: RecipeNutritionTotals;
  /** Składniki bez danych — suma jest o nie zaniżona. */
  missingNutrition: string[];
  /** Składniki w `szt` bez `gramsPerPiece` — nie da się ich przeliczyć. */
  missingPieceWeight: string[];
};

/** Domyślny próg, powyżej którego rozjazd uznajemy za błąd danych, nie zaokrąglenie. */
export const NUTRITION_TOLERANCE = 0.1;

export const ZERO_TOTALS: RecipeNutritionTotals = {
  kcal: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
  fiber: 0,
};

/**
 * Sprowadza ilość składnika do gramów/mililitrów.
 *
 * `g` i `ml` idą 1:1 — tabela wartości ma osobną podstawę dla płynów, więc
 * przeliczanie gęstości byłoby liczeniem tego samego dwa razy.
 * `szt` wymaga masy sztuki; bez niej zwracamy null zamiast zgadywać.
 */
function toBaseAmount(item: NutritionInputItem): number | null {
  if (item.normalizedUnit === 'szt') {
    const perPiece = item.nutrition?.gramsPerPiece;
    if (!perPiece) return null;
    return item.normalizedAmount * perPiece;
  }
  return item.normalizedAmount;
}

export function computeRecipeNutrition(
  items: NutritionInputItem[],
): RecipeNutritionResult {
  const totals: RecipeNutritionTotals = { ...ZERO_TOTALS };
  const missingNutrition: string[] = [];
  const missingPieceWeight: string[] = [];

  for (const item of items) {
    if (!item.nutrition) {
      missingNutrition.push(item.name);
      continue;
    }

    const baseAmount = toBaseAmount(item);
    if (baseAmount === null) {
      missingPieceWeight.push(item.name);
      continue;
    }

    const factor = baseAmount / 100;
    totals.kcal += item.nutrition.kcal * factor;
    totals.protein += item.nutrition.protein * factor;
    totals.carbs += item.nutrition.carbs * factor;
    totals.fat += item.nutrition.fat * factor;
    totals.fiber += item.nutrition.fiber * factor;
  }

  return { totals, missingNutrition, missingPieceWeight };
}

/**
 * Energia ze współczynników Atwatera. Sprawdza spójność samej trójki makro
 * z deklarowanym kcal — wyłapuje wartości wpisane z ręki, nawet gdy nie mamy
 * danych o składnikach.
 */
export function atwaterKcal(
  totals: Omit<RecipeNutritionTotals, 'kcal'>,
): number {
  return (
    4 * totals.protein + 4 * totals.carbs + 9 * totals.fat + 2 * totals.fiber
  );
}

/** Względne odchylenie `actual` od `expected`; null gdy nie ma od czego liczyć. */
export function relativeDeviation(
  actual: number,
  expected: number,
): number | null {
  if (expected === 0) return actual === 0 ? 0 : null;
  return (actual - expected) / expected;
}

export function roundTotals(
  totals: RecipeNutritionTotals,
): RecipeNutritionTotals {
  return {
    kcal: Math.round(totals.kcal),
    protein: Math.round(totals.protein * 10) / 10,
    carbs: Math.round(totals.carbs * 10) / 10,
    fat: Math.round(totals.fat * 10) / 10,
    fiber: Math.round(totals.fiber * 10) / 10,
  };
}
