/**
 * Golden spec pliku tagów składników i unii na przepisach.
 *
 * Pilnuje TRZECH rzeczy w gicie, zanim cokolwiek trafi do bazy:
 * 1. plik `ingredient-tags-pl-v1.json` pokrywa DOKŁADNIE słownik z
 *    `ingredients-*-pl-v1.txt` (403 nazwy, klucz `normalizedName`) i każdy
 *    wpis spełnia reguły spójności (`validateIngredientTagEntry`);
 * 2. unia tagów dla kilku prawdziwych przepisów z katalogu jest taka, jak
 *    ustalono przy kuracji (28.08.2026) — zmiana tutaj to świadoma decyzja
 *    o alergenach, nie efekt uboczny edycji pliku;
 * 3. reguły diet (`diet-rules.util`) na tych tagach dają katalogowi te same
 *    liczności, które audyt policzył portem klasyfikatora iOS — parytet
 *    serwer ↔ telefon. Dolne granice, bo katalog rośnie.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ALLERGEN_ID_VALUES } from '../common/allergens';
import {
  deriveRecipeTags,
  validateIngredientTagEntry,
  type IngredientTagEntry,
} from '../common/diet-tags';
import { normalizeText } from '../common/normalize-text.util';
import { nutritionPerServing, satisfiesDiet } from './diet-rules.util';

const CATALOG_DIR = join(__dirname, '..', '..', 'prisma', 'catalog');

type TagsFile = { version: string; ingredients: IngredientTagEntry[] };
type CatalogRecipe = {
  title: string;
  servings: number;
  nutrition: { kcal: number; protein: number; carbs: number; fat: number };
  ingredients: Array<{ ingredientName: string }>;
};

const tagsFile = JSON.parse(
  readFileSync(join(CATALOG_DIR, 'ingredient-tags-pl-v1.json'), 'utf8'),
) as TagsFile;
const byName = new Map(tagsFile.ingredients.map((e) => [e.normalizedName, e]));

const txtNames = readdirSync(CATALOG_DIR)
  .filter((f) => /^ingredients-.*-pl-v1\.txt$/.test(f))
  .flatMap((f) =>
    readFileSync(join(CATALOG_DIR, f), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );

const recipes = (
  JSON.parse(
    readFileSync(join(CATALOG_DIR, 'recipes-catalog-full-v2.json'), 'utf8'),
  ) as {
    recipes: CatalogRecipe[];
  }
).recipes;

const tagsOf = (recipe: CatalogRecipe) =>
  deriveRecipeTags(
    recipe.ingredients.map((i) => {
      const entry = byName.get(normalizeText(i.ingredientName));
      if (!entry) throw new Error(`brak tagów dla ${i.ingredientName}`);
      return entry;
    }),
  );

describe('ingredient-tags-pl-v1.json — struktura', () => {
  it('pokrywa dokładnie słownik z plików txt (bez braków i bez nadmiaru)', () => {
    const txtSet = new Set(txtNames.map(normalizeText));
    expect(txtSet.size).toBe(txtNames.length);
    const missing = txtNames.filter((n) => !byName.has(normalizeText(n)));
    const extra = tagsFile.ingredients
      .map((e) => e.normalizedName)
      .filter((n) => !txtSet.has(n));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(tagsFile.ingredients.length).toBe(txtNames.length);
  });

  it('klucz to normalizeText(name), bez duplikatów', () => {
    for (const entry of tagsFile.ingredients) {
      expect(entry.normalizedName).toBe(normalizeText(entry.name));
    }
    expect(byName.size).toBe(tagsFile.ingredients.length);
  });

  it('każdy wpis spełnia reguły spójności', () => {
    const problems = tagsFile.ingredients.flatMap((entry) =>
      validateIngredientTagEntry(entry, ALLERGEN_ID_VALUES).map(
        (p) => `${entry.normalizedName}: ${p}`,
      ),
    );
    expect(problems).toEqual([]);
  });

  it('każdy składnik używany w katalogu przepisów ma wpis', () => {
    const uncovered = new Set<string>();
    for (const recipe of recipes) {
      for (const ingredient of recipe.ingredients) {
        if (!byName.has(normalizeText(ingredient.ingredientName))) {
          uncovered.add(ingredient.ingredientName);
        }
      }
    }
    expect(Array.from(uncovered)).toEqual([]);
  });

  it('luki z audytu A2/A3/A9 są zamknięte', () => {
    expect(byName.get('granola')?.allergens).toContain('gluten');
    expect(byName.get('baton musli')?.allergens).toContain('gluten');
    expect(byName.get('zakwas na zurek')?.allergens).toContain('gluten');
    expect(byName.get('seler korzeniowy')?.allergens).toEqual(['celery']);
    expect(byName.get('bulion drobiowy')?.allergens).toContain('celery');
    expect(byName.get('przyprawa uniwersalna')?.allergens).toContain('celery');
    expect(byName.get('majonez')?.allergens).toEqual(['eggs', 'mustard']);
    expect(byName.get('hummus')?.allergens).toEqual(['sesame']);
    expect(byName.get('sezam')?.allergens).toEqual(['sesame']);
    expect(byName.get('mleko bez laktozy')?.allergens).toEqual([]);
    expect(byName.get('mleko bez laktozy')?.dietTags).toEqual(['DAIRY']);
    expect(byName.get('mleko kokosowe z puszki')?.allergens).toEqual([]);
    expect(byName.get('krewetka')?.dietTags).toEqual(['CRUSTACEAN', 'FISH']);
    expect(byName.get('pestki dyni')?.dietTags).toEqual([]);
  });
});

describe('unia tagów na prawdziwych przepisach (kuracja 28.08.2026)', () => {
  const GOLDEN: Array<[string, string[], string[]]> = [
    [
      'Żurek z białą kiełbasą i jajkiem',
      ['celery', 'eggs', 'gluten', 'lactose'],
      ['DAIRY', 'EGG', 'GLUTEN_GRAIN', 'GRAIN', 'MEAT', 'PROCESSED'],
    ],
    [
      'Skyr z granolą i malinami',
      ['gluten', 'lactose', 'nuts'],
      ['ANIMAL_OTHER', 'DAIRY', 'GLUTEN_GRAIN', 'GRAIN', 'PROCESSED'],
    ],
    ['Hummus z warzywami do maczania', ['sesame'], ['LEGUME']],
    [
      'Rosół z makaronem',
      ['celery', 'eggs', 'gluten'],
      ['EGG', 'GLUTEN_GRAIN', 'GRAIN', 'MEAT'],
    ],
    [
      'Kurczak teriyaki z makaronem i warzywami',
      ['gluten', 'sesame', 'soy'],
      ['ANIMAL_OTHER', 'GLUTEN_GRAIN', 'GRAIN', 'LEGUME', 'MEAT', 'PROCESSED'],
    ],
    [
      'Owsianka z bananem i borówką',
      ['gluten', 'lactose'],
      ['DAIRY', 'GLUTEN_GRAIN', 'GRAIN'],
    ],
  ];

  it.each(GOLDEN)('%s', (title, allergens, dietTags) => {
    const recipe = recipes.find((r) => r.title === title);
    expect(recipe).toBeDefined();
    expect(tagsOf(recipe!)).toEqual({ allergens, dietTags });
  });
});

describe('parytet reguł diet z portem klasyfikatora iOS (audyt 27.08.2026)', () => {
  const count = (diet: Parameters<typeof satisfiesDiet>[0]) =>
    recipes.filter((recipe) =>
      satisfiesDiet(diet, {
        dietTags: tagsOf(recipe).dietTags,
        hasIngredientData: recipe.ingredients.length > 0,
        perServing: nutritionPerServing({
          servings: recipe.servings,
          nutritionKcal: recipe.nutrition.kcal,
          nutritionProtein: recipe.nutrition.protein,
          nutritionCarbs: recipe.nutrition.carbs,
          nutritionFat: recipe.nutrition.fat,
        }),
      }),
    ).length;

  it('liczności nie spadają poniżej stanu z kuracji (89 przepisów: 44/1/52/7/6/48)', () => {
    expect(recipes.length).toBeGreaterThanOrEqual(89);
    expect(count('VEGETARIAN')).toBeGreaterThanOrEqual(44);
    expect(count('VEGAN')).toBeGreaterThanOrEqual(1);
    expect(count('PESCATARIAN')).toBeGreaterThanOrEqual(52);
    expect(count('KETO')).toBeGreaterThanOrEqual(7);
    expect(count('PALEO')).toBeGreaterThanOrEqual(6);
    expect(count('HIGH_PROTEIN')).toBeGreaterThanOrEqual(48);
    expect(count('NONE')).toBe(recipes.length);
  });

  it('wegetariańskie ⊆ pescetariańskie, wegańskie ⊆ wegetariańskie', () => {
    const sets = (diet: Parameters<typeof satisfiesDiet>[0]) =>
      new Set(
        recipes
          .filter((recipe) =>
            satisfiesDiet(diet, {
              dietTags: tagsOf(recipe).dietTags,
              hasIngredientData: true,
              perServing: null,
            }),
          )
          .map((r) => r.title),
      );
    const vegetarian = sets('VEGETARIAN');
    const pescatarian = sets('PESCATARIAN');
    const vegan = sets('VEGAN');
    for (const title of vegetarian) expect(pescatarian.has(title)).toBe(true);
    for (const title of vegan) expect(vegetarian.has(title)).toBe(true);
  });
});
