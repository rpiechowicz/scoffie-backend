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
  // Od 30.09.2026 tabela służy też WYŚWIETLANIU (`kitchenMeasure`): gramy
  // przypraw z katalogu telefon pokazuje jako szczyptę / łyżeczki / łyżki.
  // Dlatego obejmuje każdą przyprawę katalogu, a nie tylko te podawane
  // łyżeczkami. Masy łyżeczki płaskiej — tabele USDA dla odpowiedników.
  'papryka wedzona mielona': 2.3,
  'kmin rzymski': 2.1,
  majeranek: 0.6,
  'rozmaryn suszony': 1.2,
  'szalwia suszona': 0.7,
  'ziola prowansalskie': 1,
  'galka muszkatolowa': 2.2,
  'kardamon mielony': 2,
  curry: 2,
  'garam masala': 2,
  'przyprawa do piernika': 2.5,
  'przyprawa do gyrosa': 2.5,
  'platki chili': 1.8,
  'cebula prazona': 1.3,
  'cukier puder': 2.5,
  'cukier waniliowy': 4,
  // Sosy i pasty w gramach („30 g majonezu”) — łyżka ≈ 15–20 g.
  musztarda: 5,
  majonez: 5,
  ketchup: 6,
  'sos chili slodki': 7,
  'sos barbecue': 6,
  'sos sriracha': 5,
  'sos pomidorowy': 5,
  'salsa pomidorowa': 5,
  'pesto bazyliowe': 5,
  'pasta curry': 5,
};

/**
 * Przyprawy liczone w kuchni SZTUKAMI, nie łyżeczkami: „1 g liścia
 * laurowego” to dla gotującego zagadka. Masa sztuki to umowa katalogu
 * (liść ≈ 0,5 g: przepisy piszą „1 g” tam, gdzie w garnku lądują 2 liście),
 * formy — do odmiany po polsku na telefonie.
 */
const SPICE_PIECES_BY_NAME: Record<
  string,
  { grams: number; one: string; few: string; many: string }
> = {
  'lisc laurowy': { grams: 0.5, one: 'liść', few: 'liście', many: 'liści' },
  'ziele angielskie': {
    grams: 0.25,
    one: 'ziarno',
    few: 'ziarna',
    many: 'ziaren',
  },
  // Dawna, błędna nazwa z katalogu (poprawiona 2.10.2026,
  // `scripts/fix-ziele-angielskie.ts`) — zostaje dla archiwów list zakupów,
  // które trzymają nazwę z dnia zakupów.
  'ziolo angielskie': {
    grams: 0.25,
    one: 'ziarno',
    few: 'ziarna',
    many: 'ziaren',
  },
  gozdziki: { grams: 0.2, one: 'goździk', few: 'goździki', many: 'goździków' },
};

/** Łyżeczka płynu (sos sojowy, ocet) — jak w `LIQUID_SPOON_UNITS_IN_ML`. */
const ML_PER_TEASPOON = 5;

/**
 * Jak pokazać ilość przyprawy w kuchni. `per` = gramy (albo ml — w jednostce
 * wiersza) na łyżeczkę (`spoon`) lub na sztukę (`piece`). Telefon zamienia
 * nim gramaturę po przeskalowaniu porcji na „szczypta / ½ łyżeczki /
 * 2 łyżki” albo „2 liście”; dane zostają w gramach.
 */
export type KitchenMeasure =
  | { kind: 'spoon'; per: number }
  | { kind: 'piece'; per: number; one: string; few: string; many: string };

/**
 * Miara kuchenna dla wiersza składnika albo pozycji listy zakupów.
 * `null` = pokazuj jak dotąd (nie przyprawa, jednostka inna niż g/ml,
 * przyprawa spoza tabeli).
 */
export function kitchenMeasure(
  ingredientName: string,
  department: string,
  unit: string,
): KitchenMeasure | null {
  if (normalizeText(department) !== 'przyprawy i sosy') return null;
  const normalizedUnit = normalizeText(unit);
  if (normalizedUnit === 'ml') return { kind: 'spoon', per: ML_PER_TEASPOON };
  if (normalizedUnit !== 'g') return null;
  const name = normalizeText(ingredientName);
  const piece = SPICE_PIECES_BY_NAME[name];
  if (piece) {
    const { grams, one, few, many } = piece;
    return { kind: 'piece', per: grams, one, few, many };
  }
  const grams = SPICE_GRAMS_PER_TEASPOON_BY_NAME[name];
  return grams ? { kind: 'spoon', per: grams } : null;
}

/**
 * Wiersz dla telefonu z `kitchenMeasure` — tylko gdy miara jest (przyprawy).
 * Bez klucza przy reszcie: katalog to ~10 tys. wierszy składników, a `null`
 * przy każdym tylko by go pogrubił. Brak pola = telefon pokazuje jak dotąd
 * (także starsze wersje aplikacji, które pola nie znają).
 */
export function withKitchenMeasure<
  T extends { name: string; unit: string; department: string },
>(row: T): T & { kitchenMeasure?: KitchenMeasure } {
  const measure = kitchenMeasure(row.name, row.department, row.unit);
  return measure ? { ...row, kitchenMeasure: measure } : row;
}

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
    'g' | 'kg' | 'ml' | 'l' | 'szt' | 'szczypta' | 'lyzeczka' | 'lyzka';

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
