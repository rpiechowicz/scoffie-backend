import type { GdprChannel, GdprKind, GdprStatus } from '../contract';

/**
 * Reguły rejestru RODO — czyste funkcje (bez bazy i zegara), wspólne dla
 * serwisu, kart ekranu i reguły w centrum alertów.
 */

export const GDPR_KINDS = [
  'ACCESS',
  'ERASURE',
  'RECTIFICATION',
  'RESTRICTION',
  'OBJECTION',
  'PORTABILITY',
] as const satisfies readonly GdprKind[];

export const GDPR_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'DONE',
  'REJECTED',
] as const satisfies readonly GdprStatus[];

export const GDPR_CHANNELS = [
  'EMAIL',
  'APP',
  'STORE',
  'POST',
  'OTHER',
] as const satisfies readonly GdprChannel[];

/** Wniosek w toku — liczy się do terminu. */
export const GDPR_OPEN_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Termin ustawowy (art. 12 ust. 3): „miesiąc” liczymy jako 30 dni —
 * krócej niż kalendarzowy miesiąc najwyżej o dzień, więc zawsze bezpiecznie.
 */
export const GDPR_DUE_DAYS = 30;
/** Przedłużenie „o dwa kolejne miesiące” przy sprawach złożonych. */
export const GDPR_EXTENSION_DAYS = 60;
/** Od tylu dni przed terminem wniosek jest „bliski terminu” (karta + alert). */
export const GDPR_WARN_DAYS = 7;

export function gdprDueAt(receivedAt: Date): Date {
  return new Date(receivedAt.getTime() + GDPR_DUE_DAYS * DAY_MS);
}

export function gdprExtendedDueAt(receivedAt: Date): Date {
  return new Date(
    receivedAt.getTime() + (GDPR_DUE_DAYS + GDPR_EXTENSION_DAYS) * DAY_MS,
  );
}

export function isGdprOpen(status: string): boolean {
  return (GDPR_OPEN_STATUSES as readonly string[]).includes(status);
}

export type GdprUrgency = 'overdue' | 'due-soon' | 'ok';

/** Tylko dla otwartych — zamknięty wniosek nie ma już terminu. */
export function gdprUrgency(dueAt: Date, now: Date): GdprUrgency {
  const left = dueAt.getTime() - now.getTime();
  if (left < 0) return 'overdue';
  if (left < GDPR_WARN_DAYS * DAY_MS) return 'due-soon';
  return 'ok';
}

/** Pełne doby do terminu (ujemne po terminie) — do treści alertu. */
export function gdprDaysLeft(dueAt: Date, now: Date): number {
  const left = dueAt.getTime() - now.getTime();
  return left >= 0 ? Math.ceil(left / DAY_MS) : -Math.ceil(-left / DAY_MS);
}

export const GDPR_KIND_LABELS: Record<GdprKind, string> = {
  ACCESS: 'dostęp (art. 15)',
  ERASURE: 'usunięcie (art. 17)',
  RECTIFICATION: 'sprostowanie (art. 16)',
  RESTRICTION: 'ograniczenie (art. 18)',
  OBJECTION: 'sprzeciw (art. 21)',
  PORTABILITY: 'przeniesienie (art. 20)',
};
