import type { ProductId } from '../contract';

/**
 * Produkty, które zna KONTRAKT panelu (`ProductId` w `contract.ts`) — w tej
 * samej kolejności co `SUBSCRIPTION_PRODUCTS` (Solo → We dwoje → Rodzina).
 *
 * Osobna lista, a nie `Object.keys(SUBSCRIPTION_PRODUCTS)`, bo front robi
 * `PRODUCTS[productId].name` bez zabezpieczenia: nieznany identyfikator
 * (nowy SKU wypuszczony w App Store przed deployem) wywróciłby ekran. Test
 * `admin-products.spec.ts` pilnuje, żeby lista szła w parze z cennikiem —
 * nowy produkt w domenie = czerwony test i zmiana kontraktu w obu repo.
 */
export const ADMIN_PRODUCT_IDS: readonly ProductId[] = [
  'app.scoffie.pro.solo.monthly',
  'app.scoffie.pro.duet.monthly',
  'app.scoffie.pro.family.monthly',
];

export function isAdminProductId(value: string): value is ProductId {
  return (ADMIN_PRODUCT_IDS as readonly string[]).includes(value);
}
