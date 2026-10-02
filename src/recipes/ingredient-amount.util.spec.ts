import {
  ALLOWED_UNITS,
  kitchenMeasure,
  normalizeIngredientAmount,
  normalizeText,
  withKitchenMeasure,
} from './ingredient-amount.util';

/**
 * Tabela łyżeczek jest jedyną prawdą o tym, ile waży „1 łyżeczka soli" — i to
 * dla WSZYSTKICH dróg do bazy (import katalogu, przeliczanie makro, tworzenie
 * przepisu przez API). Serwis miał kiedyś własną kopię tej tabeli, która
 * rozjechała się o jedną pozycję; te wiersze przybijają wartości, żeby
 * kolejna kopia nie mogła zrobić tego po cichu.
 */
describe('normalizeIngredientAmount', () => {
  it.each([
    ['mąka pszenna', 'Zboża i makarony', 300, 'g', 300, 'g'],
    ['mąka pszenna', 'Zboża i makarony', 1.5, 'kg', 1500, 'g'],
    ['mleko', 'Nabiał', 250, 'ml', 250, 'ml'],
    ['mleko', 'Nabiał', 2, 'l', 2000, 'ml'],
    ['jajko', 'Nabiał', 3, 'szt', 3, 'szt'],
    ['sól', 'Przyprawy i sosy', 1, 'łyżeczka', 6, 'g'],
    ['sól', 'Przyprawy i sosy', 1, 'łyżka', 18, 'g'],
    ['sól', 'Przyprawy i sosy', 1, 'szczypta', 0.375, 'g'],
    ['sól', 'Przyprawy i sosy', 2, 'lyzeczka', 12, 'g'],
    // D3: ta pozycja żyła tylko w utilu; kopia w RecipesService dawała 2.5 g.
    ['przyprawa uniwersalna', 'Przyprawy i sosy', 1, 'łyżeczka', 4, 'g'],
    ['ketchup', 'Przyprawy i sosy', 1, 'łyżka', 15, 'ml'],
    ['sos sojowy', 'Przyprawy i sosy', 1, 'łyżeczka', 5, 'ml'],
    ['musztarda', 'Przyprawy i sosy', 1, 'szczypta', 0.5, 'ml'],
    // Przyprawa spoza tabeli — domyślne 2,5 g na łyżeczkę.
    ['przyprawa do ryb', 'Przyprawy i sosy', 1, 'łyżeczka', 2.5, 'g'],
    ['przyprawa do ryb', 'Przyprawy i sosy', 1, 'łyżka', 7.5, 'g'],
    ['zioła prowansalskie', 'Przyprawy i sosy', 1, 'łyżeczka', 1, 'g'],
    ['majeranek', 'Przyprawy i sosy', 1, 'łyżeczka', 0.6, 'g'],
  ])(
    '%s (%s): %s %s -> %s %s',
    (name, category, amount, unit, expectedAmount, expectedUnit) => {
      const result = normalizeIngredientAmount(name, category, amount, unit);
      expect(result.normalizedUnit).toBe(expectedUnit);
      expect(result.normalizedAmount).toBeCloseTo(expectedAmount, 4);
    },
  );

  describe('bramka kategorii', () => {
    it('odrzuca łyżeczkę poza kategorią „Przyprawy i sosy"', () => {
      expect(() =>
        normalizeIngredientAmount('mleko', 'Nabiał', 1, 'łyżeczka'),
      ).toThrow(/only for category "Przyprawy i sosy"/);
      expect(() =>
        normalizeIngredientAmount('mleko', 'Nabiał', 1, 'łyżeczka'),
      ).toThrow(/mleko/);
    });

    it('nie bramkuje g/kg/ml/l/szt', () => {
      for (const unit of ['g', 'kg', 'ml', 'l', 'szt']) {
        expect(() =>
          normalizeIngredientAmount('mleko', 'Nabiał', 1, unit),
        ).not.toThrow();
      }
    });

    it('rozpoznaje kategorię niezależnie od wielkości liter i spacji', () => {
      expect(
        normalizeIngredientAmount('sól', 'PRZYPRAWY I SOSY', 1, 'łyżeczka')
          .normalizedAmount,
      ).toBe(6);
      expect(
        normalizeIngredientAmount('sól', 'Przyprawy i sosy ', 1, 'łyżeczka')
          .normalizedAmount,
      ).toBe(6);
    });
  });
});

describe('normalizeText', () => {
  it.each([
    ['Mąka Pszenna', 'maka pszenna'],
    ['Łyżeczka', 'lyzeczka'],
    ['Żurek żółty', 'zurek zolty'],
    // Zwijanie białych znaków: tak pisze `normalizedName` loader katalogu,
    // więc tak samo musi czytać każdy, kto po nim szuka.
    ['  Sól   morska \n', 'sol morska'],
    ['papryka\tsłodka', 'papryka slodka'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });
});

describe('ALLOWED_UNITS', () => {
  it('pokrywa się z listą jednostek w CreateRecipeIngredientDto', () => {
    // Bliźniak tej listy siedzi w `dto/create-recipe.dto.ts`
    // (`ingredientUnits`) — obie edytuje się razem. DTO nie jest tu
    // importowane, żeby test nie ciągnął `@nestjs/swagger`.
    expect([...ALLOWED_UNITS].sort()).toEqual(
      [
        'g',
        'kg',
        'ml',
        'l',
        'szt',
        'szczypta',
        'łyżeczka',
        'łyżka',
        'lyzeczka',
        'lyzka',
      ].sort(),
    );
  });
});

describe('kitchenMeasure — miara kuchenna przypraw do wyświetlania', () => {
  const SPICES = 'Przyprawy i sosy';

  it('gramy przyprawy → gramy na łyżeczkę z tej samej tabeli co normalizacja', () => {
    expect(kitchenMeasure('sól', SPICES, 'g')).toEqual({
      kind: 'spoon',
      per: 6,
    });
    expect(kitchenMeasure('Majeranek', SPICES, 'g')).toEqual({
      kind: 'spoon',
      per: 0.6,
    });
    // Odwrotność normalizacji: 1 łyżeczka → gramy → z powrotem 1 łyżeczka.
    for (const name of ['sól', 'cynamon', 'kmin rzymski', 'curry']) {
      const grams = normalizeIngredientAmount(name, SPICES, 1, 'łyżeczka');
      const measure = kitchenMeasure(name, SPICES, grams.normalizedUnit);
      expect(measure?.kind).toBe('spoon');
      expect(grams.normalizedAmount / measure!.per).toBeCloseTo(1, 6);
    }
  });

  it('płyn w ml → 5 ml na łyżeczkę, niezależnie od nazwy', () => {
    expect(kitchenMeasure('sos sojowy', SPICES, 'ml')).toEqual({
      kind: 'spoon',
      per: 5,
    });
    expect(kitchenMeasure('ocet balsamiczny', SPICES, 'ml')).toEqual({
      kind: 'spoon',
      per: 5,
    });
  });

  it('liść laurowy, ziele angielskie, goździki — sztuki z odmianą', () => {
    expect(kitchenMeasure('liść laurowy', SPICES, 'g')).toEqual({
      kind: 'piece',
      per: 0.5,
      one: 'liść',
      few: 'liście',
      many: 'liści',
    });
    expect(kitchenMeasure('zioło angielskie', SPICES, 'g')?.kind).toBe('piece');
    expect(kitchenMeasure('ziele angielskie', SPICES, 'g')?.kind).toBe('piece');
  });

  it('bez miary: inny dział, inna jednostka, przyprawa spoza tabeli', () => {
    expect(kitchenMeasure('sól', 'Nabiał', 'g')).toBeNull();
    expect(kitchenMeasure('sól', SPICES, 'łyżeczka')).toBeNull();
    expect(kitchenMeasure('sól', SPICES, 'szt')).toBeNull();
    expect(kitchenMeasure('przyprawa do ryb', SPICES, 'g')).toBeNull();
  });

  it('każda przyprawa w gramach z katalogu ma miarę', () => {
    // Lista z katalogu 30.09.2026 (1072 przepisy, dział „Przyprawy i sosy”,
    // jednostka g). Nowa przyprawa bez miary pokaże się w gramach — ten test
    // każe ją dopisać do tabeli.
    const catalog = [
      'sól',
      'pieprz czarny',
      'papryka słodka mielona',
      'cukier',
      'kmin rzymski',
      'oregano',
      'cynamon',
      'papryka wędzona mielona',
      'majeranek',
      'musztarda',
      'tymianek suszony',
      'liść laurowy',
      'cukier waniliowy',
      'cukier puder',
      'majonez',
      'kurkuma',
      'gałka muszkatołowa',
      'ziele angielskie',
      'czosnek granulowany',
      'płatki chili',
      'cukier brązowy',
      'ketchup',
      'rozmaryn suszony',
      'garam masala',
      'curry',
      'papryka ostra mielona',
      'kminek',
      'zioła prowansalskie',
      'sos chili słodki',
      'imbir mielony',
      'pesto bazyliowe',
      'salsa pomidorowa',
      'sos barbecue',
      'bazylia suszona',
      'przyprawa do piernika',
      'sos sriracha',
      'pasta curry',
      'kardamon mielony',
      'przyprawa do gyrosa',
      'goździki',
      'szałwia suszona',
      'sos pomidorowy',
      'cebula prażona',
    ];
    expect(
      catalog.filter((name) => !kitchenMeasure(name, SPICES, 'g')),
    ).toEqual([]);
  });

  it('withKitchenMeasure dokłada pole tylko przyprawom', () => {
    const salt = { name: 'sól', unit: 'g', department: SPICES, amount: 2 };
    const milk = {
      name: 'mleko',
      unit: 'ml',
      department: 'Nabiał',
      amount: 200,
    };
    expect(withKitchenMeasure(salt)).toEqual({
      ...salt,
      kitchenMeasure: { kind: 'spoon', per: 6 },
    });
    expect(withKitchenMeasure(milk)).toBe(milk);
    expect('kitchenMeasure' in withKitchenMeasure(milk)).toBe(false);
  });
});
