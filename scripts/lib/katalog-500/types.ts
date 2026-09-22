/**
 * Typy partii „Katalog 500" (22.09.2026) — patrz
 * `prisma/catalog/katalog-500-lista.md` i `scripts/lib/katalog-500-2026-09.ts`.
 */

/** Tylko jednostki bazowe: łyżki i szczypty działają wyłącznie dla przypraw, a masa jest dokładniejsza. */
export type Ing = [name: string, amount: number, unit: 'g' | 'ml' | 'szt'];

export type MealType =
  | 'BREAKFAST'
  | 'SECOND_BREAKFAST'
  | 'LUNCH'
  | 'AFTERNOON_SNACK'
  | 'DINNER'
  | 'SNACK';

export type Def = {
  /** Klucz pozycji z listy, np. `sn-12`, `ob-101`, `pr-3`. */
  plan: string;
  title: string;
  /** 2–3 zdania: czym jest danie i dlaczego warto; bez makr i bez „przepis na". */
  description: string;
  mealType: MealType;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  /** Łączny czas od wyjęcia składników do podania (z pieczeniem i duszeniem). */
  prepTimeMinutes: number;
  servings: number;
  ingredients: Ing[];
  steps: string[];
  /** Jedno zdanie po angielsku: co widać na talerzu (do promptu Recrafta). */
  photo: string;
  /** Naczynie do promptu; domyślnie talerz. */
  vessel?: 'plate' | 'bowl' | 'board';
};

export type Nutrition100 = {
  /** g dla stałych, ml dla płynów — jak w `ingredient-nutrition-pl-v1.json`. */
  unit: 'g' | 'ml';
  kcal: number;
  protein: number;
  /** Przyswajalne, BEZ błonnika (konwencja IŻŻ). */
  carbs: number;
  fat: number;
  fiber: number;
  sodiumMg: number;
  /** Masa jadalnej części 1 sztuki — tylko gdy przepisy podają składnik w `szt`. */
  gramsPerPiece?: number;
};

/**
 * Uzupełnienie katalogu składników.
 *
 * Składnik już obecny w `ingredient-tags-pl-v1.json` (jest w txt i ma tagi,
 * brakuje mu tylko makro): podaj samo `name` + `nutrition`.
 * Składnik zupełnie nowy: dodatkowo `category` (id pliku txt, np.
 * `nabial-i-jajko`), `allergens` i `dietTags` wg konwencji z pliku tagów —
 * alergeny oznaczamy NADMIAROWO.
 */
export type IngredientAddition = {
  name: string;
  nutrition: Nutrition100;
  category?: string;
  allergens?: string[];
  dietTags?: string[];
  note?: string;
};
