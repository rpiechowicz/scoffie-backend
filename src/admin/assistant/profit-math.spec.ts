import { netRevenuePln } from '../../config/ai-unit-economics';
import {
  dailyNetRevenuePln,
  DAYS_PER_MONTH,
  isProfitPeriod,
  marginPct,
  marginTrendPp,
  paysForDay,
  profitWindows,
  proposalCounts,
  revenueByDay,
  secondsOf,
  trendPct,
  TURN_BUCKET_LABELS,
  TURN_BUCKET_THRESHOLDS_MS,
  turnBucketIndex,
  turnHistogram,
  type DayWindow,
  type RevenueSubscription,
} from './profit-math';
import { addDays, warsawDayStart } from '../common/warsaw-calendar';

const NOW = new Date('2026-09-24T10:00:00Z');
const SOLO = 'app.scoffie.pro.solo.monthly';

const day = (key: string, next: string): DayWindow => ({
  key,
  start: warsawDayStart(key),
  end: warsawDayStart(next),
});

const sub = (
  patch: Partial<RevenueSubscription> = {},
): RevenueSubscription => ({
  provider: 'APPLE',
  productId: SOLO,
  environment: 'Production',
  ownershipType: 'PURCHASED',
  createdAt: new Date('2026-09-01T10:00:00Z'),
  expiresAt: new Date('2026-10-01T10:00:00Z'),
  revokedAt: null,
  operatorHoldAt: null,
  ...patch,
});

describe('okres rentowności', () => {
  it('7 i 30 dni to ostatnie N polskich dni łącznie z dzisiejszym', () => {
    const { current, previous } = profitWindows('7', NOW);
    expect(current.days.map((entry) => entry.key)).toEqual([
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
    ]);
    expect(current.from.toISOString()).toBe('2026-09-17T22:00:00.000Z');
    expect(current.to.toISOString()).toBe('2026-09-24T22:00:00.000Z');
    // Poprzedni okres: tyle samo dni, tuż przed bieżącym.
    expect(previous.days).toHaveLength(7);
    expect(previous.days[0].key).toBe('2026-09-11');
    expect(previous.to.toISOString()).toBe(current.from.toISOString());

    const thirty = profitWindows('30', NOW);
    expect(thirty.current.days).toHaveLength(30);
    expect(thirty.current.days[0].key).toBe('2026-08-26');
    expect(thirty.previous.days[29].key).toBe('2026-08-25');
  });

  it('„ten miesiąc” zaczyna się pierwszego, poprzedni okres ma tyle samo dni', () => {
    const { current, previous } = profitWindows('month', NOW);
    expect(current.days).toHaveLength(24);
    expect(current.days[0].key).toBe('2026-09-01');
    expect(current.days[23].key).toBe('2026-09-24');
    expect(previous.days[0].key).toBe('2026-08-08');
    expect(previous.days[23].key).toBe('2026-08-31');
  });

  it('dzień zaczyna się o polskiej północy, także tuż po niej w UTC', () => {
    // 23:30 w Polsce 24.09 = 21:30 UTC — to wciąż 24.09.
    const { current } = profitWindows(
      'month',
      new Date('2026-09-24T21:30:00Z'),
    );
    expect(current.days.at(-1)?.key).toBe('2026-09-24');
    // 00:30 w Polsce 25.09 = 22:30 UTC 24.09 — to już 25.09.
    const next = profitWindows('month', new Date('2026-09-24T22:30:00Z'));
    expect(next.current.days.at(-1)?.key).toBe('2026-09-25');
  });

  it('rozpoznaje tylko okresy z kontraktu', () => {
    expect(['7', '30', 'month'].every(isProfitPeriod)).toBe(true);
    expect(isProfitPeriod('90')).toBe(false);
    expect(isProfitPeriod(undefined)).toBe(false);
  });
});

describe('przychód z subskrypcji', () => {
  it('dzienny przychód = netto ceny ÷ 30 — jedna arytmetyka z cennikiem', () => {
    expect(dailyNetRevenuePln(sub())).toBeCloseTo(
      netRevenuePln(29.99) / DAYS_PER_MONTH,
      10,
    );
  });

  it('bez pieniędzy: nadanie ręczne, sandbox, Chmura Rodzinna, nieznany SKU', () => {
    expect(dailyNetRevenuePln(sub({ provider: 'MANUAL' }))).toBe(0);
    expect(dailyNetRevenuePln(sub({ environment: 'Sandbox' }))).toBe(0);
    expect(dailyNetRevenuePln(sub({ environment: null }))).toBe(0);
    expect(dailyNetRevenuePln(sub({ ownershipType: 'FAMILY_SHARED' }))).toBe(0);
    expect(dailyNetRevenuePln(sub({ productId: 'app.scoffie.pro.x' }))).toBe(0);
    // Stare wiersze bez `ownershipType` to zakup (Chmura Rodzinna jest jawna).
    expect(dailyNetRevenuePln(sub({ ownershipType: null }))).toBeGreaterThan(0);
  });

  it('pełny okres 30 dni daje dokładnie miesięczne netto — dzień zakupu tak, dzień wygaśnięcia nie', () => {
    // 1.09–1.10 włącznie: zakup 1.09 o 12:00, wygaśnięcie 1.10 o 12:00.
    const days = Array.from({ length: 31 }, (_, index) =>
      day(addDays('2026-09-01', index), addDays('2026-09-01', index + 1)),
    );
    const revenue = revenueByDay(sub(), days);
    expect(revenue[0]).toBeGreaterThan(0); // 1.09 — dzień zakupu
    expect(revenue[30]).toBe(0); // 1.10 — dzień wygaśnięcia
    expect(revenue.reduce((total, value) => total + value, 0)).toBeCloseTo(
      netRevenuePln(29.99),
      8,
    );
  });

  it('zwrot i blokada operatora ucinają przychód od swojego dnia', () => {
    const d = day('2026-09-15', '2026-09-16');
    const before = day('2026-09-10', '2026-09-11');
    const revoked = sub({ revokedAt: new Date('2026-09-15T08:00:00Z') });
    expect(paysForDay(revoked, before)).toBe(true);
    expect(paysForDay(revoked, d)).toBe(false);
    const held = sub({ operatorHoldAt: new Date('2026-09-15T08:00:00Z') });
    expect(paysForDay(held, d)).toBe(false);
  });

  it('łaska płatnicza nie jest przychodem, brak daty końca — też nie', () => {
    const grace = sub({ expiresAt: new Date('2026-09-20T10:00:00Z') });
    expect(paysForDay(grace, day('2026-09-19', '2026-09-20'))).toBe(true);
    expect(paysForDay(grace, day('2026-09-22', '2026-09-23'))).toBe(false);
    expect(
      paysForDay(sub({ expiresAt: null }), day('2026-09-10', '2026-09-11')),
    ).toBe(false);
  });

  it('dni sprzed zakupu nie niosą przychodu', () => {
    expect(paysForDay(sub(), day('2026-08-31', '2026-09-01'))).toBe(false);
  });
});

describe('trendy i marża', () => {
  it('trend w procentach, z jednym miejscem po przecinku', () => {
    expect(trendPct(110, 100)).toBe(10);
    expect(trendPct(90, 100)).toBe(-10);
    expect(trendPct(1, 3)).toBe(-66.7);
  });

  it('poprzedni okres bez przychodu — trend neutralny, nie nieskończony', () => {
    expect(trendPct(50, 0)).toBe(0);
    expect(trendPct(0, 0)).toBe(0);
  });

  it('marża: przychód minus koszt modelu po kursie, 0 bez przychodu', () => {
    expect(marginPct(100, 10, 4)).toBeCloseTo(60, 10);
    expect(marginPct(100, 50, 4)).toBeCloseTo(-100, 10);
    expect(marginPct(0, 10, 4)).toBe(0);
  });

  it('zmiana marży w punktach procentowych', () => {
    expect(
      marginTrendPp(
        { revenueZl: 100, costUsd: 10 },
        { revenueZl: 100, costUsd: 12.5 },
        4,
      ),
    ).toBe(10);
    expect(
      marginTrendPp(
        { revenueZl: 0, costUsd: 1 },
        { revenueZl: 100, costUsd: 10 },
        4,
      ),
    ).toBe(-60);
  });

  it('poprzedni okres bez przychodu — zmiana marży 0 (brak porównania), nie cała bieżąca marża', () => {
    expect(
      marginTrendPp(
        { revenueZl: 100, costUsd: 10 },
        { revenueZl: 0, costUsd: 3 },
        4,
      ),
    ).toBe(0);
    expect(
      marginTrendPp(
        { revenueZl: 0, costUsd: 0 },
        { revenueZl: 0, costUsd: 0 },
        4,
      ),
    ).toBe(0);
  });
});

describe('czas tury', () => {
  it('etykiety kubełków są DOKŁADNIE kontraktem panelu (z półpauzą)', () => {
    expect(TURN_BUCKET_LABELS).toEqual([
      '0–4',
      '4–6',
      '6–8',
      '8–10',
      '10–15',
      '15–20',
      '20–30',
      '30+',
    ]);
    expect(TURN_BUCKET_THRESHOLDS_MS).toEqual([
      4000, 6000, 8000, 10000, 15000, 20000, 30000,
    ]);
  });

  it('kubełki są półotwarte [a, b) — jak `width_bucket` w Postgresie', () => {
    expect(turnBucketIndex(0)).toBe(0);
    expect(turnBucketIndex(3999)).toBe(0);
    expect(turnBucketIndex(4000)).toBe(1);
    expect(turnBucketIndex(5999)).toBe(1);
    expect(turnBucketIndex(6000)).toBe(2);
    expect(turnBucketIndex(14_999)).toBe(4);
    expect(turnBucketIndex(29_999)).toBe(6);
    expect(turnBucketIndex(30_000)).toBe(7);
    expect(turnBucketIndex(600_000)).toBe(7);
  });

  it('histogram ma zawsze osiem kubełków, brakujące z zerem', () => {
    const histogram = turnHistogram(
      new Map([
        [1, 3],
        [7, 2],
      ]),
    );
    expect(histogram).toHaveLength(8);
    expect(histogram[0]).toEqual({ bucket: '0–4', count: 0 });
    expect(histogram[1]).toEqual({ bucket: '4–6', count: 3 });
    expect(histogram[7]).toEqual({ bucket: '30+', count: 2 });
  });

  it('p50/p95 w sekundach z jednym miejscem po przecinku', () => {
    expect(secondsOf(9000)).toBe(9);
    expect(secondsOf(8150)).toBe(8.2);
    expect(secondsOf(19_449)).toBe(19.4);
    expect(secondsOf(null)).toBe(0);
  });
});

describe('propozycje', () => {
  it('każdy status z kontraktu, zera dla brakujących, obce odpadają', () => {
    expect(
      proposalCounts([
        { status: 'APPLIED', count: 3 },
        { status: 'UNDONE', count: 1 },
        { status: 'COS_NOWEGO', count: 9 },
      ]),
    ).toEqual({
      PENDING: 0,
      APPLIED: 3,
      UNDONE: 1,
      STALE: 0,
      EXPIRED: 0,
      FAILED: 0,
    });
  });
});
