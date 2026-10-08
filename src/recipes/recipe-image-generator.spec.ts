import {
  isGeneratedRecipeImageUrl,
  withoutGeneratedImages,
} from './recipe-image-generator';

const GENERATED =
  'https://image.pollinations.ai/prompt/professional%20food%20photo%2C%20Tajny%20gulasz%2C%20przepis%20babci?seed=scoffie-1';
const CATALOG_PHOTO = 'https://img.scoffie.app/recipe-images/abc.webp';

describe('withoutGeneratedImages — karty bez adresów generatora (review 7.10.2026)', () => {
  it('rozpoznaje adres generatora po bazie i po hoście, nie myli z R2', () => {
    expect(isGeneratedRecipeImageUrl(GENERATED)).toBe(true);
    expect(
      isGeneratedRecipeImageUrl('http://image.pollinations.ai/prompt/x'),
    ).toBe(true);
    expect(
      isGeneratedRecipeImageUrl(
        'https://gen.example/p/x',
        'https://gen.example/p',
      ),
    ).toBe(true);
    expect(isGeneratedRecipeImageUrl(CATALOG_PHOTO)).toBe(false);
    expect(isGeneratedRecipeImageUrl('')).toBe(false);
    expect(isGeneratedRecipeImageUrl('nie adres')).toBe(false);
  });

  it('PLAN_WEEK: adres generatora w slocie → null, zdjęcie katalogu zostaje', () => {
    const card = {
      kind: 'PLAN_WEEK',
      days: [
        {
          dayOfWeek: 'MON',
          slots: [
            { recipeId: 'r-1', title: 'Tajny gulasz', imageUrl: GENERATED },
            { recipeId: 'r-2', title: 'Owsianka', imageUrl: CATALOG_PHOTO },
            { recipeId: 'r-3', title: 'Bez zdjęcia', imageUrl: null },
          ],
        },
      ],
    };
    const result = withoutGeneratedImages(card);
    expect(result.days[0].slots.map((slot) => slot.imageUrl)).toEqual([
      null,
      CATALOG_PHOTO,
      null,
    ]);
    expect(JSON.stringify(result)).not.toContain('pollinations');
    // Wejście nietknięte (karta z bazy nie jest mutowana).
    expect(card.days[0].slots[0].imageUrl).toBe(GENERATED);
  });

  it('PLAN_DAY, OPTIONS i SWAP: każda głębokość', () => {
    expect(
      withoutGeneratedImages({
        kind: 'PLAN_DAY',
        slots: [{ imageUrl: GENERATED }],
      }).slots[0].imageUrl,
    ).toBeNull();
    expect(
      withoutGeneratedImages({
        kind: 'OPTIONS',
        options: [{ imageUrl: GENERATED }, { imageUrl: CATALOG_PHOTO }],
      }).options.map((option) => option.imageUrl),
    ).toEqual([null, CATALOG_PHOTO]);
    expect(
      withoutGeneratedImages({
        kind: 'SWAP',
        from: { imageUrl: GENERATED },
        to: { imageUrl: CATALOG_PHOTO },
      }),
    ).toMatchObject({
      from: { imageUrl: null },
      to: { imageUrl: CATALOG_PHOTO },
    });
  });

  it('karta bez adresów generatora wraca jako TEN SAM obiekt; null i prymitywy przechodzą', () => {
    const clean = {
      kind: 'OPTIONS',
      options: [{ imageUrl: CATALOG_PHOTO, title: 'Owsianka' }],
    };
    expect(withoutGeneratedImages(clean)).toBe(clean);
    expect(withoutGeneratedImages(null)).toBeNull();
    expect(withoutGeneratedImages('tekst')).toBe('tekst');
  });

  it('pole o innej nazwie z adresem generatora zostaje (to nie zdjęcie karty)', () => {
    const card = { prompt: GENERATED };
    expect(withoutGeneratedImages(card)).toBe(card);
  });
});
