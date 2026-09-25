import { RECIPE_IMAGE_PLACEHOLDER_URL } from '../../recipes/recipe-image-placeholder';
import { toRecipeListItem, type RecipeListRow } from './recipe-list-item';

const row = (patch: Partial<RecipeListRow> = {}): RecipeListRow => ({
  id: 'r1',
  title: 'Owsianka',
  imageUrl: 'https://img.scoffie.app/recipe-images/r1.webp',
  isActive: true,
  mealType: 'LUNCH',
  suitableMealTypes: ['DINNER', 'LUNCH'],
  difficulty: 'MEDIUM',
  prepTimeMinutes: 20,
  servings: 4,
  nutritionKcal: 2_000,
  nutritionProtein: 90,
  nutritionFat: 61,
  nutritionCarbs: 250,
  allergens: ['gluten'],
  updatedAt: new Date('2026-09-25T10:00:00.000Z'),
  ...patch,
});

describe('wiersz listy katalogu', () => {
  it('makro na porcję z kolumn CAŁEGO przepisu, pory w kolejności dnia', () => {
    expect(toRecipeListItem(row(), 3, 7)).toEqual({
      id: 'r1',
      title: 'Owsianka',
      imageUrl: 'https://img.scoffie.app/recipe-images/r1.webp',
      hasImage: true,
      isActive: true,
      mealType: 'LUNCH',
      suitableMealTypes: ['LUNCH', 'DINNER'],
      difficulty: 'MEDIUM',
      prepTimeMinutes: 20,
      servings: 4,
      kcalPerServing: 500,
      proteinPerServing: 22.5,
      fatPerServing: 15.3,
      carbsPerServing: 62.5,
      allergens: ['gluten'],
      inPlans: 3,
      favorites: 7,
      updatedAt: '2026-09-25T10:00:00.000Z',
    });
  });

  it('brak zdjęcia: pusty adres, zaślepka', () => {
    expect(toRecipeListItem(row({ imageUrl: null }), 0, 0)).toMatchObject({
      imageUrl: '',
      hasImage: false,
    });
    expect(
      toRecipeListItem(row({ imageUrl: RECIPE_IMAGE_PLACEHOLDER_URL }), 0, 0)
        .hasImage,
    ).toBe(false);
  });

  it('pusta lista pór (wiersz sprzed backfillu) — slot bazowy', () => {
    expect(
      toRecipeListItem(row({ suitableMealTypes: [] }), 0, 0).suitableMealTypes,
    ).toEqual(['LUNCH']);
  });
});
