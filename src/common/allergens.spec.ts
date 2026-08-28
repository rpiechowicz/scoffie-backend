import { AppException } from './app-exception';
import {
  ALLERGEN_IDS,
  ALLERGEN_ID_VALUES,
  isAllergenId,
  normalizeAllergenIds,
} from './allergens';

const errorOf = (fn: () => unknown): AppException => {
  try {
    fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
};

describe('normalizeAllergenIds', () => {
  it('powinno znormalizować i posortować znane id', () => {
    expect(normalizeAllergenIds([' Gluten ', 'SOY', 'eggs'])).toEqual([
      'eggs',
      'gluten',
      'soy',
    ]);
  });

  it('powinno deduplikować po normalizacji', () => {
    expect(normalizeAllergenIds(['gluten', 'Gluten', ' gluten'])).toEqual([
      'gluten',
    ]);
  });

  it('powinno pomijać puste stringi i wartości nietekstowe', () => {
    expect(normalizeAllergenIds(['gluten', '', '   ', 42, null])).toEqual([
      'gluten',
    ]);
  });

  it('powinno zwrócić pustą listę dla pustego wejścia', () => {
    expect(normalizeAllergenIds([])).toEqual([]);
  });

  it.each(['shellfish', 'sulphites', 'anything', 'GLUTEN_FREE'])(
    'powinno odrzucić nieznane id %s jako VALIDATION_ERROR',
    (bad) => {
      expect(() => normalizeAllergenIds(['gluten', bad])).toThrow(AppException);
      const error = errorOf(() => normalizeAllergenIds(['gluten', bad]));
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining(bad.toLowerCase()),
      });
    },
  );

  it('powinno wymienić wszystkie nieznane id naraz', () => {
    const error = errorOf(() => normalizeAllergenIds(['zzz', 'aaa']));
    const response = error.getResponse() as { message: string };
    expect(response.message).toContain('aaa');
    expect(response.message).toContain('zzz');
  });

  it('powinno odrzucić wejście, które nie jest listą', () => {
    expect(() => normalizeAllergenIds('gluten' as unknown as string[])).toThrow(
      AppException,
    );
  });
});

describe('isAllergenId', () => {
  it('powinno rozpoznać wszystkie znane id', () => {
    for (const id of ALLERGEN_IDS) {
      expect(isAllergenId(id)).toBe(true);
    }
  });

  it.each(['Gluten', 'shellfish', '', null, 42])(
    'powinno odrzucić %p',
    (value) => {
      expect(isAllergenId(value)).toBe(false);
    },
  );

  it('powinno pilnować kontraktu z iOS (DietPreference.swift, enum Allergen)', () => {
    expect(ALLERGEN_ID_VALUES).toEqual([
      'gluten',
      'lactose',
      'eggs',
      'nuts',
      'peanuts',
      'fish',
      'soy',
      'celery',
      'mustard',
      'sesame',
    ]);
  });
});
