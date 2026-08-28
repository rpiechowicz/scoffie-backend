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
