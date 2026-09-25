/**
 * Kroki przygotowania: z wejścia klienta do kształtu, który czyta iOS.
 *
 * Do tej pory kroki dało się wgrać WYŁĄCZNIE importem katalogu — `recipes:create`
 * ich nie przyjmował. Dla asystenta to była dziura nie do obejścia: potrafił
 * zaproponować danie, ale nie umiał zapisać, jak je ugotować.
 *
 * Kształt na drucie to `{ stepNumber, text }`. iOS akceptuje kilka pisowni
 * (`stepNumber`, `step_number`, `text`, `instruction`) i przy braku numeru
 * bierze pozycję w tablicy — dlatego stary katalog, zapisany jako
 * `{ step, text }`, wyświetla się poprawnie mimo innej nazwy pola. Nowe
 * zapisy używają nazwy, którą klient czyta wprost, żeby numeracja nie zależała
 * od kolejności elementów w JSON-ie.
 */
export type RecipeStepInput = {
  stepNumber?: number;
  text: string;
};

export type RecipeStepStored = {
  stepNumber: number;
  text: string;
};

/**
 * Numeruje kroki od 1 po kolei, niezależnie od tego, co przysłał klient.
 *
 * `stepNumber` z wejścia służy WYŁĄCZNIE do ustalenia kolejności — potem i tak
 * nadajemy numery od nowa. Inaczej model, który poda „1, 2, 2, 5", zapisałby
 * przepis z duplikatem i dziurą, a użytkownik zobaczyłby kroki w losowej
 * kolejności. Puste teksty odpadają, bo pusty krok to nie krok.
 */
export function normalizeRecipeSteps(
  steps: RecipeStepInput[] | undefined,
): RecipeStepStored[] | undefined {
  if (steps === undefined) return undefined;

  return steps
    .map((step, index) => ({
      order: step.stepNumber ?? index + 1,
      index,
      text: step.text.trim(),
    }))
    .filter((step) => step.text.length > 0)
    .sort((a, b) =>
      a.order !== b.order ? a.order - b.order : a.index - b.index,
    )
    .map((step, position) => ({ stepNumber: position + 1, text: step.text }));
}

/**
 * Kroki z `Recipe.sourceInstructions` → teksty w kolejności wykonania.
 *
 * Kolumna ma dwie pisownie: import katalogu zapisuje `{ step, text }`,
 * `recipes:create`/`update` — `{ stepNumber, text }` (`normalizeRecipeSteps`).
 * Czytamy to samo, co iOS: numer z `stepNumber` / `step` / `step_number`, tekst
 * z `text` / `instruction`, a bez numeru — pozycję w tablicy. Puste kroki
 * odpadają, jak w `normalizeRecipeSteps`. Czytają to panel (szczegół
 * przepisu) i eksport katalogu (`catalog-export.ts`).
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
