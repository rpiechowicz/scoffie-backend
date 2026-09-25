/**
 * Czyste przejścia z wierszy katalogu na kontrakt panelu — bez Prismy, żeby
 * reguły dało się sprawdzić testem jednostkowym (`catalog-math.spec.ts`).
 */

// Kroki i porządek alfabetyczny żyją w domenie, bo czyta je też eksport
// katalogu (`src/recipes/catalog/`), a domena nie importuje `src/admin/`.
export { stepsFromInstructions } from '../../recipes/recipe-steps.util';
export { comparePolish } from '../../common/polish-order';

/**
 * Podstawa wartości odżywczych składnika: 100 g czy 100 ml.
 *
 * W bazie NIE MA takiej kolumny — jednostka żyje tylko w pliku, z którego
 * wgrywa się makro (`prisma/catalog/ingredient-nutrition-pl-v1.json`, pole
 * `unit`). Wyprowadzamy ją z danych, które baza ma: z jednostek, w jakich
 * przepisy katalogu naprawdę odmierzają składnik (`RecipeIngredient.normalizedUnit`).
 * Dla składników użytych w przepisach zgadza się to z plikiem w 100 %
 * (sprawdzone 24.09.2026 na katalogu 500 przepisów: 301/301); składnik bez
 * przepisu dostaje `g` — mylą się tu tylko płyny, których żaden przepis nie
 * używa (15, np. wody i soki). Trwałe rozwiązanie to kolumna jednostki przy
 * decyzji D1 (ROADMAPA §9).
 */
export function baseUnitFromUsage(usage: {
  grams: number;
  millilitres: number;
}): 'g' | 'ml' {
  return usage.millilitres > usage.grams ? 'ml' : 'g';
}

/**
 * Kalorie na porcję: `Recipe.nutritionKcal` to CAŁY przepis (konwencja
 * `recipe-nutrition.util.ts`), porcji jest `servings` (1..8).
 */
export function kcalPerServing(
  nutritionKcal: number,
  servings: number,
): number {
  return Math.round(nutritionKcal / Math.max(1, servings));
}

/**
 * Gramy makroskładnika na porcję (białko, tłuszcz, węglowodany) — z kolumny
 * CAŁEGO przepisu, jak `kcalPerServing` i `Recipe.nutritionPerServing` w iOS;
 * jedno miejsce po przecinku.
 */
export function gramsPerServing(total: number, servings: number): number {
  return Math.round((total / Math.max(1, servings)) * 10) / 10;
}
