import {
  summarizeCookFeedback,
  timerNamesOf,
  type CookFeedbackRow,
} from './admin-cook-feedback.service';
import { parseExtensions } from '../../recipes/cook-scenario/cook-feedback.service';

const SINCE = new Date('2026-10-01T00:00:00.000Z');
const R1 = 'recipe-1';
const R2 = 'recipe-2';

const row = (patch: Partial<CookFeedbackRow>): CookFeedbackRow => ({
  recipeId: R1,
  scenarioVersion: 3,
  rating: 'UP',
  tags: [],
  comment: null,
  extensions: {},
  updatedAt: new Date('2026-10-02T12:00:00.000Z'),
  ...patch,
});

describe('summarizeCookFeedback', () => {
  const titles = new Map([
    [R1, 'Kotlet de volaille'],
    [R2, 'Zupa krem'],
  ]);
  const names = new Map([
    [
      `${R1}@3`,
      new Map([['t-kotlety', { label: 'Kotlety', stepTitle: 'Smaż kotlety' }]]),
    ],
  ]);

  it('sumy, dni, powody; „+min” liczy sesje i średnią na sesję', () => {
    const summary = summarizeCookFeedback(
      [
        row({
          rating: 'DOWN',
          tags: ['Za długo'],
          extensions: { 't-kotlety': 120 },
        }),
        row({
          rating: 'DOWN',
          comment: 'za krótko',
          extensions: { 't-kotlety': 240 },
        }),
        row({ recipeId: R2, updatedAt: new Date('2026-10-03T08:00:00.000Z') }),
      ],
      SINCE,
      3,
      titles,
      names,
    );

    expect(summary.totals).toEqual({
      up: 1,
      down: 2,
      withNote: 2,
      withExtensions: 2,
    });
    expect(summary.daily).toEqual([
      { date: '2026-10-01', up: 0, down: 0 },
      { date: '2026-10-02', up: 0, down: 2 },
      { date: '2026-10-03', up: 1, down: 0 },
    ]);
    expect(summary.byTag).toEqual([{ tag: 'Za długo', count: 1 }]);
    expect(summary.byRecipe[0]).toEqual({
      recipeId: R1,
      recipeTitle: 'Kotlet de volaille',
      up: 0,
      down: 2,
      withExtensions: 2,
    });
    expect(summary.timers).toEqual([
      {
        recipeId: R1,
        recipeTitle: 'Kotlet de volaille',
        scenarioVersion: 3,
        timerId: 't-kotlety',
        timerLabel: 'Kotlety',
        stepTitle: 'Smaż kotlety',
        sessions: 2,
        averageSeconds: 180,
      },
    ]);
  });

  it('inna wersja scenariusza = osobny timer, bez nazwy, gdy treści nie ma', () => {
    const summary = summarizeCookFeedback(
      [row({ scenarioVersion: 4, extensions: { 't-kotlety': 60 } })],
      SINCE,
      1,
      titles,
      names,
    );
    expect(summary.timers[0]).toMatchObject({
      scenarioVersion: 4,
      timerLabel: null,
      stepTitle: null,
    });
  });
});

describe('timerNamesOf', () => {
  it('bierze timery kroków, pomija kroki bez timera i śmieci', () => {
    const names = timerNamesOf({
      steps: [
        { title: 'Nastaw wodę', timer: null },
        {
          title: 'Gotuj ziemniaki',
          timer: { id: 't-ziemniaki', label: 'Ziemniaki' },
        },
        'zepsuty krok',
        { title: 'Bez id', timer: { label: 'X' } },
      ],
    });
    expect([...names.entries()]).toEqual([
      ['t-ziemniaki', { label: 'Ziemniaki', stepTitle: 'Gotuj ziemniaki' }],
    ]);
    expect(timerNamesOf(null).size).toBe(0);
  });
});

describe('parseExtensions', () => {
  it('zera wypadają, reszta zostaje', () => {
    expect(parseExtensions({ a: 0, b: 120 })).toEqual({ b: 120 });
  });

  it.each([
    ['tablica', [1]],
    ['ułamek', { a: 1.5 }],
    ['ujemne', { a: -1 }],
    ['ponad 2 h', { a: 7201 }],
    ['tekst', { a: '60' }],
    ['pusty klucz', { '': 60 }],
  ])('%s — VALIDATION_ERROR', (_name, value) => {
    expect(() => parseExtensions(value)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }) as Error,
    );
  });

  it('za dużo timerów — VALIDATION_ERROR', () => {
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`t${i}`, 60]),
    );
    expect(() => parseExtensions(many)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }) as Error,
    );
  });
});
