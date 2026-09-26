import { MealType } from '@prisma/client';
import {
  buildCatalogMap,
  EMPTY_SIGNALS,
  ingredientMatches,
  queryStems,
  RecipeSearchQuery,
  SearchAudience,
  SearchSignals,
  SearchSourceRecipe,
  searchRecipes,
  stem,
  toSearchable,
} from './catalog-search';

let counter = 0;

function source(
  title: string,
  overrides: Partial<SearchSourceRecipe> = {},
  ingredientNames: [string, string][] = [['Cebula', 'Warzywa']],
): SearchSourceRecipe {
  counter += 1;
  return {
    id: `id-${title}`,
    title,
    description: null,
    mealType: 'LUNCH' as MealType,
    suitableMealTypes: [],
    prepTimeMinutes: 30,
    servings: 2,
    nutritionKcal: 1000,
    nutritionProtein: 60,
    nutritionFat: 30,
    nutritionCarbs: 100,
    allergens: [],
    dietTags: [],
    ingredients: ingredientNames.map(([name, department], index) => ({
      ingredientId: `ing-${name}`,
      name,
      department,
      normalizedAmount: 100 + index,
      normalizedUnit: 'g',
      gramsPerPiece: null,
    })),
    ...overrides,
  } satisfies SearchSourceRecipe & { id: string };
}

const doc = (
  title: string,
  overrides: Partial<SearchSourceRecipe> = {},
  ingredientNames?: [string, string][],
) =>
  toSearchable(
    source(title, overrides, ingredientNames),
    `R${String(counter).padStart(3, '0')}`,
    false,
  );

const query = (
  overrides: Partial<RecipeSearchQuery> = {},
): RecipeSearchQuery => ({
  text: '',
  mealType: null,
  tags: [],
  includeIngredients: [],
  excludeIngredients: [],
  maxPrepMinutes: null,
  maxKcalPerServing: null,
  minProteinPerServing: null,
  sort: 'BEST_FIT',
  limit: 8,
  ...overrides,
});

const NOBODY: SearchAudience = {
  allergens: [],
  excludedIngredientIds: [],
  diets: [],
};

const titles = (result: { hits: { title: string }[] }) =>
  result.hits.map((hit) => hit.title);

describe('rdzenie polskich słów', () => {
  it('odmiana trafia w ten sam rdzeń', () => {
    expect('kurczak'.startsWith(stem('kurczakiem'))).toBe(true);
    expect('zupa'.startsWith(stem('zupy'))).toBe(true);
    expect('lekkie'.startsWith(stem('lekkiego'))).toBe(true);
  });

  it('słowa puste i pory posiłku wypadają, słowo po „bez" też', () => {
    expect(queryStems('coś na obiad z kurczakiem')).toEqual([
      stem('kurczakiem'),
    ]);
    // „bez mięsa" nie może promować dań z mięsem.
    expect(queryStems('zupa bez mięsa')).toEqual([stem('zupa')]);
  });

  it('składnik po nazwie: każde znaczące słowo musi trafić', () => {
    expect(ingredientMatches('Jajko', 'jajka')).toBe(true);
    expect(
      ingredientMatches('Filet z piersi kurczaka', 'pierś z kurczaka'),
    ).toBe(true);
    expect(ingredientMatches('Filet z indyka', 'pierś z kurczaka')).toBe(false);
    // Od początku wyrazu — „por" nie trafia w „porcję".
    expect(ingredientMatches('Porcja mięsa', 'por')).toBe(false);
  });
});

describe('searchRecipes — filtry twarde jedzących', () => {
  it('alergen jedzącego wyklucza danie, nawet gdy pasuje do prośby', () => {
    const recipes = [
      doc('Dorsz z masłem', { allergens: ['LACTOSE'] }),
      doc('Dorsz z warzywami'),
    ];
    const result = searchRecipes(recipes, query({ text: 'dorsz' }), {
      ...NOBODY,
      allergens: ['LACTOSE'],
    });
    expect(titles(result)).toEqual(['Dorsz z warzywami']);
  });

  it('dieta wegetariańska odrzuca mięso i ryby — reguły walidatora planu', () => {
    const recipes = [
      doc('Kotlet schabowy', { dietTags: ['MEAT'] }),
      doc('Placki z cukinii', { dietTags: ['EGG'] }),
    ];
    const result = searchRecipes(recipes, query(), {
      ...NOBODY,
      diets: ['VEGETARIAN'],
    });
    expect(titles(result)).toEqual(['Placki z cukinii']);
  });

  it('wykluczony składnik jedzącego (po id) wyklucza danie', () => {
    const recipes = [
      doc('Risotto z pieczarkami', {}, [['Pieczarki', 'Warzywa']]),
      doc('Risotto z dynią', {}, [['Dynia', 'Warzywa']]),
    ];
    const result = searchRecipes(recipes, query(), {
      ...NOBODY,
      excludedIngredientIds: ['ing-Pieczarki'],
    });
    expect(titles(result)).toEqual(['Risotto z dynią']);
  });
});

describe('searchRecipes — kryteria z prośby', () => {
  it('pora: danie pasuje przez suitableMealTypes, pusta lista = mealType', () => {
    const recipes = [
      doc('Owsianka', {
        mealType: 'BREAKFAST',
        suitableMealTypes: ['BREAKFAST', 'SECOND_BREAKFAST'],
      }),
      doc('Gulasz', { mealType: 'LUNCH' }),
    ];
    expect(
      titles(
        searchRecipes(recipes, query({ mealType: 'SECOND_BREAKFAST' }), NOBODY),
      ),
    ).toEqual(['Owsianka']);
    expect(
      titles(searchRecipes(recipes, query({ mealType: 'LUNCH' }), NOBODY)),
    ).toEqual(['Gulasz']);
  });

  it('tagi: w grupie LUB, między grupami I', () => {
    const recipes = [
      doc('Zupa z kurczakiem', {}, [['Kurczak', 'Mięso']]),
      doc('Zupa pomidorowa', {}, [['Pomidor', 'Warzywa']]),
      doc('Sałatka z kurczakiem', {}, [['Kurczak', 'Mięso']]),
    ];
    expect(
      titles(
        searchRecipes(recipes, query({ tags: ['soup', 'salad'] }), NOBODY),
      ).sort(),
    ).toEqual(['Sałatka z kurczakiem', 'Zupa pomidorowa', 'Zupa z kurczakiem']);
    expect(
      titles(
        searchRecipes(recipes, query({ tags: ['soup', 'poultry'] }), NOBODY),
      ),
    ).toEqual(['Zupa z kurczakiem']);
  });

  it('składniki: muszą być wszystkie z include, żadnego z exclude, z odmianą', () => {
    const recipes = [
      doc('Leczo', {}, [
        ['Papryka czerwona', 'Warzywa'],
        ['Kiełbasa', 'Mięso'],
      ]),
      doc('Papryka faszerowana', {}, [
        ['Papryka czerwona', 'Warzywa'],
        ['Ryż', 'Zboża i makarony'],
      ]),
    ];
    expect(
      titles(
        searchRecipes(
          recipes,
          query({
            includeIngredients: ['papryki'],
            excludeIngredients: ['kiełbasy'],
          }),
          NOBODY,
        ),
      ),
    ).toEqual(['Papryka faszerowana']);
  });

  it('limit czasu nie przepuszcza dań bez czasu (0 = nie wiemy)', () => {
    const recipes = [
      doc('Szybkie', { prepTimeMinutes: 15 }),
      doc('Bez czasu', { prepTimeMinutes: 0 }),
      doc('Długie', { prepTimeMinutes: 90 }),
    ];
    expect(
      titles(searchRecipes(recipes, query({ maxPrepMinutes: 30 }), NOBODY)),
    ).toEqual(['Szybkie']);
  });

  it('kalorie i białko liczą się NA PORCJĘ', () => {
    const recipes = [
      // 1000 kcal na 2 porcje = 500 na porcję.
      doc('Pół tysiąca', { nutritionKcal: 1000, servings: 2 }),
      doc('Tysiąc', { nutritionKcal: 1000, servings: 1 }),
    ];
    expect(
      titles(searchRecipes(recipes, query({ maxKcalPerServing: 600 }), NOBODY)),
    ).toEqual(['Pół tysiąca']);
    expect(
      titles(
        searchRecipes(recipes, query({ minProteinPerServing: 50 }), NOBODY),
      ),
    ).toEqual(['Tysiąc']);
  });

  it('tekst zawęża do dań, które trafiają; nietrafiony tekst jest pomijany jawnie', () => {
    const recipes = [
      doc('Kurczak curry', {}, [['Kurczak', 'Mięso']]),
      doc('Pieczarki z patelni', {}, [['Pieczarki', 'Warzywa']]),
    ];
    const hit = searchRecipes(
      recipes,
      query({ text: 'coś z kurczakiem' }),
      NOBODY,
    );
    expect(titles(hit)).toEqual(['Kurczak curry']);
    expect(hit.textIgnored).toBe(false);

    const miss = searchRecipes(
      recipes,
      query({ text: 'rozgrzewające' }),
      NOBODY,
    );
    expect(miss.textIgnored).toBe(true);
    expect(miss.total).toBe(2);
  });

  it('synonim tagu łapie się w tekście: „lekkiego" trafia w light', () => {
    const recipes = [
      doc('Sałatka', { nutritionKcal: 600, servings: 2 }),
      doc('Golonka', { nutritionKcal: 3000, servings: 2 }),
    ];
    expect(
      titles(searchRecipes(recipes, query({ text: 'coś lekkiego' }), NOBODY)),
    ).toEqual(['Sałatka']);
  });

  it('zero wyników: podpowiedź, ile dań byłoby bez każdego kryterium', () => {
    const recipes = [doc('Gulasz', { prepTimeMinutes: 90 })];
    const result = searchRecipes(
      recipes,
      query({ maxPrepMinutes: 20, mealType: 'LUNCH' }),
      NOBODY,
    );
    expect(result.total).toBe(0);
    expect(result.relaxations).toEqual([
      { without: 'max_prep_minutes', total: 1 },
    ]);
  });
});

describe('searchRecipes — ranking', () => {
  const signals = (overrides: Partial<SearchSignals>): SearchSignals => ({
    ...EMPTY_SIGNALS,
    ...overrides,
  });

  it('danie z planu tego tygodnia spada, ulubione idzie w górę', () => {
    const recipes = [doc('A'), doc('B'), doc('C')];
    const result = searchRecipes(
      recipes,
      query(),
      NOBODY,
      signals({
        plannedThisWeek: new Set(['id-A']),
        favorites: new Set(['id-C']),
      }),
    );
    expect(titles(result)).toEqual(['C', 'B', 'A']);
    expect(result.hits[0].why).toContain('ulubione domu');
    expect(result.hits[2].why).toContain('JUŻ jest w planie tego tygodnia');
  });

  it('składniki wspólne z planem tygodnia podnoszą danie — przyprawy się nie liczą', () => {
    const recipes = [
      doc('Z porem', {}, [['Por', 'Warzywa']]),
      doc('Z solą', {}, [['Sól', 'Przyprawy i sosy']]),
      doc('Zwykłe', {}, [['Kapusta', 'Warzywa']]),
    ];
    const result = searchRecipes(
      recipes,
      query(),
      NOBODY,
      signals({ weekIngredientIds: new Set(['ing-Por', 'ing-Sól']) }),
    );
    expect(titles(result)[0]).toBe('Z porem');
    expect(result.hits[0].why[0]).toContain('wspólne z planem tygodnia: Por');
    const salt = result.hits.find((hit) => hit.title === 'Z solą');
    expect(salt?.why).toEqual([]);
  });

  it('sortowanie po liczbie: najszybsze, najlżejsze, najwięcej białka', () => {
    const recipes = [
      doc('Wolne lekkie', {
        prepTimeMinutes: 60,
        nutritionKcal: 400,
        nutritionProtein: 20,
      }),
      doc('Szybkie ciężkie', {
        prepTimeMinutes: 10,
        nutritionKcal: 1600,
        nutritionProtein: 90,
      }),
    ];
    expect(
      titles(searchRecipes(recipes, query({ sort: 'QUICKEST' }), NOBODY))[0],
    ).toBe('Szybkie ciężkie');
    expect(
      titles(searchRecipes(recipes, query({ sort: 'LIGHTEST' }), NOBODY))[0],
    ).toBe('Wolne lekkie');
    expect(
      titles(
        searchRecipes(recipes, query({ sort: 'HIGH_PROTEIN' }), NOBODY),
      )[0],
    ).toBe('Szybkie ciężkie');
  });

  it('dywersyfikacja: przy równych wynikach nie same zupy', () => {
    const recipes = [
      doc('Zupa 1'),
      doc('Zupa 2'),
      doc('Zupa 3'),
      doc('Sałatka 1'),
      doc('Gulasz 1'),
    ];
    const result = searchRecipes(recipes, query({ limit: 3 }), NOBODY);
    const soups = titles(result).filter((title) => title.startsWith('Zupa'));
    expect(soups.length).toBeLessThanOrEqual(1);
  });

  it('limit: domyślnie 8, najwyżej 15', () => {
    const recipes = Array.from({ length: 30 }, (_, index) =>
      doc(`Danie ${index}`),
    );
    expect(
      searchRecipes(recipes, query({ limit: 0 }), NOBODY).hits,
    ).toHaveLength(8);
    expect(
      searchRecipes(recipes, query({ limit: 99 }), NOBODY).hits,
    ).toHaveLength(15);
  });

  it('trafienie niesie makro NA PORCJĘ i referencję do kolejnych narzędzi', () => {
    const [hit] = searchRecipes([doc('Jedno')], query(), NOBODY).hits;
    expect(hit).toMatchObject({
      title: 'Jedno',
      kcal: 500,
      protein: 30,
      prepMinutes: 30,
      slots: ['LUNCH'],
    });
    expect(hit.recipe).toMatch(/^R\d{3}$/);
  });
});

describe('buildCatalogMap', () => {
  it('liczby na pory i tagi, przykład indeksu w szerokości katalogu, deterministycznie', () => {
    const recipes = [
      doc('Zupa z soczewicy', { mealType: 'LUNCH' }),
      doc('Owsianka', { mealType: 'BREAKFAST' }),
    ];
    const map = buildCatalogMap(recipes, 3);
    expect(map).toContain('W katalogu jest 2 dań');
    expect(map).toContain('obiad 1');
    expect(map).toContain('śniadanie 1');
    expect(map).toContain('- soup — zupy i kremy (1)');
    expect(map).toContain('R007');
    expect(buildCatalogMap(recipes, 3)).toBe(map);
    // Mapa nie wymienia dań — tylko liczby i tagi.
    expect(map).not.toContain('Zupa z soczewicy');
  });
});
