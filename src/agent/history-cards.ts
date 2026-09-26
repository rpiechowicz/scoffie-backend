import { fenceSafe } from './fence-safe';

/**
 * Karty z poprzednich tur w historii dla MODELU — zwięzły dopisek do tekstu
 * wiadomości asystenta (workstream, Etap 1).
 *
 * DLACZEGO. Historia niosła sam `text`, a karta jest DODATKIEM do tekstu,
 * więc w kolejnej turze model nie wiedział, co pokazał: „wybieram drugą" nie
 * miało do czego się odnieść, a „zamień tylko wtorek" kończyło się układaniem
 * tygodnia od nowa. Pełny JSON karty to kilka tysięcy tokenów etykiet dla
 * telefonu (napisy, zdjęcia, stan przycisków) w każdej turze — dlatego
 * dopisek jest minimalny i stabilny:
 *
 *   • OPTIONS — opcje w kolejności kafelków: „1) R012 Tytuł; 2) …"; numer
 *     to pozycja na ekranie, niezależna od tego, jak model ułożył tekst;
 *   • najnowsza propozycja PLAN_WEEK/PLAN_DAY — id, status Z BAZY (karta
 *     w historii niesie stan z chwili zapisu, a liczy się dzisiejszy)
 *     i pozycje „MON DINNER R045 Tytuł (dla: …)" — dokładnie to, czego
 *     potrzebuje `revise_proposal`;
 *   • starsze propozycje — jedna linia (id i status), bo i tak nie są już
 *     tym, o czym mówi użytkownik.
 *
 * Referencje jak wszędzie indziej: `R…` z indeksu katalogu tury, przepis
 * gospodarstwa własnym identyfikatorem. Domownik bez zgody na asystenta idzie
 * jako liczba (`+1`), jak w `projectWeekPlanForModel`. Tytuły są danymi od
 * ludzi, więc przechodzą przez `fenceSafe`, jak wyniki narzędzi.
 */

/** Wiersz historii — to, co runner czyta z `AgentMessage`. */
export type HistoryMessageRow = {
  role: string;
  kind?: string | null;
  text: string;
  card?: unknown;
};

/** Stan propozycji z bazy. */
export type HistoryProposalState = {
  id: string;
  status: string;
  expiresAt: Date | null;
};

export type HistoryCardContext = {
  /** `recipeId` → `R012`. */
  refByRecipeId: ReadonlyMap<string, string>;
  /** Domownicy ze zgodą — tylko ich identyfikatory wolno pokazać modelowi. */
  visibleUserIds: ReadonlySet<string>;
  proposals: ReadonlyMap<string, HistoryProposalState>;
  now: Date;
};

const PLAN_KINDS = new Set(['PLAN_WEEK', 'PLAN_DAY']);

/** Identyfikatory propozycji planu z kart w historii — do jednego zapytania o stan. */
export function planProposalIds(rows: readonly HistoryMessageRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const id = planCardOf(row)?.proposalId;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Tekst wiadomości dla modelu: sam `text` albo `text` + dopisek karty.
 * `rows` chronologicznie — najnowsza propozycja planu dostaje pozycje.
 */
export function historyTexts(
  rows: readonly HistoryMessageRow[],
  context: HistoryCardContext,
): string[] {
  let latestPlan = -1;
  rows.forEach((row, index) => {
    if (planCardOf(row)) latestPlan = index;
  });
  return rows.map((row, index) => {
    if (row.role !== 'ASSISTANT') return row.text;
    const note = cardNote(row, index === latestPlan, context);
    return note ? `${row.text}\n\n${note}` : row.text;
  });
}

function cardNote(
  row: HistoryMessageRow,
  isLatestPlan: boolean,
  context: HistoryCardContext,
): string | null {
  if (row.kind === 'OPTIONS') return optionsNote(row.card, context);
  const plan = planCardOf(row);
  if (plan) return planNote(plan, isLatestPlan, context);
  return null;
}

type OptionsCardLike = {
  eyebrow?: unknown;
  options?: { recipeId?: unknown; title?: unknown }[];
};

function optionsNote(raw: unknown, context: HistoryCardContext): string | null {
  const card = asRecord(raw) as OptionsCardLike | null;
  const options = Array.isArray(card?.options) ? card.options : [];
  if (options.length === 0) return null;
  const items = options
    .map(
      (option, index) =>
        `${index + 1}) ${ref(option.recipeId, context)} ${title(option.title)}`,
    )
    .join('; ');
  const slot =
    typeof card?.eyebrow === 'string' && card.eyebrow.trim()
      ? ` „${fenceSafe(card.eyebrow.trim())}"`
      : '';
  return `[Karta OPTIONS${slot} — opcje w kolejności kafelków: ${items}]`;
}

type PlanSlotLike = {
  mealType?: unknown;
  recipeId?: unknown;
  title?: unknown;
  participantIds?: unknown;
};

type PlanCardLike = {
  kind: string;
  proposalId: string;
  weekStart?: unknown;
  /** PLAN_WEEK. */
  days?: { dayOfWeek?: unknown; slots?: PlanSlotLike[] }[];
  /** PLAN_DAY: dzień wynika z daty, sloty bez dnia. */
  date?: unknown;
  slots?: PlanSlotLike[];
};

function planCardOf(row: HistoryMessageRow): PlanCardLike | null {
  if (row.role !== 'ASSISTANT' || !row.kind || !PLAN_KINDS.has(row.kind)) {
    return null;
  }
  const card = asRecord(row.card);
  if (!card || typeof card.proposalId !== 'string') return null;
  return { ...(card as Omit<PlanCardLike, 'kind'>), kind: row.kind };
}

function planNote(
  card: PlanCardLike,
  isLatest: boolean,
  context: HistoryCardContext,
): string {
  const state = context.proposals.get(card.proposalId);
  const status = !state
    ? 'UNKNOWN'
    : state.status === 'PENDING' &&
        state.expiresAt !== null &&
        state.expiresAt.getTime() <= context.now.getTime()
      ? 'EXPIRED'
      : state.status;
  const week =
    typeof card.weekStart === 'string' ? ` tydzień ${card.weekStart}` : '';
  const head = `Propozycja ${card.kind} ${card.proposalId} status=${status}${week}`;
  if (!isLatest) return `[${head} — starsza wersja]`;
  const positions = planPositions(card, context);
  return positions.length > 0
    ? `[${head}: ${positions.join('; ')}]`
    : `[${head}: bez pozycji]`;
}

function planPositions(
  card: PlanCardLike,
  context: HistoryCardContext,
): string[] {
  const days: { day: string; slots: PlanSlotLike[] }[] = Array.isArray(
    card.days,
  )
    ? card.days.map((day) => ({
        day: typeof day.dayOfWeek === 'string' ? day.dayOfWeek : '?',
        slots: Array.isArray(day.slots) ? day.slots : [],
      }))
    : [
        {
          day: dayOfDate(card.date),
          slots: Array.isArray(card.slots) ? card.slots : [],
        },
      ];
  const lines: string[] = [];
  for (const { day, slots } of days) {
    for (const slot of slots) {
      const meal = typeof slot.mealType === 'string' ? slot.mealType : '?';
      lines.push(
        `${day} ${meal} ${ref(slot.recipeId, context)} ${title(slot.title)}${audience(
          slot.participantIds,
          context,
        )}`,
      );
    }
  }
  return lines;
}

/** „ (dla: <id>, +1)"; puste = cały dom, więc bez dopisku. */
function audience(raw: unknown, context: HistoryCardContext): string {
  const ids = Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === 'string')
    : [];
  if (ids.length === 0) return '';
  const visible = ids.filter((id) => context.visibleUserIds.has(id));
  const hidden = ids.length - visible.length;
  const parts = [...visible, ...(hidden > 0 ? [`+${hidden}`] : [])];
  return ` (dla: ${parts.join(', ')})`;
}

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

/** `YYYY-MM-DD` → `TUE` (UTC, jak cały plan tygodnia). */
function dayOfDate(raw: unknown): string {
  if (typeof raw !== 'string') return '?';
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? '?' : DAY_CODES[date.getUTCDay()];
}

function ref(raw: unknown, context: HistoryCardContext): string {
  if (typeof raw !== 'string' || !raw) return '?';
  return context.refByRecipeId.get(raw) ?? raw;
}

function title(raw: unknown): string {
  return typeof raw === 'string' ? fenceSafe(raw.trim()) : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
