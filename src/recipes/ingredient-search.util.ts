import { normalizeText } from '../common/normalize-text.util';

/**
 * Dopasowywanie składnika po NAZWIE, nie po identyfikatorze.
 *
 * Asystent zna „pierś z kurczaka", nie `7adf5ec0-…`, a `recipes:create`
 * wymaga UUID-a składnika z katalogu. Bez wyszukiwarki jedyną drogą byłoby
 * zgadywanie — czyli halucynowany identyfikator i błąd zamiast przepisu.
 *
 * Dopasowanie idzie dwuetapowo: baza zawęża kandydatów po RDZENIU zapytania
 * (kilka pierwszych znaków najdłuższego słowa), a ranking liczy się w kodzie.
 * Powód jest polski: „jajka" nie zawiera się w „jajko", więc samo `contains`
 * na pełnym zapytaniu gubiłoby odmianę. Rdzeń „jajk" łapie obie formy, a
 * ranking układa je w sensownej kolejności.
 */
export const INGREDIENT_SEARCH_DEFAULT_LIMIT = 20;
export const INGREDIENT_SEARCH_MAX_LIMIT = 50;

/**
 * Ile pierwszych znaków słowa idzie do filtra SQL. Cztery, bo polska odmiana
 * zmienia zwykle końcówkę („jajko/jajka", „pomidor/pomidory", „marchew/marchewki"),
 * a krótszy rdzeń wciągałby pół katalogu.
 */
export const SEARCH_STEM_LENGTH = 4;

/** Ilu kandydatów bierzemy z bazy do rankingu — sufit, nie wynik. */
export const SEARCH_CANDIDATE_LIMIT = 200;

const SPICE_CATEGORY = 'przyprawy i sosy';

/**
 * Rdzeń zapytania do filtra SQL: najdłuższe słowo przycięte do
 * `SEARCH_STEM_LENGTH`.
 *
 * Najdłuższe, a nie pierwsze, bo w „pierś z kurczaka" znaczące jest
 * „kurczaka", a nie „pierś" ani „z".
 */
export function searchStem(query: string): string {
  const normalized = normalizeText(query);
  if (!normalized) return '';
  const longest = normalized
    .split(' ')
    .reduce((best, word) => (word.length > best.length ? word : best), '');
  return longest.slice(0, SEARCH_STEM_LENGTH);
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Jak dobrze kandydat odpowiada zapytaniu. 0 = w ogóle.
 *
 * Kolejność progów jest celowa: dokładna nazwa bije wszystko, potem prefiks
 * (odmiana), potem zawieranie („kurczak" w „pierś z kurczaka"), a na końcu
 * wspólny rdzeń. Bez tego „jajko" ustępowałoby „jajkom przepiórczym" tylko
 * dlatego, że oba pasują.
 */
export function matchScore(query: string, candidate: string): number {
  const q = normalizeText(query);
  const c = normalizeText(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;

  const prefix = commonPrefixLength(q, c);
  const longer = Math.max(q.length, c.length);

  // Odmiana TEGO SAMEGO słowa: prawie cała nazwa się pokrywa („jajka"/„jajko").
  // Musi bić dosłowne zawieranie, bo inaczej „jajka" wskazywałyby „sałatkę
  // z jajkami" zamiast samego jajka — zapytanie jest w niej podciągiem.
  if (prefix / longer >= 0.7) return 85;

  if (c.startsWith(q) || q.startsWith(c)) return 75;

  // Zawieranie waży tym mniej, im mniejszą część nazwy pokrywa zapytanie.
  if (c.includes(q)) return 45 + Math.round(20 * (q.length / c.length));
  if (q.includes(c)) return 40 + Math.round(20 * (c.length / q.length));

  if (prefix >= SEARCH_STEM_LENGTH) return 30 + Math.min(10, prefix);

  // Zapytanie wielosłowne: liczy się najlepsze dopasowanie któregokolwiek
  // słowa („makaron pełnoziarnisty" ma trafić w „makaron").
  const words = q
    .split(' ')
    .filter((word) => word.length >= SEARCH_STEM_LENGTH);
  let best = 0;
  for (const word of words) {
    if (c.includes(word)) best = Math.max(best, 50);
    else if (commonPrefixLength(word, c) >= SEARCH_STEM_LENGTH) {
      best = Math.max(best, 35);
    }
  }
  return best;
}

export type RankableIngredient = {
  name: string;
  normalizedName: string;
  aliases?: { alias: string }[];
};

/**
 * Najlepszy wynik po nazwie ALBO którymkolwiek aliasie — alias istnieje po to,
 * żeby „jajka" trafiały w „jajko" nawet wtedy, gdy rdzeń nie wystarczy.
 */
export function bestScore(
  query: string,
  ingredient: RankableIngredient,
): number {
  let best = matchScore(query, ingredient.name);
  for (const alias of ingredient.aliases ?? []) {
    best = Math.max(best, matchScore(query, alias.alias));
  }
  return best;
}

export function rankIngredients<T extends RankableIngredient>(
  query: string,
  candidates: T[],
): T[] {
  if (!normalizeText(query)) {
    return [...candidates].sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  }
  return candidates
    .map((candidate) => ({ candidate, score: bestScore(query, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Przy remisie krótsza nazwa jest zwykle tą ogólną („makaron" przed
      // „makaron pełnoziarnisty penne"), a to jej najczęściej szukamy.
      if (a.candidate.name.length !== b.candidate.name.length) {
        return a.candidate.name.length - b.candidate.name.length;
      }
      return a.candidate.name.localeCompare(b.candidate.name, 'pl');
    })
    .map((entry) => entry.candidate);
}

/**
 * Jednostki, które system NAPRAWDĘ przyjmie dla tego składnika.
 *
 * To nie jest lista życzeniowa, tylko odbicie dwóch istniejących reguł:
 * łyżki i szczypty przelicza wyłącznie kategoria „Przyprawy i sosy"
 * (`normalizeIngredientAmount` rzuca dla reszty), a `szt` wymaga masy sztuki,
 * bo bez niej nie da się policzyć makro (`computeRecipeNutrition` zwraca
 * wtedy null). Dzięki temu asystent nie proponuje „1 bułka", gdy bułka nie ma
 * gramatury — i nie dostaje odmowy dopiero przy zapisie.
 */
export function allowedUnitsFor(ingredient: {
  category: string;
  gramsPerPiece: number | null;
}): string[] {
  const units = ['g', 'kg', 'ml', 'l'];
  if (ingredient.gramsPerPiece != null) units.push('szt');
  if (normalizeText(ingredient.category) === SPICE_CATEGORY) {
    units.push('łyżeczka', 'łyżka', 'szczypta');
  }
  return units;
}
