import { buildPlanDayCard } from './plan-day-card';
import { buildClarifyCard } from './clarify-card';
import { goalNote, shortDateLabel, weekRangeLabel } from './agent-cards';

// Karta dnia i pytanie to dwie rzeczy, które użytkownik czyta ZANIM czegokolwiek
// dotknie. Obie muszą dać się sprawdzić bez bazy, dostawcy i tury.

const slot = (over: Record<string, unknown> = {}) => ({
  dayOfWeek: 'TUE',
  mealType: 'LUNCH',
  recipeId: 'r-1',
  title: 'Kurczak z ryżem',
  kcalPerServing: 620,
  prepTimeMinutes: 35,
  participantIds: [],
  change: 'NEW',
  ...over,
});

const preview = (over: Record<string, unknown> = {}) =>
  ({
    violations: [],
    changes: { created: 2, updated: 0, deleted: 1 },
    slots: [
      slot(),
      slot({ mealType: 'BREAKFAST', recipeId: 'r-2', title: 'Owsianka', kcalPerServing: 447, prepTimeMinutes: 12 }),
      // Inny dzień — karta dnia nie ma prawa go pokazać.
      slot({ dayOfWeek: 'WED', recipeId: 'r-3', title: 'Gulasz' }),
    ],
    removed: [
      { dayOfWeek: 'TUE', mealType: 'DINNER', title: 'Zupa pomidorowa' },
      { dayOfWeek: 'SAT', mealType: 'DINNER', title: 'Pierogi' },
    ],
    ...over,
  }) as never;

const build = (over: Record<string, unknown> = {}) =>
  buildPlanDayCard({
    proposalId: 'p-1',
    weekStart: '2026-08-31',
    dayOfWeek: 'TUE',
    date: '2026-09-01',
    preview: preview(),
    targetKcalPerDay: 2100,
    expiresAt: new Date('2026-09-03T10:00:00.000Z'),
    ...over,
  } as never);

describe('buildPlanDayCard', () => {
  it('pokazuje WYŁĄCZNIE ten dzień, w porządku dnia', () => {
    const card = build();
    expect(card.slots.map((s) => s.title)).toEqual([
      'Owsianka',
      'Kurczak z ryżem',
    ]);
    // Propozycja dnia nie rusza reszty tygodnia, więc cudze usunięcia
    // w karcie dnia byłyby wprowadzaniem w błąd.
    expect(card.removed.map((r) => r.title)).toEqual(['Zupa pomidorowa']);
  });

  it('liczy sumę dnia i mówi, ile jeszcze wchodzi w cel', () => {
    const card = build();
    expect(card.summary.kcalTotal).toBe(1067);
    expect(card.summary.goalNote).toBe('zostaje 1033');
    expect(card.title).toBe('Cały dzień pod cel 2100 kcal');
  });

  it('bez celu nie wymyśla normy', () => {
    const card = build({ targetKcalPerDay: null });
    expect(card.summary.goalNote).toBeNull();
    expect(card.title).toBe('Cały dzień, 1067 kcal');
  });

  it('przekroczony cel mówi to wprost, a nie „zostaje −200”', () => {
    const card = build({ targetKcalPerDay: 900 });
    expect(card.summary.goalNote).toBe('167 kcal ponad cel');
  });

  it('przycisk nazywa dzień, który zapisuje', () => {
    const card = build();
    expect(card.actions).toEqual([
      {
        type: 'APPLY',
        proposalId: 'p-1',
        label: 'Zapisz wtorek',
        style: 'PRIMARY',
      },
    ]);
    expect(card.eyebrow).toBe('Propozycja · wtorek 1 września');
    expect(card.state).toMatchObject({ status: 'PENDING', canApply: true });
  });
});

describe('buildClarifyCard', () => {
  it('robi z odpowiedzi zwykłe wiadomości, nie osobny protokół', () => {
    const card = buildClarifyCard({
      question: 'Dla ilu osób mam planować?',
      hint: 'W profilu są cztery, ale wspominałeś o weekendzie we dwoje.',
      options: ['Dla czterech', 'Dla dwóch'],
    });

    expect(card.kind).toBe('CLARIFY');
    expect(card.actions).toEqual([
      { type: 'ASK', proposalId: null, label: 'Dla czterech', style: 'PRIMARY', prompt: 'Dla czterech' },
      { type: 'ASK', proposalId: null, label: 'Dla dwóch', style: 'SECONDARY', prompt: 'Dla dwóch' },
    ]);
  });

  it('przycina do czterech odpowiedzi i wyrzuca puste', () => {
    const card = buildClarifyCard({
      question: 'Co wolisz?',
      options: ['A', '  ', 'B', 'C', 'D', 'E'],
    });
    expect(card.actions.map((a) => a.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(card.hint).toBeNull();
  });
});

describe('etykiety dat', () => {
  it('zakres w jednym miesiącu nie powtarza nazwy miesiąca', () => {
    expect(weekRangeLabel('2026-08-31')).toBe('31 sierpnia – 6 września');
    expect(weekRangeLabel('2026-09-07')).toBe('7–13 września');
  });

  it('krótka data ma dzień bez zera i miesiąc z zerem', () => {
    expect(shortDateLabel('2026-09-01')).toBe('1.09');
    expect(shortDateLabel('2026-12-24')).toBe('24.12');
  });

  it('drobne odchylenie od celu to szum, nie informacja', () => {
    expect(goalNote(2060, 2100)).toBe('w celu');
    expect(goalNote(1800, 2100)).toBe('300 kcal poniżej celu');
    expect(goalNote(2400, 2100)).toBe('300 kcal ponad cel');
    expect(goalNote(2400, null)).toBeNull();
  });
});
