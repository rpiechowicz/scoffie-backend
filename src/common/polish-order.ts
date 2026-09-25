const POLISH = new Intl.Collator('pl', { sensitivity: 'base', numeric: true });

/**
 * Porządek alfabetyczny po polsku („ł” po „l”, „ż” na końcu), remis po id.
 * Jedna definicja dla list panelu i dla kolejności przepisów w eksporcie
 * katalogu (`src/recipes/catalog/catalog-export.ts`).
 */
export function comparePolish(
  a: { text: string; id: string },
  b: { text: string; id: string },
): number {
  return (
    POLISH.compare(a.text, b.text) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
