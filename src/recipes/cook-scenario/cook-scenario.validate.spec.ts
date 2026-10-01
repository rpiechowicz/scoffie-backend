import {
  checkScenarioAgainstRecipe,
  parseCookScenarioContent,
  type ScenarioRecipe,
} from './cook-scenario.validate';
import type { CookScenarioContent } from './cook-scenario.types';

const recipe: ScenarioRecipe = {
  servings: 2,
  ingredients: [
    { ingredientId: 'ing-maslo', name: 'masło', amount: 30, unit: 'g' },
    { ingredientId: 'ing-sol', name: 'sól', amount: 3, unit: 'g' },
  ],
};

const valid = (): Record<string, unknown> => ({
  schemaVersion: 1,
  basePortions: 2,
  portionUnit: null,
  totalMinutes: 20,
  tips: ['Masło musi być miękkie.'],
  nextTimeTip: null,
  steps: [
    {
      id: 's1',
      phase: 'PREP',
      stage: null,
      title: 'Rozgnieć masło',
      body: 'Rozgnieć masło widelcem i posól.',
      ingredients: [
        { ingredientId: 'ing-maslo', amount: 30, unit: 'g', part: 'ALL' },
        { ingredientId: 'ing-sol', amount: 1, unit: 'g', part: 'PART' },
      ],
      mentions: [],
      note: null,
      timer: {
        id: 't1',
        label: 'Masło',
        minSeconds: 600,
        maxSeconds: 720,
        trigger: 'NOW',
        startLabel: 'Odliczaj 10 min',
        alert: { title: 'Masło gotowe', body: 'Wyjmij je.' },
      },
      during: null,
      scaleNote: null,
    },
    {
      id: 's2',
      phase: 'FINISH',
      stage: 'W MIĘDZYCZASIE',
      title: 'Posól resztą soli',
      body: 'Dosyp resztę soli.',
      ingredients: [
        { ingredientId: 'ing-sol', amount: 2, unit: 'g', part: 'REST' },
      ],
      mentions: ['ing-maslo'],
      note: { kind: 'CUE', text: 'Sól się rozpuściła.' },
      timer: null,
      during: 't1',
      scaleNote: { fromPortions: 4, text: 'Weź większą miskę.' },
    },
  ],
});

const parse = (value: unknown) => parseCookScenarioContent(value);

const check = (mutate: (c: Record<string, unknown>) => void): string[] => {
  const raw = valid();
  mutate(raw);
  const parsed = parse(raw);
  expect(parsed.errors).toEqual([]);
  return checkScenarioAgainstRecipe(
    parsed.content as CookScenarioContent,
    recipe,
  );
};

const steps = (raw: Record<string, unknown>) =>
  raw.steps as Array<Record<string, unknown>>;

describe('parseCookScenarioContent', () => {
  it('przyjmuje poprawny scenariusz bez błędów', () => {
    const parsed = parse(valid());
    expect(parsed.errors).toEqual([]);
    expect(parsed.content?.steps).toHaveLength(2);
  });

  it('odczyt przyjmuje zapisy starszych zasad (.3/.4): tytuł 45, treść 300, startLabel 30 — limity pisania .5 go nie dotyczą', () => {
    // Review Codexa: zaostrzenie limitów FORMATU schowałoby opublikowane
    // scenariusze (WS zwraca scenario: null). Ostrzejsze limity .5 pilnuje
    // tylko system pisania (COOK_AUTHOR_LIMITS).
    const raw = valid();
    const [first] = steps(raw);
    first.title = 'x'.repeat(45);
    first.body = 'y'.repeat(300);
    const parsed = parse(raw);
    expect(parsed.errors).toEqual([]);
    expect(parsed.content?.steps[0].title).toHaveLength(45);
  });

  it('odrzuca nie-obiekt', () => {
    expect(parse(null)).toEqual({
      content: null,
      errors: ['scenariusz: wymagany obiekt'],
    });
  });

  it('zbiera wszystkie błędy kształtu naraz', () => {
    const raw = valid();
    raw.schemaVersion = 2;
    steps(raw)[0].phase = 'BAKE';
    steps(raw)[0].title = 'x'.repeat(61);
    (steps(raw)[0].timer as Record<string, unknown>).label =
      'Bardzo długa nazwa';
    (steps(raw)[0].timer as Record<string, unknown>).maxSeconds = 300;
    const parsed = parse(raw);
    expect(parsed.content).toBeNull();
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        'schemaVersion: oczekiwano 1',
        'steps[0].phase: dozwolone PREP, COOK, FINISH, SERVE',
        'steps[0].title: 61 znaków, limit 60',
        'steps[0].timer.label: 18 znaków, limit 14',
        'steps[0].timer: maxSeconds mniejsze niż minSeconds',
      ]),
    );
  });

  it('pilnuje liczby rad i zakresu kroków', () => {
    const raw = valid();
    raw.tips = ['a', 'b', 'c', 'd'];
    raw.steps = [];
    const errors = parse(raw).errors;
    expect(errors).toContain('tips: 4 rad, limit 3');
    expect(errors).toContain('steps: 0 kroków, dozwolone 1–30');
  });

  it('ilość składnika musi być dodatnia', () => {
    const raw = valid();
    (steps(raw)[0].ingredients as Array<Record<string, unknown>>)[0].amount = 0;
    expect(parse(raw).errors).toContain(
      'steps[0].ingredients[0].amount: wymagana liczba dodatnia',
    );
  });
});

describe('checkScenarioAgainstRecipe', () => {
  it('zgodny scenariusz nie ma błędów', () => {
    expect(check(() => undefined)).toEqual([]);
  });

  it('porcje scenariusza muszą być porcjami przepisu', () => {
    expect(check((raw) => (raw.basePortions = 4))).toEqual([
      'basePortions 4 ≠ porcje przepisu 2',
    ]);
  });

  it('suma części składnika = ilość w przepisie', () => {
    const errors = check((raw) => {
      (steps(raw)[1].ingredients as Array<Record<string, unknown>>)[0].amount =
        1;
    });
    expect(errors).toEqual(['składnik „sól”: w krokach 2 g, w przepisie 3 g']);
  });

  it('każdy składnik przepisu musi trafić do jakiegoś kroku', () => {
    const errors = check((raw) => {
      steps(raw)[0].ingredients = [
        { ingredientId: 'ing-sol', amount: 1, unit: 'g', part: 'PART' },
      ];
    });
    expect(errors).toEqual(['składnik „masło” nie trafia do żadnego kroku']);
  });

  it('składnik spoza przepisu i obca jednostka to błąd', () => {
    const errors = check((raw) => {
      const first = steps(raw)[0].ingredients as Array<Record<string, unknown>>;
      first.push({
        ingredientId: 'ing-cukier',
        amount: 5,
        unit: 'g',
        part: 'ALL',
      });
      first[1].unit = 'łyżeczka';
      steps(raw)[1].mentions = ['ing-pieprz'];
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'steps[0].ingredients[2]: składnika nie ma w przepisie',
        'steps[0].ingredients[1] (sól): jednostka łyżeczka ≠ g',
        'steps[1].mentions[0]: składnika nie ma w przepisie',
      ]),
    );
  });

  it('`during` wskazuje timer z WCZEŚNIEJSZEGO kroku', () => {
    const errors = check((raw) => {
      steps(raw)[0].during = 't1';
      steps(raw)[1].during = 't-nieznany';
    });
    expect(errors).toEqual([
      'steps[0].during: brak wcześniejszego timera „t1”',
      'steps[1].during: brak wcześniejszego timera „t-nieznany”',
    ]);
  });

  it('powtórzone id kroku i timera', () => {
    const errors = check((raw) => {
      steps(raw)[1].id = 's1';
      steps(raw)[1].timer = { ...(steps(raw)[0].timer as object) };
      steps(raw)[1].during = null;
    });
    expect(errors).toEqual([
      'steps[1].id: powtórzone „s1”',
      'steps[1].timer.id: powtórzone „t1”',
    ]);
  });

  it('toleruje zaokrąglenie sumy (1%)', () => {
    const errors = check((raw) => {
      (steps(raw)[1].ingredients as Array<Record<string, unknown>>)[0].amount =
        2.01;
    });
    expect(errors).toEqual([]);
  });
});
