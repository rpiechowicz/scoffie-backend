import {
  AGENT_CARD_VERSION,
  DetectedItem,
  DetectedItemsCard,
} from './agent-cards';

/** Ile produktów pokazujemy — dalej to spis z natury, nie podsumowanie. */
export const MAX_DETECTED_ITEMS = 12;

/**
 * Co asystent zobaczył na zdjęciu — do sprostowania jednym zdaniem.
 *
 * Rozdział na „pewne” i „niepewne” jest tu całą treścią. Model, który wymienia
 * wszystko jednym tonem, przemyca zgadywanie między rzeczy rozpoznane, a lista
 * składników, w której jedna pozycja jest zmyślona, jest gorsza niż lista
 * krótsza o tę pozycję — bo nie widać, która to.
 */
export function buildDetectedItemsCard(input: {
  items: readonly DetectedItem[];
  intro?: string | null;
}): DetectedItemsCard {
  const items = input.items
    .map((item) => ({ name: item.name.trim(), sure: item.sure }))
    .filter((item) => item.name.length > 0)
    // Pewne najpierw: lista zaczyna się od tego, co wiadomo, a kończy na tym,
    // co wymaga potwierdzenia.
    .sort((a, b) => Number(b.sure) - Number(a.sure))
    .slice(0, MAX_DETECTED_ITEMS);

  const unsure = items.filter((item) => !item.sure).length;

  return {
    kind: 'DETECTED_ITEMS',
    v: AGENT_CARD_VERSION,
    eyebrow: 'Ze zdjęcia',
    title: title(items.length, unsure),
    items,
    actions: [
      {
        type: 'ASK',
        proposalId: null,
        label: 'Popraw listę',
        style: 'SECONDARY',
        prompt: 'Popraw listę: ',
      },
    ],
  };
}

function title(total: number, unsure: number): string {
  if (total === 0) return 'Nie rozpoznałem nic pewnego';
  if (unsure === 0) {
    return `Widzę ${total} ${plural(total, 'produkt', 'produkty', 'produktów')}`;
  }
  return `Widzę ${total} ${plural(total, 'produkt', 'produkty', 'produktów')}, ${unsure} niepewn${unsure === 1 ? 'y' : 'e'}`;
}

function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  const mod100 = count % 100;
  if (mod100 >= 12 && mod100 <= 14) return many;
  const mod10 = count % 10;
  return mod10 >= 2 && mod10 <= 4 ? few : many;
}
