/**
 * Parametry trwałego wykonywania tur (workstream, Etap 5) — czytane z env
 * PRZY KAŻDYM użyciu, jak reszta `AI_*`, więc zmiana nie wymaga builda.
 *
 * - `AI_TURN_LEASE_MS` (30 s): ważność lease workera. Odnawiany co ⅓, więc
 *   dwa zgubione odnowienia z rzędu jeszcze nie oddają tury. Po padzie
 *   procesu (SIGKILL, OOM) nowy worker przejmuje turę najpóźniej po tym czasie;
 *   łagodne zamknięcie zwalnia lease od razu.
 * - `AI_TURN_MAX_ATTEMPTS` (3): ile razy tura może zostać PRZEJĘTA. Odzyskanie
 *   po utracie procesu to nie ponawianie błędów dostawcy — błąd dostawcy
 *   kończy turę w tej samej próbie. Limit chroni przed pętlą deployów, w której
 *   ta sama tura odtwarzałaby się w nieskończoność na nasz rachunek.
 * - `AI_TURN_WORKER` (`on`): `off` = proces przyjmuje tury, ale ich nie
 *   wykonuje (e2e „pad przed startem runnera", instancja tylko do API).
 * - `AI_TURN_WORKER_POLL_MS` (3 s): co ile worker szuka tur bez właściciela.
 * - `AI_TURN_WORKER_CONCURRENCY` (16): najwyżej tyle tur naraz w procesie
 *   z odpytywania (tura przyjęta w TYM procesie startuje od razu, bez kolejki).
 */
export type TurnLeaseConfig = {
  leaseMs: number;
  renewMs: number;
  maxAttempts: number;
  workerEnabled: boolean;
  pollMs: number;
  concurrency: number;
};

export const TURN_LEASE_DEFAULTS = {
  leaseMs: 30_000,
  maxAttempts: 3,
  pollMs: 3_000,
  concurrency: 16,
} as const;

function readInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = (env[key] ?? '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export function readTurnLeaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): TurnLeaseConfig {
  const leaseMs = readInt(
    env,
    'AI_TURN_LEASE_MS',
    TURN_LEASE_DEFAULTS.leaseMs,
    1_000,
    600_000,
  );
  return {
    leaseMs,
    renewMs: Math.max(250, Math.floor(leaseMs / 3)),
    maxAttempts: readInt(
      env,
      'AI_TURN_MAX_ATTEMPTS',
      TURN_LEASE_DEFAULTS.maxAttempts,
      1,
      10,
    ),
    workerEnabled: (env.AI_TURN_WORKER ?? '').trim().toLowerCase() !== 'off',
    pollMs: readInt(
      env,
      'AI_TURN_WORKER_POLL_MS',
      TURN_LEASE_DEFAULTS.pollMs,
      100,
      600_000,
    ),
    concurrency: readInt(
      env,
      'AI_TURN_WORKER_CONCURRENCY',
      TURN_LEASE_DEFAULTS.concurrency,
      1,
      256,
    ),
  };
}

/** Wejście tury zapisane przy przyjęciu — to, czego nie ma w innych kolumnach. */
export type TurnExecutionInput = {
  dates: { weekStart: string; clientToday: string; timeZone: string };
  proposalMode: boolean;
};

export function parseTurnExecution(value: unknown): TurnExecutionInput | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<TurnExecutionInput>;
  const dates = row.dates;
  if (
    !dates ||
    typeof dates.weekStart !== 'string' ||
    typeof dates.clientToday !== 'string' ||
    typeof dates.timeZone !== 'string' ||
    typeof row.proposalMode !== 'boolean'
  ) {
    return null;
  }
  return {
    dates: {
      weekStart: dates.weekStart,
      clientToday: dates.clientToday,
      timeZone: dates.timeZone,
    },
    proposalMode: row.proposalMode,
  };
}

/** Worker stracił prawo do tury — ktoś inny ją przejął albo domknął. */
export class LeaseLostError extends Error {
  constructor(readonly turnId: string) {
    super(`lease tury ${turnId} utracony`);
    this.name = 'LeaseLostError';
  }
}
