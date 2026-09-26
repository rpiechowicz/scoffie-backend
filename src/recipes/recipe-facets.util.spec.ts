import { MealType } from '@prisma/client';
import {
  FacetRecipe,
  RECIPE_SEARCH_TAGS,
  RECIPE_TAG_LABELS,
  recipeSearchTags,
  tagGroup,
} from './recipe-facets.util';

const recipe = (overrides: Partial<FacetRecipe>): FacetRecipe => ({
  title: 'Danie',
  mealType: 'LUNCH' as MealType,
  prepTimeMinutes: 30,
  perServing: { kcal: 500, protein: 20 },
  ingredients: [{ name: 'Cebula', department: 'Warzywa' }],
  ...overrides,
});

describe('recipeSearchTags — rodzaj dania (reguły z iOS)', () => {
  it('zupa w obiedzie to soup, niezależnie od polskich znaków', () => {
    expect(recipeSearchTags(recipe({ title: 'Żurek z jajkiem' }))).toContain(
      'soup',
    );
    expect(
      recipeSearchTags(recipe({ title: 'Krem z dyni', mealType: 'DINNER' })),
    ).toContain('soup');
  });

  it('wygrywa słowo, które stoi w nazwie najwcześniej', () => {
    // „Tost z jajkiem" to kanapka, „Jajka na miękko z grzankami" — jajka.
    expect(
      recipeSearchTags(
        recipe({ title: 'Tost z jajkiem', mealType: 'BREAKFAST' }),
      ),
    ).toContain('sandwich');
    expect(
      recipeSearchTags(
        recipe({ title: 'Jajka na miękko z grzankami', mealType: 'BREAKFAST' }),
      ),
    ).toContain('eggs');
  });

  it('bez słowa w nazwie obiad czyta dodatek ze składników', () => {
    const tags = recipeSearchTags(
      recipe({
        title: 'Kurczak w sosie śmietanowym',
        ingredients: [
          { name: 'Filet z kurczaka', department: 'Mięso' },
          { name: 'Ryż basmati', department: 'Zboża i makarony' },
        ],
      }),
    );
    expect(tags).toContain('grains');
  });

  it('w kolacji makaron jest makaronem, a nie „kaszą"', () => {
    const tags = recipeSearchTags(
      recipe({
        title: 'Szybka kolacja z tuńczykiem',
        mealType: 'DINNER',
        ingredients: [
          { name: 'Makaron penne', department: 'Zboża i makarony' },
        ],
      }),
    );
    expect(tags).toContain('pasta');
    expect(tags).not.toContain('grains');
  });

  it('w przekąskach sernik to ciasto (cake), nie zapiekanka (bake)', () => {
    const tags = recipeSearchTags(
      recipe({ title: 'Sernik na zimno', mealType: 'AFTERNOON_SNACK' }),
    );
    expect(tags).toContain('cake');
    expect(tags).not.toContain('bake');
  });

  it('danie bez pasującego słowa nie dostaje rodzaju', () => {
    const tags = recipeSearchTags(
      recipe({ title: 'Golonka z kapustą', ingredients: [] }),
    );
    expect(tags.filter((tag) => tagGroup(tag) === 'dish')).toEqual([]);
  });
});

describe('recipeSearchTags — mięso i smak', () => {
  it('drób, wieprzowina, ryby — po składnikach i dziale', () => {
    const tags = recipeSearchTags(
      recipe({
        ingredients: [
          { name: 'Udko z kurczaka', department: 'Mięso' },
          { name: 'Boczek wędzony', department: 'Mięso' },
          { name: 'Filet z mintaja', department: 'Ryby' },
        ],
      }),
    );
    expect(tags).toEqual(expect.arrayContaining(['poultry', 'pork', 'fish']));
    expect(tags).not.toContain('meatless');
  });

  it('polędwica z indyka to drób, nie wieprzowina', () => {
    const tags = recipeSearchTags(
      recipe({
        ingredients: [{ name: 'Polędwica z indyka', department: 'Mięso' }],
      }),
    );
    expect(tags).toContain('poultry');
    expect(tags).not.toContain('pork');
  });

  it('„bez mięsa" tylko na dowodzie — przepis bez składników nie jest wege', () => {
    expect(recipeSearchTags(recipe({}))).toContain('meatless');
    expect(recipeSearchTags(recipe({ ingredients: [] }))).not.toContain(
      'meatless',
    );
  });

  it('słodkie kontra słone, remis na słono', () => {
    const sweet = recipeSearchTags(
      recipe({
        mealType: 'BREAKFAST',
        title: 'Owsianka',
        ingredients: [
          { name: 'Banan', department: 'Owoce' },
          { name: 'Miód', department: 'Inne' },
        ],
      }),
    );
    expect(sweet).toContain('sweet');
    expect(recipeSearchTags(recipe({ ingredients: [] }))).toContain('savory');
    expect(
      recipeSearchTags(recipe({ title: 'Placki na słodko', ingredients: [] })),
    ).toContain('sweet');
  });
});

describe('recipeSearchTags — cechy z makro', () => {
  it('szybkie do 20 min, 0 minut to „nie wiemy", nie „od ręki"', () => {
    expect(recipeSearchTags(recipe({ prepTimeMinutes: 15 }))).toContain(
      'quick',
    );
    expect(recipeSearchTags(recipe({ prepTimeMinutes: 25 }))).not.toContain(
      'quick',
    );
    expect(recipeSearchTags(recipe({ prepTimeMinutes: 0 }))).not.toContain(
      'quick',
    );
  });

  it('lekkie do 400 kcal na porcję, dużo białka od 25 g', () => {
    const tags = recipeSearchTags(
      recipe({ perServing: { kcal: 380, protein: 32 } }),
    );
    expect(tags).toEqual(expect.arrayContaining(['light', 'high_protein']));
    expect(recipeSearchTags(recipe({ perServing: null }))).not.toContain(
      'light',
    );
  });

  it('kolejność tagów jest kolejnością słownika — deterministyczny prefiks', () => {
    const tags = recipeSearchTags(
      recipe({
        title: 'Zupa z kurczakiem',
        prepTimeMinutes: 15,
        ingredients: [{ name: 'Kurczak', department: 'Mięso' }],
      }),
    );
    const order = tags.map((tag) => RECIPE_SEARCH_TAGS.indexOf(tag));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('każdy tag ma etykietę i słowa do szukania', () => {
    for (const tag of RECIPE_SEARCH_TAGS) {
      expect(RECIPE_TAG_LABELS[tag].label.length).toBeGreaterThan(0);
      expect(RECIPE_TAG_LABELS[tag].words.length).toBeGreaterThan(0);
    }
  });
});
