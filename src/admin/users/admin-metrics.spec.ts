import { subscriptionAlive } from '../../config/subscription-lifetime';
import {
  endOfDayPoints,
  mrrSeries,
  paidAt,
  paidCounts,
  percentChange,
  trendOfSeries,
  type SubscriptionHistoryRow,
} from './admin-metrics';
import {
  mrrAt,
  revenueSpans,
  type MetricSubscription,
} from '../subscriptions/subscription-metrics';
import { warsawDays } from '../common/warsaw-calendar';

const NOW = new Date('2026-09-24T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

const row = (
  patch: Partial<SubscriptionHistoryRow> = {},
): SubscriptionHistoryRow => ({
  productId: 'app.scoffie.pro.solo.monthly',
  status: 'ACTIVE',
  environment: 'Production',
  expiresAt: ahead(10),
  graceExpiresAt: null,
  neverExpires: false,
  revokedAt: null,
  operatorHoldAt: null,
  createdAt: ago(20),
  updatedAt: ago(1),
  ...patch,
});

describe('percentChange / trendOfSeries', () => {
  it('liczy zmianę względem poprzedniej wartości, do 0,1 pkt', () => {
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(90, 100)).toBe(-10);
    expect(percentChange(1, 3)).toBe(-66.7);
    expect(percentChange(49.99, 49.99)).toBe(0);
  });

  it('z zera nie ma porównania — null, a nie nieskończoność', () => {
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(Number.NaN, 3)).toBeNull();
  });

  it('d1 wobec wczoraj, d7 wobec tygodnia wstecz; bez bazy d1 = 0, d7 znika', () => {
    const series = [10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20, 20, 22];
    expect(trendOfSeries(series)).toEqual({ d1: 10, d7: 10 });
    expect(trendOfSeries([0, 0, 0, 0, 0, 0, 0, 5])).toEqual({ d1: 0 });
    expect(trendOfSeries([7])).toEqual({ d1: 0 });
  });
});

describe('endOfDayPoints', () => {
  it('minione doby — ostatnia milisekunda doby, dziś — teraz', () => {
    const days = warsawDays(NOW, 3);
    const points = endOfDayPoints(days, NOW);
    expect(points[0].toISOString()).toBe('2026-09-22T21:59:59.999Z');
    expect(points[1].toISOString()).toBe('2026-09-23T21:59:59.999Z');
    expect(points[2]).toBe(NOW);
  });
});

describe('paidAt — stan subskrypcji w przeszłości', () => {
  const saved = {
    APPLE_ENVIRONMENT: process.env.APPLE_ENVIRONMENT,
    APPLE_ACCEPT_SANDBOX: process.env.APPLE_ACCEPT_SANDBOX,
  };
  beforeAll(() => {
    // Parytet z domeną przy konfiguracji produkcyjnej: tam uznajemy tylko
    // Production, czyli dokładnie to, co liczy się do przychodu.
    process.env.APPLE_ENVIRONMENT = 'Production';
    delete process.env.APPLE_ACCEPT_SANDBOX;
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('TERAZ dla żywych wierszy mówi dokładnie to, co subscriptionAlive', () => {
    const cases: SubscriptionHistoryRow[] = [
      row(),
      row({ expiresAt: ago(1) }),
      row({ expiresAt: new Date(NOW.getTime() - 60_000) }),
      row({ status: 'GRACE', expiresAt: ago(3), graceExpiresAt: ahead(2) }),
      row({ status: 'GRACE', expiresAt: ago(3), graceExpiresAt: ago(1) }),
      row({ status: 'GRACE', expiresAt: ago(20), graceExpiresAt: null }),
      row({ status: 'GRACE', expiresAt: ago(3), graceExpiresAt: null }),
      row({ revokedAt: ago(1) }),
      row({ operatorHoldAt: ago(2) }),
      row({ expiresAt: null }),
      row({ status: 'EXPIRED', expiresAt: ago(2) }),
      row({ status: 'REVOKED', revokedAt: ago(1), expiresAt: ahead(5) }),
    ];
    for (const candidate of cases) {
      expect(paidAt(candidate, NOW)).toBe(
        subscriptionAlive(
          {
            id: 'x',
            provider: 'APPLE',
            messagesLimitSnapshot: null,
            plansLimitSnapshot: null,
            ...candidate,
          },
          NOW,
        ),
      );
    }
  });

  it('Sandbox nigdy nie jest przychodem', () => {
    expect(paidAt(row({ environment: 'Sandbox' }), NOW)).toBe(false);
    expect(paidAt(row({ environment: null }), NOW)).toBe(false);
  });

  it('przed założeniem wiersza subskrypcji nie było', () => {
    const created = row({ createdAt: ago(3) });
    expect(paidAt(created, ago(4))).toBe(false);
    expect(paidAt(created, ago(2))).toBe(true);
  });

  it('wygasła żyła do końca opłaconego okresu, nie dłużej', () => {
    const expired = row({
      status: 'EXPIRED',
      expiresAt: ago(5),
      updatedAt: ago(4),
    });
    expect(paidAt(expired, ago(6))).toBe(true);
    expect(paidAt(expired, ago(4.9))).toBe(false);
  });

  it('wygasła po łasce: dni łaski się liczą', () => {
    const afterGrace = row({
      status: 'EXPIRED',
      expiresAt: ago(10),
      graceExpiresAt: ago(3),
      updatedAt: ago(3),
    });
    expect(paidAt(afterGrace, ago(5))).toBe(true);
    expect(paidAt(afterGrace, ago(2))).toBe(false);
  });

  it('martwy wiersz nie żył po ostatnim zapisie, nawet z datą końca w przyszłości', () => {
    const dead = row({
      status: 'EXPIRED',
      expiresAt: ahead(5),
      updatedAt: ago(2),
    });
    expect(paidAt(dead, ago(3))).toBe(true);
    expect(paidAt(dead, ago(1))).toBe(false);
  });

  it('zwrot i blokada operatora ucinają dostęp od swojej chwili', () => {
    const refunded = row({
      status: 'REVOKED',
      revokedAt: ago(2),
      expiresAt: ahead(5),
      updatedAt: ago(2),
    });
    expect(paidAt(refunded, ago(3))).toBe(true);
    expect(paidAt(refunded, ago(1))).toBe(false);

    const held = row({ operatorHoldAt: ago(2) });
    expect(paidAt(held, ago(3))).toBe(true);
    expect(paidAt(held, ago(1))).toBe(false);
  });
});

describe('paidCounts / mrrSeries', () => {
  const metric = (
    patch: Partial<MetricSubscription> = {},
  ): MetricSubscription => ({
    ...row(),
    id: `sub-${Math.random()}`,
    provider: 'APPLE',
    ownershipType: 'PURCHASED',
    autoRenewStatus: true,
    messagesLimitSnapshot: null,
    plansLimitSnapshot: null,
    purchaserUserId: null,
    ...patch,
  });

  it('liczy sztuki opłaconych wierszy z produkcji; nieznany produkt też jest sztuką', () => {
    const rows = [
      row({ productId: 'app.scoffie.pro.family.monthly' }),
      row({ productId: 'app.scoffie.pro.duet.monthly', createdAt: ago(2) }),
      row({ productId: 'app.scoffie.pro.nowy.sku' }),
      row({ environment: 'Sandbox' }),
    ];
    expect(paidCounts(rows, [ago(3), NOW])).toEqual([2, 3]);
  });

  it('MRR pulpitu = MRR ekranu Subskrypcje: bez Chmury Rodzinnej, nieznany SKU za 0 zł', () => {
    const rows = [
      metric({ productId: 'app.scoffie.pro.family.monthly' }),
      metric({ productId: 'app.scoffie.pro.duet.monthly', createdAt: ago(2) }),
      metric({ productId: 'app.scoffie.pro.nowy.sku' }),
      metric({ environment: 'Sandbox' }),
      metric({ ownershipType: 'FAMILY_SHARED' }),
      metric({ provider: 'MANUAL' }),
    ];
    const points = [ago(3), NOW];
    const series = mrrSeries(rows, points, NOW);
    expect(series).toEqual([49.99, 89.98]);
    const spans = revenueSpans(rows, NOW);
    expect(series).toEqual(points.map((point) => mrrAt(spans, point)));
  });
});
