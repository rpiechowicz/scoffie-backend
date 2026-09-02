import { createHash } from 'node:crypto';

/**
 * Odcisk stanu tygodnia — po nim poznajemy, że plan zmienił się między
 * propozycją a kliknięciem „Dodaj do planu”.
 *
 * Bez tego dwa scenariusze kończą się cichym nadpisaniem cudzej pracy:
 * ktoś w domu poprawia wtorek z telefonu, a my zapisujemy tydzień policzony
 * PRZED tą poprawką; albo użytkownik wraca do rozmowy sprzed tygodnia i klika
 * przycisk, który wygląda tak samo jak wczoraj. Odcisk zamienia jedno i drugie
 * w uczciwą odmowę („plan się zmienił”), zamiast w niespodziankę.
 *
 * Liczymy z tego, co realnie definiuje pozycję planu: dzień, posiłek, przepis,
 * audytorium i porcje. `createdAt` ani `id` nie wchodzą — zapis tej samej
 * treści innym wierszem nie jest zmianą planu z punktu widzenia użytkownika.
 */
export type BaselineSlot = {
  dayOfWeek: string;
  mealType: string;
  recipeId: string;
  participantIds?: string[];
  plannedServings?: number | null;
};

export function weekBaselineHash(slots: readonly BaselineSlot[]): string {
  const rows = slots
    .map((slot) => {
      const participants = [...(slot.participantIds ?? [])].sort().join(',');
      const servings = slot.plannedServings ?? '';
      return `${slot.dayOfWeek}|${slot.mealType}|${slot.recipeId}|${participants}|${servings}`;
    })
    .sort();

  return createHash('sha256')
    .update(rows.join('\n'))
    .digest('hex')
    .slice(0, 32);
}
