import {
  autoPlanBlock,
  canonicalTaxonomy,
  canonicalTaxonomyList,
  easterSunday,
  EMPTY_RECIPE_TAXONOMY,
  isOccasionSeason,
  RECIPE_DISH_TYPES,
  seasonOf,
  taxonomyProblems,
  taxonomySearchText,
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

  it('Niedziela Wielkanocna — znane daty', () => {
    const iso = (year: number) => easterSunday(year).toISOString().slice(0, 10);
    expect(iso(2025)).toBe('2025-04-20');
    expect(iso(2026)).toBe('2026-04-05');
    expect(iso(2027)).toBe('2027-03-28');
    expect(iso(2038)).toBe('2038-04-25');
  });

  it('okresy okazji: grudzień do 26., Wielkanoc −14..+1 dni, grill, Sylwester', () => {
    const on = (occasion: string, date: string) =>
      isOccasionSeason(occasion, new Date(`${date}T12:00:00Z`));
    expect(on('CHRISTMAS_EVE', '2026-12-01')).toBe(true);
    expect(on('CHRISTMAS', '2026-12-26')).toBe(true);
    expect(on('CHRISTMAS_EVE', '2026-12-27')).toBe(false);
    expect(on('CHRISTMAS_EVE', '2026-11-30')).toBe(false);
    expect(on('EASTER', '2026-03-22')).toBe(true);
    expect(on('EASTER', '2026-03-21')).toBe(false);
    expect(on('EASTER', '2026-04-06')).toBe(true);
    expect(on('EASTER', '2026-04-07')).toBe(false);
    expect(on('BARBECUE', '2026-05-01')).toBe(true);
    expect(on('BARBECUE', '2026-10-01')).toBe(false);
    expect(on('PARTY', '2026-12-31')).toBe(true);
    expect(on('PARTY', '2027-01-01')).toBe(true);
    expect(on('PARTY', '2027-01-02')).toBe(false);
  });

  it('planer sam: bez dodatku, poza sezonem i „od święta” poza okazją', () => {
    const july = new Date('2026-07-15T12:00:00Z');
    const december = new Date('2026-12-20T12:00:00Z');
    const plain = { seasons: [], occasions: [], features: [] };
    expect(autoPlanBlock(plain, july)).toBeNull();
    expect(autoPlanBlock({ ...plain, features: ['SIDE'] }, july)).toBe('SIDE');
    expect(autoPlanBlock({ ...plain, seasons: ['WINTER'] }, july)).toBe(
      'OUT_OF_SEASON',
    );
    expect(
      autoPlanBlock({ ...plain, seasons: ['WINTER'] }, december),
    ).toBeNull();
    const carp = {
      seasons: [],
      occasions: ['CHRISTMAS_EVE'],
      features: ['OCCASIONAL'],
    };
    expect(autoPlanBlock(carp, july)).toBe('OUT_OF_OCCASION');
    expect(autoPlanBlock(carp, december)).toBeNull();
    // Okazja bez `OCCASIONAL` (bigos, żurek) = danie całoroczne.
    expect(
      autoPlanBlock({ ...plain, occasions: ['CHRISTMAS'] }, july),
    ).toBeNull();
  });

  it('słowa taksonomii dla wyszukiwarki asystenta', () => {
    const text = taxonomySearchText({
      cuisine: 'ITALIAN',
      dishType: 'PASTA',
      seasons: ['SUMMER'],
      occasions: ['BARBECUE'],
      equipment: ['OVEN', 'AIRFRYER'],
      features: ['LUNCHBOX'],
    });
    for (const word of ['wloskie', 'letnie', 'grilla', 'airfryer', 'pudelka']) {
      expect(text).toContain(word);
    }
    expect(text).not.toContain('piekarnik');
    expect(taxonomySearchText(EMPTY_RECIPE_TAXONOMY)).toBe('');
  });

  it('pora roku meteorologicznie, po dacie UTC', () => {
    expect(seasonOf(new Date('2026-02-28T12:00:00Z'))).toBe('WINTER');
    expect(seasonOf(new Date('2026-03-01T00:00:00Z'))).toBe('SPRING');
    expect(seasonOf(new Date('2026-06-15T00:00:00Z'))).toBe('SUMMER');
    expect(seasonOf(new Date('2026-11-30T23:00:00Z'))).toBe('AUTUMN');
    expect(seasonOf(new Date('2026-12-24T18:00:00Z'))).toBe('WINTER');
  });
});
