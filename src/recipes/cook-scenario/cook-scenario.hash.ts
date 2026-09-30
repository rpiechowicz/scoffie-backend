import { createHash } from 'node:crypto';
import { stepsFromInstructions } from '../recipe-steps.util';

/** Pola przepisu, z których scenariusz powstał. */
export interface RecipeContentForHash {
  title: string;
  servings: number;
  sourceInstructions: unknown;
  ingredients: ReadonlyArray<{
    ingredientId: string;
    amount: number;
    unit: string;
  }>;
}

/**
 * Odcisk TREŚCI przepisu (sha256), zapisywany przy scenariuszu. Inny odcisk
 * obecnego przepisu = scenariusz napisany do czegoś innego → nieaktualny.
 *
 * Wchodzi tylko to, na czym scenariusz się opiera: tytuł, porcje, składniki
 * (id, ilość, jednostka — posortowane po id, bo kolejność wierszy nie jest
 * treścią) i teksty kroków. Nie wchodzą zdjęcie, makro, tagi, taksonomia —
 * ich zmiana nie unieważnia kroków.
 */
export function recipeContentHash(recipe: RecipeContentForHash): string {
  const canonical = {
    title: recipe.title.trim(),
    servings: recipe.servings,
    ingredients: [...recipe.ingredients]
      .map((row) => [row.ingredientId, row.amount, row.unit.trim()] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    steps: stepsFromInstructions(recipe.sourceInstructions),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}
