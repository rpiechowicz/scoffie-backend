import { toRecipeListFacets, type RecipeFacetsRow } from './recipe-list-facets';

const row = (patch: Partial<RecipeFacetsRow> = {}): RecipeFacetsRow => ({
  title: 'Kurczak curry z ryżem',
  mealType: 'LUNCH',
  prepTimeMinutes: 35,
  servings: 4,
  nutritionKcal: 2_400,
  nutritionProtein: 160,
  nutritionFat: 60,
  nutritionCarbs: 280,
  nutritionFiber: 18,
  nutritionSalt: 5,
  allergens: ['milk'],
  dietTags: ['MEAT', 'DAIRY', 'GRAIN'],
  cuisine: 'INDIAN',
  dishType: 'STEW',
  seasons: ['WINTER', 'AUTUMN'],
  occasions: [],
  equipment: [],
  features: ['LUNCHBOX'],
  ingredients: [
    { name: 'Filet z kurczaka', department: 'Mięso' },
    { name: 'Ryż basmati', department: 'Sypkie' },
    { name: 'Jogurt naturalny', department: 'Nabiał' },
  ],
  ...patch,
});

describe('filtry listy katalogu', () => {
  it('taksonomia w porządku słownika, mięso i smak ze składników, makro na porcję', () => {
    expect(toRecipeListFacets(row())).toEqual({
      cuisine: 'INDIAN',
      dishType: 'STEW',
      seasons: ['AUTUMN', 'WINTER'],
      occasions: [],
      equipment: [],
      features: ['LUNCHBOX'],
      proteins: ['poultry'],
      taste: 'savory',
      diets: ['LACTOSE_FREE', 'GLUTEN_FREE'],
      fiberPerServing: 4.5,
      saltPerServing: 1.3,
    });
  });

  it('bez mięsa: wege, „meatless”; ryba łapie „Z rybą”', () => {
    const veg = toRecipeListFacets(
      row({
        dietTags: ['GRAIN'],
        allergens: ['gluten'],
        ingredients: [{ name: 'Makaron pszenny', department: 'Sypkie' }],
      }),
    );
    expect(veg.proteins).toEqual(['meatless']);
    expect(veg.diets).toEqual(['LACTOSE_FREE', 'VEGETARIAN', 'VEGAN']);

    const fish = toRecipeListFacets(
      row({
        dietTags: ['FISH'],
        allergens: ['fish'],
        ingredients: [{ name: 'Łosoś', department: 'Ryby' }],
      }),
    );
    expect(fish.proteins).toEqual(['fish']);
    expect(fish.diets).toContain('WITH_FISH');
    expect(fish.diets).not.toContain('VEGETARIAN');
  });

  it('przepis bez danych nie spełnia żadnej diety ani mięsa', () => {
    const empty = toRecipeListFacets(
      row({
        ingredients: [],
        dietTags: [],
        allergens: [],
        nutritionKcal: 0,
        nutritionProtein: 0,
        nutritionFat: 0,
        nutritionCarbs: 0,
        cuisine: null,
      }),
    );
    expect(empty.diets).toEqual([]);
    expect(empty.proteins).toEqual([]);
    expect(empty.cuisine).toBe('OTHER');
  });

  it('skorupiaki to „Z rybą”, nie wege', () => {
    const shrimp = toRecipeListFacets(
      row({
        dietTags: ['CRUSTACEAN'],
        allergens: ['crustaceans'],
        ingredients: [{ name: 'Krewetki', department: 'Ryby' }],
      }),
    );
    expect(shrimp.diets).toContain('WITH_FISH');
    expect(shrimp.diets).not.toContain('VEGETARIAN');
  });

  it('same tagi bez składników to też dowód (jak `fromServerTags` w iOS)', () => {
    const tagsOnly = toRecipeListFacets(
      row({ ingredients: [], dietTags: ['DAIRY'], allergens: [] }),
    );
    expect(tagsOnly.diets).toEqual([
      'LACTOSE_FREE',
      'VEGETARIAN',
      'GLUTEN_FREE',
    ]);
    expect(tagsOnly.proteins).toEqual([]);
  });

  it('keto po węglowodanach na porcję', () => {
    expect(toRecipeListFacets(row({ nutritionCarbs: 80 })).diets).toContain(
      'KETO',
    );
  });
});
