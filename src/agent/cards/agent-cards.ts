import { DayOfWeek, MealType } from '@prisma/client';
import { AiCardsMode } from '../../config/agent-env';

/**
 * Karty asystenta — kontrakt z TELEFONEM.
 *
 * Odpowiedź asystenta przestaje być akapitem: `AgentMessage.kind` mówi, czym
 * jest wiadomość, a `AgentMessage.card` niesie jej treść w kształcie, który
 * klient potrafi narysować i na którym potrafi umieścić przycisk.
 *
 * Trzy zasady, od których zależy, czy to się nie rozjedzie:
 *
 * 1. **Liczby i nazwy składa SERWER z bazy.** Model wskazuje wyłącznie
 *    identyfikatory. Kalorie przepisane z pamięci modelu wyglądałyby tak samo
 *    jak prawdziwe i nie byłoby jak odróżnić jednych od drugich.
 * 2. **`text` wiadomości broni się sam.** Karta jest DODATKIEM — klient, który
 *    jej nie zna (starszy build, nowy `kind`), pokazuje zdanie i nic nie traci.
 * 3. **Etykiety są gotowymi polskimi napisami**, jak `progress[].label`. Nowy
 *    rodzaj karty nie wymaga wtedy wydania aplikacji, a klient nie tłumaczy
 *    kodów slotów — tego samego zabrania modelowi prompt systemowy.
 */
export const AGENT_MESSAGE_KINDS = [
  'TEXT',
  'PLAN_WEEK',
  'APPLIED',
] as const;

export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

export function isAgentMessageKind(value: unknown): value is AgentMessageKind {
  return (
    typeof value === 'string' &&
    (AGENT_MESSAGE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Wersja kontraktu karty.
 *
 * Reguła: w obrębie wersji pola tylko się DODAJE i zawsze jako opcjonalne.
 * Zmiana łamiąca podbija `v`, a serwer emituje starą wersję do czasu adopcji
 * buildu — tak samo jak przy `WS_AUTH_MODE`.
 */
export const AGENT_CARD_VERSION = 1;

/**
 * Deklaracja klienta: „umiem narysować kartę".
 *
 * Idzie w `PostMessageDto.clientCapabilities`, a nie w nagłówku ani w wersji
 * builda, bo pyta o UMIEJĘTNOŚĆ, nie o wersję. Build, który dostał karty,
 * i build, który je dopiero dostanie, różnią się dokładnie tym jednym.
 */
export const CARDS_CAPABILITY_V1 = 'cards.v1';

/**
 * Czy ta tura pracuje w trybie propozycji.
 *
 * Jedno miejsce na pytanie „kto zapisuje plan: model czy człowiek", bo
 * odpowiedź musi być IDENTYCZNA w trzech miejscach naraz — w prompcie
 * (co model ma robić), w executorze (czego mu nie wolno) i w kliencie
 * (co zobaczy). Rozjazd któregokolwiek z nich kończy się turą, w której model
 * obiecuje zapisany plan, a plan się nie zapisał.
 *
 * `soft` pyta klienta, bo tryb propozycji bez karty to ślepy zaułek: stary
 * build pokazałby zdanie „zaproponowałem" i ani jednego przycisku.
 */
export function resolveProposalMode(
  mode: AiCardsMode,
  clientCapabilities: readonly string[] | undefined,
): boolean {
  if (mode === 'off') return false;
  if (mode === 'strict') return true;
  return (clientCapabilities ?? []).includes(CARDS_CAPABILITY_V1);
}

/** Przycisk w karcie. Napis przychodzi z serwera, klient go nie wymyśla. */
export type AgentCardAction = {
  type: 'APPLY' | 'UNDO' | 'OPEN_PLAN';
  proposalId: string | null;
  label: string;
  style: 'PRIMARY' | 'SECONDARY';
};

/**
 * Stan karty liczony PRZY ODCZYCIE, nigdy zapisywany.
 *
 * Karta w historii jest żywym sterownikiem, nie zdjęciem: po tygodniu, na
 * drugim telefonie i po ręcznej zmianie planu ma pokazywać prawdę o tym, czy
 * przycisk jeszcze cokolwiek zrobi.
 */
export type AgentCardState = {
  status: 'PENDING' | 'APPLIED' | 'UNDONE' | 'STALE' | 'EXPIRED' | 'FAILED';
  canApply: boolean;
  canUndo: boolean;
  /** Do kiedy da się kliknąć (ISO 8601); `null` = bez terminu. */
  until: string | null;
};

export type PlanWeekCardSlot = {
  mealType: MealType;
  /** „Obiad” — klient nie pokazuje kodów slotów. */
  mealLabel: string;
  recipeId: string;
  title: string;
  /** Kalorie NA PORCJĘ — karta mówi o talerzu, nie o garnku. */
  kcalPerServing: number;
  prepTimeMinutes: number;
  /** Puste = całe gospodarstwo. */
  participantIds: string[];
  change: 'NEW' | 'KEPT';
};

export type PlanWeekCardDay = {
  dayOfWeek: DayOfWeek;
  /** „Poniedziałek”. */
  dayLabel: string;
  /** `YYYY-MM-DD` — policzone z `weekStart`, nie przez model. */
  date: string;
  slots: PlanWeekCardSlot[];
  /** Suma kalorii dnia na osobę — po tym widać, czy plan dowozi cel. */
  kcalTotal: number;
};

export type PlanWeekCardRemoval = {
  dayLabel: string;
  mealLabel: string;
  title: string;
};

export type PlanWeekCard = {
  kind: 'PLAN_WEEK';
  v: number;
  proposalId: string;
  weekStart: string;
  title: string;
  /** Jedno zdanie modelu „dlaczego tak”; `null`, gdy nic nie dopisał. */
  subtitle: string | null;
  days: PlanWeekCardDay[];
  /** Co ZNIKNIE po zapisaniu — zmiana planu nigdy nie jest cicha. */
  removed: PlanWeekCardRemoval[];
  summary: {
    meals: number;
    created: number;
    updated: number;
    removed: number;
    /** Średnia dzienna z pozycji propozycji (na osobę). */
    averageKcalPerDay: number;
    /** Cel pytającego; `null`, gdy nie ma go w preferencjach. */
    targetKcalPerDay: number | null;
  };
  actions: AgentCardAction[];
  state: AgentCardState;
};

export type AppliedCard = {
  kind: 'APPLIED';
  v: number;
  proposalId: string;
  weekStart: string;
  title: string;
  summary: { created: number; updated: number; removed: number };
  /**
   * Czego „Cofnij” NIE przywróci. Kaskada przy usuwaniu pozycji zabiera
   * odhaczone „zjedzone”, a użytkownik ma o tym wiedzieć PRZED kliknięciem.
   */
  notes: string[];
  actions: AgentCardAction[];
  state: AgentCardState;
};

export type AgentCard = PlanWeekCard | AppliedCard;

/** Nazwa posiłku w mianowniku — do etykiety wiersza w karcie. */
export const MEAL_LABELS: Record<MealType, string> = {
  BREAKFAST: 'Śniadanie',
  SECOND_BREAKFAST: 'II śniadanie',
  LUNCH: 'Obiad',
  AFTERNOON_SNACK: 'Podwieczorek',
  DINNER: 'Kolacja',
  SNACK: 'Przekąska',
};

/** Nazwa dnia w mianowniku — „Poniedziałek”, nie „na poniedziałek”. */
export const DAY_LABELS: Record<DayOfWeek, string> = {
  MON: 'Poniedziałek',
  TUE: 'Wtorek',
  WED: 'Środa',
  THU: 'Czwartek',
  FRI: 'Piątek',
  SAT: 'Sobota',
  SUN: 'Niedziela',
};

/** Kolejność dni tygodnia — ta sama co w enumie Prismy. */
export const DAYS_IN_WEEK_ORDER: readonly DayOfWeek[] = [
  DayOfWeek.MON,
  DayOfWeek.TUE,
  DayOfWeek.WED,
  DayOfWeek.THU,
  DayOfWeek.FRI,
  DayOfWeek.SAT,
  DayOfWeek.SUN,
];

/**
 * Data dnia tygodnia liczona z poniedziałka.
 *
 * Model dat nie liczy (mówi o tym prompt), a karta pokazuje „Wtorek 2.09” —
 * więc liczy je serwer, w UTC, tak jak reszta planu tygodnia.
 */
export function dateForDay(weekStart: string, day: DayOfWeek): string {
  const index = DAYS_IN_WEEK_ORDER.indexOf(day);
  const base = new Date(`${weekStart}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + Math.max(0, index));
  return base.toISOString().slice(0, 10);
}
