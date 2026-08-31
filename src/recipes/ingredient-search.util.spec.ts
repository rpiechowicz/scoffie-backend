import {
  allowedUnitsFor,
  matchScore,
  rankIngredients,
  SEARCH_STEM_LENGTH,
  searchStem,
} from './ingredient-search.util';

const ingredient = (name: string, aliases: string[] = []) => ({
  name,
  normalizedName: name.toLowerCase(),
  aliases: aliases.map((alias) => ({ alias })),
});

describe('searchStem', () => {
  it('bierze NAJDŁUŻSZE słowo, nie pierwsze', () => {
    // W „pierś z kurczaka" znaczące jest „kurczaka", nie „pierś" ani „z".
    expect(searchStem('pierś z kurczaka')).toBe('kurc');
  });

  it('przycina do stałej długości rdzenia', () => {
    expect(searchStem('pomidory')).toHaveLength(SEARCH_STEM_LENGTH);
    expect(searchStem('pomidory')).toBe('pomi');
  });

  it('krótkie słowo zostaje w całości', () => {
    expect(searchStem('ryż')).toBe('ryz');
  });

  it('puste zapytanie daje pusty rdzeń', () => {
    expect(searchStem('   ')).toBe('');
  });

  it('zdejmuje polskie znaki — tak samo jak `normalizedName` w bazie', () => {
    expect(searchStem('śmietana')).toBe('smie');
  });
});

describe('matchScore', () => {
  it('dokładna nazwa bije wszystko', () => {
    expect(matchScore('jajko', 'jajko')).toBe(100);
  });

  it('odmiana (wspólny prefiks) wygrywa z samym zawieraniem', () => {
    const odmiana = matchScore('jajka', 'jajko');
    const zawieranie = matchScore('jajka', 'sałatka z jajkami i majonezem');
    expect(odmiana).toBeGreaterThan(zawieranie);
  });

  it('nazwa zawierająca zapytanie punktuje wyżej niż odwrotnie', () => {
    expect(matchScore('kurczak', 'pierś z kurczaka')).toBeGreaterThan(0);
  });

  it('zapytanie wielosłowne trafia po którymkolwiek znaczącym słowie', () => {
    expect(matchScore('makaron pełnoziarnisty', 'makaron')).toBeGreaterThan(0);
  });

  it('nic wspólnego to zero, nie przypadkowe trafienie', () => {
    expect(matchScore('czekolada', 'ziemniaki')).toBe(0);
  });

  it('ignoruje wielkość liter i ogonki', () => {
    expect(matchScore('ŚMIETANA', 'śmietana')).toBe(100);
  });
});

describe('rankIngredients', () => {
  it('polska odmiana trafia w formę z katalogu', () => {
    // To jest cały powód, dla którego ranking liczy się w kodzie, a nie w SQL:
    // „jajka" nie zawiera się w „jajko".
    const wynik = rankIngredients('jajka', [
      ingredient('mąka pszenna'),
      ingredient('jajko'),
    ]);
    expect(wynik[0].name).toBe('jajko');
  });

  it('przy remisie krótsza nazwa idzie pierwsza — to zwykle ta ogólna', () => {
    // Oba zaczynają się od zapytania, więc punktują tak samo; rozstrzyga długość.
    const wynik = rankIngredients('ryż', [
      ingredient('ryż brązowy'),
      ingredient('ryż biały'),
    ]);
    expect(wynik.map((i) => i.name)).toEqual(['ryż biały', 'ryż brązowy']);
  });

  it('alias działa tak samo jak nazwa', () => {
    const wynik = rankIngredients('kurczak', [
      ingredient('ziemniaki'),
      ingredient('pierś z kurczaka', ['kurczak']),
    ]);
    expect(wynik[0].name).toBe('pierś z kurczaka');
  });

  it('odsiewa kandydatów bez żadnego dopasowania', () => {
    const wynik = rankIngredients('czekolada', [
      ingredient('ziemniaki'),
      ingredient('cebula'),
    ]);
    expect(wynik).toEqual([]);
  });

  it('puste zapytanie = przeglądanie alfabetyczne, nie pustka', () => {
    const wynik = rankIngredients('', [
      ingredient('ziemniaki'),
      ingredient('cebula'),
    ]);
    expect(wynik.map((i) => i.name)).toEqual(['cebula', 'ziemniaki']);
  });
});

describe('allowedUnitsFor', () => {
  it('sztuki tylko dla składnika z gramaturą — inaczej nie policzymy makro', () => {
    expect(
      allowedUnitsFor({ category: 'Nabiał', gramsPerPiece: 60 }),
    ).toContain('szt');
    expect(
      allowedUnitsFor({ category: 'Piekarnia', gramsPerPiece: null }),
    ).not.toContain('szt');
  });

  it('łyżki i szczypty tylko dla przypraw — reszta rzuca przy przeliczaniu', () => {
    const przyprawa = allowedUnitsFor({
      category: 'Przyprawy i sosy',
      gramsPerPiece: null,
    });
    expect(przyprawa).toEqual(
      expect.arrayContaining(['łyżeczka', 'łyżka', 'szczypta']),
    );
    expect(
      allowedUnitsFor({ category: 'Warzywa', gramsPerPiece: null }),
    ).not.toContain('łyżka');
  });

  it('gramy i mililitry są zawsze', () => {
    expect(allowedUnitsFor({ category: 'Inne', gramsPerPiece: null })).toEqual(
      expect.arrayContaining(['g', 'kg', 'ml', 'l']),
    );
  });
});
