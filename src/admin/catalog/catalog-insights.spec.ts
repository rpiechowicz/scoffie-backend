import type { CatalogGapRecipe } from '../contract';
import {
  compareGapRecipes,
  countGaps,
  rank,
  recipeGaps,
  type GapInputRow,
} from './catalog-insights';

type IngredientRow = GapInputRow['ingredients'][number]['ingredient'];

const ingredient = (over: Partial<IngredientRow> = {}): IngredientRow => ({
  name: 'Mąka',
  nutritionKcalPer100: 350,
  nutritionProteinPer100: 10,
  nutritionCarbsPer100: 70,
  nutritionFatPer100: 1,
  gramsPerPiece: null,
  ...over,
});

const row = (over: Partial<GapInputRow> = {}): GapInputRow => ({
  id: 'r1',
  title: 'Naleśniki',
  imageUrl: 'https://img.scoffie.app/r1.webp',
  isActive: true,
  mealType: 'BREAKFAST',
  suitableMealTypes: ['BREAKFAST'],
  // 4·20 + 4·100 + 9·10 + 2·5 = 580
  nutritionKcal: 580,
  nutritionProtein: 20,
  nutritionFat: 10,
  nutritionCarbs: 100,
  nutritionFiber: 5,
  sourceInstructions: [{ step: 1, text: 'Wymieszaj.' }],
  ingredients: [{ normalizedUnit: 'g', ingredient: ingredient() }],
  ...over,
});

const gapsOf = (input: GapInputRow): CatalogGapRecipe => {
  const result = recipeGaps(input);
  if (!result) throw new Error('oczekiwano luk');
  return result;
};

describe('luki w katalogu', () => {
  it('pełny przepis nie ma luk', () => {
    expect(recipeGaps(row())).toBeNull();
  });

  it('brak zdjęcia, kroków, pór i składników', () => {
    const result = gapsOf(
      row({
        imageUrl: ' ',
        sourceInstructions: null,
        suitableMealTypes: [],
        ingredients: [],
      }),
    );
    expect(result.gaps).toEqual([
      'no-image',
      'no-meal-types',
      'no-steps',
      'no-ingredients',
    ]);
  });

  it('zerowe makro i zerowe kcal', () => {
    expect(gapsOf(row({ nutritionKcal: 0 })).gaps).toEqual(['zero-macros']);
    expect(
      gapsOf(row({ nutritionProtein: 0, nutritionFat: 0, nutritionCarbs: 0.2 }))
        .gaps,
    ).toEqual(['zero-macros']);
  });

  it('kcal niezgodne z makro o więcej niż 25 %', () => {
    // 580 z makro; 800 to 27,5 % względem większej, 700 — 17 %
    const off = gapsOf(row({ nutritionKcal: 800 }));
    expect(off.gaps).toEqual(['kcal-mismatch']);
    expect(off).toMatchObject({ kcal: 800, kcalFromMacros: 580 });
    expect(recipeGaps(row({ nutritionKcal: 700 }))).toBeNull();
  });

  it('składnik bez makro i sztuka bez masy — z nazwami', () => {
    const result = gapsOf(
      row({
        ingredients: [
          { normalizedUnit: 'szt', ingredient: ingredient({ name: 'Jajko' }) },
          {
            normalizedUnit: 'g',
            ingredient: ingredient({
              name: 'Cukier',
              nutritionFatPer100: null,
            }),
          },
          {
            normalizedUnit: 'szt',
            ingredient: ingredient({ name: 'Banan', gramsPerPiece: 120 }),
          },
        ],
      }),
    );
    expect(result.gaps).toEqual(['ingredient-no-nutrition', 'piece-no-grams']);
    expect(result.ingredients).toEqual(['Cukier', 'Jajko']);
  });

  it('liczniki mają każdy rodzaj; aktywne i więcej luk najpierw', () => {
    const a = gapsOf(row({ id: 'a', title: 'A', imageUrl: null }));
    const b = gapsOf(
      row({ id: 'b', title: 'B', imageUrl: null, sourceInstructions: [] }),
    );
    const c = gapsOf(
      row({
        id: 'c',
        title: 'C',
        isActive: false,
        imageUrl: null,
        ingredients: [],
      }),
    );
    const sorted = [a, c, b].sort(compareGapRecipes);
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a', 'c']);
    const counts = countGaps(sorted);
    expect(counts['no-image']).toBe(3);
    expect(counts['no-steps']).toBe(1);
    expect(counts['kcal-mismatch']).toBe(0);
    expect(Object.keys(counts)).toHaveLength(8);
  });

  it('ranking pomija nieznane przepisy i zera, sortuje malejąco', () => {
    const meta = new Map([
      ['x', { title: 'Żurek', imageUrl: null, isActive: true }],
      ['y', { title: 'Barszcz', imageUrl: 'u', isActive: false }],
    ]);
    expect(
      rank(
        [
          { recipeId: 'x', count: 2 },
          { recipeId: 'y', count: 5 },
          { recipeId: 'z', count: 9 },
          { recipeId: 'x', count: 0 },
        ],
        meta,
        10,
      ),
    ).toEqual([
      { id: 'y', title: 'Barszcz', imageUrl: 'u', isActive: false, count: 5 },
      { id: 'x', title: 'Żurek', imageUrl: '', isActive: true, count: 2 },
    ]);
    expect(
      rank([{ recipeId: 'x', count: 0 }], meta, 10, { keepZero: true }),
    ).toHaveLength(1);
  });
});
