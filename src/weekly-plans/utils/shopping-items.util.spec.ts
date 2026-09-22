import { ShoppingDepartment } from '../types/shopping-department.enum';
import type {
  ShoppingAccumulator,
  ShoppingListItem,
} from '../types/shopping-types';
import {
  buildDisplayShoppingItems,
  itemSignature,
  roundShoppingAmount,
  sortShoppingItems,
  toShoppingUnit,
} from './shopping-items.util';

const item = (
  overrides: Partial<ShoppingListItem> & { name: string },
): ShoppingListItem => ({
  productKey: `${overrides.name.toLowerCase()}::g`,
  unit: 'g',
  department: ShoppingDepartment.VEGETABLES,
  totalAmount: 100,
  isChecked: false,
  ...overrides,
});

const acc = (
  overrides: Partial<ShoppingAccumulator> & { name: string },
): ShoppingAccumulator => ({
  productKey: `${overrides.name.toLowerCase()}::g`,
  unit: 'g',
  department: ShoppingDepartment.VEGETABLES,
  totalAmount: 100,
  ...overrides,
});

describe('itemSignature', () => {
  it('nie zależy od kolejności pozycji', () => {
    const a = item({ name: 'Cebula' });
    const b = item({ name: 'Ziemniak', totalAmount: 500 });
    expect(itemSignature([a, b])).toBe(itemSignature([b, a]));
  });

  it.each([
    ['ilość', { totalAmount: 101 }],
    ['jednostka', { unit: 'ml' }],
    ['dział', { department: ShoppingDepartment.OTHER }],
    ['nazwa wyświetlana', { name: 'Cebula (g)' }],
  ])('zmienia się, gdy zmieni się %s', (_label, patch) => {
    const base = item({ name: 'Cebula' });
    expect(itemSignature([{ ...base, ...patch }])).not.toBe(
      itemSignature([base]),
    );
  });

  it('nie zależy od zaznaczenia', () => {
    const base = item({ name: 'Cebula' });
    expect(itemSignature([{ ...base, isChecked: true }])).toBe(
      itemSignature([base]),
    );
  });

  it('pusta lista ma pusty podpis', () => {
    expect(itemSignature([])).toBe('');
  });
});

describe('buildDisplayShoppingItems', () => {
  it('zaokrągla ilości do dwóch miejsc i dokleja zaznaczenie z mapy', () => {
    const items = buildDisplayShoppingItems(
      [acc({ name: 'Cebula', totalAmount: 0.375 })],
      new Map([['cebula::g', true]]),
    );
    expect(items).toEqual([
      expect.objectContaining({
        name: 'Cebula',
        totalAmount: 0.38,
        isChecked: true,
      }),
    ]);
  });

  it('brak wpisu w mapie znaczy „nieodhaczone"', () => {
    const [row] = buildDisplayShoppingItems(
      [acc({ name: 'Cebula' })],
      new Map(),
    );
    expect(row.isChecked).toBe(false);
  });

  it('ta sama nazwa w dwóch jednostkach dostaje dopisek z jednostką', () => {
    const items = buildDisplayShoppingItems(
      [
        acc({
          name: 'Sól',
          productKey: 'sól::g',
          unit: 'g',
          department: ShoppingDepartment.SPICES,
        }),
        acc({
          name: 'Sól',
          productKey: 'sól::ml',
          unit: 'ml',
          department: ShoppingDepartment.SPICES,
        }),
        acc({ name: 'Cebula' }),
      ],
      new Map(),
    );
    expect(items.map((row) => row.name)).toEqual([
      'Cebula',
      'Sól (g)',
      'Sól (ml)',
    ]);
  });

  it('pusta agregacja daje pustą listę', () => {
    expect(buildDisplayShoppingItems([], new Map())).toEqual([]);
  });
});

describe('sortShoppingItems', () => {
  it('układa działy w kolejności sklepu, a w dziale alfabetycznie', () => {
    const sorted = sortShoppingItems([
      item({ name: 'Ziemniak' }),
      item({ name: 'Sól', department: ShoppingDepartment.SPICES }),
      item({ name: 'Cebula' }),
      item({
        name: 'Płyn do naczyń',
        department: ShoppingDepartment.HOUSEHOLD,
      }),
      item({ name: 'Marchew' }),
      item({ name: 'Łosoś', department: ShoppingDepartment.FISH }),
    ]);
    expect(sorted.map((row) => row.name)).toEqual([
      'Cebula',
      'Marchew',
      'Ziemniak',
      'Łosoś',
      'Sól',
      'Płyn do naczyń',
    ]);
  });

  it('nieznany dział ląduje na końcu, jak „Inne"', () => {
    const sorted = sortShoppingItems([
      item({ name: 'Coś', department: 'Zupełnie obce' as ShoppingDepartment }),
      item({ name: 'Cebula' }),
    ]);
    expect(sorted.map((row) => row.name)).toEqual(['Cebula', 'Coś']);
  });

  it('nie mutuje wejścia', () => {
    const input = [item({ name: 'Ziemniak' }), item({ name: 'Cebula' })];
    sortShoppingItems(input);
    expect(input.map((row) => row.name)).toEqual(['Ziemniak', 'Cebula']);
  });
});

describe('toShoppingUnit', () => {
  it('przelicza gramy na sztuki, gdy produkt ma masę sztuki', () => {
    expect(toShoppingUnit(330, 'g', 110)).toEqual({ amount: 3, unit: 'szt' });
  });

  it('sztuki zostają sztukami', () => {
    expect(toShoppingUnit(1, 'szt', 110)).toEqual({ amount: 1, unit: 'szt' });
  });

  it.each([
    ['bez masy sztuki', 150, 'g', null],
    ['masa sztuki zero', 150, 'g', 0],
    ['mililitry nie są masą', 200, 'ml', 110],
  ])('%s → bez zmian', (_, amount, unit, gramsPerPiece) => {
    expect(toShoppingUnit(amount, unit, gramsPerPiece)).toEqual({
      amount,
      unit,
    });
  });
});

describe('roundShoppingAmount', () => {
  it.each([
    [1.08, 1.5],
    [0.25, 0.5],
    [0.5, 0.5],
    [2, 2],
    // Suma zmiennoprzecinkowa tuż nad całością nie może skoczyć o połówkę.
    [330 / 110 + 1 + 1e-9, 4],
  ])('sztuki: %p → %p (w górę do połówki)', (amount, expected) => {
    expect(roundShoppingAmount(amount, 'szt')).toBe(expected);
  });

  it('gramy i mililitry — dwa miejsca po przecinku, jak dotąd', () => {
    expect(roundShoppingAmount(0.375, 'g')).toBe(0.38);
    expect(roundShoppingAmount(7.5, 'ml')).toBe(7.5);
  });
});
