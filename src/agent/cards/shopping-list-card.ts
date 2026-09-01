import {
  AGENT_CARD_VERSION,
  ShoppingListCard,
  ShoppingListCardGroup,
  weekRangeLabel,
} from './agent-cards';

/** Ile pozycji pokazujemy w dziale, zanim karta zamieni się w listę. */
export const MAX_ITEMS_PER_GROUP = 6;

/**
 * Lista zakupów tygodnia, po działach.
 *
 * Karta mówi DOKŁADNIE tyle, ile serwer wie: co plan wymaga i ile z tego
 * ktoś już odhaczył. Makieta obiecywała tu więcej („pozostałe 14 rzeczy masz
 * w spiżarni”), ale aplikacja nie ma spiżarni i nie wie, co stoi w szafce —
 * ta liczba byłaby wzięta znikąd i wyglądałaby dokładnie tak samo jak
 * policzona.
 *
 * Grupowanie po działach nie jest ozdobą: listę zakupów czyta się w sklepie,
 * chodząc alejkami, a nie w kolejności, w jakiej przepisy trafiły do planu.
 */
export function buildShoppingListCard(input: {
  weekStart: string;
  items: readonly {
    name: string;
    unit: string;
    department: string;
    totalAmount: number;
    isChecked: boolean;
  }[];
  /** Kolejność działów — ta sama co na liście zakupów w aplikacji. */
  departmentOrder: readonly string[];
}): ShoppingListCard {
  const remaining = input.items.filter((item) => !item.isChecked);
  const checked = input.items.length - remaining.length;

  const byDepartment = new Map<string, string[]>();
  for (const item of remaining) {
    const bucket = byDepartment.get(item.department) ?? [];
    bucket.push(itemLabel(item));
    byDepartment.set(item.department, bucket);
  }

  const known = input.departmentOrder.filter((department) =>
    byDepartment.has(department),
  );
  const rest = [...byDepartment.keys()]
    .filter((department) => !input.departmentOrder.includes(department))
    .sort((a, b) => a.localeCompare(b, 'pl'));

  const groups: ShoppingListCardGroup[] = [...known, ...rest].map(
    (department) => ({
      department,
      items: (byDepartment.get(department) ?? []).slice(0, MAX_ITEMS_PER_GROUP),
    }),
  );

  return {
    kind: 'SHOPPING_LIST',
    v: AGENT_CARD_VERSION,
    weekStart: input.weekStart,
    eyebrow: `Lista zakupów · ${weekRangeLabel(input.weekStart)}`,
    title: title(remaining.length),
    groups,
    summary: { remaining: remaining.length, checked },
    checkedNote:
      checked > 0
        ? `${checked} ${plural(checked, 'pozycja', 'pozycje', 'pozycji')} już odhaczone`
        : null,
    actions: [
      {
        type: 'OPEN_SHOPPING',
        proposalId: null,
        label: 'Otwórz listę zakupów',
        style: 'PRIMARY',
      },
    ],
  };
}

/** „Feta 2 op.” — nazwa i ilość w jednym napisie, jak na liście w sklepie. */
function itemLabel(item: {
  name: string;
  unit: string;
  totalAmount: number;
}): string {
  if (item.totalAmount <= 0) return item.name;
  // Ilości ułamkowe zaokrąglamy do jednego miejsca: „0,3 kg mąki” da się
  // kupić, „0,2857 kg” nie.
  const amount = Number.isInteger(item.totalAmount)
    ? String(item.totalAmount)
    : item.totalAmount.toFixed(1).replace('.', ',');
  return item.unit ? `${item.name} ${amount} ${item.unit}` : `${item.name} ${amount}`;
}

function title(remaining: number): string {
  if (remaining === 0) return 'Wszystko odhaczone';
  return `${remaining} ${plural(remaining, 'rzecz', 'rzeczy', 'rzeczy')} do kupienia`;
}

function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  const mod100 = count % 100;
  if (mod100 >= 12 && mod100 <= 14) return many;
  const mod10 = count % 10;
  return mod10 >= 2 && mod10 <= 4 ? few : many;
}
