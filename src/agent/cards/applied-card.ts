import { AGENT_CARD_VERSION, AppliedCard, weekRangeLabel } from './agent-cards';

/** „13 kwietnia” — data zapisu po ludzku, w UTC jak reszta planu tygodnia. */
export function weekStartLabel(weekStart: string): string {
  return new Intl.DateTimeFormat('pl-PL', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${weekStart}T00:00:00.000Z`));
}

/**
 * Potwierdzenie zapisu — z „Cofnij” W WIADOMOŚCI, nie w toaście.
 *
 * Toast znika po trzech sekundach i zabiera ze sobą jedyną drogę odwrotu.
 * Wiadomość zostaje w rozmowie, więc cofnięcie jest tam, gdzie użytkownik
 * będzie go szukał: przy zmianie, która go zaskoczyła.
 */
export function buildAppliedCard(input: {
  proposalId: string;
  weekStart: string;
  changes: { created: number; updated: number; deleted: number };
  undoUntil: Date;
  canUndo: boolean;
}): AppliedCard {
  const notes: string[] = [];
  if (input.changes.deleted > 0) {
    // Kaskada przy usuwaniu pozycji zabiera odhaczone „zjedzone”. Cofnięcie
    // przywróci posiłek, ale nie to, że ktoś go odhaczył — i użytkownik ma
    // o tym wiedzieć PRZED kliknięciem, nie po.
    notes.push(
      'Cofnięcie przywróci usunięte posiłki, ale nie odhaczenia „zjedzone”.',
    );
  }

  return {
    kind: 'APPLIED',
    v: AGENT_CARD_VERSION,
    proposalId: input.proposalId,
    weekStart: input.weekStart,
    title: 'Zapisano w planie',
    subtitle: `${changesLabel(input.changes)} · ${weekRangeLabel(input.weekStart)}`,
    summary: {
      created: input.changes.created,
      updated: input.changes.updated,
      removed: input.changes.deleted,
    },
    notes,
    actions: [
      ...(input.canUndo
        ? [
            {
              type: 'UNDO' as const,
              proposalId: input.proposalId,
              label: 'Cofnij',
              style: 'SECONDARY' as const,
            },
          ]
        : []),
      {
        type: 'OPEN_PLAN' as const,
        proposalId: null,
        label: 'Otwórz Plan tygodnia',
        style: 'PRIMARY' as const,
      },
    ],
    state: {
      status: 'APPLIED',
      canApply: false,
      canUndo: input.canUndo,
      until: input.undoUntil.toISOString(),
    },
  };
}

/**
 * „2 nowe pozycje, 1 usunięta” — co się właściwie stało.
 *
 * Sama liczba pozycji nie mówi nic: zapis, który wymienił cały tydzień,
 * i zapis, który dodał jedno danie, wyglądałyby tak samo.
 */
function changesLabel(changes: {
  created: number;
  updated: number;
  deleted: number;
}): string {
  const parts: string[] = [];
  if (changes.created > 0) {
    parts.push(
      `${changes.created} ${plural(changes.created, 'nowa pozycja', 'nowe pozycje', 'nowych pozycji')}`,
    );
  }
  if (changes.updated > 0) {
    parts.push(
      `${changes.updated} ${plural(changes.updated, 'zmieniona', 'zmienione', 'zmienionych')}`,
    );
  }
  if (changes.deleted > 0) {
    parts.push(
      `${changes.deleted} ${plural(changes.deleted, 'usunięta', 'usunięte', 'usuniętych')}`,
    );
  }
  return parts.length > 0 ? parts.join(', ') : 'Bez zmian w planie';
}

/** Polska odmiana po liczbie — „1 nowa pozycja”, „3 nowe”, „5 nowych”. */
function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  const mod100 = count % 100;
  if (mod100 >= 12 && mod100 <= 14) return many;
  const mod10 = count % 10;
  return mod10 >= 2 && mod10 <= 4 ? few : many;
}

/** Zdanie, które broni się bez karty — dla klienta, który jej nie zna. */
export function appliedMessageText(input: {
  weekStart: string;
  changes: { created: number; updated: number; deleted: number };
}): string {
  const parts: string[] = [];
  if (input.changes.created > 0) parts.push(`dodane: ${input.changes.created}`);
  if (input.changes.updated > 0)
    parts.push(`zmienione: ${input.changes.updated}`);
  if (input.changes.deleted > 0)
    parts.push(`usunięte: ${input.changes.deleted}`);
  const summary = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `Zapisałem plan na tydzień od ${weekStartLabel(input.weekStart)}${summary}.`;
}
