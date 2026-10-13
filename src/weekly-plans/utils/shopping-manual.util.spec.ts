import {
  cleanProductName,
  manualNameKey,
  manualRowKey,
  mergeManualAmount,
  productKeyNamePart,
  toManualListUnit,
} from './shopping-manual.util';

describe('shopping-manual.util', () => {
  it('cleanProductName zwija białe znaki i wycina niewidoczne', () => {
    expect(cleanProductName('  Karma\u200b  dla\tkota\n')).toBe(
      'Karma dla kota',
    );
    expect(cleanProductName('\u200b\ufeff')).toBe('');
  });

  it('manualNameKey to część nazwy z productKey', () => {
    expect(manualNameKey(' Chleb  Żytni ')).toBe('chleb żytni');
    expect(productKeyNamePart('chleb żytni::szt')).toBe('chleb żytni');
    expect(productKeyNamePart('chleb::')).toBe('chleb');
  });

  it('toManualListUnit: kg/l na g/ml, gramy z masą sztuki na sztuki', () => {
    expect(toManualListUnit(1.5, 'kg', null)).toEqual({
      amount: 1500,
      unit: 'g',
    });
    expect(toManualListUnit(2, 'l', null)).toEqual({
      amount: 2000,
      unit: 'ml',
    });
    expect(toManualListUnit(330, 'g', 110)).toEqual({ amount: 3, unit: 'szt' });
    expect(toManualListUnit(2, 'szt', null)).toEqual({
      amount: 2,
      unit: 'szt',
    });
  });

  it('mergeManualAmount: suma w tej samej jednostce, nowa wygrywa w innej, bez ilości nic nie zmienia', () => {
    const ml = { amount: 500, unit: 'ml' };
    expect(mergeManualAmount(ml, { amount: 250, unit: 'ml' })).toEqual({
      amount: 750,
      unit: 'ml',
    });
    expect(mergeManualAmount(ml, { amount: 2, unit: 'szt' })).toEqual({
      amount: 2,
      unit: 'szt',
    });
    expect(mergeManualAmount(ml, null)).toEqual(ml);
    expect(mergeManualAmount(null, ml)).toEqual(ml);
    expect(
      mergeManualAmount(
        { amount: 90, unit: 'szt' },
        { amount: 20, unit: 'szt' },
      ),
    ).toEqual({ amount: 99, unit: 'szt' });
  });

  it('manualRowKey: z ilością własny klucz, bez — pierwszy alfabetycznie wiersz produktu albo własny', () => {
    expect(manualRowKey({ nameKey: 'mleko', amount: 1, unit: 'ml' }, [])).toBe(
      'mleko::ml',
    );
    expect(
      manualRowKey({ nameKey: 'mleko', amount: null, unit: null }, [
        'mleko::ml',
        'mleko owsiane::ml',
        'mleko::g',
      ]),
    ).toBe('mleko::g');
    expect(
      manualRowKey({ nameKey: 'chleb', amount: null, unit: null }, [
        'mleko::ml',
      ]),
    ).toBe('chleb::');
  });
});
