import { normalizeText } from '../common/normalize-text.util';

/**
 * Dopasowanie nazw składników po RDZENIU słowa (polska odmiana): „jajka”
 * trafia „Jajko”, „orzechy” — „Orzech włoski”, „ser” — „Serek”, ale nie
 * „Ogórek konserwowy”. Jedno źródło dla wyszukiwarki asystenta
 * (`find_recipes`, `suggest_meals`) i wspólnego silnika ograniczeń
 * (`recipe-constraints`, „bez X” w planerze). Przeniesione z
 * `agent/search/catalog-search.ts` bez zmian (noc 27/28.09.2026, N8A S6).
 */

/** Wyrazy tekstu po normalizacji (ASCII, małe litery). */
export function words(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * Słowa, które nic nie mówią o daniu. Pory posiłku też: od nich jest pole
 * `meal_type`, a „obiad" w tekście trafiałby w przypadkowe tytuły.
 */
const STOPWORDS = new Set([
  'a',
  'ale',
  'albo',
  'co',
  'cos',
  'czyms',
  'czegos',
  'dla',
  'do',
  'i',
  'jakies',
  'jakis',
  'lub',
  'mam',
  'mi',
  'na',
  'nie',
  'o',
  'od',
  'po',
  'pod',
  'przez',
  'w',
  'we',
  'z',
  'ze',
  'za',
  'danie',
  'dania',
  'przepis',
  'przepisy',
  'pomysl',
  'pomysly',
  'propozycja',
  'chce',
  'zrobic',
  'ugotowac',
  'sniadanie',
  'sniadania',
  'obiad',
  'obiady',
  'kolacja',
  'kolacje',
  'kolacji',
  'przekaska',
  'podwieczorek',
  'lunch',
]);

/**
 * Rdzeń słowa dla polskiej odmiany: „kurczakiem" → „kurcza", „zupy" → „zup",
 * „lekkiego" → „lekki". Dopasowanie idzie od POCZĄTKU wyrazu (`hasPrefix`),
 * więc rdzeń nie łapie środka innych słów.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.length <= 5) return word.slice(0, word.length - 1);
  return word.slice(0, Math.max(5, Math.ceil(word.length * 0.6)));
}

/**
 * Znaczące rdzenie zapytania. Słowo po „bez" wypada: „bez mięsa" w tekście
 * nie może PROMOWAĆ dań z mięsem — od wykluczeń jest `exclude_ingredients`.
 */
export function queryStems(text: string): string[] {
  const tokens = words(text);
  const stems: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'bez') {
      i += 1;
      continue;
    }
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    const root = stem(token);
    if (!stems.includes(root)) stems.push(root);
  }
  return stems;
}

/**
 * Wyraz zaczyna się od rdzenia. Krótki rdzeń (do 3 liter) łapie tylko krótką
 * końcówkę: „ser" trafia w „serek", ale nie w „sernik", „por" — w „pory",
 * ale nie w „porcję".
 */
export const hasPrefix = (list: readonly string[], root: string): boolean =>
  list.some(
    (word) =>
      word.startsWith(root) &&
      (root.length > 3 || word.length <= root.length + 2),
  );

/**
 * Czy składnik przepisu odpowiada nazwie z prośby: KAŻDE znaczące słowo
 * nazwy (po rdzeniu) zaczyna któryś wyraz składnika. „pierś z kurczaka"
 * pasuje do „Filet z piersi kurczaka", „jajka" do „Jajko".
 */
export function ingredientMatches(
  ingredientName: string,
  wanted: string,
): boolean {
  const roots = queryStems(wanted);
  if (roots.length === 0) return false;
  const have = words(ingredientName);
  return roots.every((root) => hasPrefix(have, root));
}
