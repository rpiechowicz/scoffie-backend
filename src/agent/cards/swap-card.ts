import { DayOfWeek, MealType } from '@prisma/client';
import {
  AGENT_CARD_VERSION,
  DAY_LABELS,
  MEAL_LABELS,
  SwapCard,
  SwapCardDelta,
  SwapCardSide,
} from './agent-cards';

/**
 * Karta podmiany: PRZED i PO w jednej ramce.
 *
 * Pytanie, z którym użytkownik przychodzi po podmianę, brzmi „co się zmieni”,
 * a nie „co będzie”. Sama nowa pozycja nie odpowiada na nie wcale — dopiero
 * zestawienie ze starą mówi, czy warto.
 */
export function buildSwapCard(input: {
  proposalId: string;
  weekStart: string;
  date: string;
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  from: SwapCardSide | null;
  to: SwapCardSide;
  /** Czego chciał użytkownik: po tym poznajemy, która zmiana jest „dobra”. */
  reason?: string | null;
  /** Imiona osób, których dotyczy podmiana; puste = cały dom. */
  forNames?: readonly string[];
  expiresAt: Date;
}): SwapCard {
  const deltas = buildDeltas(input.from, input.to);

  return {
    kind: 'SWAP',
    v: AGENT_CARD_VERSION,
    proposalId: input.proposalId,
    weekStart: input.weekStart,
    date: input.date,
    eyebrow: eyebrow(input.dayOfWeek, input.mealType, input.forNames ?? []),
    title: swapTitle(deltas, input.reason, input.from !== null),
    from: input.from,
    to: input.to,
    deltas,
    actions: [
      {
        type: 'APPLY',
        proposalId: input.proposalId,
        label: input.from ? 'Podmień' : 'Dodaj do planu',
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
 * Nadtytuł mówi, KOGO dotyczy podmiana.
 *
 * Bez imienia karta „Podmiana · środa, śniadanie" wygląda identycznie dla
 * zmiany całemu domowi i dla wydzielenia jednej porcji — a to są dwie zupełnie
 * różne rzeczy i tylko jedna z nich zabiera jedzenie reszcie.
 */
function eyebrow(
  day: DayOfWeek,
  meal: MealType,
  forNames: readonly string[],
): string {
  const slot = `${DAY_LABELS[day].toLowerCase()}, ${MEAL_LABELS[meal].toLowerCase()}`;
  if (forNames.length === 0) return `Podmiana · ${slot}`;
  // „tylko Rafał", a nie „dla Rafała": polskiej odmiany imion nie da się
  // zrobić regułą — „Rafał → Rafała" działa, „Kinga → Kingi" już nie, a imion
  // nie znamy z góry. Mianownik po „tylko" czyta się naturalnie i nigdy nie
  // wychodzi z niego potworek.
  const who =
    forNames.length === 1
      ? forNames[0]
      : `${forNames.slice(0, -1).join(', ')} i ${forNames[forNames.length - 1]}`;
  return `Podmiana · ${slot} · tylko ${who}`;
}

/**
 * Różnice warte pokazania.
 *
 * Pokazujemy WYŁĄCZNIE te, które faktycznie się zmieniły: „0 min” i „±5 kcal”
 * to szum, który każe szukać zmiany tam, gdzie jej nie ma. „Dobra” jest
 * zawsze ta w dół — przy podmianie prosi się o krócej albo lżej, nigdy
 * odwrotnie; gdyby ktoś chciał więcej, poprosiłby o inne danie, nie o zamianę.
 */
function buildDeltas(
  from: SwapCardSide | null,
  to: SwapCardSide,
): SwapCardDelta[] {
  if (!from) return [];

  const deltas: SwapCardDelta[] = [];
  const minutes = to.prepTimeMinutes - from.prepTimeMinutes;
  if (Math.abs(minutes) >= 5) {
    deltas.push({
      value: `${minutes > 0 ? '+' : '−'}${Math.abs(minutes)} min`,
      label: minutes < 0 ? 'szybciej' : 'dłużej',
      good: minutes < 0,
    });
  }

  const kcal = to.kcalPerServing - from.kcalPerServing;
  if (Math.abs(kcal) >= 30) {
    deltas.push({
      value: `${kcal > 0 ? '+' : '−'}${Math.abs(kcal)} kcal`,
      label: 'na porcję',
      good: kcal < 0,
    });
  }

  return deltas;
}

/**
 * Tytuł mówi, PO CO ta podmiana.
 *
 * „Podmiana dania” byłoby powtórzeniem nadtytułu. Najmocniejsza różnica
 * niesie tu całą informację — a gdy nie ma żadnej, uczciwiej powiedzieć
 * „inne danie” niż udawać, że coś zyskujemy.
 */
function swapTitle(
  deltas: readonly SwapCardDelta[],
  reason: string | null | undefined,
  hadSomething: boolean,
): string {
  if (!hadSomething) return 'Wolne miejsce w planie';

  const best = deltas.find((delta) => delta.good) ?? deltas[0];
  if (best) {
    const amount = best.value.replace(/^[+−]/, '');
    return best.label === 'szybciej' || best.label === 'dłużej'
      ? `${best.good ? 'Szybciej' : 'Dłużej'} o ${amount}`
      : `${best.good ? 'Lżej' : 'Ciężej'} o ${amount}`;
  }
  const trimmed = reason?.trim();
  return trimmed && trimmed.length <= 60 ? trimmed : 'Inne danie w tym slocie';
}
