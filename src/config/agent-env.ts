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

/**
 * Poziom wysiłku modelu (`output_config.effort`).
 *
 * Domyślnie `medium`, a nie `high` z API: model kosztowy liczy tury właśnie
 * dla `medium`, więc `high` po cichu podniósłby rachunek ponad to, co
 * policzone. Podniesienie to świadoma decyzja, nie ustawienie domyślne.
 */
export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];
export const AI_EFFORT_DEFAULT: AiEffort = 'medium';

export type AgentEnv = {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  effort: AiEffort;
  apiKeyPresent: boolean;
  /** Twardy limit jednej tury (AbortSignal); po nim tura = FAILED `AI_TIMEOUT`. */
  turnTimeoutMs: number;
  /** Kwoty per gospodarstwo i miesiąc — liczniki w `AiUsageCounter`. */
  messagesPerMonth: number;
  plansPerMonth: number;
  /**
   * Globalny bezpiecznik kosztu na dobę (USD); `null` = bez limitu.
   *
   * `null` można dziś dostać WYŁĄCZNIE przez jawne `AI_GLOBAL_DAILY_BUDGET_USD=off`.
   * Wcześniej brak zmiennej znaczył „bez limitu" — czyli instalacja bez
   * żadnego hamulca wydatków wyglądała dokładnie tak samo jak instalacja
   * skonfigurowana. Domyślna jest teraz liczba, a nieskończoność wymaga decyzji.
   */
  globalDailyBudgetUsd: number | null;
  /** Opóźnienie odpowiedzi providera `stub` (testy lease/timeoutu). */
  stubDelayMs: number;
};

export const AGENT_ENV_DEFAULTS = {
  turnTimeoutMs: 90_000,
  messagesPerMonth: 200,
  plansPerMonth: 30,
  /**
   * Siatka, nie polityka: zmierzone tury kosztują $0,12–$1,00, więc $5 na dobę
   * to około trzydziestu tur — więcej, niż zrobi normalne gospodarstwo, i o rząd
   * wielkości mniej, niż potrafi spalić pętla. Kto chce inaczej, ustawia liczbę
   * albo `off`; brak zmiennej nie może znaczyć „bez limitu".
   */
  globalDailyBudgetUsd: 5,
  stubDelayMs: 0,
} as const;

/** Jedyna droga do braku budżetu — jawna i widoczna w `railway variables`. */
export const AI_BUDGET_OFF = 'off';

type NumericKey =
  | 'AI_TURN_TIMEOUT_MS'
  | 'AI_LIMIT_MESSAGES_PER_MONTH'
  | 'AI_LIMIT_PLANS_PER_MONTH'
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

function readEffort(env: NodeJS.ProcessEnv): AiEffort {
  const raw = (env.AI_EFFORT ?? '').trim().toLowerCase();
  return (AI_EFFORTS as readonly string[]).includes(raw)
    ? (raw as AiEffort)
    : AI_EFFORT_DEFAULT;
}

function readProvider(env: NodeJS.ProcessEnv): AiProvider {
  const raw = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'stub' ? 'stub' : 'anthropic';
}

/**
 * Budżet dobowy: liczba ≥ 0, `off` (bez limitu) albo domyślna.
 *
 * `0` jest legalne i znaczy „zatrzymaj wszystko" — inaczej niż przy limitach
 * żądań, gdzie zero blokowałoby aplikację przez pomyłkę w env. Tutaj jedynym
 * skutkiem jest wyłączony asystent, a to bywa dokładnie tym, o co chodzi.
 */
function readDailyBudgetUsd(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.AI_GLOBAL_DAILY_BUDGET_USD ?? '').trim().toLowerCase();
  if (!raw) return AGENT_ENV_DEFAULTS.globalDailyBudgetUsd;
  if (raw === AI_BUDGET_OFF) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return AGENT_ENV_DEFAULTS.globalDailyBudgetUsd;
  }
  return parsed;
}

export function readAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  return {
    enabled: (env.AI_ENABLED ?? '').trim().toLowerCase() === 'true',
    provider: readProvider(env),
    model: (env.AI_MODEL ?? '').trim() || AI_MODEL_DEFAULT,
    effort: readEffort(env),
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
    globalDailyBudgetUsd: readDailyBudgetUsd(env),
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
  const effortRaw = (env.AI_EFFORT ?? '').trim().toLowerCase();
  if (effortRaw && !(AI_EFFORTS as readonly string[]).includes(effortRaw)) {
    problems.push(
      `AI_EFFORT=${effortRaw} — dozwolone: ${AI_EFFORTS.join(', ')} (przy złej wartości działa ${AI_EFFORT_DEFAULT})`,
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
  const budgetRaw = (env.AI_GLOBAL_DAILY_BUDGET_USD ?? '').trim();
  if (budgetRaw && budgetRaw.toLowerCase() !== AI_BUDGET_OFF) {
    const parsed = Number(budgetRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      problems.push(
        `AI_GLOBAL_DAILY_BUDGET_USD=${budgetRaw} — oczekiwana liczba ≥ 0 albo ${AI_BUDGET_OFF} ` +
          `(przy złej wartości działa domyślne $${AGENT_ENV_DEFAULTS.globalDailyBudgetUsd}/dobę)`,
      );
    }
  }
  const numeric: Array<[NumericKey, { min: number; integer: boolean }]> = [
    ['AI_TURN_TIMEOUT_MS', { min: 1, integer: true }],
    ['AI_LIMIT_MESSAGES_PER_MONTH', { min: 0, integer: true }],
    ['AI_LIMIT_PLANS_PER_MONTH', { min: 0, integer: true }],
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
