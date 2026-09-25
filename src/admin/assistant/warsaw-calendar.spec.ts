import {
  addDays,
  mondayOf,
  warsawDateKey,
  warsawDayStart,
} from './warsaw-calendar';

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
