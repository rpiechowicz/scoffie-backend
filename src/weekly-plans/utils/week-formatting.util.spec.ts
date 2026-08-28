import { AppException } from '../../common/app-exception';
import {
  currentWeekStart,
  formatWeekStart,
  parseWeekStart,
} from './week-formatting.util';

describe('parseWeekStart', () => {
  it('powinno przyjąć poniedziałek w formacie YYYY-MM-DD jako północ UTC', () => {
    expect(parseWeekStart('2026-08-31').toISOString()).toBe(
      '2026-08-31T00:00:00.000Z',
    );
    expect(parseWeekStart('2026-04-13').getUTCDay()).toBe(1);
  });

  it.each([
    ['niedziela', '2026-08-30'],
    ['wtorek', '2026-09-01'],
    ['data z godziną i strefą', '2026-08-31T00:00:00+02:00'],
    ['pełny ISO', '2026-08-31T00:00:00.000Z'],
    ['nieistniejący dzień', '2026-02-30'],
    ['śmieci', 'abc'],
    ['pusty', ''],
  ])('powinno odrzucić %s (%s) jako VALIDATION_ERROR', (_label, value) => {
    expect(() => parseWeekStart(value)).toThrow(AppException);
    try {
      parseWeekStart(value);
    } catch (error) {
      expect((error as AppException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
  });

  it('powinno wracać do tego samego klucza po formatWeekStart', () => {
    for (const key of ['2026-08-31', '2026-01-05', '2026-12-28']) {
      expect(formatWeekStart(parseWeekStart(key))).toBe(key);
    }
  });
});

describe('currentWeekStart', () => {
  it.each([
    ['poniedziałek północ', '2026-08-24T00:00:00.000Z', '2026-08-24'],
    ['czwartek popołudnie', '2026-08-27T15:30:00.000Z', '2026-08-24'],
    ['niedziela 23:59', '2026-08-30T23:59:59.999Z', '2026-08-24'],
    [
      'poniedziałek 00:00 następnego tygodnia',
      '2026-08-31T00:00:00.000Z',
      '2026-08-31',
    ],
    ['przełom roku', '2027-01-01T12:00:00.000Z', '2026-12-28'],
  ])('%s -> %s', (_label, iso, expected) => {
    expect(formatWeekStart(currentWeekStart(new Date(iso)))).toBe(expected);
  });

  it('zwraca datę, którą parseWeekStart uzna za poprawną', () => {
    const monday = currentWeekStart(new Date('2026-08-27T10:00:00.000Z'));
    expect(monday.getUTCDay()).toBe(1);
    expect(parseWeekStart(formatWeekStart(monday)).getTime()).toBe(
      monday.getTime(),
    );
  });
});
