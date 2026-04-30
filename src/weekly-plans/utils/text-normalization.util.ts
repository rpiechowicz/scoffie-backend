/// Stable product key used to merge same-product/same-unit entries from
/// different recipes within a shopping list.
export function normalizeProductKey(name: string, unit: string): string {
  return `${name.trim().toLowerCase()}::${unit.trim().toLowerCase()}`;
}

/// Lowercases, strips diacritics, and folds Polish accents so keyword
/// matching can use plain ASCII stems (e.g. "ł" -> "l", "ś" -> "s").
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ł]/g, 'l')
    .replace(/[ą]/g, 'a')
    .replace(/[ć]/g, 'c')
    .replace(/[ę]/g, 'e')
    .replace(/[ń]/g, 'n')
    .replace(/[ó]/g, 'o')
    .replace(/[ś]/g, 's')
    .replace(/[ź]/g, 'z')
    .replace(/[ż]/g, 'z')
    .trim();
}

/// Escapes a literal string so it can be safely embedded inside a `RegExp(...)`.
export function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/// Treats `keyword` as a stem — `ser` matches `ser`, `sery`, `sera`, etc.
/// Caller is expected to pass `text` already normalized.
export function keywordMatches(text: string, keyword: string): boolean {
  const escaped = escapeForRegex(keyword);
  const pattern = new RegExp(`\\b${escaped}[a-z]*\\b`, 'i');
  return pattern.test(text);
}

/// Capitalizes the first character without touching the rest. Used as a
/// gentler alternative to "real" title-case for already-Polish names.
export function toTitleCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/// Re-applies Polish diacritics to text that went through `normalizeText`.
/// Phrase replacements run first (e.g. "wino biale polslodkie" → "wino białe
/// półsłodkie"), then individual token replacements (e.g. "maslo" → "masło").
export function toPolishDisplayText(value: string): string {
  let output = value.trim().toLowerCase();
  if (!output) return output;

  const phraseReplacements: Array<[string, string]> = [
    ['papryka slodka', 'papryka słodka'],
    ['papryka ostra', 'papryka ostra'],
    ['papryka zolta', 'papryka żółta'],
    ['fasola biala', 'fasola biała'],
    ['wino biale', 'wino białe'],
    ['wino czerwone polslodkie', 'wino czerwone półsłodkie'],
    ['wino czerwone polwytrawne', 'wino czerwone półwytrawne'],
    ['wino biale polslodkie', 'wino białe półsłodkie'],
    ['wino biale polwytrawne', 'wino białe półwytrawne'],
  ];

  for (const [from, to] of phraseReplacements) {
    output = output.replace(
      new RegExp(`\\b${escapeForRegex(from)}\\b`, 'g'),
      to,
    );
  }

  const tokenReplacements: Array<[string, string]> = [
    ['ogorek', 'ogórek'],
    ['maslo', 'masło'],
    ['salata', 'sałata'],
    ['platki', 'płatki'],
    ['losos', 'łosoś'],
    ['brokul', 'brokuł'],
    ['ryz', 'ryż'],
    ['smietana', 'śmietana'],
    ['smietanka', 'śmietanka'],
    ['sol', 'sól'],
    ['zolta', 'żółta'],
    ['zolty', 'żółty'],
    ['biala', 'biała'],
    ['biale', 'białe'],
    ['bialy', 'biały'],
    ['brazowy', 'brązowy'],
    ['jasminowy', 'jaśminowy'],
    ['zytni', 'żytni'],
    ['zytnie', 'żytnie'],
    ['wloski', 'włoski'],
    ['twarozek', 'twarożek'],
    ['kielbasa', 'kiełbasa'],
    ['lopatka', 'łopatka'],
    ['wolowina', 'wołowina'],
    ['jablko', 'jabłko'],
    ['jablka', 'jabłka'],
    ['polslodkie', 'półsłodkie'],
    ['polwytrawne', 'półwytrawne'],
  ];

  for (const [from, to] of tokenReplacements) {
    output = output.replace(
      new RegExp(`\\b${escapeForRegex(from)}\\b`, 'g'),
      to,
    );
  }

  return output.replace(/\s+/g, ' ').trim();
}
