import { DayOfWeek } from '@prisma/client';
import {
  WeekPlanPreview,
  WeekPlanPreviewSlot,
} from '../../weekly-plans/weekly-plans.service';
import { MEAL_TYPES_IN_DAY_ORDER } from '../../common/meal-types';
import {
  AGENT_CARD_VERSION,
  DAY_LABELS,
  MEAL_LABELS,
  PlanDayCard,
  goalNote,
  longDateLabel,
} from './agent-cards';

/**
 * Karta jednego dnia.
 *
 * Osobny builder, a nie tydzień zawężony do jednego wiersza: dzień czyta się
 * inaczej. Tydzień pokazuje UKŁAD — czy coś się nie powtarza, czy piątek nie
 * jest pusty. Dzień pokazuje TALERZ: co po kolei, ile to razem i ile zostaje
 * do celu. Ta sama treść w układzie tygodnia odpowiada na pytanie, którego
 * przy „co na jutro?" nikt nie zadał.
 */
export function buildPlanDayCard(input: {
  proposalId: string;
  weekStart: string;
  dayOfWeek: DayOfWeek;
  date: string;
  preview: WeekPlanPreview;
  note?: string | null;
  targetKcalPerDay: number | null;
  expiresAt: Date;
}): PlanDayCard {
  const slots = (input.preview.slots ?? [])
    .filter((slot) => slot.dayOfWeek === input.dayOfWeek)
    .sort(
      (a, b) =>
        MEAL_TYPES_IN_DAY_ORDER.indexOf(a.mealType) -
        MEAL_TYPES_IN_DAY_ORDER.indexOf(b.mealType),
    );

  const kcalTotal = slots.reduce((sum, slot) => sum + slot.kcalPerServing, 0);

  return {
    kind: 'PLAN_DAY',
    v: AGENT_CARD_VERSION,
    proposalId: input.proposalId,
    weekStart: input.weekStart,
    date: input.date,
    eyebrow: 'Propozycja dnia',
    eyebrowDetail: `${DAY_LABELS[input.dayOfWeek].toLowerCase()}, ${longDateLabel(input.date)}`,
    title: dayTitle(kcalTotal, input.targetKcalPerDay),
    subtitle: input.note?.trim() ? input.note.trim() : null,
    slots: slots.map((slot) => cardSlot(slot)),
    // Tylko usunięcia z TEGO dnia — propozycja dnia nie rusza reszty tygodnia,
    // więc pokazywanie tam czegokolwiek byłoby wprowadzaniem w błąd.
    removed: (input.preview.removed ?? [])
      .filter((removal) => removal.dayOfWeek === input.dayOfWeek)
      .map((removal) => ({
        dayLabel: DAY_LABELS[removal.dayOfWeek],
        mealLabel: MEAL_LABELS[removal.mealType],
        title: removal.title,
      })),
    summary: {
      meals: slots.length,
      kcalTotal,
      targetKcalPerDay: input.targetKcalPerDay,
      goalNote: remainderNote(kcalTotal, input.targetKcalPerDay),
    },
    actions: [
      {
        type: 'APPLY',
        proposalId: input.proposalId,
        label: `Zapisz ${DAY_LABELS[input.dayOfWeek].toLowerCase()}`,
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

function cardSlot(slot: WeekPlanPreviewSlot) {
  return {
    mealType: slot.mealType,
    mealLabel: MEAL_LABELS[slot.mealType],
    recipeId: slot.recipeId,
    title: slot.title,
    kcalPerServing: slot.kcalPerServing,
    prepTimeMinutes: slot.prepTimeMinutes,
    imageUrl: slot.imageUrl,
    participantIds: slot.participantIds,
    change: slot.change,
  };
}

/**
 * Tytuł mówi, po co ten dzień tak wygląda.
 *
 * „Propozycja dnia” nie niesie żadnej informacji — użytkownik i tak widzi,
 * że to propozycja. Cel niesie: po nim od razu wiadomo, czy plan mieści się
 * w tym, o co go proszono.
 */
function dayTitle(kcalTotal: number, target: number | null): string {
  if (target === null || target <= 0) return `Cały dzień, ${kcalTotal} kcal`;
  return kcalTotal <= target
    ? `Cały dzień pod cel ${target} kcal`
    : `Cały dzień, ${kcalTotal} kcal przy celu ${target}`;
}

/**
 * „zostaje 228” — ile jeszcze wchodzi w cel.
 *
 * Inaczej niż w karcie tygodnia, gdzie liczy się odchylenie średniej: przy
 * jednym dniu użytkownik pyta „czy zmieszczę jeszcze podwieczorek?", a nie
 * „czy trzymam normę".
 */
function remainderNote(kcalTotal: number, target: number | null): string | null {
  if (target === null || target <= 0) return null;
  const left = target - kcalTotal;
  if (left > 0) return `zostaje ${left}`;
  if (left === 0) return 'równo w cel';
  return goalNote(kcalTotal, target, { tolerance: 0 });
}
