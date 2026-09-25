import {
  addCivilDays,
  addDays,
  civilKey,
  fromWarsawWallClock,
  mondayOf,
  oneMonthEarlier,
  warsawDate,
  warsawDateKey,
  warsawDayStart,
  warsawDays,
  warsawMidnight,
  warsawMonthDays,
  warsawMonthStart,
  warsawTodayStart,
  warsawWallClock,
  warsawWeekStart,
} from './warsaw-calendar';

/**
 * Przypadki z trzech dawnych kopii kalendarza (pulpit `users/warsaw-time`,
 * asystent `assistant/warsaw-calendar`, subskrypcje `subscription-metrics`)
 * — wszystkie zostały, bo każda kopia pilnowała innej ścieżki.
 */

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
    expect(warsawTodayStart(instant).toISOString()).toBe(
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

describe('kalendarz panelu (Europe/Warsaw)', () => {
  it('dzień to polski dzień, nie dzień w UTC', () => {
    // 23:30 czasu letniego to jeszcze ten sam dzień w Polsce, a w UTC — nie.
    expect(warsawDateKey(new Date('2026-09-23T21:59:59Z'))).toBe('2026-09-23');
    expect(warsawDateKey(new Date('2026-09-23T22:00:00Z'))).toBe('2026-09-24');
    // Zimą przesunięcie jest godzinne.
    expect(warsawDateKey(new Date('2026-01-14T22:59:59Z'))).toBe('2026-01-14');
    expect(warsawDateKey(new Date('2026-01-14T23:00:00Z'))).toBe('2026-01-15');
  });

  it('początek dnia to północ w Polsce jako chwila UTC — latem i zimą', () => {
    expect(warsawDayStart('2026-09-24').toISOString()).toBe(
      '2026-09-23T22:00:00.000Z',
    );
    expect(warsawDayStart('2026-01-15').toISOString()).toBe(
      '2026-01-14T23:00:00.000Z',
    );
  });

  it('dni zmiany czasu zaczynają się o właściwej północy', () => {
    // 29.03.2026 zegarki idą do przodu o 2:00 — północ jest jeszcze zimowa.
    expect(warsawDayStart('2026-03-29').toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    );
    expect(warsawDayStart('2026-03-30').toISOString()).toBe(
      '2026-03-29T22:00:00.000Z',
    );
    // 25.10.2026 cofają się o 3:00 — północ jest jeszcze letnia.
    expect(warsawDayStart('2026-10-25').toISOString()).toBe(
      '2026-10-24T22:00:00.000Z',
    );
    expect(warsawDayStart('2026-10-26').toISOString()).toBe(
      '2026-10-25T23:00:00.000Z',
    );
  });

  it('dodawanie dni przechodzi przez granice miesięcy i lat', () => {
    expect(addDays('2026-09-24', -24)).toBe('2026-08-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('poniedziałek tygodnia w postaci `WeeklyPlan.weekStart`', () => {
    const monday = '2026-09-21T00:00:00.000Z';
    expect(mondayOf('2026-09-21').toISOString()).toBe(monday);
    expect(mondayOf('2026-09-24').toISOString()).toBe(monday);
    expect(mondayOf('2026-09-27').toISOString()).toBe(monday); // niedziela
    expect(mondayOf('2026-09-28').toISOString()).toBe(
      '2026-09-28T00:00:00.000Z',
    );
  });
});

describe('miesiące i zegar ścienny (ekran Subskrypcje)', () => {
  const NOW = new Date('2026-09-24T12:00:00.000Z');

  it('początek miesiąca: czas letni i zimowy', () => {
    expect(warsawMonthStart(2026, 8).toISOString()).toBe(
      '2026-08-31T22:00:00.000Z',
    );
    expect(warsawMonthStart(2026, 0).toISOString()).toBe(
      '2025-12-31T23:00:00.000Z',
    );
    // Miesiąc 12 przechodzi na następny rok, jak w `Date.UTC`.
    expect(warsawMonthStart(2026, 12).toISOString()).toBe(
      '2026-12-31T23:00:00.000Z',
    );
  });

  it('zegar ścienny i droga powrotna', () => {
    const wall = warsawWallClock(new Date('2026-03-29T01:30:00.000Z'));
    expect([wall.day, wall.hour, wall.minute]).toEqual([29, 3, 30]);
    expect(fromWarsawWallClock(2026, 2, 29, 3, 30).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });

  it('ten sam dzień miesiąc temu — także przez zmianę czasu i koniec lutego', () => {
    expect(oneMonthEarlier(NOW).toISOString()).toBe('2026-08-24T12:00:00.000Z');
    // 12:00 CEST 15 kwietnia → 12:00 CET 15 marca.
    expect(
      oneMonthEarlier(new Date('2026-04-15T10:00:00.000Z')).toISOString(),
    ).toBe('2026-03-15T11:00:00.000Z');
    expect(
      oneMonthEarlier(new Date('2026-03-31T10:00:00.000Z')).toISOString(),
    ).toBe('2026-02-28T11:00:00.000Z');
  });
});
