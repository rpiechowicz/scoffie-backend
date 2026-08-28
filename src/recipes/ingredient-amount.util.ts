/**
 * Sprowadzanie ilosci skladnika do jednostki bazowej (g / ml / szt).
 *
 * Wyciagniete ze skryptu importu, bo liczy z tego takze przeliczanie makro:
 * gdyby kazde miejsce mialo wlasna kopie tabel lyzeczek, baza i katalog JSON
 * rozjechalyby sie po pierwszej korekcie.
 */
import { normalizeText } from '../common/normalize-text.util';

export type NormalizedIngredient = {
  normalizedAmount: number;
  normalizedUnit: 'g' | 'ml' | 'szt';
};

export const ALLOWED_UNITS = new Set([
  'g',
  'kg',
  'ml',
  'l',
  'szt',
  'szczypta',
  'łyżeczka',
  'łyżka',
  'lyzeczka',
  'lyzka',
]);
const LIQUID_SPOON_UNITS_IN_ML: Record<
  'lyzeczka' | 'lyzka' | 'szczypta',
  number
> = {
  lyzeczka: 5,
  lyzka: 15,
  szczypta: 0.5,
};
const SPICE_GRAMS_PER_TEASPOON_BY_NAME: Record<string, number> = {
  sol: 6,
  'pieprz czarny': 2.3,
  pieprz: 2.3,
  'papryka slodka mielona': 2.3,
  'papryka ostra mielona': 2.3,
  cynamon: 2.6,
  kurkuma: 2.2,
  kminek: 2.1,
  oregano: 1,
  'tymianek suszony': 1,
  'bazylia suszona': 0.8,
  'imbir mielony': 2.2,
  'czosnek granulowany': 2.8,
  cukier: 4,
  'cukier brazowy': 4,
  // Mieszanka typu Vegeta — granulacja jak cukier, nie jak pylista papryka.
  'przyprawa uniwersalna': 4,
};
const LIQUID_CONDIMENTS = new Set([
  'ketchup',
  'musztarda',
  'majonez',
  'ocet jablkowy',
  'ocet winny',
  'sos pomidorowy',
  'sos sojowy',
]);

// Re-eksport, bo skrypty (`scripts/import-recipes-from-json.ts`,
// `scripts/recompute-recipe-nutrition.ts`) importują `normalizeText` stąd,
// a leżą poza `tsconfig.include` — zerwany import wyszedłby dopiero w runtime.
export { normalizeText };

export function normalizeIngredientAmount(
  ingredientName: string,
  category: string,
  amount: number,
  unit: string,
): NormalizedIngredient {
  const normalizedUnit = normalizeText(unit) as
    | 'g'
    | 'kg'
    | 'ml'
    | 'l'
    | 'szt'
    | 'szczypta'
    | 'lyzeczka'
    | 'lyzka';

  if (normalizedUnit === 'g')
    return { normalizedAmount: amount, normalizedUnit: 'g' };
  if (normalizedUnit === 'kg')
    return { normalizedAmount: amount * 1000, normalizedUnit: 'g' };
  if (normalizedUnit === 'ml')
    return { normalizedAmount: amount, normalizedUnit: 'ml' };
  if (normalizedUnit === 'l')
    return { normalizedAmount: amount * 1000, normalizedUnit: 'ml' };
  if (normalizedUnit === 'szt')
    return { normalizedAmount: amount, normalizedUnit: 'szt' };

  const normalizedCategory = normalizeText(category);
  if (normalizedCategory !== 'przyprawy i sosy') {
    throw new Error(
      `Unit "${unit}" is allowed only for category "Przyprawy i sosy" (ingredient: ${ingredientName})`,
    );
  }

  const spoonFactor =
    normalizedUnit === 'lyzka' ? 3 : normalizedUnit === 'szczypta' ? 1 / 16 : 1;
  const normalizedName = normalizeText(ingredientName);

  if (LIQUID_CONDIMENTS.has(normalizedName)) {
    const mlPerUnit = LIQUID_SPOON_UNITS_IN_ML[normalizedUnit];
    return { normalizedAmount: amount * mlPerUnit, normalizedUnit: 'ml' };
  }

  const gramsPerTeaspoon =
    SPICE_GRAMS_PER_TEASPOON_BY_NAME[normalizedName] ?? 2.5;
  return {
    normalizedAmount: amount * gramsPerTeaspoon * spoonFactor,
    normalizedUnit: 'g',
  };
}
