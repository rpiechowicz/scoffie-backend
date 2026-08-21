import {
  atwaterKcal,
  computeRecipeNutrition,
  relativeDeviation,
  roundTotals,
  type IngredientNutritionPer100,
  type NutritionInputItem,
} from './recipe-nutrition.util';

const oats: IngredientNutritionPer100 = {
  kcal: 379,
  protein: 13.2,
  carbs: 57.6,
  fat: 6.9,
  fiber: 10.1,
  gramsPerPiece: null,
};

const milk: IngredientNutritionPer100 = {
  kcal: 61,
  protein: 3.3,
  carbs: 4.7,
  fat: 3.3,
  fiber: 0,
  gramsPerPiece: null,
};

const banana: IngredientNutritionPer100 = {
  kcal: 89,
  protein: 1.1,
  carbs: 20.2,
  fat: 0.3,
  fiber: 2.6,
  gramsPerPiece: 120,
};

function item(
  name: string,
  normalizedAmount: number,
  normalizedUnit: string,
  nutrition: IngredientNutritionPer100 | null,
): NutritionInputItem {
  return { name, normalizedAmount, normalizedUnit, nutrition };
}

describe('computeRecipeNutrition', () => {
  it('sums grams and millilitres against the per-100 basis', () => {
    const { totals } = computeRecipeNutrition([
      item('platki owsiane', 100, 'g', oats),
      item('mleko', 400, 'ml', milk),
    ]);

    expect(Math.round(totals.kcal)).toBe(623); // 379 + 4 * 61
    expect(Math.round(totals.protein * 10) / 10).toBe(26.4);
  });

  it('converts pieces through gramsPerPiece', () => {
    const { totals } = computeRecipeNutrition([
      item('banan', 2, 'szt', banana),
    ]);

    // 2 sztuki po 120 g = 240 g, czyli 2.4 * wartosci na 100 g
    expect(Math.round(totals.kcal)).toBe(214);
    expect(Math.round(totals.fiber * 10) / 10).toBe(6.2);
  });

  it('reports ingredients without nutrition instead of silently zeroing them', () => {
    const { totals, missingNutrition } = computeRecipeNutrition([
      item('platki owsiane', 100, 'g', oats),
      item('tajemniczy skladnik', 200, 'g', null),
    ]);

    expect(missingNutrition).toEqual(['tajemniczy skladnik']);
    expect(Math.round(totals.kcal)).toBe(379);
  });

  it('reports pieces that have no weight rather than guessing one', () => {
    const weightless: IngredientNutritionPer100 = {
      ...banana,
      gramsPerPiece: null,
    };
    const { totals, missingPieceWeight } = computeRecipeNutrition([
      item('banan', 2, 'szt', weightless),
    ]);

    expect(missingPieceWeight).toEqual(['banan']);
    expect(totals.kcal).toBe(0);
  });

  it('returns zeros for an empty recipe', () => {
    const { totals, missingNutrition, missingPieceWeight } =
      computeRecipeNutrition([]);

    expect(totals).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
    expect(missingNutrition).toEqual([]);
    expect(missingPieceWeight).toEqual([]);
  });
});

describe('atwaterKcal', () => {
  it('matches the declared energy of a self-consistent set of macros', () => {
    // Owsianka z bananem i borowka po korekcie: 894 kcal / 30 B / 137 W / 21 T / 19 blonnika
    const computed = atwaterKcal({
      protein: 30,
      carbs: 137,
      fat: 21,
      fiber: 19,
    });

    expect(Math.abs(computed - 894) / 894).toBeLessThan(0.1);
  });

  it('exposes macros that were written down without being counted', () => {
    // Wartosci sprzed audytu dla tego samego przepisu
    const computed = atwaterKcal({
      protein: 23,
      carbs: 108,
      fat: 18,
      fiber: 12,
    });

    expect(computed).toBeCloseTo(710, 0);
  });
});

describe('relativeDeviation', () => {
  it('returns a signed ratio against the expected value', () => {
    expect(relativeDeviation(120, 100)).toBeCloseTo(0.2, 5);
    expect(relativeDeviation(80, 100)).toBeCloseTo(-0.2, 5);
  });

  it('treats zero against zero as agreement and zero against anything else as unknown', () => {
    expect(relativeDeviation(0, 0)).toBe(0);
    expect(relativeDeviation(5, 0)).toBeNull();
  });
});

describe('roundTotals', () => {
  it('keeps kcal whole and macros at one decimal', () => {
    expect(
      roundTotals({
        kcal: 893.62,
        protein: 29.94,
        carbs: 136.51,
        fat: 21.38,
        fiber: 18.77,
      }),
    ).toEqual({
      kcal: 894,
      protein: 29.9,
      carbs: 136.5,
      fat: 21.4,
      fiber: 18.8,
    });
  });
});
