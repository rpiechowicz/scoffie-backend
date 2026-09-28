import { turnTextFor } from './agent-tool-executor';

/**
 * Zdanie serwera przy niepełnym wyniku planowania (N8B S0 + N6-1) — za
 * `AI_PARTIAL_SERVER_TEXT`. Wyłączone = dokładnie to samo co przed zmianą
 * (`null` → model dostaje kolejną rundę).
 */
const ON = { partialServerText: true };
const OFF = { partialServerText: false };

const partialWeek = {
  proposed: true,
  planner: {
    status: 'PARTIAL',
    filled: '12/14',
    issues: [
      'NO_CANDIDATES FRI DINNER — ALLERGEN×40',
      'KCAL_OUT_OF_TOLERANCE MON — u1: 1900 kcal w dniu wobec celu 2600 (-27 %).',
      'KCAL_OUT_OF_TOLERANCE TUE — domownik bez zgody na asystenta: cel dnia nietrafiony (bez szczegółów)',
      'PROTEIN_OUT_OF_TOLERANCE TUE — u1: protein: 60 g wobec 110 g (-45 %).',
      'REPEAT_FORCED — Za mało różnych dań.',
    ],
  },
};

describe('zdanie serwera przy PARTIAL (N8B S0)', () => {
  it('flaga wyłączona: plan i podmiana PARTIAL bez zdania, jak przed zmianą', () => {
    expect(
      turnTextFor('build_meal_plan', { days: ['MON'] }, partialWeek, OFF),
    ).toBeNull();
    expect(
      turnTextFor(
        'replace_plan_item',
        { day_of_week: 'WED', meal_type: 'DINNER' },
        partialWeek,
        OFF,
      ),
    ).toBeNull();
  });

  it('tydzień PARTIAL: brakujące posiłki, kalorie, białko, powtórki — bez imion i id', () => {
    const text = turnTextFor(
      'build_meal_plan',
      { days: ['MON', 'TUE'] },
      partialWeek,
      ON,
    );
    expect(text).toBe(
      'Plan tygodnia czeka na zatwierdzenie, ale nie wszystko się udało: ' +
        'dla 2 posiłków nie ma dania spełniającego wszystkie ograniczenia; ' +
        'kalorie części dni odbiegają od celu o ponad 10 %; ' +
        'białko części dni odbiega od celu o ponad 20 %; ' +
        'część dań się powtarza, bo pasujących przepisów jest mało. ' +
        'Możesz go zatwierdzić albo powiedzieć, co zmienić.',
    );
    expect(text).not.toMatch(/u1|zgody/);
  });

  it('jeden dzień: „Plan na poniedziałek”, jeden brakujący posiłek w liczbie pojedynczej', () => {
    const text = turnTextFor(
      'build_meal_plan',
      { days: ['MON'] },
      {
        proposed: true,
        planner: { status: 'PARTIAL', filled: '3/4', issues: [] },
      },
      ON,
    );
    expect(text).toBe(
      'Plan na poniedziałek czeka na zatwierdzenie, ale nie wszystko się udało: ' +
        'dla jednego posiłku nie ma dania spełniającego wszystkie ograniczenia. ' +
        'Możesz go zatwierdzić albo powiedzieć, co zmienić.',
    );
  });

  it('jeden dzień z kaloriami poza celem: „tego dnia”, nie „części dni”', () => {
    expect(
      turnTextFor(
        'build_meal_plan',
        { days: ['FRI'] },
        {
          proposed: true,
          planner: {
            status: 'PARTIAL',
            filled: '3/3',
            issues: [
              'KCAL_OUT_OF_TOLERANCE FRI — u1: 2100 kcal w dniu wobec celu 6000 (-65 %).',
            ],
          },
        },
        ON,
      ),
    ).toBe(
      'Plan na piątek czeka na zatwierdzenie, ale nie wszystko się udało: ' +
        'kalorie tego dnia odbiegają od celu o ponad 10 %. ' +
        'Możesz go zatwierdzić albo powiedzieć, co zmienić.',
    );
  });

  it('PARTIAL z nieznanego powodu → bez zdania (model tłumaczy sam)', () => {
    expect(
      turnTextFor(
        'build_meal_plan',
        { days: ['MON'] },
        {
          proposed: true,
          planner: {
            status: 'PARTIAL',
            filled: '4/4',
            issues: ['MACRO_OUT_OF_TOLERANCE MON — u1: fat'],
          },
        },
        ON,
      ),
    ).toBeNull();
  });

  it('OK zostaje OK — flaga nie zmienia zdań sukcesu', () => {
    const ok = { proposed: true, planner: { status: 'OK', filled: '4/4' } };
    expect(turnTextFor('build_meal_plan', { days: ['MON'] }, ok, ON)).toBe(
      turnTextFor('build_meal_plan', { days: ['MON'] }, ok, OFF),
    );
    expect(turnTextFor('replace_plan_item', {}, ok, ON)).toBe(
      'Nowe danie czeka na zatwierdzenie w karcie.',
    );
  });

  it('podmiana PARTIAL: kalorie i białko TEGO dnia, bez „brakujących posiłków”', () => {
    expect(
      turnTextFor(
        'replace_plan_item',
        { day_of_week: 'WED', meal_type: 'DINNER' },
        partialWeek,
        ON,
      ),
    ).toBe(
      'Nowe danie czeka na zatwierdzenie w karcie, ale kalorie tego dnia odbiegają od celu o ponad 10 % ' +
        'i białko tego dnia odbiega od celu o ponad 20 % — to najlepsze, jakie znalazłem przy tych warunkach.',
    );
  });
});

describe('suggest_meals bez dwóch dań (N6-1)', () => {
  const input = { day_of_week: 'FRI', meal_type: 'DINNER' };

  it('powód słowami: dwa największe filtry, porada zależna od tego, czy da się je zmienić', () => {
    expect(
      turnTextFor(
        'suggest_meals',
        input,
        {
          unsatisfiable: true,
          offered: 0,
          removedBy: { REQUIRED_TAG: 30, REQUEST_DIET: 12, ALLERGEN: 2 },
        },
        ON,
      ),
    ).toBe(
      'Nie znalazłem co najmniej dwóch dań na kolację w piątek — najwięcej odpada przez ' +
        'wymagany rodzaj dania i dietę z prośby. ' +
        'Zmień jedno życzenie (składnik, czas, rodzaj dania) albo wybierz inny posiłek.',
    );
    expect(
      turnTextFor(
        'suggest_meals',
        input,
        {
          unsatisfiable: true,
          offered: 0,
          removedBy: { ALLERGEN: 30, DIET: 12 },
        },
        ON,
      ),
    ).toMatch(
      /alergeny domowników i dietę domowników\. To ograniczenia domowników/,
    );
  });

  it('bez liczników (albo same pory) — zdanie ogólne; wyłączona flaga — bez zdania', () => {
    const data = { unsatisfiable: true, offered: 0, removedBy: {} };
    expect(turnTextFor('suggest_meals', input, data, ON)).toBe(
      'Nie znalazłem co najmniej dwóch dań na kolację w piątek, które pasują do Waszych ograniczeń i życzeń. ' +
        'Zmień jedno życzenie albo wybierz inny posiłek.',
    );
    expect(turnTextFor('suggest_meals', input, data, OFF)).toBeNull();
  });
});
