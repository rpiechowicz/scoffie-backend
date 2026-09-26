import { Prisma } from '@prisma/client';
import { TURN_TIMEOUT_GRACE_MS } from '../config/agent-env';

/**
 * Co ile runner odświeża `AgentTurn.updatedAt` tury w biegu — znak życia
 * procesu, który ją prowadzi. Postęp i szkic też odświeżają tę kolumnę, ale
 * model potrafi myśleć pół minuty bez jednego i drugiego.
 */
export const TURN_HEARTBEAT_MS = 15_000;

/**
 * Po ilu ms bez znaku życia tura RUNNING uchodzi za osieroconą (proces, który
 * ją prowadził, padł: deploy, OOM). Cztery zgubione uderzenia serca — ani
 * jedno opóźnione zapytanie, ani chwilowo zajęta pętla zdarzeń nie zabiją
 * żywej tury, a rozmowa po restarcie odblokowuje się w minutę, nie po
 * `AI_TURN_TIMEOUT_MS` (4 min).
 */
export const TURN_ORPHAN_AFTER_MS = 60_000;

/** Dlaczego tura przestała żyć — decyduje o kodzie błędu przy domknięciu. */
export type OrphanReason = 'heartbeat' | 'timeout';

type LivenessRow = { startedAt: Date; updatedAt: Date };

/**
 * Werdykt dla JEDNEJ tury RUNNING; `null` = żyje.
 *
 * `timeout` (po `AI_TURN_TIMEOUT_MS` + margines) zamyka turę zawsze — runner
 * ma własny zegar i dawno by ją przerwał, więc skoro wciąż biegnie, coś się
 * zacięło. `heartbeat` nie dotyczy tur, które ten proces właśnie prowadzi
 * (`inProcess`): przy jednej instancji tura z mapy runnera żyje z definicji,
 * a cisza znaczy najwyżej zajętą pętlę zdarzeń.
 */
export function orphanReason(
  turn: LivenessRow,
  turnTimeoutMs: number,
  inProcess: boolean,
  now: number = Date.now(),
): OrphanReason | null {
  if (now - turn.startedAt.getTime() >= turnTimeoutMs + TURN_TIMEOUT_GRACE_MS) {
    return 'timeout';
  }
  if (!inProcess && now - turn.updatedAt.getTime() >= TURN_ORPHAN_AFTER_MS) {
    return 'heartbeat';
  }
  return null;
}

/** Kod błędu osieroconej tury: po czasie — timeout, bez znaku życia — pad procesu. */
export function orphanErrorCode(
  reason: OrphanReason,
): 'AI_TIMEOUT' | 'AI_PROVIDER_ERROR' {
  return reason === 'timeout' ? 'AI_TIMEOUT' : 'AI_PROVIDER_ERROR';
}

/**
 * Warunek Prisma na KANDYDATÓW do domknięcia (nadzbiór — ostateczny werdykt
 * i tak wydaje `orphanReason`, bo zna mapę runnera). Chodzi po indeksie
 * `AgentTurn(status, updatedAt)`.
 */
export function orphanCandidatesWhere(
  turnTimeoutMs: number,
  now: number = Date.now(),
): Prisma.AgentTurnWhereInput {
  return {
    status: 'RUNNING',
    OR: [
      { updatedAt: { lte: new Date(now - TURN_ORPHAN_AFTER_MS) } },
      {
        startedAt: {
          lte: new Date(now - turnTimeoutMs - TURN_TIMEOUT_GRACE_MS),
        },
      },
    ],
  };
}

/**
 * Warunek Prisma na turę ŻYWĄ (RUNNING, ze znakiem życia i przed czasem) —
 * semafor domu i rezerwacja budżetu liczą tylko takie, więc tura po padzie
 * procesu nie zjada miejsca, zanim ktoś ją posprząta.
 */
export function liveTurnWhere(
  turnTimeoutMs: number,
  now: number = Date.now(),
): Prisma.AgentTurnWhereInput {
  return {
    status: 'RUNNING',
    updatedAt: { gt: new Date(now - TURN_ORPHAN_AFTER_MS) },
    startedAt: { gt: new Date(now - turnTimeoutMs - TURN_TIMEOUT_GRACE_MS) },
  };
}
