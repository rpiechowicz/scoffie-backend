import { SUBSCRIPTION_PRODUCTS, productLimits } from './subscription-products';

describe('productLimits', () => {
  it('kupiony produkt narzuca limity, nie env', () => {
    const fallback = { messagesPerMonth: 200, plansPerMonth: 30 };
    expect(productLimits('pl.weeklymeals.pro.duet.monthly', fallback)).toEqual({
      messagesPerMonth: 50,
      plansPerMonth: 12,
      product: 'We dwoje',
    });
    expect(
      productLimits('pl.weeklymeals.pro.family.monthly', fallback),
    ).toEqual({ messagesPerMonth: 75, plansPerMonth: 18, product: 'Rodzina' });
  });

  it('nieznany produkt (nowy SKU przed deployem) nie blokuje i nie daje nieskończoności', () => {
    const fallback = { messagesPerMonth: 200, plansPerMonth: 30 };
    expect(productLimits('pl.weeklymeals.pro.nowy', fallback)).toEqual({
      ...fallback,
      product: null,
    });
    expect(productLimits(null, fallback)).toEqual({
      ...fallback,
      product: null,
    });
  });

  it('drabina rośnie: droższy plan ma więcej wiadomości i zapisów', () => {
    const ladder = Object.values(SUBSCRIPTION_PRODUCTS).sort(
      (a, b) => a.pricePln - b.pricePln,
    );
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i].messagesPerMonth).toBeGreaterThan(
        ladder[i - 1].messagesPerMonth,
      );
      expect(ladder[i].plansPerMonth).toBeGreaterThan(
        ladder[i - 1].plansPerMonth,
      );
    }
  });

  it('każdy plan jest tańszy za wiadomość niż poprzedni — inaczej większy nie ma sensu', () => {
    const ladder = Object.values(SUBSCRIPTION_PRODUCTS).sort(
      (a, b) => a.pricePln - b.pricePln,
    );
    for (let i = 1; i < ladder.length; i += 1) {
      const prev = ladder[i - 1].pricePln / ladder[i - 1].messagesPerMonth;
      const curr = ladder[i].pricePln / ladder[i].messagesPerMonth;
      expect(curr).toBeLessThan(prev);
    }
  });

  it('każdy plan ma zapas nad zmierzonym zużyciem swojego gospodarstwa', () => {
    // Scenariusze z rachunku (cennik §13): tyle wiadomości zużywa realnie
    // dom danej wielkości w miesiącu. Limit poniżej tej liczby znaczyłby
    // produkt, który kończy się w połowie miesiąca.
    const realne = {
      'pl.weeklymeals.pro.solo.monthly': 14,
      'pl.weeklymeals.pro.duet.monthly': 40,
      'pl.weeklymeals.pro.family.monthly': 70,
    };
    for (const [id, uzycie] of Object.entries(realne)) {
      expect(SUBSCRIPTION_PRODUCTS[id].messagesPerMonth).toBeGreaterThan(
        uzycie,
      );
    }
  });

  it('zapisy planu nigdy nie kończą się przed wiadomościami (nic nie kosztują)', () => {
    // Zatwierdzenie propozycji to kliknięcie bez wywołania modelu, więc ten
    // licznik nie chroni budżetu — ma tylko nie blokować uczciwego użycia.
    // Jedna propozycja powstaje z ~3–4 wiadomości.
    for (const plan of Object.values(SUBSCRIPTION_PRODUCTS)) {
      expect(plan.plansPerMonth).toBeGreaterThanOrEqual(
        Math.floor(plan.messagesPerMonth / 4),
      );
    }
  });
});
