import type {
  ShoppingAccumulator,
  ShoppingListItem,
  ShoppingListArchiveSnapshot,
} from '../types/shopping-types';
import { DEPARTMENT_ORDER } from '../types/shopping-department.enum';
import { normalizeText } from './text-normalization.util';
import { formatWeekStart } from './week-formatting.util';

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
/// rounding amounts to 2 decimals, attaching `isChecked` from the saved
/// state, and disambiguating same-name-different-unit duplicates.
export function buildDisplayShoppingItems(
  aggregatedItems: ShoppingAccumulator[],
  checkedMap: Map<string, boolean>,
): ShoppingListItem[] {
  if (aggregatedItems.length === 0) {
    return [];
  }

  const normalized = aggregatedItems.map((item) => ({
    ...item,
    totalAmount: Number(item.totalAmount.toFixed(2)),
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
