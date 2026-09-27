import type { ApplyWeekSlotDto } from '../../weekly-plans/dto/apply-week-plan.dto';
import { JOINED_PORTION_SERVINGS } from '../../weekly-plans/utils/plan-portions.util';

/**
 * Kto ułożył stan docelowy propozycji:
 * - `model` — `propose_week_plan` / `propose_day_plan` (sloty z `toSlots`,
 *   bez porcji);
 * - `server` — migawka + serwerowa zmiana (revise, swap, split, planer).
 */
export type ProposalOrigin = 'model' | 'server';

/**
 * Porcje per osoba w propozycjach asystenta (workstream
 * `per-user-portions-write-safety`, ETAP 9). Model porcji nie liczy ani nie
 * kopiuje — robi to ta funkcja, deterministycznie, na migawce tygodnia:
 *
 * - pozycja z alokacją powtórzona w stanie docelowym BEZ porcji dostaje
 *   `portionPolicy: PRESERVE` — alokacja zostaje (przy zmianie audytorium
 *   serwer przelicza ją przy zapisie), nigdy cichy równy podział;
 * - NOWA pozycja w tym samym dniu i posiłku, w którym stała pozycja z
 *   alokacją, która znika (zamiana dania), przejmuje porcje osób (KEEP):
 *   zostający — swoja porcja, nowi — 1,00;
 * - `dropped` = pozycje z alokacją, które znikają bez następcy z porcjami.
 *   Dla stanu ułożonego przez model to odmowa (usunięcie tylko jawnym
 *   `propose_remove_meal`); ścieżki serwerowe usuwają jawnie.
 *
 * Sloty z jawnymi `portions` albo `portionPolicy` zostają bez zmian.
 */
export function prepareProposalSlots(
  current: readonly ApplyWeekSlotDto[],
  target: readonly ApplyWeekSlotDto[],
  memberIds: readonly string[],
): { slots: ApplyWeekSlotDto[]; dropped: ApplyWeekSlotDto[] } {
  const keyOf = (slot: ApplyWeekSlotDto) =>
    `${slot.dayOfWeek}|${slot.mealType}|${slot.recipeId}`;
  const mealOf = (slot: ApplyWeekSlotDto) =>
    `${slot.dayOfWeek}|${slot.mealType}`;
  const allocated = current.filter((slot) => (slot.portions ?? []).length > 0);
  const currentByKey = new Map(current.map((slot) => [keyOf(slot), slot]));
  const targetKeys = new Set(target.map(keyOf));

  // Porcje osób z pozycji z alokacją, które ZNIKAJĄ — per dzień i posiłek.
  const leavingByMeal = new Map<string, Map<string, number>>();
  for (const slot of allocated) {
    if (targetKeys.has(keyOf(slot))) continue;
    const byPerson =
      leavingByMeal.get(mealOf(slot)) ?? new Map<string, number>();
    for (const portion of slot.portions ?? []) {
      if (!byPerson.has(portion.userId)) {
        byPerson.set(portion.userId, portion.servings);
      }
    }
    leavingByMeal.set(mealOf(slot), byPerson);
  }

  const carried = new Set<string>();
  const slots = target.map((slot): ApplyWeekSlotDto => {
    if ((slot.portions ?? []).length > 0 || slot.portionPolicy) return slot;
    const existing = currentByKey.get(keyOf(slot));
    if (existing) {
      return (existing.portions ?? []).length > 0
        ? { ...slot, portionPolicy: 'PRESERVE' }
        : slot;
    }
    const leaving = leavingByMeal.get(mealOf(slot));
    if (!leaving) return slot;
    const audience = slot.participantIds?.length
      ? slot.participantIds
      : memberIds;
    if (!audience.some((userId) => leaving.has(userId))) return slot;
    carried.add(mealOf(slot));
    const { plannedServings: _derived, ...rest } = slot;
    return {
      ...rest,
      portions: [...new Set(audience)]
        .sort((a, b) => a.localeCompare(b))
        .map((userId) => ({
          userId,
          servings: leaving.get(userId) ?? JOINED_PORTION_SERVINGS,
        })),
    };
  });

  const dropped = allocated.filter(
    (slot) => !targetKeys.has(keyOf(slot)) && !carried.has(mealOf(slot)),
  );
  return { slots, dropped };
}
