/**
 * Test złoty scenariuszy pisanych ręcznie (`prisma/catalog/cook-scenarios-pl-v1.json`).
 *
 * Bez bazy: nazwy składników z pliku zamieniamy na nazwy z pliku katalogu
 * (`recipes-catalog-full-v2.json`, eksport bazy) i puszczamy te same
 * walidatory, które uruchamia `publishCookScenario`. Czerwony test =
 * wzorzec rozjechał się z przepisem (np. ktoś zmienił ilość w panelu,
 * a nocny eksport przyniósł nowy plik katalogu) — trzeba poprawić wzorzec,
 * zanim `pnpm cook-scenarios:load` odmówi na produkcji.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveGoldenContent,
  type GoldenScenarioFile,
} from './cook-scenario.golden';
import { COOK_SCENARIO_RULES_VERSION } from './cook-scenario.types';
import {
  checkScenarioAgainstRecipe,
  parseCookScenarioContent,
} from './cook-scenario.validate';

const CATALOG_DIR = join(__dirname, '..', '..', '..', 'prisma', 'catalog');

type CatalogRecipe = {
  id: string;
  title: string;
  servings: number;
  ingredients: Array<{ ingredientName: string; amount: number; unit: string }>;
};

const golden = JSON.parse(
  readFileSync(join(CATALOG_DIR, 'cook-scenarios-pl-v1.json'), 'utf8'),
) as GoldenScenarioFile;
const catalog = JSON.parse(
  readFileSync(join(CATALOG_DIR, 'recipes-catalog-full-v2.json'), 'utf8'),
) as { recipes: CatalogRecipe[] };
const byId = new Map(catalog.recipes.map((recipe) => [recipe.id, recipe]));

describe('scenariusze Gotuj — wzorce', () => {
  it('plik ma wersję zasad zgodną z kodem i co najmniej jeden wzorzec', () => {
    expect(golden.rulesVersion).toBe(COOK_SCENARIO_RULES_VERSION);
    expect(golden.scenarios.length).toBeGreaterThan(0);
  });

  describe.each(golden.scenarios.map((entry) => [entry.title, entry] as const))(
    '%s',
    (_title, entry) => {
      const recipe = byId.get(entry.recipeId);

      it('przepis jest w katalogu pod tym tytułem', () => {
        expect(recipe?.title).toBe(entry.title);
      });

      it('przechodzi walidatory kształtu i zgodności z przepisem', () => {
        if (!recipe) throw new Error('brak przepisu w katalogu');
        // W teście id składnika = jego nazwa — liczy się tylko to, że
        // referencje i sumy zgadzają się z przepisem.
        const names = new Set(
          recipe.ingredients.map((row) => row.ingredientName),
        );
        const resolved = resolveGoldenContent(entry.content, (name) =>
          names.has(name) ? name : undefined,
        );
        expect(resolved.errors).toEqual([]);
        const parsed = parseCookScenarioContent(resolved.content);
        expect(parsed.errors).toEqual([]);
        const errors = checkScenarioAgainstRecipe(parsed.content!, {
          servings: recipe.servings,
          ingredients: recipe.ingredients.map((row) => ({
            ingredientId: row.ingredientName,
            name: row.ingredientName,
            amount: row.amount,
            unit: row.unit,
          })),
        });
        expect(errors).toEqual([]);
      });
    },
  );
});
