import type { Prisma } from '@prisma/client';
import type { KitchenMeasure } from '../../recipes/ingredient-amount.util';
import type { PrismaService } from '../../prisma/prisma.service';

export type ShoppingAccumulator = {
  productKey: string;
  name: string;
  unit: string;
  department: string;
  totalAmount: number;
};

export type ShoppingListItem = ShoppingAccumulator & {
  isChecked: boolean;
  /** Miara kuchenna przypraw — tylko w odpowiedzi dla telefonu, nie w bazie. */
  kitchenMeasure?: KitchenMeasure;
};

export type ShoppingListArchiveSnapshot = {
  archiveId: string;
  weekStart: string;
  weekLabel: string;
  revision: number;
  archivedAt: number;
  isCurrentClosed: boolean;
  items: ShoppingListItem[];
};

/**
 * Pozycja bieżącej listy tak, jak widzi ją ekran: plus tytuły przepisów,
 * z których coś do niej DOPISANO (`ShoppingListExtra`). Pusta tablica =
 * pozycja wyłącznie z planu. Archiwa tego pola nie mają.
 */
export type ShoppingListStateItem = ShoppingListItem & {
  addedFrom: string[];
  /**
   * Część dopisana RĘCZNIE (`ShoppingListManualItem`), `null` = brak.
   * `amount`/`unit` = `null` to „kup to” bez ilości; ilość jest w jednostce
   * listy i zawiera się już w `totalAmount`.
   */
  manual: ShoppingManualPart | null;
};

export type ShoppingManualPart = {
  amount: number | null;
  unit: string | null;
  /** Kto dopisał (ostatnio) — telefon zamienia na domownika. */
  addedById: string | null;
  /**
   * Kiedy ostatnio dopisano albo zmieniono ilość — ms od epoki, jak
   * `archivedAt`. Telefon porównuje z zamknięciem listy: „kup jeszcze chleb” bez ilości po zamknięciu nie
   * zmienia sumy, a ptaszek nie może o tym decydować — domownik odhacza
   * chleb w sklepie, a ten dalej należy do nowej rundy.
   */
  addedAt: number;
};

/** Ostatnio dopisywane w domu — „powtórz jednym stuknięciem” w arkuszu. */
export type ShoppingRecentProduct = {
  name: string;
  department: string;
  /** `null` = własna nazwa domu, spoza katalogu. */
  ingredientId: string | null;
  amount: number | null;
  unit: string | null;
};

export type ShoppingListStateDto = {
  items: ShoppingListStateItem[];
  archives: ShoppingListArchiveSnapshot[];
  recentProducts: ShoppingRecentProduct[];
};

/** Produkt katalogu w arkuszu „Dodaj produkty”. */
export type ShoppingProductCatalogEntry = {
  id: string;
  name: string;
  department: string;
  /** Ma masę sztuki — na liście zawsze w sztukach (`toShoppingUnit`). */
  pieceOnly: boolean;
  /** Inne nazwy tego samego produktu, po których też da się go znaleźć. */
  aliases: string[];
};

/**
 * Katalog dla telefonu. `products: null` = telefon ma już tę rewizję
 * i nic nie trzeba wysyłać.
 */
export type ShoppingProductCatalogDto = {
  revision: string;
  products: ShoppingProductCatalogEntry[] | null;
};

/// Lets methods accept either a transactional Prisma client or the root
/// PrismaService — useful for read paths that may run inside or outside a tx.
export type PrismaReadClient = Prisma.TransactionClient | PrismaService;
