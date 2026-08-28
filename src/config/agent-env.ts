/**
 * Konfiguracja asystenta AI (`src/agent/`) z env — czytana PER WYWOŁANIE,
 * nie przy imporcie (jak `resolveWsAuthMode`): e2e włącza asystenta w jednym
 * procesie, a zmiana flagi na Railway nie ma wymagać nowego builda.
 *
 * Zasada Fazy 0: przy `AI_ENABLED` pustym/`false` NIC nie jest wymagane —
 * merge nie potrzebuje żadnej zmiennej na Railway. Dopiero `AI_ENABLED=true`
 * z dostawcą `anthropic` wymaga klucza; wartość klucza nigdy nie trafia do
 * komunikatów ani logów.
 */
export const AI_PROVIDERS = ['anthropic', 'stub'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_MODEL_DEFAULT = 'claude-sonnet-5';

export type AgentEnv = {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  apiKeyPresent: boolean;
  /** Twardy limit jednej tury (AbortSignal); po nim tura = FAILED `AI_TIMEOUT`. */
  turnTimeoutMs: number;
  /** Kwoty per gospodarstwo i miesiąc — liczniki w `AiUsageCounter`. */
  messagesPerMonth: number;
  plansPerMonth: number;
  /** Globalny bezpiecznik kosztu na dobę (USD); `null` = bez limitu. */
  globalDailyBudgetUsd: number | null;
  /** Opóźnienie odpowiedzi providera `stub` (testy lease/timeoutu). */
  stubDelayMs: number;
};

export const AGENT_ENV_DEFAULTS = {
  turnTimeoutMs: 90_000,
  messagesPerMonth: 200,
  plansPerMonth: 30,
  stubDelayMs: 0,
} as const;

type NumericKey =
  | 'AI_TURN_TIMEOUT_MS'
  | 'AI_LIMIT_MESSAGES_PER_MONTH'
  | 'AI_LIMIT_PLANS_PER_MONTH'
  | 'AI_GLOBAL_DAILY_BUDGET_USD'
  | 'AI_STUB_DELAY_MS';

function readNumber(
  env: NodeJS.ProcessEnv,
  key: NumericKey,
  fallback: number,
  { min = 0, integer = true }: { min?: number; integer?: boolean } = {},
): number {
  const raw = (env[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (
    !Number.isFinite(parsed) ||
    parsed < min ||
    (integer && !Number.isInteger(parsed))
  ) {
    return fallback;
  }
  return parsed;
}

function readProvider(env: NodeJS.ProcessEnv): AiProvider {
  const raw = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'stub' ? 'stub' : 'anthropic';
}

export function readAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  const budgetRaw = (env.AI_GLOBAL_DAILY_BUDGET_USD ?? '').trim();
  const budget = budgetRaw
    ? readNumber(env, 'AI_GLOBAL_DAILY_BUDGET_USD', -1, {
        min: 0,
        integer: false,
      })
    : -1;
  return {
    enabled: (env.AI_ENABLED ?? '').trim().toLowerCase() === 'true',
    provider: readProvider(env),
    model: (env.AI_MODEL ?? '').trim() || AI_MODEL_DEFAULT,
    apiKeyPresent: (env.ANTHROPIC_API_KEY ?? '').trim().length > 0,
    turnTimeoutMs: readNumber(
      env,
      'AI_TURN_TIMEOUT_MS',
      AGENT_ENV_DEFAULTS.turnTimeoutMs,
      { min: 1 },
    ),
    messagesPerMonth: readNumber(
      env,
      'AI_LIMIT_MESSAGES_PER_MONTH',
      AGENT_ENV_DEFAULTS.messagesPerMonth,
    ),
    plansPerMonth: readNumber(
      env,
      'AI_LIMIT_PLANS_PER_MONTH',
      AGENT_ENV_DEFAULTS.plansPerMonth,
    ),
    globalDailyBudgetUsd: budget < 0 ? null : budget,
    stubDelayMs: readNumber(
      env,
      'AI_STUB_DELAY_MS',
      AGENT_ENV_DEFAULTS.stubDelayMs,
    ),
  };
}

/**
 * Problemy konfiguracji do `assert-env` (naruszenie na prod, ostrzeżenie w
 * dev/CI). Komunikaty bez wartości zmiennych — klucz API to sekret.
 */
export function agentEnvProblems(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const problems: string[] = [];
  const enabledRaw = (env.AI_ENABLED ?? '').trim().toLowerCase();
  if (enabledRaw && enabledRaw !== 'true' && enabledRaw !== 'false') {
    problems.push(
      `AI_ENABLED=${enabledRaw} — dozwolone: true, false (przy złej wartości asystent jest wyłączony)`,
    );
  }
  const providerRaw = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  if (
    providerRaw &&
    !(AI_PROVIDERS as readonly string[]).includes(providerRaw)
  ) {
    problems.push(
      `AI_PROVIDER=${providerRaw} — dozwolone: ${AI_PROVIDERS.join(', ')} (przy złej wartości działa jak anthropic)`,
    );
  }
  const agent = readAgentEnv(env);
  if (agent.enabled && agent.provider === 'anthropic' && !agent.apiKeyPresent) {
    problems.push(
      'ANTHROPIC_API_KEY jest pusty (AI_ENABLED=true, AI_PROVIDER=anthropic)',
    );
  }
  const numeric: Array<[NumericKey, { min: number; integer: boolean }]> = [
    ['AI_TURN_TIMEOUT_MS', { min: 1, integer: true }],
    ['AI_LIMIT_MESSAGES_PER_MONTH', { min: 0, integer: true }],
    ['AI_LIMIT_PLANS_PER_MONTH', { min: 0, integer: true }],
    ['AI_GLOBAL_DAILY_BUDGET_USD', { min: 0, integer: false }],
    ['AI_STUB_DELAY_MS', { min: 0, integer: true }],
  ];
  for (const [key, opts] of numeric) {
    const raw = (env[key] ?? '').trim();
    if (!raw) continue;
    const parsed = Number(raw);
    const bad =
      !Number.isFinite(parsed) ||
      parsed < opts.min ||
      (opts.integer && !Number.isInteger(parsed));
    if (bad) {
      problems.push(
        `${key}=${raw} — oczekiwana ${opts.integer ? 'liczba całkowita' : 'liczba'} ≥ ${opts.min} (przy złej wartości działa domyślna)`,
      );
    }
  }
  return problems;
}
