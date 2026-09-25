import { Prisma } from '@prisma/client';
import { normalizeText } from '../../common/normalize-text.util';

/**
 * Wyszukiwanie „bez polskich znaków": `lodz` ma trafić w „Łódź".
 *
 * Baza nie ma rozszerzenia `unaccent`, a kolumny osób, domów i tytułów nie
 * mają postaci znormalizowanej (jak `Ingredient.normalizedName`). Dlatego
 * tekst kolumny składamy w SQL tak samo, jak `normalizeText` składa zapytanie
 * w JS: `translate` zdejmuje znaki diakrytyczne, `lower` sprowadza wielkość
 * liter, białe znaki zwijają się do jednej spacji.
 */

/** Najkrótsze zapytanie, które w ogóle szukamy — jedna litera trafia wszystkich. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Pary „litera → litera ASCII" wyliczone z SAMEJ `normalizeText` na zakresie
 * Latin-1 i Latin Extended-A (U+00C0–U+017F), obie wielkości liter. Lista
 * wypisana ręcznie rozjechałaby się z JS przy pierwszej literze spoza
 * polskiego alfabetu („Müller", „Zoë").
 */
export const FOLD_MAP: { from: string; to: string } = (() => {
  let from = '';
  let to = '';
  for (let code = 0xc0; code <= 0x17f; code += 1) {
    const letter = String.fromCharCode(code);
    const folded = normalizeText(letter);
    if (folded.length === 1 && /^[a-z]$/.test(folded)) {
      from += letter;
      to += folded;
    }
  }
  return { from, to };
})();

/** Zapytanie po normalizacji albo `null`, gdy za krótkie, żeby szukać. */
export function normalizeQuery(raw: string | null | undefined): string | null {
  const normalized = normalizeText(raw ?? '');
  return normalized.length >= MIN_QUERY_LENGTH ? normalized : null;
}

/** Wzorzec `LIKE` „zawiera", z `%`, `_` i `\` w zapytaniu traktowanymi dosłownie. */
export function containsPattern(normalized: string): string {
  return `%${normalized.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Tekst kolumny złożony jak `normalizeText` (bez `trim` — wzorzec i tak „zawiera"). */
export function sqlFolded(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`regexp_replace(lower(translate(${column}, ${FOLD_MAP.from}, ${FOLD_MAP.to})), '\\s+', ' ', 'g')`;
}

/** `kolumna` (złożona) zawiera zapytanie. */
export function sqlFoldedContains(
  column: Prisma.Sql,
  normalized: string,
): Prisma.Sql {
  return Prisma.sql`${sqlFolded(column)} LIKE ${containsPattern(normalized)} ESCAPE '\\'`;
}

/** Id (uuid) zawiera zapytanie — wklejony kawałek identyfikatora z logu. */
export function sqlIdContains(
  column: Prisma.Sql,
  normalized: string,
): Prisma.Sql {
  return Prisma.sql`${column}::text LIKE ${containsPattern(normalized)} ESCAPE '\\'`;
}

/** To samo składanie co `sqlFolded`, w JS — do testu parytetu z `normalizeText`. */
export function foldLikeSql(value: string): string {
  let translated = '';
  for (const char of value) {
    const index = FOLD_MAP.from.indexOf(char);
    translated += index >= 0 ? FOLD_MAP.to[index] : char;
  }
  return translated.toLowerCase().replace(/\s+/g, ' ');
}
