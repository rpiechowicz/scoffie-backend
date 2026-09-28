/**
 * Typy partii „Katalog 1000" (28.09.2026) — patrz
 * `prisma/catalog/katalog-1000-lista.md` i `scripts/lib/katalog-1000-2026-09.ts`.
 */
import type {
  RecipeCuisine,
  RecipeDishType,
  RecipeEquipment,
  RecipeFeature,
  RecipeOccasion,
  RecipeSeason,
} from '../../../src/recipes/recipe-taxonomy';

/**
 * Składnik przepisu: nazwa DOKŁADNIE jak w `ingredient-tags-pl-v1.json`,
 * ilość i jednostka bazowa (g, ml albo szt — `szt` tylko dla składników
 * z `gramsPerPiece`). Łyżki i szczypty zamieniamy na gramy.
 */
export type Ing = [name: string, amount: number, unit: 'g' | 'ml' | 'szt'];

export type MealType =
  | 'BREAKFAST'
  | 'SECOND_BREAKFAST'
  | 'LUNCH'
  | 'AFTERNOON_SNACK'
  | 'DINNER'
  | 'SNACK';

export type Def = {
  /** Klucz pozycji z listy, np. `SN-001`, `OB-042`, `NA-017`. */
  plan: string;
  /** Tytuł z listy; drobna poprawka dozwolona (generator ostrzeże). */
  title: string;
  /** 2–3 zdania (80–320 znaków): czym jest danie i dlaczego warto; bez makr i bez „przepis na". */
  description: string;
  mealType: MealType;
  /**
   * Dodatkowe pory poza bazową (np. koktajl śniadaniowy też na II śniadanie).
   * Klasyfikator doda swoje; ręczne ponad jego próg kcal × 1,5 wypadną.
   */
  extraMealTypes?: MealType[];
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  /** Łączny czas od wyjęcia składników do podania (z pieczeniem, duszeniem, marynowaniem). */
  prepTimeMinutes: number;
  servings: number;
  // ── taksonomia (src/recipes/recipe-taxonomy.ts) ──
  cuisine: RecipeCuisine;
  dishType: RecipeDishType;
  seasons?: RecipeSeason[];
  occasions?: RecipeOccasion[];
  equipment?: RecipeEquipment[];
  features?: RecipeFeature[];
  ingredients: Ing[];
  /**
   * 3–10 kroków, bez numerów na początku. Przepis na airfryer ma w krokach
   * WARIANT NA PIEKARNIK (temperatura i czas) — generator to sprawdza.
   */
  steps: string[];
  /** Jedno zdanie po angielsku: co widać na talerzu (do promptu Recrafta). */
  photo: string;
  /** Naczynie do zdjęcia; domyślnie talerz. Napoje: `cup` (niski kubek, jak dotychczasowe koktajle). */
  vessel?: 'plate' | 'bowl' | 'board' | 'cup';
};

export type Nutrition100 = {
  /** g dla stałych, ml dla płynów — jak w `ingredient-nutrition-pl-v1.json`. */
  unit: 'g' | 'ml';
  kcal: number;
  protein: number;
  /** Przyswajalne, BEZ błonnika (konwencja IŻŻ). */
  carbs: number;
  /** Cukry — część `carbs`. */
  sugars: number;
  fat: number;
  /** Nasycone — część `fat`. */
  saturatedFat: number;
  fiber: number;
  sodiumMg: number;
  /** Masa jadalnej części 1 sztuki — tylko gdy przepisy podają składnik w `szt`. */
  gramsPerPiece?: number;
};

/**
 * Uzupełnienie katalogu składników — gdy przepis naprawdę potrzebuje
 * produktu, którego nie ma w `ingredient-tags-pl-v1.json`. Nowy składnik:
 * `category` (id pliku txt), `allergens` i `dietTags` wg konwencji pliku
 * tagów — alergeny NADMIAROWO — i makro z cukrami i nasyconymi. Musi dać się
 * kupić w Lidlu, Biedronce, Selgrosie albo Makro.
 */
export type IngredientAddition = {
  name: string;
  nutrition: Nutrition100;
  category?: string;
  allergens?: string[];
  dietTags?: string[];
  note?: string;
};
