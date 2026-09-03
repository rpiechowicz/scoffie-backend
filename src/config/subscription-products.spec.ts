import { SUBSCRIPTION_PRODUCTS, productLimits } from './subscription-products';

describe('productLimits', () => {
  it('kupiony produkt narzuca limity, nie env', () => {
    const fallback = { messagesPerMonth: 200, plansPerMonth: 30 };
    expect(productLimits('pl.weeklymeals.pro.duet.monthly', fallback)).toEqual({
      messagesPerMonth: 60,
      plansPerMonth: 8,
      product: 'Duet',
    });
    expect(
      productLimits('pl.weeklymeals.pro.family.monthly', fallback),
    ).toEqual({ messagesPerMonth: 100, plansPerMonth: 14, product: 'Rodzina' });
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
});
