import {
  DETAILS_MAX_INGREDIENTS,
  DETAILS_MAX_STEPS,
  projectRecipeDetailsForModel,
  readRecipeSteps,
} from './agent-tool-executor';
import { AGENT_TOOLS, AGENT_TOOL_TIERS, TRIAGE_TOOLS } from './agent-tools';

const recipe = {
  id: 'r-1',
  title: 'Dorsz z masłem',
  mealType: 'DINNER',
  servings: 4,
  prepTimeMinutes: 35,
  nutritionKcal: 1600,
  nutritionProtein: 120,
  nutritionFat: 80,
  nutritionCarbs: 40,
  allergens: ['fish', 'lactose'],
  dietTags: ['FISH', 'DAIRY'],
  isCatalog: true,
  sourceInstructions: [
    { stepNumber: 2, text: 'Podsmaż masło.' },
    { stepNumber: 1, text: 'Umyj dorsza.' },
  ],
  ingredients: [
    { name: 'dorsz', amount: 600, unit: 'g' },
    { name: 'masło', amount: 40.005, unit: 'g' },
  ],
};

describe('projectRecipeDetailsForModel', () => {
  it('oddaje makra NA PORCJĘ, nie na cały przepis', () => {
    // W bazie makra opisują cały przepis; model i użytkownik myślą porcjami,
    // a obiad na 1600 kcal wyglądałby na niemożliwy do wpisania w cel dnia.
    const result = projectRecipeDetailsForModel(recipe);
    expect(result.kcalPerServing).toBe(400);
    expect(result.proteinPerServing).toBe(30);
    expect(result.fatPerServing).toBe(20);
    expect(result.carbsPerServing).toBe(10);
  });

  it('oddaje CAŁY skład, bo to jest jedyny powód, dla którego się tu przychodzi', () => {
    const result = projectRecipeDetailsForModel(recipe);
    expect(result.ingredients).toEqual([
      { name: 'dorsz', amount: 600, unit: 'g' },
      // Zaokrąglenie do dwóch miejsc: 40.005 g z bazy to szum po dzieleniu,
      // a model przepisuje tę liczbę użytkownikowi.
      { name: 'masło', amount: 40.01, unit: 'g' },
    ]);
  });

  it('nie przepuszcza adresu zdjęcia ani identyfikatorów składników', () => {
    // Model MA gdzie wkleić `imageUrl` (362 B), bo pisze tekst do użytkownika.
    const result = projectRecipeDetailsForModel({
      ...recipe,
      ...({ imageUrl: 'https://example.test/x.jpg' } as object),
    });
    expect(JSON.stringify(result)).not.toContain('example.test');
    expect(Object.keys(result)).not.toContain('imageUrl');
  });

  it('brak porcji nie dzieli przez zero', () => {
    const result = projectRecipeDetailsForModel({ ...recipe, servings: null });
    expect(result.servings).toBe(1);
    expect(result.kcalPerServing).toBe(1600);
  });

  it('przepis bez kroków oddaje pustą listę, a nie undefined', () => {
    const result = projectRecipeDetailsForModel({
      ...recipe,
      sourceInstructions: null,
    });
    expect(result.steps).toEqual([]);
  });

  it('tnie skład i kroki do sufitu', () => {
    const result = projectRecipeDetailsForModel({
      ...recipe,
      ingredients: Array.from({ length: 80 }, (_, i) => ({
        name: `skladnik ${i}`,
        amount: 1,
        unit: 'g',
      })),
      sourceInstructions: Array.from({ length: 60 }, (_, i) => ({
        stepNumber: i + 1,
        text: `krok ${i}`,
      })),
    });
    expect(result.ingredients).toHaveLength(DETAILS_MAX_INGREDIENTS);
    expect(result.steps).toHaveLength(DETAILS_MAX_STEPS);
  });
});

describe('readRecipeSteps', () => {
  it('czyta trzy pisownie i układa po numerze', () => {
    // Katalog jest starszy niż `recipes:create` z krokami i zapisuje `step`.
    expect(
      readRecipeSteps([
        { step: 2, text: 'drugi' },
        { stepNumber: 1, text: 'pierwszy' },
      ]),
    ).toEqual(['pierwszy', 'drugi']);
    expect(readRecipeSteps([{ step_number: 1, instruction: 'jeden' }])).toEqual(
      ['jeden'],
    );
    expect(readRecipeSteps(['goły string'])).toEqual(['goły string']);
  });

  it('pusty krok nie jest krokiem', () => {
    expect(readRecipeSteps([{ text: '   ' }, { text: 'coś' }])).toEqual([
      'coś',
    ]);
  });

  it('nie-tablica nie wywraca odczytu', () => {
    expect(readRecipeSteps(null)).toEqual([]);
    expect(readRecipeSteps({ steps: 'x' })).toEqual([]);
  });
});

describe('nowe narzędzia czytające', () => {
  it.each(['get_recipe_details', 'find_recipes'])(
    '%s jest w warstwie rozmowy, więc nie kosztuje przekazania planiście',
    (name) => {
      expect(AGENT_TOOL_TIERS[name]).toBe('chat');
      expect(TRIAGE_TOOLS.map((tool) => tool.name)).toContain(name);
      expect(AGENT_TOOLS.map((tool) => tool.name)).toContain(name);
    },
  );

  it('nie dokładają ani jednego pola nieobowiązkowego', () => {
    // Limit API to 24 pola nieobowiązkowe W SUMIE i jest wyczerpany co do
    // jednego; przekroczenie to 400 na KAŻDEJ turze, niewidoczne w testach.
    for (const name of ['get_recipe_details', 'find_recipes']) {
      const tool = AGENT_TOOLS.find((entry) => entry.name === name);
      const properties = Object.keys(tool?.input_schema.properties ?? {});
      expect(tool?.input_schema.required).toEqual(properties);
    }
  });
});
