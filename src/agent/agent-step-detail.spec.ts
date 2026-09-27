import { describeStep, doneLabel } from './agent-step-detail';
import { progressStep } from './agent-progress';

const ok = (data: unknown) => ({ ok: true as const, data });

describe('describeStep — fakty kroku do „Jak pracowałem”', () => {
  it('dobór dań: pora, dzień, życzenia i wynik', () => {
    expect(
      describeStep(
        'suggest_meals',
        {
          meal_type: 'DINNER',
          day_of_week: 'WED',
          diet: 'VEGETARIAN',
          must_have_tags: [],
          prefer_tags: [],
          avoid_ingredients: ['ryba'],
          max_prep_minutes: 30,
        },
        ok({ offered: 3, eligible: 38 }),
      ),
    ).toBe(
      'Kolacja · na środę · wegetariańskie · bez: ryba · do 30 min — 3 z 38 pasujących',
    );
  });

  it('plan dnia z planera: dni, pory i kcal osoby', () => {
    expect(
      describeStep(
        'build_meal_plan',
        { days: ['SAT'], meal_types: ['BREAKFAST', 'LUNCH', 'DINNER'] },
        ok({
          proposed: true,
          planner: {
            status: 'OK',
            perPersonDaily: [{ avgKcal: 1978.4, avgTargetKcal: 2000 }],
          },
        }),
      ),
    ).toBe(
      'Sobota · Śniadanie, obiad i kolacja — śr. 1978 z 2000 kcal dziennie',
    );
  });

  it('plan tygodnia: pusty i pełny', () => {
    expect(describeStep('get_week_plan', {}, ok({ items: [] }))).toBe(
      'Tydzień jest jeszcze pusty',
    );
    expect(
      describeStep('get_week_plan', {}, ok({ items: [{}, {}, {}, {}, {}] })),
    ).toBe('5 posiłków w planie tygodnia');
  });

  it('zapis planu mówi, ile się zmieniło; próba — czy się spina', () => {
    expect(
      describeStep(
        'apply_week_plan',
        { dry_run: false },
        ok({ changes: { created: 3, updated: 1, deleted: 0 }, violations: [] }),
      ),
    ).toBe('3 nowe · 1 zmieniony');
    expect(
      describeStep(
        'apply_week_plan',
        { dry_run: true },
        ok({ violations: [] }),
      ),
    ).toBe('Wszystko się zgadza');
  });

  it('odmowa narzędzia też jest faktem, bez kodu na ekranie', () => {
    expect(
      describeStep(
        'find_recipes',
        {},
        {
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'x' },
        },
      ),
    ).toBe('Nie wyszło — spróbowałem inaczej');
  });

  it('nieznane narzędzie nie wymyśla szczegółu', () => {
    expect(describeStep('nowe_narzedzie', {}, ok({}))).toBeNull();
  });
});

describe('doneLabel — ten sam krok w czasie przeszłym', () => {
  it('krok na żywo niesie też zdanie po fakcie', () => {
    const step = progressStep('propose_day_plan', {}, new Date(0), 't');
    expect(step.done).toBe('Ułożyłem propozycję dnia');
    expect(doneLabel('apply_week_plan', { dry_run: true })).toBe(
      'Sprawdziłem, czy plan się spina',
    );
    // Kroki przejściowe nie mają zdania po fakcie — po turze ich nie ma.
    expect(progressStep('think', {}, new Date(0), 't').done).toBeUndefined();
  });
});
