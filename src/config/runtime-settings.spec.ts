import { readThrottleLimit } from '../common/throttle/throttle-env';
import { readAgentEnv } from './agent-env';
import {
  effectiveProcessEnv,
  runtimeOverrides,
  setRuntimeOverrides,
} from './runtime-overrides';
import {
  isRuntimeSettingKey,
  RUNTIME_SETTING_KEYS,
  RUNTIME_SETTINGS,
} from './runtime-settings';

describe('nadpisania env z panelu', () => {
  const saved = { ...process.env };

  afterEach(() => {
    setRuntimeOverrides({});
    process.env = { ...saved };
  });

  it('nadpisanie wygrywa z env, usunięte wraca do env', () => {
    process.env.AI_ENABLED = 'true';
    process.env.AI_LIMIT_MESSAGES_PER_MONTH = '40';
    expect(readAgentEnv().enabled).toBe(true);

    setRuntimeOverrides({
      AI_ENABLED: 'false',
      AI_LIMIT_MESSAGES_PER_MONTH: '7',
    });
    expect(readAgentEnv()).toMatchObject({
      enabled: false,
      messagesPerMonth: 7,
    });

    setRuntimeOverrides({ AI_LIMIT_MESSAGES_PER_MONTH: '7' });
    expect(readAgentEnv()).toMatchObject({
      enabled: true,
      messagesPerMonth: 7,
    });

    setRuntimeOverrides({});
    expect(readAgentEnv().messagesPerMonth).toBe(40);
  });

  it('jawnie podany env nie widzi nadpisań (testy, assert-env)', () => {
    setRuntimeOverrides({ AI_ENABLED: 'false' });
    expect(readAgentEnv({ AI_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('bez nadpisań to ten sam obiekt process.env, a mapa jest zamrożona', () => {
    expect(effectiveProcessEnv()).toBe(process.env);
    setRuntimeOverrides({ AI_ENABLED: 'false' });
    expect(Object.isFrozen(runtimeOverrides())).toBe(true);
    expect(effectiveProcessEnv().AI_ENABLED).toBe('false');
  });

  it('biała lista: limity i wyłącznik tak, sekrety i reszta nie', () => {
    expect([...RUNTIME_SETTING_KEYS].sort()).toEqual(
      [
        'AI_ENABLED',
        'AI_MAX_TURN_COST_USD',
        'AI_GLOBAL_DAILY_BUDGET_USD',
        'AI_LIMIT_MESSAGES_PER_MONTH',
        'AI_LIMIT_PLANS_PER_MONTH',
        'AI_TRIAL_MESSAGES',
        'AI_TRIAL_PLANS',
        'AI_ALLOWED_USERS',
        'AI_CARDS_MODE',
        'AI_CATALOG_MODE',
        'AI_CACHE_WARM_HOURS',
        'THROTTLE_DEFAULT_LIMIT',
        'THROTTLE_IP_LIMIT',
        'THROTTLE_AUTH_LIMIT',
        'THROTTLE_AGENT_MESSAGE_LIMIT',
        'THROTTLE_AGENT_POLL_LIMIT',
      ].sort(),
    );
    for (const key of [
      'ANTHROPIC_API_KEY',
      'JWT_SECRET',
      'DATABASE_URL',
      'AI_PROVIDER',
      'AI_CONSENT_REQUIRED',
      // Zbyt niski limit panelu zamknąłby panel przed adminem.
      'THROTTLE_ADMIN_LIMIT',
      'THROTTLE_ADMIN_AUTH_LIMIT',
      'THROTTLE_ADMIN_CODE_LIMIT',
    ]) {
      expect(isRuntimeSettingKey(key)).toBe(false);
    }
  });

  it('walidacja tymi samymi parserami — zła wartość to błąd, nie cicha domyślna', () => {
    const check = (key: keyof typeof RUNTIME_SETTINGS, raw: string) =>
      RUNTIME_SETTINGS[key].normalize(raw);
    expect(check('AI_ENABLED', ' FALSE ')).toEqual({
      ok: true,
      value: 'false',
    });
    expect(check('AI_ENABLED', 'nie')).toMatchObject({ ok: false });
    expect(check('AI_MAX_TURN_COST_USD', '0.5')).toEqual({
      ok: true,
      value: '0.5',
    });
    expect(check('AI_MAX_TURN_COST_USD', 'OFF')).toEqual({
      ok: true,
      value: 'off',
    });
    expect(check('AI_MAX_TURN_COST_USD', '-1')).toMatchObject({ ok: false });
    expect(check('AI_GLOBAL_DAILY_BUDGET_USD', '0')).toEqual({
      ok: true,
      value: '0',
    });
    expect(check('AI_GLOBAL_DAILY_BUDGET_USD', 'dużo')).toMatchObject({
      ok: false,
    });
    expect(check('AI_LIMIT_MESSAGES_PER_MONTH', '12')).toEqual({
      ok: true,
      value: '12',
    });
    expect(check('AI_LIMIT_MESSAGES_PER_MONTH', '1.5')).toMatchObject({
      ok: false,
    });
    expect(check('AI_TRIAL_PLANS', '')).toMatchObject({ ok: false });
    expect(
      check(
        'AI_ALLOWED_USERS',
        ' Ala@Example.com, ala@example.com ,,0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
      ),
    ).toEqual({
      ok: true,
      value: 'ala@example.com,0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
    });
    expect(check('AI_ALLOWED_USERS', '')).toEqual({ ok: true, value: '' });
    expect(check('AI_ALLOWED_USERS', 'ala, bob@x.pl')).toMatchObject({
      ok: false,
    });
  });

  it('wartość po normalizacji czyta readAgentEnv tak samo jak env', () => {
    setRuntimeOverrides({
      AI_MAX_TURN_COST_USD: 'off',
      AI_GLOBAL_DAILY_BUDGET_USD: '2.5',
      AI_ALLOWED_USERS: 'ala@example.com',
    });
    const agent = readAgentEnv();
    expect(agent).toMatchObject({
      maxTurnCostUsd: null,
      globalDailyBudgetUsd: 2.5,
      allowedUsers: ['ala@example.com'],
    });
    expect(RUNTIME_SETTINGS.AI_MAX_TURN_COST_USD.effective(agent)).toBe('off');
    expect(RUNTIME_SETTINGS.AI_ALLOWED_USERS.effective(agent)).toBe(
      'ala@example.com',
    );
  });

  it('tryb kart: lista wyboru, te same wartości co env; off nie na produkcji', () => {
    const spec = RUNTIME_SETTINGS.AI_CARDS_MODE;
    expect(spec.kind).toBe('choice');
    expect(spec.options).toEqual(['off', 'soft', 'strict']);
    expect(spec.normalize(' SOFT ')).toEqual({ ok: true, value: 'soft' });
    expect(spec.normalize('lenient')).toMatchObject({ ok: false });
    expect(spec.normalize('off')).toEqual({ ok: true, value: 'off' });
    process.env.NODE_ENV = 'production';
    expect(spec.normalize('off')).toMatchObject({ ok: false });
    expect(spec.normalize('strict')).toEqual({ ok: true, value: 'strict' });

    process.env.NODE_ENV = 'test';
    process.env.AI_CARDS_MODE = 'soft';
    setRuntimeOverrides({ AI_CARDS_MODE: 'strict' });
    expect(spec.effective(readAgentEnv())).toBe('strict');
  });

  it('limity THROTTLE_*: liczba całkowita ≥ 1, działają bez restartu', () => {
    const spec = RUNTIME_SETTINGS.THROTTLE_AGENT_MESSAGE_LIMIT;
    expect(spec.kind).toBe('number');
    expect(spec.normalize(' 40 ')).toEqual({ ok: true, value: '40' });
    for (const bad of ['0', '-3', '2.5', 'dużo', '']) {
      expect(spec.normalize(bad)).toMatchObject({ ok: false });
    }
    delete process.env.THROTTLE_AGENT_MESSAGE_LIMIT;
    expect(readThrottleLimit('THROTTLE_AGENT_MESSAGE_LIMIT')).toBe(20);
    setRuntimeOverrides({ THROTTLE_AGENT_MESSAGE_LIMIT: '7' });
    expect(readThrottleLimit('THROTTLE_AGENT_MESSAGE_LIMIT')).toBe(7);
    expect(spec.effective(readAgentEnv())).toBe('7');
    // Jawny env (assert-env, e2e) nadpisań nie widzi.
    expect(readThrottleLimit('THROTTLE_AGENT_MESSAGE_LIMIT', {})).toBe(20);
  });
});
