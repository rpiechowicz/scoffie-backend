/**
 * Czyste przejścia z wierszy katalogu na kontrakt panelu — bez Prismy, żeby
 * reguły dało się sprawdzić testem jednostkowym (`catalog-math.spec.ts`).
 */

/**
 * Kroki z `Recipe.sourceInstructions` → teksty w kolejności wykonania.
 *
 * Kolumna ma dwie pisownie: import katalogu zapisuje `{ step, text }`,
 * `recipes:create`/`update` — `{ stepNumber, text }` (`recipe-steps.util.ts`).
 * Czytamy to samo, co iOS: numer z `stepNumber` / `step` / `step_number`, tekst
 * z `text` / `instruction`, a bez numeru — pozycję w tablicy. Puste kroki
 * odpadają, jak w `normalizeRecipeSteps`.
 */
export function stepsFromInstructions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries = value as unknown[];
  const steps: { order: number; index: number; text: string }[] = [];
  entries.forEach((entry, index) => {
    if (typeof entry === 'string') {
      steps.push({ order: index + 1, index, text: entry.trim() });
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    const order = [record.stepNumber, record.step, record.step_number].find(
      (candidate): candidate is number =>
        typeof candidate === 'number' && Number.isFinite(candidate),
    );
    const text = [record.text, record.instruction].find(
      (candidate): candidate is string => typeof candidate === 'string',
    );
    steps.push({ order: order ?? index + 1, index, text: (text ?? '').trim() });
  });
  return steps
    .filter((step) => step.text.length > 0)
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((step) => step.text);
}

/**
 * Podstawa wartości odżywczych składnika: 100 g czy 100 ml.
 *
 * W bazie NIE MA takiej kolumny — jednostka żyje tylko w pliku, z którego
 * wgrywa się makro (`prisma/catalog/ingredient-nutrition-pl-v1.json`, pole
 * `unit`). Wyprowadzamy ją z danych, które baza ma: z jednostek, w jakich
 * przepisy katalogu naprawdę odmierzają składnik (`RecipeIngredient.normalizedUnit`).
 * Dla składników użytych w przepisach zgadza się to z plikiem w 100 %
 * (sprawdzone 24.09.2026 na katalogu 500 przepisów: 301/301); składnik bez
 * przepisu dostaje `g` — mylą się tu tylko płyny, których żaden przepis nie
 * używa (15, np. wody i soki). Trwałe rozwiązanie to kolumna jednostki przy
 * decyzji D1 (ROADMAPA §9).
 */
export function baseUnitFromUsage(usage: {
  grams: number;
  millilitres: number;
}): 'g' | 'ml' {
  return usage.millilitres > usage.grams ? 'ml' : 'g';
}

/**
 * Kalorie na porcję: `Recipe.nutritionKcal` to CAŁY przepis (konwencja
 * `recipe-nutrition.util.ts`), porcji jest `servings` (1..8).
 */
export function kcalPerServing(
  nutritionKcal: number,
  servings: number,
): number {
  return Math.round(nutritionKcal / Math.max(1, servings));
}

const POLISH = new Intl.Collator('pl', { sensitivity: 'base', numeric: true });

/** Porządek alfabetyczny po polsku („ł” po „l”, „ż” na końcu), remis po id. */
export function comparePolish(
  a: { text: string; id: string },
  b: { text: string; id: string },
): number {
  return (
    POLISH.compare(a.text, b.text) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
