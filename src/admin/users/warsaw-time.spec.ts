import {
  addCivilDays,
  civilKey,
  warsawDate,
  warsawDayStart,
  warsawDays,
  warsawMidnight,
  warsawMonthDays,
  warsawWeekStart,
} from './warsaw-time';

describe('doba panelu w Europe/Warsaw', () => {
  it('latem północ w Warszawie to 22:00 UTC dnia poprzedniego', () => {
    expect(
      warsawMidnight({ year: 2026, month: 9, day: 24 }).toISOString(),
    ).toBe('2026-09-23T22:00:00.000Z');
  });

  it('zimą północ w Warszawie to 23:00 UTC dnia poprzedniego', () => {
    expect(
      warsawMidnight({ year: 2026, month: 12, day: 1 }).toISOString(),
    ).toBe('2026-11-30T23:00:00.000Z');
  });

  it('doby zmiany czasu mają 23 i 25 godzin, a nie „minus 24 h"', () => {
    const spring = warsawDays(new Date('2026-03-29T12:00:00Z'), 1)[0];
    expect(spring.key).toBe('2026-03-29');
    expect(spring.start.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(spring.end.toISOString()).toBe('2026-03-29T22:00:00.000Z');

    const autumn = warsawDays(new Date('2026-10-25T12:00:00Z'), 1)[0];
    expect(autumn.key).toBe('2026-10-25');
    expect(autumn.start.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(autumn.end.toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('rejestracja o 0:30 czasu polskiego należy już do nowej doby', () => {
    // 22:30 UTC = 0:30 w Warszawie następnego dnia (CEST).
    const instant = new Date('2026-09-23T22:30:00Z');
    expect(civilKey(warsawDate(instant))).toBe('2026-09-24');
    expect(warsawDayStart(instant).toISOString()).toBe(
      '2026-09-23T22:00:00.000Z',
    );
  });

  it('warsawDays: od najstarszej, ostatnia to dziś, doby na styk', () => {
    const days = warsawDays(new Date('2026-09-24T10:00:00Z'), 30);
    expect(days).toHaveLength(30);
    expect(days[29].key).toBe('2026-09-24');
    expect(days[0].key).toBe('2026-08-26');
    for (let i = 1; i < days.length; i += 1) {
      expect(days[i].start.getTime()).toBe(days[i - 1].end.getTime());
    }
  });

  it('miesiąc: od 1. dnia do dziś, w granicach miesiąca warszawskiego', () => {
    // 30.09 23:30 UTC to już 1.10 w Warszawie — miesiąc ma jedną dobę.
    const october = warsawMonthDays(new Date('2026-09-30T23:30:00Z'));
    expect(october.map((day) => day.key)).toEqual(['2026-10-01']);
    const september = warsawMonthDays(new Date('2026-09-24T10:00:00Z'));
    expect(september).toHaveLength(24);
    expect(september[0].key).toBe('2026-09-01');
  });

  it('tydzień: poniedziałek jako północ UTC tej daty (klucz WeeklyPlan)', () => {
    // czwartek
    expect(
      warsawWeekStart(new Date('2026-09-24T10:00:00Z')).toISOString(),
    ).toBe('2026-09-21T00:00:00.000Z');
    // niedziela wieczorem
    expect(
      warsawWeekStart(new Date('2026-09-27T20:00:00Z')).toISOString(),
    ).toBe('2026-09-21T00:00:00.000Z');
    // poniedziałek 0:30 w Warszawie = niedziela 22:30 UTC — już nowy tydzień
    expect(
      warsawWeekStart(new Date('2026-09-27T22:30:00Z')).toISOString(),
    ).toBe('2026-09-28T00:00:00.000Z');
  });

  it('addCivilDays przechodzi przez granice miesięcy i lat', () => {
    expect(civilKey(addCivilDays({ year: 2026, month: 1, day: 1 }, -1))).toBe(
      '2025-12-31',
    );
    expect(civilKey(addCivilDays({ year: 2028, month: 2, day: 28 }, 1))).toBe(
      '2028-02-29',
    );
  });
});
