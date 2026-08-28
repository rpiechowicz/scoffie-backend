import {
  DIET_TAG_ID_VALUES,
  deriveRecipeTags,
  isDietTagId,
  sameTags,
} from './diet-tags';

describe('DIET_TAG_IDS', () => {
  it('pilnuje kontraktu z plikiem tagów i klientem iOS (RecipeDietProfile)', () => {
    expect(DIET_TAG_ID_VALUES).toEqual([
      'MEAT',
      'FISH',
      'CRUSTACEAN',
      'DAIRY',
      'EGG',
      'ANIMAL_OTHER',
      'GLUTEN_GRAIN',
      'GRAIN',
      'LEGUME',
      'PROCESSED',
      'ALCOHOL',
      'NON_FOOD',
    ]);
  });

  it.each(['meat', 'Meat', '', null, 7, 'VEGAN'])(
    'isDietTagId odrzuca %p',
    (value) => {
      expect(isDietTagId(value)).toBe(false);
    },
  );
});

describe('deriveRecipeTags', () => {
  it('liczy unię, deduplikuje i sortuje', () => {
    expect(
      deriveRecipeTags([
        { allergens: ['lactose'], dietTags: ['DAIRY'] },
        { allergens: ['gluten'], dietTags: ['GRAIN', 'GLUTEN_GRAIN'] },
        { allergens: ['gluten', 'eggs'], dietTags: ['EGG', 'GRAIN'] },
      ]),
    ).toEqual({
      allergens: ['eggs', 'gluten', 'lactose'],
      dietTags: ['DAIRY', 'EGG', 'GLUTEN_GRAIN', 'GRAIN'],
    });
  });

  it('przepis bez składników ma puste listy', () => {
    expect(deriveRecipeTags([])).toEqual({ allergens: [], dietTags: [] });
  });

  it('składnik bez tagów niczego nie dokłada', () => {
    expect(
      deriveRecipeTags([
        { allergens: [], dietTags: [] },
        { allergens: ['fish'], dietTags: ['FISH'] },
      ]),
    ).toEqual({ allergens: ['fish'], dietTags: ['FISH'] });
  });

  it('nie mutuje wejścia', () => {
    const input = [{ allergens: ['soy'], dietTags: ['LEGUME'] }];
    deriveRecipeTags(input);
    expect(input).toEqual([{ allergens: ['soy'], dietTags: ['LEGUME'] }]);
  });
});

describe('sameTags', () => {
  it('porównuje jak zbiory', () => {
    expect(sameTags(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameTags(['a'], ['a', 'b'])).toBe(false);
    expect(sameTags([], [])).toBe(true);
    expect(sameTags(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});
