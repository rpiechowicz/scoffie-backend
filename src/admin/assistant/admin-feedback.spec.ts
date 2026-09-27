import { summarize } from './admin-feedback.service';

const row = (over: Partial<Parameters<typeof summarize>[0][number]> = {}) => ({
  rating: 'UP',
  tags: [] as string[],
  comment: null as string | null,
  messageKind: 'TEXT',
  updatedAt: new Date('2026-09-26T10:00:00.000Z'),
  ...over,
});

describe('summarize (dział „Oceny”)', () => {
  const since = new Date('2026-09-25T00:00:00.000Z');

  it('liczy sumy, dni z zerami i podpowiedzi tylko przy kciuku w dół', () => {
    const result = summarize(
      [
        row(),
        row({ rating: 'DOWN', tags: ['TOO_LONG'], messageKind: 'PLAN_DAY' }),
        row({
          rating: 'DOWN',
          comment: 'Krócej',
          updatedAt: new Date('2026-09-27T23:59:00.000Z'),
        }),
        // Pochwała z „co było dobre” też jest podpowiedzią.
        row({ tags: ['CONCISE'] }),
      ],
      since,
      3,
    );

    expect(result.totals).toEqual({ up: 2, down: 2, withNote: 3 });
    expect(result.daily).toEqual([
      { date: '2026-09-25', up: 0, down: 0 },
      { date: '2026-09-26', up: 2, down: 1 },
      { date: '2026-09-27', up: 0, down: 1 },
    ]);
    expect(result.byKind).toEqual([
      { kind: 'TEXT', up: 2, down: 1 },
      { kind: 'PLAN_DAY', up: 0, down: 1 },
    ]);
    expect(result.byTag).toEqual([
      { tag: 'CONCISE', count: 1 },
      { tag: 'TOO_LONG', count: 1 },
    ]);
  });

  it('powód spoza kontraktu wypada, a nie psuje rozkładu', () => {
    const result = summarize(
      [row({ rating: 'DOWN', tags: ['UNSAFE', 'BAD_DISHES'] })],
      since,
      3,
    );
    expect(result.byTag).toEqual([{ tag: 'BAD_DISHES', count: 1 }]);
  });
});
