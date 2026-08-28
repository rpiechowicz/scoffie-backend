import { AppException } from '../../common/app-exception';
import { formatWeekStart, parseWeekStart } from './week-formatting.util';

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
