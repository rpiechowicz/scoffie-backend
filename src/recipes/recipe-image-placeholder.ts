/**
 * Zaślepka zdjęcia przepisu z katalogu, który nie ma jeszcze zdjęcia z
 * Recrafta. Plik leży w `public/` i wychodzi przez `/static/` (patrz
 * `app.setup.ts`).
 *
 * Nie `null`: pusty `imageUrl` backend zamienia w locie na obrazek z
 * pollinations (`RecipesService.resolveRecipeImageUrl`), a import robi to
 * samo przy domyślnym `IMAGE_GENERATOR_PROVIDER`. Stały adres jest też
 * znacznikiem „do zrobienia": przepisy czekające na zdjęcie to
 * `WHERE "imageUrl" = RECIPE_IMAGE_PLACEHOLDER_URL`, a
 * `backfill-recipe-image-urls-from-r2.ts` traktuje je jak puste.
 */
export const RECIPE_IMAGE_PLACEHOLDER_URL =
  'https://api.scoffie.app/static/recipe-placeholder.png';

export function isRecipeImagePlaceholder(url?: string | null): boolean {
  return (url ?? '').trim() === RECIPE_IMAGE_PLACEHOLDER_URL;
}
