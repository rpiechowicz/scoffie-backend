import {
  canonicalTaxonomy,
  canonicalTaxonomyList,
  RECIPE_DISH_TYPES,
  seasonOf,
  taxonomyProblems,
} from './recipe-taxonomy';
import { RECIPE_DISH_TAGS } from './recipe-facets.util';

describe('taksonomia przepisu', () => {
  it('poprawna taksonomia nie ma problemów; pominięte pola się nie liczą', () => {
    expect(
      taxonomyProblems({
        cuisine: 'POLISH',
        dishType: 'SOUP',
        seasons: ['AUTUMN', 'WINTER'],
        occasions: ['CHRISTMAS_EVE'],
        equipment: ['OVEN'],
        features: ['OCCASIONAL'],
      }),
    ).toEqual([]);
    expect(taxonomyProblems({})).toEqual([]);
    expect(taxonomyProblems({ dishType: null })).toEqual([]);
  });

  it('nieznana wartość, powtórka i nie-lista to błędy', () => {
    expect(
      taxonomyProblems({
        cuisine: 'polish',
        occasions: ['EASTER', 'EASTER'],
        features: 'LUNCHBOX' as unknown as string[],
      }),
    ).toEqual([
      'nieznana kuchnia "polish"',
      'occasions: wartość powtórzona',
      'features musi być listą',
    ]);
  });

  it('listy w porządku słownika, bez powtórzeń i wartości spoza słownika', () => {
    expect(
      canonicalTaxonomyList('seasons', ['WINTER', 'SPRING', 'WINTER']),
    ).toEqual(['SPRING', 'WINTER']);
    expect(
      canonicalTaxonomy({
        cuisine: 'THAI',
        dishType: 'STEW',
        seasons: [],
        occasions: ['PARTY', 'BARBECUE'],
        equipment: ['GRILL', 'OVEN', 'X'],
        features: [],
      }),
    ).toEqual({
      cuisine: 'THAI',
      dishType: 'STEW',
      seasons: [],
      occasions: ['BARBECUE', 'PARTY'],
      equipment: ['OVEN', 'GRILL'],
      features: [],
    });
  });

  it('rodzaj dania = tagi wyszukiwania asystenta plus MAIN', () => {
    expect(
      RECIPE_DISH_TYPES.filter((type) => type !== 'MAIN').map((type) =>
        type.toLowerCase(),
      ),
    ).toEqual(expect.arrayContaining([...RECIPE_DISH_TAGS]));
    expect(RECIPE_DISH_TYPES).toHaveLength(RECIPE_DISH_TAGS.length + 1);
  });

  it('pora roku meteorologicznie, po dacie UTC', () => {
    expect(seasonOf(new Date('2026-02-28T12:00:00Z'))).toBe('WINTER');
    expect(seasonOf(new Date('2026-03-01T00:00:00Z'))).toBe('SPRING');
    expect(seasonOf(new Date('2026-06-15T00:00:00Z'))).toBe('SUMMER');
    expect(seasonOf(new Date('2026-11-30T23:00:00Z'))).toBe('AUTUMN');
    expect(seasonOf(new Date('2026-12-24T18:00:00Z'))).toBe('WINTER');
  });
});
