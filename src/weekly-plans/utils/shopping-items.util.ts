import type {
  ShoppingAccumulator,
  ShoppingListItem,
  ShoppingListArchiveSnapshot,
} from '../types/shopping-types';
import { DEPARTMENT_ORDER } from '../types/shopping-department.enum';
import { normalizeText } from './text-normalization.util';
import { formatWeekStart } from './week-formatting.util';

/**
 * Jednostka, w której produkt stoi na liście zakupów.
 *
 * Katalog zapisuje ten sam produkt raz w gramach, raz w sztukach („cebula
 * 150 g” w jednym przepisie, „1 szt” w drugim), a lista sklejała pozycje po
 * parze nazwa + jednostka — więc tydzień z obydwoma przepisami dawał dwa
 * wiersze „Cebula (g)” i „Cebula (szt)”, a sama cebula skakała między
 * jednostkami zależnie od tego, co akurat było w planie.
 *
 * Reguła jest per PRODUKT, nie per tydzień: składnik ze znaną masą sztuki
 * (`Ingredient.gramsPerPiece`) idzie na listę ZAWSZE w sztukach, bo tak się
 * go kupuje. Jednostka i `productKey` nie zależą więc od tego, jakie przepisy
 * trafiły do planu, a zaznaczenie „kupione” nie gubi się przy każdej zmianie.
 * Bez masy sztuki nie ma czym przeliczyć — zostaje jednostka z przepisu.
 */
export function toShoppingUnit(
  amount: number,
  unit: string,
  gramsPerPiece: number | null | undefined,
): { amount: number; unit: string } {
  if (gramsPerPiece && gramsPerPiece > 0 && normalizeText(unit) === 'g') {
    return { amount: amount / gramsPerPiece, unit: 'szt' };
  }
  return { amount, unit };
}

/**
 * Ilość tak, jak stoi na liście (i jak ląduje w migawce oraz archiwum).
 *
 * Sztuki idą w górę do połówki: po przeliczeniu z gramów wychodziło
 * „1,08 szt” ogórka, a w sklepie kupuje się całą albo pół. Reszta — dwa
 * miejsca po przecinku, jak dotąd. Epsilon chroni przed 4,0000001 → 4,5.
 */
export function roundShoppingAmount(amount: number, unit: string): number {
  if (normalizeText(unit) === 'szt') {
    return Math.ceil(amount * 2 - 0.000_001) / 2;
  }
  return Number(amount.toFixed(2));
}

/// Stable, content-addressable signature for a list of items. Used to detect
/// whether a regenerated shopping list actually changed (so we can skip a
/// snapshot bump if it didn't).
export function itemSignature(items: ShoppingListItem[]): string {
  return items
    .map((item) =>
      [
        item.productKey,
        item.totalAmount.toFixed(6),
        item.unit,
        item.department,
        item.name,
      ].join('|'),
    )
    .sort()
    .join('||');
}

/// Sorts shopping list items by department (using DEPARTMENT_ORDER) and
/// then alphabetically by name within a department.
export function sortShoppingItems(
  items: ShoppingListItem[],
): ShoppingListItem[] {
  return [...items].sort((a, b) => {
    const rankA = DEPARTMENT_ORDER[a.department] ?? DEPARTMENT_ORDER.Inne;
    const rankB = DEPARTMENT_ORDER[b.department] ?? DEPARTMENT_ORDER.Inne;
    if (rankA !== rankB) return rankA - rankB;
    if (a.department === b.department) {
      return a.name.localeCompare(b.name);
    }
    return a.department.localeCompare(b.department);
  });
}

/// Turns aggregated accumulator entries into the display-shaped list items,
/// rounding amounts (`roundShoppingAmount`), attaching `isChecked` from the
/// saved state, and disambiguating same-name-different-unit duplicates.
export function buildDisplayShoppingItems(
  aggregatedItems: ShoppingAccumulator[],
  checkedMap: Map<string, boolean>,
): ShoppingListItem[] {
  if (aggregatedItems.length === 0) {
    return [];
  }

  const normalized = aggregatedItems.map((item) => ({
    ...item,
    totalAmount: roundShoppingAmount(item.totalAmount, item.unit),
    isChecked: checkedMap.get(item.productKey) ?? false,
  }));

  const unitsByName = new Map<string, Set<string>>();
  for (const item of normalized) {
    const set = unitsByName.get(item.name) ?? new Set<string>();
    set.add(normalizeText(item.unit));
    unitsByName.set(item.name, set);
  }

  return sortShoppingItems(
    normalized.map((item) => {
      const units = unitsByName.get(item.name);
      if (units && units.size > 1) {
        return {
          ...item,
          // Avoid visually duplicated product rows when same canonical name has different units.
          // Po `toShoppingUnit` zostaje to tylko dla produktów bez masy sztuki
          // (i dla pary g/ml, której nie ma czym przeliczyć).
          name: `${item.name} (${item.unit})`,
        };
      }
      return item;
    }),
  );
}

/// Rounds amounts and re-sorts a snapshot's persisted item rows back into
/// the standard display order.
export function mapSnapshotItems(
  items: Array<{
    productKey: string;
    name: string;
    unit: string;
    department: string;
    totalAmount: number;
    isChecked: boolean;
  }>,
): ShoppingListItem[] {
  return sortShoppingItems(
    items.map((item) => ({
      productKey: item.productKey,
      name: item.name,
      unit: item.unit,
      department: item.department,
      totalAmount: Number(item.totalAmount.toFixed(2)),
      isChecked: item.isChecked,
    })),
  );
}

/// Builds the API-shaped archive snapshot from a Prisma archive row plus
/// the set of currently-active archive ids (so we can mark
/// `isCurrentClosed`).
export function toArchiveSnapshot(
  archive: {
    id: string;
    weekStart: Date;
    weekLabel: string;
    revision: number;
    archivedAt: Date;
    items: Array<{
      productKey: string;
      name: string;
      unit: string;
      department: string;
      totalAmount: number;
      isChecked: boolean;
    }>;
  },
  currentArchiveIds: Set<string>,
): ShoppingListArchiveSnapshot {
  return {
    archiveId: archive.id,
    weekStart: formatWeekStart(archive.weekStart),
    weekLabel: archive.weekLabel,
    revision: archive.revision,
    archivedAt: archive.archivedAt.getTime(),
    isCurrentClosed: currentArchiveIds.has(archive.id),
    items: sortShoppingItems(
      archive.items.map((item) => ({
        productKey: item.productKey,
        name: item.name,
        unit: item.unit,
        department: item.department,
        totalAmount: Number(item.totalAmount.toFixed(2)),
        isChecked: item.isChecked,
      })),
    ),
  };
}
