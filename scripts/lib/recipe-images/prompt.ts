/**
 * Szablon promptu zdjęć przepisów (styl „A”, zatwierdzony 23.09.2026; kąt podniesiony
 * z 40° na 55° tego samego dnia — przy 65° talerz dotykał krawędzi kadru).
 *
 * Kolejność zdań ma znaczenie: model najmocniej waży początek, więc najpierw
 * kompozycja (kąt, talerz na środku), potem danie, potem stały blok, który
 * robi z każdego dania „apetyczne”, a na końcu sceneria, światło i zakazy.
 *
 * Lekcje z prób, których nie widać w samym tekście:
 * - model nie słucha liczb — „połowa wysokości” daje 80%; wielkość trzyma
 *   dopiero „about two thirds”, a środek i tak poprawia `plate-detect.ts`;
 * - „no table edge” PODSUWA krawędź stołu; blat opisujemy jako ciągnący się
 *   poza kadr;
 * - światło z tyłu dorysowuje okno i robi się mrocznie — zostaje boczne.
 */

export const RECIPE_IMAGE_VESSELS = ['plate', 'bowl', 'board', 'cup'] as const;
export type RecipeImageVessel = (typeof RECIPE_IMAGE_VESSELS)[number];

// Wielkość osobno dla każdego naczynia: „dwie trzecie wysokości” trzyma płaski
// talerz, ale szeroka deska i wysoki kubek czy głęboka miska rosły wtedy poza
// kadr (próby z 23.09.2026) — dla nich opisujemy mniejszy udział w kadrze.
const VESSEL_TEXT: Record<
  RecipeImageVessel,
  { noun: string; lead: string; size: string }
> = {
  plate: {
    noun: 'round matte off-white rustic ceramic plate',
    lead: 'On the plate',
    size: 'filling about two thirds of the image height',
  },
  bowl: {
    noun: 'round matte off-white rustic ceramic bowl',
    lead: 'In the bowl',
    size: 'filling only about half of the image width, with plenty of countertop visible on the left and right',
  },
  board: {
    noun: 'round light oak wooden serving board',
    lead: 'On the board',
    size: 'filling only about half of the image width, with plenty of countertop visible on the left and right',
  },
  // „cup” sam z siebie wychodził jak miska; kształt trzeba nazwać wprost.
  cup: {
    noun: 'short straight-sided matte off-white rustic ceramic tumbler',
    lead: 'In the tumbler',
    size: 'small in the frame, filling only about half of the image height, with countertop visible above and below it',
  },
};

export function buildRecipeImagePrompt(
  dish: string,
  vessel: RecipeImageVessel,
): string {
  const { noun, lead, size } = VESSEL_TEXT[vessel];
  const shortNoun = vessel === 'cup' ? 'tumbler' : vessel;
  return [
    'Appetizing professional food photograph, camera at a high 55-degree elevated angle looking down at the dish from the front.',
    `One ${noun} placed exactly in the center of the frame, the whole ${shortNoun} fully visible, ${size}, with even space around it.`,
    `${lead}: ${dish.trim().replace(/\.+$/, '')}.`,
    'Perfectly cooked and freshly served, juicy and delicious, rich natural colors, visible texture, golden-brown where roasted, fried or baked, subtle glossy sheen on sauces and butter.',
    `Setting: a large light grey stone kitchen countertop that extends far beyond the frame in every direction and fills the entire background, with a folded natural linen napkin and a few fresh herbs softly blurred behind the ${shortNoun}; no cutlery, no other dishes.`,
    'Soft natural daylight from the left and slightly behind, gentle highlights and soft shadows, bright and airy with a slightly warm tone.',
    'Shallow depth of field, the food in sharp focus. Ultra realistic editorial food photography, high-end cookbook style.',
    'No text, no watermark, no hands, no glass, no transparent dishes.',
  ].join(' ');
}
