import { SUBSCRIPTION_PRODUCTS } from '../../config/subscription-products';
import { ADMIN_PRODUCT_IDS, isAdminProductId } from './admin-products';

describe('produkty kontraktu panelu', () => {
  it('idą w parze z cennikiem domeny — nowy SKU wymaga zmiany kontraktu', () => {
    // Czerwony test = w `SUBSCRIPTION_PRODUCTS` jest produkt, którego panel
    // nie umie narysować (front: `PRODUCTS[productId].name`). Dopisz go do
    // `ProductId` w `contract.ts` i w `scoffie-dashboard/src/api/types.ts`.
    expect([...ADMIN_PRODUCT_IDS]).toEqual(Object.keys(SUBSCRIPTION_PRODUCTS));
  });

  it('rozpoznaje tylko znane identyfikatory', () => {
    expect(isAdminProductId('app.scoffie.pro.duet.monthly')).toBe(true);
    expect(isAdminProductId('app.scoffie.pro.nowy.monthly')).toBe(false);
  });
});
