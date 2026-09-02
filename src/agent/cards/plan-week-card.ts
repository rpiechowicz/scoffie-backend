import {
  WeekPlanPreview,
  WeekPlanPreviewSlot,
} from '../../weekly-plans/weekly-plans.service';
import {
  AGENT_CARD_VERSION,
  DAYS_IN_WEEK_ORDER,
  DAY_LABELS,
  DAY_SHORT_LABELS,
  MEAL_LABELS,
  PlanWeekCard,
  PlanWeekCardDay,
  dateForDay,
  goalNote,
  shortDateLabel,
  weekRangeLabel,
  PlanRemovalReason,
  removalReasonFor,
  kcalForPerson,
  coversWholeDay,
} from './agent-cards';
import { MEAL_TYPES_IN_DAY_ORDER } from '../../common/meal-types';

/**
 * Składa kartę propozycji z policzonego podglądu tygodnia.
 *
 * Czysta funkcja i to jest celowe: karta to jedyna rzecz, którą użytkownik
 * naprawdę czyta przed kliknięciem „Dodaj do planu”, więc jej treść musi dać
 * się sprawdzić testem bez bazy, dostawcy i tury.
 *
 * Dni i posiłki układamy w porządku dnia, nie w kolejności, w jakiej model
 * wypisał sloty — plan czyta się od poniedziałku rano.
 */
export function buildPlanWeekCard(input: {
  proposalId: string;
  weekStart: string;
  preview: WeekPlanPreview;
  note?: string | null;
  targetKcalPerDay: number | null;
  expiresAt: Date;
  applyLabel?: string;
  /** Powody usunięć od modelu — jedno słowo przy każdym zniknięciu. */
  removalReasons?: readonly PlanRemovalReason[];
  /** Dla kogo liczyć kalorie dnia (pytający); brak = jak dotąd, wspólne. */
  forUserId?: string;
  /** Sloty planowane przez dom — nota celu tylko, gdy dzień jest pełny. */
  enabledMealTypes?: readonly string[];
}): PlanWeekCard {
  const slots = input.preview.slots ?? [];
  const byDay = new Map<string, WeekPlanPreviewSlot[]>();
  for (const slot of slots) {
    const bucket = byDay.get(slot.dayOfWeek) ?? [];
    bucket.push(slot);
    byDay.set(slot.dayOfWeek, bucket);
  }

  const days: PlanWeekCardDay[] = DAYS_IN_WEEK_ORDER.filter((day) =>
    byDay.has(day),
  ).map((day) => {
    const daySlots = [...(byDay.get(day) ?? [])].sort(
      (a, b) =>
        MEAL_TYPES_IN_DAY_ORDER.indexOf(a.mealType) -
        MEAL_TYPES_IN_DAY_ORDER.indexOf(b.mealType),
    );
    const date = dateForDay(input.weekStart, day);
    return {
      dayOfWeek: day,
      dayLabel: DAY_LABELS[day],
      dayShort: DAY_SHORT_LABELS[day],
      date,
      dateLabel: shortDateLabel(date),
      slots: daySlots.map((slot) => ({
        mealType: slot.mealType,
        mealLabel: MEAL_LABELS[slot.mealType],
        recipeId: slot.recipeId,
        title: slot.title,
        kcalPerServing: slot.kcalPerServing,
        prepTimeMinutes: slot.prepTimeMinutes,
        imageUrl: slot.imageUrl,
        participantIds: slot.participantIds,
        change: slot.change,
      })),
      kcalTotal: kcalForPerson(daySlots, input.forUserId),
    };
  });
  // Plan „tylko obiady" porównywany z celem CAŁEGO dnia zawsze pokazywałby
  // ogromny deficyt — nota i cel znikają, gdy jakiś dzień nie jest pełny.
  const wholeDays =
    days.length > 0 &&
    days.every((day) =>
      coversWholeDay(
        slots.filter((slot) => slot.dayOfWeek === day.dayOfWeek),
        input.enabledMealTypes,
      ),
    );

  const averageKcalPerDay = days.length
    ? Math.round(
        days.reduce((sum, day) => sum + day.kcalTotal, 0) / days.length,
      )
    : 0;

  return {
    kind: 'PLAN_WEEK',
    v: AGENT_CARD_VERSION,
    proposalId: input.proposalId,
    weekStart: input.weekStart,
    eyebrow: 'Propozycja planu',
    eyebrowDetail: weekRangeLabel(input.weekStart),
    title: cardTitle(slots),
    subtitle: input.note?.trim() ? input.note.trim() : null,
    days,
    removed: (input.preview.removed ?? []).map((removal) => ({
      dayLabel: DAY_LABELS[removal.dayOfWeek],
      mealLabel: MEAL_LABELS[removal.mealType],
      title: removal.title,
      dayOfWeek: removal.dayOfWeek,
      mealType: removal.mealType,
      recipeId: removal.recipeId,
      reason: removalReasonFor(input.removalReasons, removal),
    })),
    summary: {
      meals: slots.length,
      created: input.preview.changes.created,
      updated: input.preview.changes.updated,
      removed: input.preview.changes.deleted,
      averageKcalPerDay,
      targetKcalPerDay: wholeDays ? input.targetKcalPerDay : null,
      goalNote: wholeDays
        ? goalNote(averageKcalPerDay, input.targetKcalPerDay)
        : null,
    },
    actions: [
      {
        type: 'APPLY',
        proposalId: input.proposalId,
        label: input.applyLabel ?? 'Dodaj do planu',
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
 * Tytuł mówi, CZEGO dotyczy propozycja — „Obiady i kolacje na tydzień”, a nie
 * „Propozycja planu”. Wypisujemy realnie zaproponowane posiłki, bo to jest
 * pierwsza rzecz, którą użytkownik sprawdza: czy asystek dotknął śniadań.
 */
function cardTitle(slots: readonly WeekPlanPreviewSlot[]): string {
  if (slots.length === 0) return 'Propozycja planu';

  const present = MEAL_TYPES_IN_DAY_ORDER.filter((meal) =>
    slots.some((slot) => slot.mealType === meal),
  );
  if (present.length === 0) return 'Propozycja planu';
  if (present.length >= 4) return 'Plan na tydzień';

  const labels = present.map((meal) => MEAL_LABELS[meal].toLowerCase());
  const head = labels.slice(0, -1).join(', ');
  const tail = labels[labels.length - 1];
  const list = head ? `${head} i ${tail}` : tail;

  return `${list.charAt(0).toUpperCase()}${list.slice(1)} na tydzień`;
}
