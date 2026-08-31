// Decyzja żyje w CommonJS obok skryptu, który jej używa (`scripts/`), bo skrypt
// migracji biegnie przed buildem i nie może importować z `dist/`.
// Spec leży w `src/`, bo tylko tu jest jest.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bootstrap = require('../../scripts/lib/bootstrap-decision.js') as {
  decideBootstrap: (input: {
    env: NodeJS.ProcessEnv;
    rebuilt: boolean;
    databaseEmpty: boolean;
  }) => { run: boolean; reason: string };
  decideIngredientTagsLoad: (input: {
    env: NodeJS.ProcessEnv;
    bootstrapRan: boolean;
    ingredientCount: number;
    taggedIngredientCount: number;
  }) => { run: boolean; reason: string };
};

describe('decideBootstrap', () => {
  it('sieje świeżą bazę bez żadnej flagi', () => {
    const result = bootstrap.decideBootstrap({
      env: {},
      rebuilt: false,
      databaseEmpty: true,
    });

    expect(result.run).toBe(true);
  });

  it('nie rusza bazy, która ma już dane', () => {
    const result = bootstrap.decideBootstrap({
      env: { SAFE_MIGRATE_BOOTSTRAP_RECIPES: 'true' },
      rebuilt: false,
      databaseEmpty: false,
    });

    expect(result.run).toBe(false);
  });

  it('sieje po rebuildzie', () => {
    const result = bootstrap.decideBootstrap({
      env: {},
      rebuilt: true,
      databaseEmpty: true,
    });

    expect(result.run).toBe(true);
  });

  it('SAFE_MIGRATE_BOOTSTRAP_RECIPES=false wygrywa nawet po rebuildzie', () => {
    const result = bootstrap.decideBootstrap({
      env: { SAFE_MIGRATE_BOOTSTRAP_RECIPES: 'false' },
      rebuilt: true,
      databaseEmpty: true,
    });

    expect(result.run).toBe(false);
  });
});

describe('decideIngredientTagsLoad', () => {
  // Scenariusz prod z 28.08: baza z danymi dostała kolumny z migracji, loader
  // nigdy nie biegł — dokładnie ten przypadek, który zostawał do ręcznego
  // `pnpm catalog:ingredients:tags`.
  it('wgrywa tagi, gdy katalog istnieje, a żaden składnik ich nie ma', () => {
    const result = bootstrap.decideIngredientTagsLoad({
      env: {},
      bootstrapRan: false,
      ingredientCount: 403,
      taggedIngredientCount: 0,
    });

    expect(result.run).toBe(true);
  });

  it('nie powtarza loadera, gdy choć jeden składnik ma tagi', () => {
    const result = bootstrap.decideIngredientTagsLoad({
      env: {},
      bootstrapRan: false,
      ingredientCount: 403,
      taggedIngredientCount: 1,
    });

    expect(result.run).toBe(false);
  });

  it('nie robi nic po bootstrapie (bootstrap sam wgrywa tagi)', () => {
    const result = bootstrap.decideIngredientTagsLoad({
      env: {},
      bootstrapRan: true,
      ingredientCount: 403,
      taggedIngredientCount: 0,
    });

    expect(result.run).toBe(false);
  });

  it('nie robi nic na bazie bez katalogu składników', () => {
    const result = bootstrap.decideIngredientTagsLoad({
      env: {},
      bootstrapRan: false,
      ingredientCount: 0,
      taggedIngredientCount: 0,
    });

    expect(result.run).toBe(false);
  });

  it('SAFE_MIGRATE_LOAD_INGREDIENT_TAGS=false wyłącza krok', () => {
    const result = bootstrap.decideIngredientTagsLoad({
      env: { SAFE_MIGRATE_LOAD_INGREDIENT_TAGS: 'false' },
      bootstrapRan: false,
      ingredientCount: 403,
      taggedIngredientCount: 0,
    });

    expect(result.run).toBe(false);
  });

  it('inne wartości flagi niż "false" nie wyłączają kroku', () => {
    for (const value of ['', 'true', 'TRUE', '0', 'no']) {
      const result = bootstrap.decideIngredientTagsLoad({
        env: { SAFE_MIGRATE_LOAD_INGREDIENT_TAGS: value },
        bootstrapRan: false,
        ingredientCount: 403,
        taggedIngredientCount: 0,
      });

      expect(result.run).toBe(true);
    }
  });
});
