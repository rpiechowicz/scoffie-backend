import { Prisma } from '@prisma/client';
import { TURN_TIMEOUT_GRACE_MS } from '../config/agent-env';

/**
 * Co ile runner odświeża `AgentTurn.updatedAt` tury BEZ lease (wykonanie
 * poza kolejką: testy jednostkowe, tury sprzed Etapu 5). Tura pod lease
 * odnawia go co ⅓ `AI_TURN_LEASE_MS` (`turn-lease-config.ts`).
 */
export const TURN_HEARTBEAT_MS = 15_000;

/**
 * Po ilu ms bez znaku życia STARA tura RUNNING (bez `deadlineAt`, sprzed
 * Etapu 5) uchodzi za osieroconą. Tury z trwałym wykonaniem nie są
 * osierocane — wygasły lease znaczy „do przejęcia", nie „martwa".
 */
export const TURN_ORPHAN_AFTER_MS = 60_000;

/** Dokładne powody domknięcia tury przez sprzątanie (`AgentTurn.failureDetail`). */
export const TURN_FAILURE_DETAIL = {
  deadline: 'AI_TURN_DEADLINE',
  legacyOrphan: 'AI_TURN_LEGACY_ORPHAN',
  attemptsExhausted: 'AI_TURN_ATTEMPTS_EXHAUSTED',
  cancelRequested: 'AI_TURN_CANCEL_REQUESTED',
} as const;

export type TurnCloseVerdict = {
  /** Kod dla telefonu — tylko znane mu wartości (kontrakt bez zmian). */
  errorCode: 'AI_TIMEOUT' | 'AI_PROVIDER_ERROR' | 'AI_CANCELLED';
  /** Dokładny powód dla operatora. */
  detail: (typeof TURN_FAILURE_DETAIL)[keyof typeof TURN_FAILURE_DETAIL];
  outcome: 'timeout' | 'failed';
};

export type TurnLivenessRow = {
  startedAt: Date;
  updatedAt: Date;
  deadlineAt: Date | null;
  attempt: number;
  leaseExpiresAt: Date | null;
  cancelRequestedAt: Date | null;
};

/**
 * Werdykt dla JEDNEJ tury RUNNING (workstream, Etap 5); `null` = żyje albo
 * czeka na przejęcie przez workera — NIE domykać.
 *
 * Kolejność:
 * 1. Po terminie CAŁEJ tury (+ margines) — `AI_TIMEOUT`, zawsze. Worker ma
 *    własny zegar do tego samego terminu, więc skoro tura wciąż wisi, nikt jej
 *    już nie dokończy.
 * 2. Tura sprzed Etapu 5 (bez `deadlineAt`): jak dawniej — minuta bez znaku
 *    życia i nie w tym procesie = `AI_PROVIDER_ERROR` (nie da się jej
 *    odtworzyć, nie ma zapisanego wejścia).
 * 3. Tura z żywym lease albo prowadzona przez ten proces — żyje.
 * 4. Bez żywego lease: „Stop" = `AI_CANCELLED`; wyczerpane próby =
 *    `AI_PROVIDER_ERROR` (`AI_TURN_ATTEMPTS_EXHAUSTED`); inaczej — do
 *    przejęcia (RECLAIMABLE), `null`.
 */
export function turnCloseVerdict(
  turn: TurnLivenessRow,
  options: {
    turnTimeoutMs: number;
    maxAttempts: number;
    inProcess: boolean;
    now?: number;
  },
): TurnCloseVerdict | null {
  const now = options.now ?? Date.now();
  const deadline =
    turn.deadlineAt?.getTime() ??
    turn.startedAt.getTime() + options.turnTimeoutMs;
  if (now >= deadline + TURN_TIMEOUT_GRACE_MS) {
    return {
      errorCode: 'AI_TIMEOUT',
      detail: TURN_FAILURE_DETAIL.deadline,
      outcome: 'timeout',
    };
  }
  // Luźno (`!`), bo wiersz bywa niepełny (atrapy, stare selekty): brak
  // kolumny = tura sprzed Etapu 5.
  if (!turn.deadlineAt) {
    if (
      !options.inProcess &&
      now - turn.updatedAt.getTime() >= TURN_ORPHAN_AFTER_MS
    ) {
      return {
        errorCode: 'AI_PROVIDER_ERROR',
        detail: TURN_FAILURE_DETAIL.legacyOrphan,
        outcome: 'failed',
      };
    }
    return null;
  }
  const leaseLive = (turn.leaseExpiresAt?.getTime() ?? 0) > now;
  if (leaseLive || options.inProcess) return null;
  if (turn.cancelRequestedAt) {
    return {
      errorCode: 'AI_CANCELLED',
      detail: TURN_FAILURE_DETAIL.cancelRequested,
      outcome: 'failed',
    };
  }
  if ((turn.attempt ?? 0) >= options.maxAttempts) {
    return {
      errorCode: 'AI_PROVIDER_ERROR',
      detail: TURN_FAILURE_DETAIL.attemptsExhausted,
      outcome: 'failed',
    };
  }
  return null;
}

/** Kolumny potrzebne do werdyktu. */
export const TURN_LIVENESS_SELECT = {
  startedAt: true,
  updatedAt: true,
  deadlineAt: true,
  attempt: true,
  leaseExpiresAt: true,
  cancelRequestedAt: true,
} as const;

/**
 * Warunek Prisma na KANDYDATÓW do domknięcia (nadzbiór — ostateczny werdykt
 * wydaje `turnCloseVerdict`, bo zna mapę runnera).
 */
export function closeCandidatesWhere(
  turnTimeoutMs: number,
  maxAttempts: number,
  now: number = Date.now(),
): Prisma.AgentTurnWhereInput {
  return {
    status: 'RUNNING',
    OR: [
      { deadlineAt: { lte: new Date(now - TURN_TIMEOUT_GRACE_MS) } },
      {
        deadlineAt: null,
        OR: [
          { updatedAt: { lte: new Date(now - TURN_ORPHAN_AFTER_MS) } },
          {
            startedAt: {
              lte: new Date(now - turnTimeoutMs - TURN_TIMEOUT_GRACE_MS),
            },
          },
        ],
      },
      {
        deadlineAt: { not: null },
        AND: [
          {
            OR: [
              { leaseExpiresAt: null },
              { leaseExpiresAt: { lte: new Date(now) } },
            ],
          },
          {
            OR: [
              { cancelRequestedAt: { not: null } },
              { attempt: { gte: maxAttempts } },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Warunek Prisma na turę ŻYWĄ — lease rozmowy, semafor domu, rezerwacja
 * budżetu. Tura z trwałym wykonaniem żyje do swojego terminu (także w
 * przerwie między padem procesu a przejęciem — zaraz ktoś ją dokończy);
 * stara — dopóki ma znak życia.
 */
export function liveTurnWhere(
  turnTimeoutMs: number,
  now: number = Date.now(),
): Prisma.AgentTurnWhereInput {
  return {
    status: 'RUNNING',
    OR: [
      { deadlineAt: { gt: new Date(now) } },
      {
        deadlineAt: null,
        updatedAt: { gt: new Date(now - TURN_ORPHAN_AFTER_MS) },
        startedAt: {
          gt: new Date(now - turnTimeoutMs - TURN_TIMEOUT_GRACE_MS),
        },
      },
    ],
  };
}
