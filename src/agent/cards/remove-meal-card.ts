import { DayOfWeek, MealType } from '@prisma/client';
import {
  AGENT_CARD_VERSION,
  DAY_LABELS,
  MEAL_LABELS,
  RemoveMealCard,
  SwapCardSide,
} from './agent-cards';

/** Dłuższy powód nie mieści się w tytule karty i urywa się w pół słowa. */
const MAX_TITLE_REASON = 60;

/**
 * Karta usunięcia: co znika i z którego miejsca.
 *
 * Przycisk mówi „Usuń z planu”, a nie „Zastosuj”: to jedyna karta, po której
 * czegoś UBYWA, i użytkownik ma to wiedzieć z samego napisu, zanim kliknie.
 * Cofnięcie działa tak samo jak przy każdej innej propozycji — zapis idzie
 * przez tę samą ścieżkę stanu docelowego tygodnia.
 */
export function buildRemoveMealCard(input: {
  proposalId: string;
  weekStart: string;
  date: string;
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  removed: SwapCardSide;
  /** Czego chciał użytkownik albo dlaczego model to usuwa. */
  reason?: string | null;
  /** Imiona osób, którym to danie znika; puste = cały dom. */
  forNames?: readonly string[];
  expiresAt: Date;
}): RemoveMealCard {
  const reason = input.reason?.trim() ?? '';

  return {
    kind: 'REMOVE_MEAL',
    v: AGENT_CARD_VERSION,
    proposalId: input.proposalId,
    weekStart: input.weekStart,
    date: input.date,
    eyebrow: eyebrow(input.dayOfWeek, input.mealType, input.forNames ?? []),
    title:
      reason.length > 0 && reason.length <= MAX_TITLE_REASON
        ? reason
        : `${input.removed.title} znika z planu`,
    removed: input.removed,
    note: reason.length > MAX_TITLE_REASON ? reason : null,
    actions: [
      {
        type: 'APPLY',
        proposalId: input.proposalId,
        label: 'Usuń z planu',
        style: 'PRIMARY',
      },
    ],
    state: {
      status: 'PENDING',
      canApply: true,
      canUndo: false,
      until: input.expiresAt.toISOString(),
    },
  };
}

/**
 * Nadtytuł mówi, KOMU to danie znika — tak samo jak przy podmianie.
 *
 * Bez tego usunięcie jednej porcji i skasowanie posiłku całemu domowi
 * wyglądają w rozmowie identycznie, a tylko jedno z nich zabiera jedzenie
 * reszcie. Imiona zostają w mianowniku po „tylko”, bo polskiej odmiany imion
 * nie da się zrobić regułą (patrz `swap-card.ts`).
 */
function eyebrow(
  day: DayOfWeek,
  meal: MealType,
  forNames: readonly string[],
): string {
  const slot = `${DAY_LABELS[day].toLowerCase()}, ${MEAL_LABELS[meal].toLowerCase()}`;
  if (forNames.length === 0) return `Usunięcie · ${slot}`;
  const who =
    forNames.length === 1
      ? forNames[0]
      : `${forNames.slice(0, -1).join(', ')} i ${forNames[forNames.length - 1]}`;
  return `Usunięcie · ${slot} · tylko ${who}`;
}
