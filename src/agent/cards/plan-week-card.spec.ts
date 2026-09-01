import { buildPlanWeekCard } from './plan-week-card';
import {
  WeekPlanPreview,
  WeekPlanPreviewSlot,
} from '../../weekly-plans/weekly-plans.service';

// Karta jest jedyną rzeczą, którą użytkownik naprawdę czyta przed kliknięciem
// „Dodaj do planu”. Te testy pilnują trzech rzeczy, których nie widać z kodu:
// kolejności (plan czyta się od poniedziałku rano), arytmetyki dnia i tego,
// że karta mówi wprost, co ZNIKNIE.

const WEEK_START = '2026-04-13'; // poniedziałek
const EXPIRES = new Date('2026-04-16T10:00:00.000Z');

const slot = (over: Partial<WeekPlanPreviewSlot> = {}): WeekPlanPreviewSlot =>
  ({
    dayOfWeek: 'MON',
    mealType: 'LUNCH',
    recipeId: '33333333-3333-4333-8333-333333333333',
    title: 'Kurczak z ryżem',
    kcalPerServing: 600,
    prepTimeMinutes: 30,
    participantIds: [],
    change: 'NEW',
    ...over,
  }) as WeekPlanPreviewSlot;

const preview = (over: Partial<WeekPlanPreview> = {}): WeekPlanPreview => ({
  violations: [],
  changes: { created: 2, updated: 0, deleted: 0 },
  slots: [slot()],
  removed: [],
  ...over,
});

const build = (over: Partial<WeekPlanPreview> = {}, note?: string) =>
  buildPlanWeekCard({
    proposalId: 'prop-1',
    weekStart: WEEK_START,
    preview: preview(over),
    note: note ?? null,
    targetKcalPerDay: 2100,
    expiresAt: EXPIRES,
  });

describe('buildPlanWeekCard', () => {
  it('układa dni od poniedziałku, a posiłki w porządku dnia', () => {
    const card = build({
      slots: [
        slot({ dayOfWeek: 'WED', mealType: 'DINNER', title: 'Zupa' }),
        slot({ dayOfWeek: 'MON', mealType: 'DINNER', title: 'Sałatka' }),
        slot({ dayOfWeek: 'MON', mealType: 'BREAKFAST', title: 'Owsianka' }),
      ],
    });

    expect(card.days.map((day) => day.dayOfWeek)).toEqual(['MON', 'WED']);
    expect(card.days[0].slots.map((s) => s.title)).toEqual([
      'Owsianka',
      'Sałatka',
    ]);
    expect(card.days[0].slots.map((s) => s.mealLabel)).toEqual([
      'Śniadanie',
      'Kolacja',
    ]);
  });

  it('liczy datę dnia z poniedziałku, bo model dat nie liczy', () => {
    const card = build({ slots: [slot({ dayOfWeek: 'WED' })] });
    expect(card.days[0].date).toBe('2026-04-15');
    expect(card.days[0].dayLabel).toBe('Środa');
  });

  it('sumuje dzień i uśrednia tydzień po dniach, które mają cokolwiek', () => {
    const card = build({
      slots: [
        slot({ dayOfWeek: 'MON', mealType: 'LUNCH', kcalPerServing: 600 }),
        slot({ dayOfWeek: 'MON', mealType: 'DINNER', kcalPerServing: 400 }),
        slot({ dayOfWeek: 'TUE', mealType: 'LUNCH', kcalPerServing: 700 }),
      ],
    });

    expect(card.days.map((day) => day.kcalTotal)).toEqual([1000, 700]);
    // Średnia liczy się z DWÓCH dni, nie z siedmiu — pusty czwartek nie
    // rozwadnia liczby, którą użytkownik porównuje z celem.
    expect(card.summary.averageKcalPerDay).toBe(850);
    expect(card.summary.targetKcalPerDay).toBe(2100);
  });

  it('tytuł wymienia posiłki, których propozycja dotyczy', () => {
    const twoMeals = build({
      slots: [
        slot({ mealType: 'LUNCH' }),
        slot({ mealType: 'DINNER', dayOfWeek: 'TUE' }),
      ],
    });
    expect(twoMeals.title).toBe('Obiad i kolacja na tydzień');

    const everything = build({
      slots: [
        slot({ mealType: 'BREAKFAST' }),
        slot({ mealType: 'SECOND_BREAKFAST' }),
        slot({ mealType: 'LUNCH' }),
        slot({ mealType: 'DINNER' }),
      ],
    });
    expect(everything.title).toBe('Plan na tydzień');
  });

  it('mówi wprost, co zniknie — zmiana planu nie jest cicha', () => {
    const card = build({
      removed: [
        {
          dayOfWeek: 'FRI',
          mealType: 'DINNER',
          recipeId: 'r-1',
          title: 'Pierogi',
        },
      ],
    });

    expect(card.removed).toEqual([
      { dayLabel: 'Piątek', mealLabel: 'Kolacja', title: 'Pierogi' },
    ]);
  });

  it('daje jeden przycisk zatwierdzenia i termin ważności', () => {
    const card = build();

    expect(card.kind).toBe('PLAN_WEEK');
    expect(card.actions).toEqual([
      {
        type: 'APPLY',
        proposalId: 'prop-1',
        label: 'Dodaj do planu',
        style: 'PRIMARY',
      },
    ]);
    expect(card.state).toEqual({
      status: 'PENDING',
      canApply: true,
      canUndo: false,
      until: EXPIRES.toISOString(),
    });
  });

  it('podtytuł bierze zdanie modelu, ale puste zostaje puste', () => {
    expect(build({}, '  Nic się nie powtarza dwa dni z rzędu.  ').subtitle).toBe(
      'Nic się nie powtarza dwa dni z rzędu.',
    );
    expect(build({}, '   ').subtitle).toBeNull();
  });
});
