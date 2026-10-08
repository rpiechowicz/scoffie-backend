import { redactOthersFromCard } from './user-export';

// Kształty kart przepisane lokalnie: `src/agent/` jest modułem
// jednokierunkowym (eslint `no-restricted-imports`), a eksport czyta karty
// jako `unknown` z bazy — test pilnuje kształtu, który zapisuje asystent
// (`PlanWeekCard`, `PlanDayCard`, `HouseholdSplitCard` w agent-cards.ts).
type PlanWeekCardSlot = {
  mealType: string;
  mealLabel: string;
  recipeId: string;
  title: string;
  kcalPerServing: number;
  prepTimeMinutes: number;
  imageUrl: string | null;
  participantIds: string[];
  portions?: { userId: string; servings: number }[];
  change: 'NEW' | 'KEPT';
};
type PlanWeekCard = {
  kind: 'PLAN_WEEK';
  days: ({ dayLabel: string; slots: PlanWeekCardSlot[] } & Record<
    string,
    unknown
  >)[];
  summary: Record<string, unknown>;
} & Record<string, unknown>;
type PlanDayCard = { kind: 'PLAN_DAY'; slots: PlanWeekCardSlot[] } & Record<
  string,
  unknown
>;
type HouseholdSplitCard = {
  kind: 'HOUSEHOLD_SPLIT';
  portions: ({ userId: string } & Record<string, unknown>)[];
} & Record<string, unknown>;

// Art. 15 ust. 4 RODO: paczka jednej osoby nie oddaje danych innych
// domowników. Audyt 5.09.2026, 2.3.7 — karty planu niosły id i porcje
// wszystkich uczestników każdego dania.
const ME = '11111111-1111-4111-8111-111111111111';
const ANIA = '22222222-2222-4222-8222-222222222222';
const MAREK = '33333333-3333-4333-8333-333333333333';

const slot = (overrides: Partial<PlanWeekCardSlot>): PlanWeekCardSlot => ({
  mealType: 'DINNER',
  mealLabel: 'Obiad',
  recipeId: '44444444-4444-4444-8444-444444444444',
  title: 'Leczo',
  kcalPerServing: 520,
  prepTimeMinutes: 30,
  imageUrl: null,
  participantIds: [],
  change: 'NEW',
  ...overrides,
});

const slots = (): PlanWeekCardSlot[] => [
  // Wspólne z porcjami trzech osób.
  slot({
    participantIds: [ME, ANIA, MAREK],
    portions: [
      { userId: ME, servings: 1 },
      { userId: ANIA, servings: 1.5 },
      { userId: MAREK, servings: 2 },
    ],
  }),
  // Tylko Ania i Marek — mnie przy tym daniu nie ma.
  slot({
    mealType: 'SUPPER',
    participantIds: [ANIA, MAREK],
    portions: [
      { userId: ANIA, servings: 1 },
      { userId: MAREK, servings: 1 },
    ],
  }),
  // Całe gospodarstwo, bez alokacji (pole opcjonalne).
  slot({ mealType: 'BREAKFAST', participantIds: [] }),
];

const state = {
  status: 'APPLIED' as const,
  canApply: false,
  canUndo: false,
  until: null,
};

const weekCard = (): PlanWeekCard => ({
  kind: 'PLAN_WEEK',
  v: 2,
  proposalId: '55555555-5555-4555-8555-555555555555',
  weekStart: '2026-10-05',
  eyebrow: 'Propozycja planu',
  eyebrowDetail: null,
  title: 'Tydzień',
  subtitle: null,
  days: [
    {
      dayOfWeek: 'MONDAY',
      dayLabel: 'Poniedziałek',
      dayShort: 'Pon',
      date: '2026-10-05',
      dateLabel: '5.10',
      slots: slots(),
      kcalTotal: 1500,
    },
  ],
  removed: [],
  summary: {
    meals: 3,
    created: 3,
    updated: 0,
    removed: 0,
    averageKcalPerDay: 1500,
    targetKcalPerDay: null,
    goalNote: null,
  },
  actions: [],
  state,
});

const dayCard = (): PlanDayCard => ({
  kind: 'PLAN_DAY',
  v: 1,
  proposalId: '66666666-6666-4666-8666-666666666666',
  weekStart: '2026-10-05',
  date: '2026-10-05',
  eyebrow: 'Propozycja dnia',
  eyebrowDetail: null,
  title: 'Poniedziałek',
  subtitle: null,
  slots: slots(),
  removed: [],
  summary: {
    meals: 3,
    kcalTotal: 1500,
    targetKcalPerDay: null,
    goalNote: null,
  },
  actions: [],
  state,
});

const expectedSlots = [
  expect.objectContaining({
    mealType: 'DINNER',
    participantIds: [ME],
    otherParticipants: 2,
    portions: [{ userId: ME, servings: 1 }],
  }),
  expect.objectContaining({
    mealType: 'SUPPER',
    participantIds: [],
    otherParticipants: 2,
    portions: [],
  }),
  slot({ mealType: 'BREAKFAST', participantIds: [] }),
];

describe('redactOthersFromCard', () => {
  it('PLAN_WEEK: w każdym daniu tylko własne id i porcja, inni jako liczba', () => {
    const out = redactOthersFromCard(weekCard(), ME) as PlanWeekCard & {
      participantsRedacted: boolean;
    };
    expect(out.participantsRedacted).toBe(true);
    expect(out.days[0].slots).toEqual(expectedSlots);
    expect(JSON.stringify(out)).not.toContain(ANIA);
    expect(JSON.stringify(out)).not.toContain(MAREK);
    // Reszta karty bez zmian.
    expect(out.summary).toEqual(weekCard().summary);
    expect(out.days[0].dayLabel).toBe('Poniedziałek');
  });

  it('PLAN_DAY: te same reguły na `slots`', () => {
    const out = redactOthersFromCard(dayCard(), ME) as PlanDayCard & {
      participantsRedacted: boolean;
    };
    expect(out.participantsRedacted).toBe(true);
    expect(out.slots).toEqual(expectedSlots);
    expect(JSON.stringify(out)).not.toContain(ANIA);
    expect(JSON.stringify(out)).not.toContain(MAREK);
  });

  it('danie całego gospodarstwa nie dostaje licznika — pusta lista zostaje pusta', () => {
    const out = redactOthersFromCard(dayCard(), ME) as PlanDayCard;
    expect(out.slots[2]).not.toHaveProperty('otherParticipants');
    expect(out.slots[2].participantIds).toEqual([]);
  });

  it('nie zmienia karty wejściowej', () => {
    const card = weekCard();
    redactOthersFromCard(card, ME);
    expect(card).toEqual(weekCard());
  });

  it('HOUSEHOLD_SPLIT: zostaje tylko własny wiersz (jak dotąd)', () => {
    const card: HouseholdSplitCard = {
      kind: 'HOUSEHOLD_SPLIT',
      v: 1,
      proposalId: '77777777-7777-4777-8777-777777777777',
      weekStart: '2026-10-05',
      date: '2026-10-05',
      eyebrow: 'Jedno danie',
      title: 'Leczo',
      prepTimeMinutes: 30,
      portions: [
        {
          userId: ME,
          displayName: 'Ja',
          goalLabel: '2 000 kcal',
          note: null,
          kcal: 600,
        },
        {
          userId: ANIA,
          displayName: 'Ania',
          goalLabel: '1 600 kcal · bez laktozy',
          note: null,
          kcal: 450,
        },
      ],
      actions: [],
      state,
    };
    const out = redactOthersFromCard(card, ME) as HouseholdSplitCard & {
      portionsRedacted: boolean;
    };
    expect(out.portionsRedacted).toBe(true);
    expect(out.portions.map((p) => p.userId)).toEqual([ME]);
  });

  it.each([null, undefined, 'tekst', 42, []])(
    'wartość, która nie jest kartą (%p), wraca bez zmian',
    (value) => {
      expect(redactOthersFromCard(value, ME)).toBe(value);
    },
  );

  it('karta bez danych o osobach wraca ta sama', () => {
    const card = { kind: 'CLARIFY', question: 'Na ile osób?' };
    expect(redactOthersFromCard(card, ME)).toBe(card);
  });
});
