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
/**
 * Margines nad `AI_TURN_TIMEOUT_MS`, po którym turę uznaje się za martwą.
 *
 * Mieszka w konfiguracji, a nie przy turach, bo tę samą granicę muszą znać
 * TRZY miejsca: leniwe domknięcie tury, lease przy wysyłce i lista rozmów
 * (żeby nie pokazywała martwej tury jako biegnącej). Dwie definicje tego
 * progu znaczyłyby, że lista mówi co innego niż wysyłka.
 */
export const TURN_TIMEOUT_GRACE_MS = 5_000;

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
/**
 * Tryb kart i propozycji.
 *
 * `off` — jak dotąd: model sam zapisuje plan w trakcie tury. Dźwignia
 * awaryjna, gdy coś w nowej ścieżce zawiedzie na produkcji.
 * `soft` — tryb propozycji dostają wyłącznie klienci, którzy zadeklarowali,
 * że umieją narysować kartę (`clientCapabilities`); starsze buildy dostają
 * dotychczasowe zachowanie, bo karty i tak by nie pokazały.
 * `strict` — tryb propozycji dla wszystkich; `apply_week_plan` znika z listy
 * narzędzi modelu. Włączane po adopcji buildu iOS.
 */
export const AI_CARDS_MODES = ['off', 'soft', 'strict'] as const;
export type AiCardsMode = (typeof AI_CARDS_MODES)[number];

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
  /** Tryb kart i propozycji — patrz `AI_CARDS_MODES`. */
  cardsMode: AiCardsMode;
  /**
   * Jak długo propozycja daje się zatwierdzić.
   *
   * Po tym czasie karta w historii mówi wprost, że jest nieaktualna, zamiast
   * pokazywać przycisk, który zapisze tydzień policzony trzy tygodnie temu.
   */
  proposalTtlMs: number;
  /** Ile czasu na „Cofnij" po zapisaniu propozycji. */
  proposalUndoWindowMs: number;
  /**
   * Kto może rozmawiać z asystentem: identyfikatory użytkowników albo
   * e-maile (małymi literami). PUSTA lista = wszyscy zalogowani, jak dotąd.
   *
   * Aplikacja jest w App Store i każdy może założyć konto — do czasu zgód,
   * polityki i paywalla to jedyna bramka między „rodzina testuje" a „obcy
   * palą klucz". Konto spoza listy dostaje 503 AI_DISABLED (jak wyłączony
   * asystent): telefon pokazuje „niedostępny" i blokuje pole, bez nowej
   * kopii po stronie iOS.
   */
  allowedUsers: string[];
  /**
   * Czy tura wymaga ważnej zgody AI_ASSISTANT (tabela `ConsentEvent`) i czy
   * do promptu trafiają tylko domownicy z własną zgodą. Domyślnie `false`:
   * bramka ma sens dopiero, gdy wydany iOS ma ekran zgody — włączona
   * wcześniej odcięłaby rodzinę od asystenta bez możliwości kliknięcia.
   */
  consentRequired: boolean;
  /**
   * Po ilu dniach od ostatniej wiadomości rozmowa (z turami, kartami i
   * propozycjami) jest kasowana automatycznie; `0` = bez retencji. Polityka
   * prywatności obiecuje 90 dni — obietnica bez automatu jest gorsza niż
   * brak obietnicy. Księga kosztów zostaje (turnId → NULL).
   */
  conversationRetentionDays: number;
  /**
   * Sufit kosztu JEDNEJ tury w USD; `null` = bez sufitu (jawne `off`).
   * Żądanie niewykonalne kręciło się 14 wywołań za $1,00 — po przekroczeniu
   * dostawca kończy pętlę narzędzi odpowiedzią tekstową.
   */
  maxTurnCostUsd: number | null;
};

/**
 * `AI_ALLOWED_USERS` — lista rozdzielona przecinkami; puste wpisy i
 * wielkość liter nie mają znaczenia (e-maile Apple bywają wpisywane różnie).
 */
export function parseAllowedUsers(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

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
  /** Trzy doby: tyle żyje sensowna propozycja tygodnia. */
  proposalTtlMs: 72 * 60 * 60 * 1000,
  /** Godzina na „Cofnij" — tyle, ile trwa zorientowanie się, że to nie to. */
  proposalUndoWindowMs: 60 * 60 * 1000,
  /** 90 dni: tyle obiecuje polityka prywatności (decyzja 2.09.2026). */
  conversationRetentionDays: 90,
  /**
   * $1: zmierzona tura niewykonalna. Zwykłe tury kosztują $0,12–0,30, więc
   * sufit ich nie dotyka; łapie wyłącznie pętlę.
   */
  maxTurnCostUsd: 1,
} as const;

/** Jedyna droga do braku budżetu — jawna i widoczna w `railway variables`. */
export const AI_BUDGET_OFF = 'off';

type NumericKey =
  | 'AI_TURN_TIMEOUT_MS'
  | 'AI_LIMIT_MESSAGES_PER_MONTH'
  | 'AI_LIMIT_PLANS_PER_MONTH'
  | 'AI_STUB_DELAY_MS'
  | 'AI_PROPOSAL_TTL_MS'
  | 'AI_PROPOSAL_UNDO_WINDOW_MS'
  | 'AI_CONVERSATION_RETENTION_DAYS';

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

function readCardsMode(env: NodeJS.ProcessEnv): AiCardsMode {
  const raw = (env.AI_CARDS_MODE ?? '').trim().toLowerCase();
  return (AI_CARDS_MODES as readonly string[]).includes(raw)
    ? (raw as AiCardsMode)
    : 'off';
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
    cardsMode: readCardsMode(env),
    proposalTtlMs: readNumber(
      env,
      'AI_PROPOSAL_TTL_MS',
      AGENT_ENV_DEFAULTS.proposalTtlMs,
      { min: 1 },
    ),
    proposalUndoWindowMs: readNumber(
      env,
      'AI_PROPOSAL_UNDO_WINDOW_MS',
      AGENT_ENV_DEFAULTS.proposalUndoWindowMs,
      { min: 0 },
    ),
    allowedUsers: parseAllowedUsers(env.AI_ALLOWED_USERS),
    consentRequired:
      (env.AI_CONSENT_REQUIRED ?? '').trim().toLowerCase() === 'true',
    conversationRetentionDays: readNumber(
      env,
      'AI_CONVERSATION_RETENTION_DAYS',
      AGENT_ENV_DEFAULTS.conversationRetentionDays,
      { min: 0 },
    ),
    maxTurnCostUsd: readMaxTurnCostUsd(env),
  };
}

/** Jak budżet dobowy: liczba ≥ 0, `off` = bez sufitu, śmieci = domyślne. */
function readMaxTurnCostUsd(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.AI_MAX_TURN_COST_USD ?? '').trim().toLowerCase();
  if (!raw) return AGENT_ENV_DEFAULTS.maxTurnCostUsd;
  if (raw === AI_BUDGET_OFF) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return AGENT_ENV_DEFAULTS.maxTurnCostUsd;
  }
  return parsed;
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
  const cardsRaw = (env.AI_CARDS_MODE ?? '').trim().toLowerCase();
  if (cardsRaw && !(AI_CARDS_MODES as readonly string[]).includes(cardsRaw)) {
    problems.push(
      `AI_CARDS_MODE=${cardsRaw} — dozwolone: ${AI_CARDS_MODES.join(', ')} (przy złej wartości działa off)`,
    );
  }
  const numeric: Array<[NumericKey, { min: number; integer: boolean }]> = [
    ['AI_TURN_TIMEOUT_MS', { min: 1, integer: true }],
    ['AI_LIMIT_MESSAGES_PER_MONTH', { min: 0, integer: true }],
    ['AI_LIMIT_PLANS_PER_MONTH', { min: 0, integer: true }],
    ['AI_STUB_DELAY_MS', { min: 0, integer: true }],
    ['AI_PROPOSAL_TTL_MS', { min: 1, integer: true }],
    ['AI_PROPOSAL_UNDO_WINDOW_MS', { min: 0, integer: true }],
    ['AI_CONVERSATION_RETENTION_DAYS', { min: 0, integer: true }],
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
