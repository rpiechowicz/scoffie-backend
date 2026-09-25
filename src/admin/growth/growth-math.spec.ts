import {
  cohortMatrix,
  cohortWeekKeys,
  funnelSteps,
  median,
  type FunnelRow,
} from './growth-math';

const T0 = new Date('2026-09-01T10:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

const row = (steps: Partial<Omit<FunnelRow, 'registered'>>): FunnelRow => ({
  registered: T0,
  onboarded: null,
  household: null,
  plan: null,
  aiConsent: null,
  firstTurn: null,
  purchase: null,
  ...steps,
});

describe('median', () => {
  it('nieparzysta, parzysta i pusta lista', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('funnelSteps', () => {
  it('pusta kohorta: zera, bez dzielenia przez zero, mediany null', () => {
    const steps = funnelSteps([]);
    expect(steps).toHaveLength(7);
    for (const step of steps) {
      expect(step).toMatchObject({
        users: 0,
        pctOfStart: 0,
        pctOfPrevious: 0,
        medianSecondsToStep: null,
      });
    }
  });

  it('lejek sekwencyjny: krok liczy tylko tych, co przeszli wszystkie poprzednie', () => {
    const steps = funnelSteps([
      row({ onboarded: at(1), household: at(2), plan: at(3) }),
      row({ onboarded: at(2), household: at(4) }),
      row({ onboarded: at(3) }),
      // zakup bez kreatora — nie wchodzi nigdzie dalej niż rejestracja
      row({ purchase: at(1) }),
    ]);
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));

    expect(steps.map((s) => s.users)).toEqual([4, 3, 2, 1, 0, 0, 0]);
    expect(byKey.registered).toMatchObject({
      pctOfStart: 100,
      pctOfPrevious: 100,
      medianSecondsToStep: 0,
    });
    expect(byKey.onboarded).toMatchObject({
      pctOfStart: 75,
      pctOfPrevious: 75,
      medianSecondsToStep: 2 * 3600,
    });
    expect(byKey.household).toMatchObject({
      pctOfStart: 50,
      pctOfPrevious: 66.7,
      medianSecondsToStep: 3 * 3600,
    });
    expect(byKey.plan).toMatchObject({
      pctOfStart: 25,
      pctOfPrevious: 50,
      medianSecondsToStep: 3 * 3600,
    });
    expect(byKey.aiConsent).toMatchObject({
      users: 0,
      pctOfPrevious: 0,
      medianSecondsToStep: null,
    });
  });

  it('zdarzenie sprzed rejestracji (subskrypcja z poprzedniego konta) liczy się jako 0 s', () => {
    const steps = funnelSteps([
      row({
        onboarded: at(1),
        household: at(1),
        plan: at(1),
        aiConsent: at(1),
        firstTurn: at(1),
        purchase: at(-48),
      }),
    ]);
    expect(steps[6]).toMatchObject({
      key: 'purchase',
      users: 1,
      pctOfStart: 100,
      medianSecondsToStep: 0,
    });
  });
});

describe('cohortWeekKeys', () => {
  it('12 poniedziałków do bieżącego włącznie, od najstarszego', () => {
    const keys = cohortWeekKeys('2026-09-21');
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe('2026-07-06');
    expect(keys[11]).toBe('2026-09-21');
  });
});

describe('cohortMatrix', () => {
  const weeks = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];

  it('procent aktywnych, przyszłe tygodnie i tygodnie sprzed zbierania puste', () => {
    const cohorts = cohortMatrix(
      weeks,
      [
        { week: '2026-08-31', offset: null, users: 4 },
        { week: '2026-08-31', offset: 0, users: 4 },
        { week: '2026-08-31', offset: 1, users: 3 },
        { week: '2026-08-31', offset: 2, users: 1 },
        { week: '2026-09-14', offset: null, users: 3 },
        { week: '2026-09-14', offset: 0, users: 3 },
        { week: '2026-09-14', offset: 1, users: 1 },
      ],
      '2026-09-25',
      // zbieramy od środy 9.09 — tydzień 31.08+1 (7–13.09) częściowo, liczy się
      '2026-09-09',
    );

    expect(cohorts.map((c) => c.users)).toEqual([4, 0, 3, 0]);
    // 31.08: tydz. 0 z backfillu, tydz. 1 (7.09) i 2 (14.09) po starcie, 3 (21.09) trwa
    expect(cohorts[0].weeks.slice(0, 5)).toEqual([100, 75, 25, 0, null]);
    expect(cohorts[0].weeks).toHaveLength(9);
    // pusta kohorta — same puste komórki
    expect(cohorts[1].weeks.every((w) => w === null)).toBe(true);
    // 14.09: tydz. 0 i 1 (21.09, trwa), dalej przyszłość
    expect(cohorts[2].weeks.slice(0, 3)).toEqual([100, 33.3, null]);
    // weekStart = północ poniedziałku w Warszawie
    expect(cohorts[0].weekStart).toBe('2026-08-30T22:00:00.000Z');
  });

  it('tydzień, który skończył się przed początkiem zbierania, jest pusty (nie 0 %)', () => {
    const [cohort] = cohortMatrix(
      ['2026-08-31'],
      [
        { week: '2026-08-31', offset: null, users: 2 },
        { week: '2026-08-31', offset: 0, users: 2 },
      ],
      '2026-09-25',
      '2026-09-14',
    );
    // 7–13.09 cały przed 14.09 → null; 14.09 i 21.09 → liczone
    expect(cohort.weeks.slice(0, 4)).toEqual([100, null, 0, 0]);
  });
});
