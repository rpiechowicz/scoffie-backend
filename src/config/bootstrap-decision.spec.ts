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
