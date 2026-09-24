import {
  cookidooStatus,
  latest,
  orderMealTypes,
  parseMealSlotTimes,
} from './household-view';

describe('widok gospodarstwa', () => {
  describe('parseMealSlotTimes', () => {
    it('przepuszcza pory z enuma z całą minutą doby', () => {
      expect(parseMealSlotTimes({ BREAKFAST: 480, DINNER: 1140 })).toEqual({
        BREAKFAST: 480,
        DINNER: 1140,
      });
    });

    it('odrzuca śmieci po cichu, zamiast wywracać kartę domu', () => {
      expect(
        parseMealSlotTimes({
          BREAKFAST: '8:00',
          LUNCH: 1440,
          DINNER: -1,
          SNACKS: 600,
          SNACK: 30.5,
          AFTERNOON_SNACK: 990,
        }),
      ).toEqual({ AFTERNOON_SNACK: 990 });
    });

    it('null i nie-obiekt to null; pusta mapa zostaje pustą mapą', () => {
      expect(parseMealSlotTimes(null)).toBeNull();
      expect(parseMealSlotTimes([480])).toBeNull();
      expect(parseMealSlotTimes('480')).toBeNull();
      expect(parseMealSlotTimes({})).toEqual({});
    });
  });

  it('pory idą w kolejności dnia, bez duplikatów', () => {
    expect(
      orderMealTypes(['DINNER', 'SNACK', 'BREAKFAST', 'LUNCH', 'DINNER']),
    ).toEqual(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']);
  });

  it('Cookidoo: wszystko poza CONNECTED to niedziałające połączenie', () => {
    expect(cookidooStatus('CONNECTED')).toBe('CONNECTED');
    expect(cookidooStatus('AUTH_FAILED')).toBe('AUTH_FAILED');
    expect(cookidooStatus('COŚ_NOWEGO')).toBe('AUTH_FAILED');
    expect(cookidooStatus(null)).toBeNull();
    expect(cookidooStatus(undefined)).toBeNull();
  });

  it('najpóźniejsza data pomija puste', () => {
    const a = new Date('2026-09-01T00:00:00.000Z');
    const b = new Date('2026-09-20T00:00:00.000Z');
    expect(latest([a, null, b])).toBe(b);
    expect(latest([null, null])).toBeNull();
    expect(latest([])).toBeNull();
  });
});
