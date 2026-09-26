import {
  readThrottleLimit,
  parseThrottleLimitStrict,
  type ThrottleKey,
} from '../common/throttle/throttle-env';
import {
  AI_CARDS_MODES,
  AI_CATALOG_MODES,
  AgentEnv,
  parseAllowedUsers,
  parseCardsModeStrict,
  parseCatalogModeStrict,
  parseEnabledStrict,
  parseNumberStrict,
  parseUsdOrOffStrict,
} from './agent-env';

/**
 * Biała lista ustawień, które panel może nadpisać w locie (ROADMAPA §5.12).
 *
 * Tylko przełączniki i limity asystenta — sekrety (klucze API, `JWT_*`)
 * NIGDY: zostają w Railwayu. Klucz spoza tej listy nie zostanie ani zapisany,
 * ani wczytany z bazy.
 *
 * `normalize` waliduje TYMI SAMYMI parserami, którymi `readAgentEnv` czyta
 * env — z jedną różnicą: zła wartość nie spada po cichu na domyślną, tylko
 * wraca jako błąd (panel pokazuje 400).
 */
export const RUNTIME_SETTING_KEYS = [
  'AI_ENABLED',
  'AI_MAX_TURN_COST_USD',
  'AI_GLOBAL_DAILY_BUDGET_USD',
  'AI_LIMIT_MESSAGES_PER_MONTH',
  'AI_LIMIT_PLANS_PER_MONTH',
  'AI_TRIAL_MESSAGES',
  'AI_TRIAL_PLANS',
  'AI_ALLOWED_USERS',
  'AI_CARDS_MODE',
  // Wyszukiwarka dań vs cały katalog w prompcie — powrót bez deployu.
  'AI_CATALOG_MODE',
  'AI_CACHE_WARM_HOURS',
  // Limity HTTP — `readThrottleLimit` czyta je per żądanie (z nadpisaniami),
  // więc zmiana działa bez restartu. Celowo BEZ `THROTTLE_ADMIN_*`: zbyt
  // niski limit panelu zamknąłby panel przed adminem, który chce go cofnąć.
  'THROTTLE_DEFAULT_LIMIT',
  'THROTTLE_IP_LIMIT',
  'THROTTLE_AUTH_LIMIT',
  'THROTTLE_AUTH_REFRESH_LIMIT',
  'THROTTLE_AUTH_REFRESH_IP_LIMIT',
  'THROTTLE_AGENT_MESSAGE_LIMIT',
  'THROTTLE_AGENT_POLL_LIMIT',
] as const;
export type RuntimeSettingKey = (typeof RUNTIME_SETTING_KEYS)[number];

export type RuntimeSettingKind = 'boolean' | 'number' | 'list' | 'choice';

type Normalized = { ok: true; value: string } | { ok: false; error: string };

type RuntimeSettingSpec = {
  label: string;
  kind: RuntimeSettingKind;
  normalize: (raw: string) => Normalized;
  /** Dozwolone wartości przy `kind: 'choice'`. */
  options?: readonly string[];
  /** Wartość, która naprawdę działa — z `readAgentEnv`, z domyślnymi. */
  effective: (agent: AgentEnv) => string;
};

const usd = (value: number | null): string =>
  value === null ? 'off' : String(value);

const usdOrOff =
  (what: string) =>
  (raw: string): Normalized => {
    const parsed = parseUsdOrOffStrict(raw);
    return parsed === undefined
      ? { ok: false, error: `${what}: oczekiwana kwota ≥ 0 albo „off”` }
      : { ok: true, value: usd(parsed) };
  };

const count =
  (what: string) =>
  (raw: string): Normalized => {
    const parsed = parseNumberStrict(raw, { min: 0, integer: true });
    return parsed === undefined
      ? { ok: false, error: `${what}: oczekiwana liczba całkowita ≥ 0` }
      : { ok: true, value: String(parsed) };
  };

/** Id konta (UUID) albo adres e-mail — to samo, co porównuje `assertUserAllowed`. */
const ALLOWED_ENTRY =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[^\s@,]+@[^\s@,]+\.[^\s@,]+)$/;
const MAX_ALLOWED_ENTRIES = 200;

const throttle = (key: ThrottleKey, label: string): RuntimeSettingSpec => ({
  label,
  kind: 'number',
  normalize: (raw) => {
    const parsed = parseThrottleLimitStrict(raw);
    return parsed === undefined
      ? { ok: false, error: `${key}: oczekiwana liczba całkowita ≥ 1` }
      : { ok: true, value: String(parsed) };
  },
  effective: () => String(readThrottleLimit(key)),
});

export const RUNTIME_SETTINGS: Record<RuntimeSettingKey, RuntimeSettingSpec> = {
  AI_ENABLED: {
    label: 'Asystent włączony',
    kind: 'boolean',
    normalize: (raw) => {
      const parsed = parseEnabledStrict(raw);
      return parsed === undefined
        ? { ok: false, error: 'AI_ENABLED: dozwolone true albo false' }
        : { ok: true, value: String(parsed) };
    },
    effective: (agent) => String(agent.enabled),
  },
  AI_MAX_TURN_COST_USD: {
    label: 'Sufit kosztu jednej tury (USD)',
    kind: 'number',
    normalize: usdOrOff('AI_MAX_TURN_COST_USD'),
    effective: (agent) => usd(agent.maxTurnCostUsd),
  },
  AI_GLOBAL_DAILY_BUDGET_USD: {
    label: 'Budżet dobowy instalacji (USD)',
    kind: 'number',
    normalize: usdOrOff('AI_GLOBAL_DAILY_BUDGET_USD'),
    effective: (agent) => usd(agent.globalDailyBudgetUsd),
  },
  AI_LIMIT_MESSAGES_PER_MONTH: {
    label: 'Wiadomości na miesiąc (bez produktu)',
    kind: 'number',
    normalize: count('AI_LIMIT_MESSAGES_PER_MONTH'),
    effective: (agent) => String(agent.messagesPerMonth),
  },
  AI_LIMIT_PLANS_PER_MONTH: {
    label: 'Plany na miesiąc (bez produktu)',
    kind: 'number',
    normalize: count('AI_LIMIT_PLANS_PER_MONTH'),
    effective: (agent) => String(agent.plansPerMonth),
  },
  AI_TRIAL_MESSAGES: {
    label: 'Wiadomości na próbę',
    kind: 'number',
    normalize: count('AI_TRIAL_MESSAGES'),
    effective: (agent) => String(agent.trialMessages),
  },
  AI_TRIAL_PLANS: {
    label: 'Plany na próbę',
    kind: 'number',
    normalize: count('AI_TRIAL_PLANS'),
    effective: (agent) => String(agent.trialPlans),
  },
  AI_ALLOWED_USERS: {
    label: 'Dozwolone osoby (pusta = wszyscy)',
    kind: 'list',
    normalize: (raw) => {
      const entries = [...new Set(parseAllowedUsers(raw))];
      const bad = entries.filter((entry) => !ALLOWED_ENTRY.test(entry));
      if (bad.length > 0) {
        return {
          ok: false,
          error: `AI_ALLOWED_USERS: to nie jest adres ani id konta: ${bad.slice(0, 3).join(', ')}`,
        };
      }
      if (entries.length > MAX_ALLOWED_ENTRIES) {
        return {
          ok: false,
          error: `AI_ALLOWED_USERS: najwyżej ${MAX_ALLOWED_ENTRIES} wpisów`,
        };
      }
      return { ok: true, value: entries.join(',') };
    },
    effective: (agent) => agent.allowedUsers.join(','),
  },
  AI_CARDS_MODE: {
    label: 'Tryb kart asystenta',
    kind: 'choice',
    options: AI_CARDS_MODES,
    normalize: (raw) => {
      const parsed = parseCardsModeStrict(raw);
      if (parsed === undefined) {
        return {
          ok: false,
          error: `AI_CARDS_MODE: dozwolone ${AI_CARDS_MODES.join(', ')}`,
        };
      }
      // Ta sama reguła, co w `assert-env`: na produkcji `off` zdejmuje zgodę
      // człowieka z zapisu planu (bez karty i bez „Cofnij”). Env z `off`
      // i włączonym asystentem nie przejdzie startu — panel nie może być
      // tylnymi drzwiami do tego samego stanu.
      if (parsed === 'off' && process.env.NODE_ENV === 'production') {
        return {
          ok: false,
          error: 'AI_CARDS_MODE: off nie jest dozwolone na produkcji',
        };
      }
      return { ok: true, value: parsed };
    },
    effective: (agent) => agent.cardsMode,
  },
  AI_CATALOG_MODE: {
    label:
      'Katalog w prompcie asystenta (search = mapa + wyszukiwarka, digest = cały katalog)',
    kind: 'choice',
    options: AI_CATALOG_MODES,
    normalize: (raw) => {
      const parsed = parseCatalogModeStrict(raw);
      return parsed === undefined
        ? {
            ok: false,
            error: `AI_CATALOG_MODE: dozwolone ${AI_CATALOG_MODES.join(', ')}`,
          }
        : { ok: true, value: parsed };
    },
    effective: (agent) => agent.catalogMode,
  },
  AI_CACHE_WARM_HOURS: {
    label:
      'Podgrzewanie cache asystenta: ile godzin po ostatniej turze (0 = wyłączone)',
    kind: 'number',
    normalize: count('AI_CACHE_WARM_HOURS'),
    effective: (agent) => String(agent.cacheWarmHours),
  },
  THROTTLE_DEFAULT_LIMIT: throttle(
    'THROTTLE_DEFAULT_LIMIT',
    'Żądania na minutę na osobę',
  ),
  THROTTLE_IP_LIMIT: throttle('THROTTLE_IP_LIMIT', 'Żądania na minutę na IP'),
  THROTTLE_AUTH_LIMIT: throttle(
    'THROTTLE_AUTH_LIMIT',
    'Logowania na minutę na IP',
  ),
  THROTTLE_AUTH_REFRESH_LIMIT: throttle(
    'THROTTLE_AUTH_REFRESH_LIMIT',
    'Odświeżenia sesji na minutę na sesję',
  ),
  THROTTLE_AUTH_REFRESH_IP_LIMIT: throttle(
    'THROTTLE_AUTH_REFRESH_IP_LIMIT',
    'Odświeżenia sesji na minutę na IP',
  ),
  THROTTLE_AGENT_MESSAGE_LIMIT: throttle(
    'THROTTLE_AGENT_MESSAGE_LIMIT',
    'Wiadomości do asystenta na minutę',
  ),
  THROTTLE_AGENT_POLL_LIMIT: throttle(
    'THROTTLE_AGENT_POLL_LIMIT',
    'Odpytania asystenta na minutę',
  ),
};

export function isRuntimeSettingKey(key: string): key is RuntimeSettingKey {
  return (RUNTIME_SETTING_KEYS as readonly string[]).includes(key);
}
