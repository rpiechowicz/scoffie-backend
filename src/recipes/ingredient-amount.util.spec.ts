import {
  ALLOWED_UNITS,
  normalizeIngredientAmount,
  normalizeText,
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
    ['zioła prowansalskie', 'Przyprawy i sosy', 1, 'łyżeczka', 2.5, 'g'],
    ['zioła prowansalskie', 'Przyprawy i sosy', 1, 'łyżka', 7.5, 'g'],
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
