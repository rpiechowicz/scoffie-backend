import {
  recipeContentHash,
  type RecipeContentForHash,
} from './cook-scenario.hash';

const base = (): RecipeContentForHash => ({
  title: 'Kotlet de volaille',
  servings: 2,
  sourceInstructions: [
    { step: 1, text: 'Zrób masło.' },
    { step: 2, text: 'Usmaż kotlety.' },
  ],
  ingredients: [
    { ingredientId: 'b', amount: 30, unit: 'g' },
    { ingredientId: 'a', amount: 320, unit: 'g' },
  ],
});

describe('recipeContentHash', () => {
  it('jest stabilny i ma prefiks algorytmu', () => {
    expect(recipeContentHash(base())).toBe(recipeContentHash(base()));
    expect(recipeContentHash(base())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('nie zależy od kolejności wierszy składników ani pisowni kroków', () => {
    const reordered = base();
    reordered.ingredients = [...reordered.ingredients].reverse();
    reordered.sourceInstructions = [
      { stepNumber: 2, text: 'Usmaż kotlety.' },
      { stepNumber: 1, text: 'Zrób masło.' },
    ];
    expect(recipeContentHash(reordered)).toBe(recipeContentHash(base()));
  });

  it.each([
    [
      'ilość składnika',
      (r: RecipeContentForHash) => ({
        ...r,
        ingredients: [{ ...r.ingredients[0], amount: 40 }, r.ingredients[1]],
      }),
    ],
    ['porcje', (r: RecipeContentForHash) => ({ ...r, servings: 4 })],
    ['tytuł', (r: RecipeContentForHash) => ({ ...r, title: 'Schabowy' })],
    [
      'tekst kroku',
      (r: RecipeContentForHash) => ({
        ...r,
        sourceInstructions: [{ step: 1, text: 'Inaczej.' }],
      }),
    ],
  ])('zmienia się, gdy zmienia się %s', (_label, change) => {
    expect(recipeContentHash(change(base()))).not.toBe(
      recipeContentHash(base()),
    );
  });
});
