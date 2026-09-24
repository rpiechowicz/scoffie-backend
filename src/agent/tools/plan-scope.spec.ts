import {
  allowedPlanWeeks,
  checkPlanScope,
  createPlanScope,
  MAX_PLANNED_DAYS_PER_TURN,
  recordPlannedDays,
} from './plan-scope';

// 24.09.2026: „zaplanuj cały miesiąc” = cztery propose_week_plan w jednej
// turze. Bramka: najwyżej tydzień na prośbę i tylko bliskie tygodnie.

describe('plan-scope — najwyżej tydzień na prośbę', () => {
  // Czwartek 24.09.2026, użytkownik ogląda bieżący tydzień.
  const dates = { weekStart: '2026-09-21', clientToday: '2026-09-24' };

  const run = (
    scope: ReturnType<typeof createPlanScope>,
    name: string,
    input: Record<string, unknown>,
  ) => {
    const refusal = checkPlanScope(name, input, scope, dates);
    if (!refusal) recordPlannedDays(name, input, scope);
    return refusal;
  };

  it('jeden tydzień przechodzi, drugi tydzień w tej samej turze — nie', () => {
    const scope = createPlanScope();
    expect(
      run(scope, 'propose_week_plan', { week_start: '2026-09-21' }),
    ).toBeNull();

    const second = run(scope, 'propose_week_plan', {
      week_start: '2026-09-28',
    });

    expect(second?.reason).toBe('range');
    expect(second?.message).toContain(`${MAX_PLANNED_DAYS_PER_TURN} dni`);
  });

  it('poprawka tego samego tygodnia nie zjada budżetu', () => {
    const scope = createPlanScope();
    run(scope, 'propose_week_plan', { week_start: '2026-09-21' });

    expect(
      run(scope, 'propose_week_plan', { week_start: '2026-09-21' }),
    ).toBeNull();
    // Dzień z tego samego tygodnia też jest już policzony.
    expect(
      run(scope, 'propose_day_plan', {
        week_start: '2026-09-21',
        day_of_week: 'FRI',
      }),
    ).toBeNull();
  });

  it('siedem dni po jednym (także przez granicę tygodnia) przechodzi, ósmy — nie', () => {
    const scope = createPlanScope();
    const days: Array<[string, string]> = [
      ['2026-09-21', 'THU'],
      ['2026-09-21', 'FRI'],
      ['2026-09-21', 'SAT'],
      ['2026-09-21', 'SUN'],
      ['2026-09-28', 'MON'],
      ['2026-09-28', 'TUE'],
      ['2026-09-28', 'WED'],
    ];
    for (const [week_start, day_of_week] of days) {
      expect(
        run(scope, 'propose_day_plan', { week_start, day_of_week }),
      ).toBeNull();
    }

    expect(
      run(scope, 'propose_day_plan', {
        week_start: '2026-09-28',
        day_of_week: 'THU',
      })?.reason,
    ).toBe('range');
  });

  it('dzień po tygodniu z innego tygodnia przekracza budżet', () => {
    const scope = createPlanScope();
    run(scope, 'propose_week_plan', { week_start: '2026-09-21' });

    expect(
      run(scope, 'propose_day_plan', {
        week_start: '2026-09-28',
        day_of_week: 'MON',
      })?.reason,
    ).toBe('range');
  });

  it('apply_week_plan liczy się tak samo jak propozycja tygodnia', () => {
    const scope = createPlanScope();
    run(scope, 'apply_week_plan', { week_start: '2026-09-21', dry_run: true });

    expect(
      run(scope, 'apply_week_plan', {
        week_start: '2026-09-28',
        dry_run: false,
      })?.reason,
    ).toBe('range');
  });

  it('tydzień za trzy tygodnie jest poza horyzontem', () => {
    const refusal = checkPlanScope(
      'propose_week_plan',
      { week_start: '2026-10-12' },
      createPlanScope(),
      dates,
    );

    expect(refusal?.reason).toBe('horizon');
    expect(refusal?.message).toContain('2026-09-28');
  });

  it('tydzień oglądany w Planie i ten po nim są w horyzoncie', () => {
    const viewing = { weekStart: '2026-10-12', clientToday: '2026-09-24' };

    expect([...allowedPlanWeeks(viewing)].sort()).toEqual([
      '2026-09-21',
      '2026-09-28',
      '2026-10-12',
      '2026-10-19',
    ]);
  });

  it('niedziela należy do tygodnia od poniedziałku, nie do następnego', () => {
    expect(
      [
        ...allowedPlanWeeks({
          weekStart: '2026-09-21',
          clientToday: '2026-09-27',
        }),
      ].sort(),
    ).toEqual(['2026-09-21', '2026-09-28']);
  });

  it('podmiana i usunięcie dania nie są planowaniem — bramka ich nie liczy', () => {
    const scope = createPlanScope();
    run(scope, 'propose_week_plan', { week_start: '2026-09-21' });

    expect(run(scope, 'propose_swap', { week_start: '2026-09-28' })).toBeNull();
    expect(
      run(scope, 'propose_remove_meal', { week_start: '2026-10-26' }),
    ).toBeNull();
  });

  it('zła data nie jest zgadywana — decyduje domena', () => {
    expect(
      checkPlanScope(
        'propose_week_plan',
        { week_start: 'jutro' },
        createPlanScope(),
        dates,
      ),
    ).toBeNull();
  });
});
