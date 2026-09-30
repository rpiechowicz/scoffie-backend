/**
 * Plik scenariuszy pisanych ręcznie (`prisma/catalog/cook-scenarios-pl-v1.json`)
 * → treść z id składników danej bazy.
 *
 * W pliku składniki są po NAZWIE z przepisu (`ingredient`, `mentions`), bo id
 * `Ingredient` różnią się między bazami (dev, prod). Zamianę robi jedna
 * funkcja dla loadera (`scripts/load-cook-scenarios.ts`, nazwy z bazy) i testu
 * złotego (nazwy z pliku katalogu) — obie drogi widzą to samo.
 */

export interface GoldenScenarioEntry {
  recipeId: string;
  title: string;
  content: unknown;
}

export interface GoldenScenarioFile {
  version: string;
  rulesVersion: string;
  scenarios: GoldenScenarioEntry[];
}

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Podmienia `ingredient` → `ingredientId` i nazwy w `mentions` → id. Nazwa,
 * której nie ma w przepisie, zostaje jako błąd (a nie cicha dziura) — treść
 * i tak nie przejdzie walidatora, ale raport powie DLACZEGO.
 */
export function resolveGoldenContent(
  content: unknown,
  idForName: (name: string) => string | undefined,
): { content: unknown; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(content) || !Array.isArray(content.steps)) {
    return { content, errors: ['scenariusz: brak listy kroków'] };
  }
  const resolve = (name: unknown, path: string): string => {
    if (typeof name !== 'string') {
      errors.push(`${path}: wymagana nazwa składnika`);
      return '';
    }
    const id = idForName(name);
    if (!id) errors.push(`${path}: „${name}” nie ma w przepisie`);
    return id ?? '';
  };
  const steps = (content.steps as unknown[]).map((step, index) => {
    if (!isRecord(step)) return step;
    const path = `steps[${index}]`;
    const ingredients = Array.isArray(step.ingredients)
      ? (step.ingredients as unknown[]).map((item, i) => {
          if (!isRecord(item)) return item;
          const { ingredient, ...rest } = item;
          return {
            ingredientId: resolve(ingredient, `${path}.ingredients[${i}]`),
            ...rest,
          };
        })
      : step.ingredients;
    const mentions = Array.isArray(step.mentions)
      ? (step.mentions as unknown[]).map((name, i) =>
          resolve(name, `${path}.mentions[${i}]`),
        )
      : step.mentions;
    return { ...step, ingredients, mentions };
  });
  return { content: { ...content, steps }, errors };
}
