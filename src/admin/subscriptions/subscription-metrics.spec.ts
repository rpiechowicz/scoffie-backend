import {
  carriesRevenue,
  compareRisk,
  endedAt,
  graceEnd,
  liveNow,
  mrrAt,
  mrrSeriesPoints,
  percentChange,
  revenueSpans,
  riskSignal,
  type MetricSubscription,
} from './subscription-metrics';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY);

const row = (over: Partial<MetricSubscription> = {}): MetricSubscription => ({
  id: 'sub-1',
  provider: 'APPLE',
  productId: 'app.scoffie.pro.solo.monthly',
  status: 'ACTIVE',
  environment: 'Production',
  ownershipType: 'PURCHASED',
  expiresAt: days(10),
  graceExpiresAt: null,
  neverExpires: false,
  revokedAt: null,
  operatorHoldAt: null,
  autoRenewStatus: true,
  messagesLimitSnapshot: 30,
  plansLimitSnapshot: 8,
  purchaserUserId: 'user-1',
  createdAt: days(-40),
  updatedAt: days(-1),
  ...over,
});

describe('subscription-metrics', () => {
  const originals = { ...process.env };
  beforeEach(() => {
    // Serwer „produkcyjny": `subscriptionAlive` odrzuca tu Sandbox. Statystyki
    // mają go mimo to widzieć — środowisko ocenia wiersz, nie serwer.
    process.env.APPLE_ENVIRONMENT = 'Production';
    process.env.APPLE_ACCEPT_SANDBOX = 'false';
  });
  afterEach(() => {
    process.env = { ...originals };
  });

  describe('żywotność i przychód', () => {
    it('Sandbox jest żywy dla statystyki, choć serwer produkcyjny nie daje z niego PRO', () => {
      expect(liveNow(row({ environment: 'Sandbox' }), NOW)).toBe(true);
    });

    it('blokada operatora, zwrot i koniec okresu — nie żyje (jak w domenie)', () => {
      expect(liveNow(row({ operatorHoldAt: days(-2) }), NOW)).toBe(false);
      expect(liveNow(row({ revokedAt: days(-2) }), NOW)).toBe(false);
      expect(liveNow(row({ expiresAt: days(-1) }), NOW)).toBe(false);
      expect(liveNow(row({ status: 'EXPIRED' }), NOW)).toBe(false);
    });

    it('przychód niesie tylko App Store, produkcja, własny zakup i znany produkt', () => {
      expect(carriesRevenue(row())).toBe(true);
      expect(carriesRevenue(row({ ownershipType: null }))).toBe(true);
      expect(carriesRevenue(row({ ownershipType: 'FAMILY_SHARED' }))).toBe(
        false,
      );
      expect(carriesRevenue(row({ environment: 'Sandbox' }))).toBe(false);
      expect(carriesRevenue(row({ provider: 'MANUAL' }))).toBe(false);
      expect(
        carriesRevenue(row({ productId: 'app.scoffie.pro.nowy.monthly' })),
      ).toBe(false);
    });
  });

  describe('endedAt — kiedy przestała płacić', () => {
    it('żywa płaci dalej', () => {
      expect(endedAt(row(), NOW)).toBeNull();
      expect(
        endedAt(row({ status: 'GRACE', expiresAt: days(-3) }), NOW),
      ).toBeNull();
    });

    it('zwrot → data zwrotu; blokada → data blokady', () => {
      expect(endedAt(row({ revokedAt: days(-5) }), NOW)).toEqual(days(-5));
      expect(endedAt(row({ operatorHoldAt: days(-4) }), NOW)).toEqual(days(-4));
    });

    it('EXPIRED po łasce → koniec łaski; bez łaski → koniec okresu', () => {
      expect(
        endedAt(
          row({
            status: 'EXPIRED',
            expiresAt: days(-20),
            graceExpiresAt: days(-10),
          }),
          NOW,
        ),
      ).toEqual(days(-10));
      expect(
        endedAt(row({ status: 'EXPIRED', expiresAt: days(-20) }), NOW),
      ).toEqual(days(-20));
    });

    it('GRACE po terminie → koniec łaski, z domyślnymi 16 dniami', () => {
      const expired = row({ status: 'GRACE', expiresAt: days(-30) });
      expect(graceEnd(expired)).toEqual(days(-14));
      expect(endedAt(expired, NOW)).toEqual(days(-14));
    });

    it('bez dat → ostatnia zmiana wiersza; nigdy po „teraz"', () => {
      expect(endedAt(row({ status: 'EXPIRED', expiresAt: null }), NOW)).toEqual(
        days(-1),
      );
      expect(
        endedAt(row({ status: 'EXPIRED', expiresAt: days(5) }), NOW),
      ).toEqual(NOW);
      expect(endedAt(row({ status: 'REVOKED' }), NOW)).toEqual(days(-1));
    });
  });

  describe('mrrAt', () => {
    const rows = [
      row({ id: 'solo' }),
      row({
        id: 'duet',
        productId: 'app.scoffie.pro.duet.monthly',
        createdAt: days(-5),
      }),
      row({
        id: 'rodzina-odeszla',
        productId: 'app.scoffie.pro.family.monthly',
        status: 'EXPIRED',
        expiresAt: days(-15),
        createdAt: days(-60),
      }),
      row({ id: 'chmura', ownershipType: 'FAMILY_SHARED' }),
      row({ id: 'sandbox', environment: 'Sandbox' }),
      row({ id: 'wstrzymana', operatorHoldAt: days(-2), createdAt: days(-30) }),
    ];
    const spans = revenueSpans(rows, NOW);

    it('dziś = suma cen żywych wierszy z przychodem', () => {
      expect(mrrAt(spans, NOW)).toBe(69.98);
    });

    it('odtwarza przeszłość: przed założeniem nie ma, po odejściu nie ma', () => {
      // 20 dni temu: solo + rodzina (jeszcze płaciła) + wstrzymana (przed blokadą).
      expect(mrrAt(spans, days(-20))).toBe(109.97);
      // 50 dni temu: tylko rodzina (solo założone 40 dni temu).
      expect(mrrAt(spans, days(-50))).toBe(49.99);
    });
  });

  it('percentChange: jedno miejsce po przecinku, bez podstawy — 0', () => {
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(2, 3)).toBe(-33.3);
    expect(percentChange(5, 0)).toBe(0);
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(0, 4)).toBe(-100);
  });

  describe('wykres MRR', () => {
    it('punkty wykresu: sześć miesięcy, koniec każdego, bieżący = teraz', () => {
      const points = mrrSeriesPoints(NOW);
      expect(points.map((p) => p.month)).toEqual([
        'kwi',
        'maj',
        'cze',
        'lip',
        'sie',
        'wrz',
      ]);
      expect(points[4].at.toISOString()).toBe('2026-08-31T21:59:59.999Z');
      expect(points[5].at).toBe(NOW);
      expect(
        mrrSeriesPoints(new Date('2026-02-10T12:00:00.000Z')).map(
          (p) => p.month,
        ),
      ).toEqual(['wrz', 'paź', 'lis', 'gru', 'sty', 'lut']);
    });
  });

  describe('ryzyko odejścia', () => {
    it('blokada operatora na żywej umowie — bez końca', () => {
      expect(riskSignal(row({ operatorHoldAt: days(-1) }), NOW)).toEqual({
        kind: 'operatorHold',
        until: null,
        productId: 'app.scoffie.pro.solo.monthly',
      });
    });

    it('łaska płatnicza — do końca łaski', () => {
      expect(
        riskSignal(
          row({
            status: 'GRACE',
            expiresAt: days(-2),
            graceExpiresAt: days(5),
          }),
          NOW,
        ),
      ).toMatchObject({ kind: 'grace', until: days(5) });
    });

    it('wyłączone odnowienie — do końca okresu', () => {
      expect(riskSignal(row({ autoRenewStatus: false }), NOW)).toMatchObject({
        kind: 'autoRenewOff',
        until: days(10),
      });
    });

    it('zdrowa, martwa, cudza albo testowa — bez sygnału', () => {
      expect(riskSignal(row(), NOW)).toBeNull();
      expect(riskSignal(row({ autoRenewStatus: null }), NOW)).toBeNull();
      expect(
        riskSignal(row({ autoRenewStatus: false, expiresAt: days(-3) }), NOW),
      ).toBeNull();
      expect(
        riskSignal(row({ revokedAt: days(-1), operatorHoldAt: days(-1) }), NOW),
      ).toBeNull();
      expect(
        riskSignal(
          row({ autoRenewStatus: false, environment: 'Sandbox' }),
          NOW,
        ),
      ).toBeNull();
      expect(
        riskSignal(
          row({ autoRenewStatus: false, ownershipType: 'FAMILY_SHARED' }),
          NOW,
        ),
      ).toBeNull();
    });

    it('ważniejszy powód pierwszy, potem bliższy termin', () => {
      const hold = { kind: 'operatorHold', until: null } as const;
      const graceSoon = { kind: 'grace', until: days(2) } as const;
      const graceLater = { kind: 'grace', until: days(9) } as const;
      const renew = { kind: 'autoRenewOff', until: days(1) } as const;
      const product = 'app.scoffie.pro.solo.monthly' as const;
      const sorted = [renew, graceLater, hold, graceSoon]
        .map((s) => ({ ...s, productId: product }))
        .sort(compareRisk)
        .map((s) => `${s.kind}:${s.until?.getTime() ?? '-'}`);
      expect(sorted).toEqual([
        'operatorHold:-',
        `grace:${days(2).getTime()}`,
        `grace:${days(9).getTime()}`,
        `autoRenewOff:${days(1).getTime()}`,
      ]);
    });
  });
});
