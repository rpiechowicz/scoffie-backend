import {
  AGENT_ENV_DEFAULTS,
  AI_MODEL_DEFAULT,
  agentEnvProblems,
  readAgentEnv,
} from './agent-env';

describe('readAgentEnv', () => {
  it('bez zmiennych: wyłączony, anthropic, domyślne limity, bez budżetu', () => {
    expect(readAgentEnv({})).toEqual({
      enabled: false,
      provider: 'anthropic',
      model: AI_MODEL_DEFAULT,
      apiKeyPresent: false,
      turnTimeoutMs: AGENT_ENV_DEFAULTS.turnTimeoutMs,
      messagesPerMonth: AGENT_ENV_DEFAULTS.messagesPerMonth,
      plansPerMonth: AGENT_ENV_DEFAULTS.plansPerMonth,
      globalDailyBudgetUsd: null,
      stubDelayMs: 0,
    });
  });

  it('czyta flagi i liczby; śmieci w liczbach = domyślne', () => {
    const env = readAgentEnv({
      AI_ENABLED: ' TRUE ',
      AI_PROVIDER: 'Stub',
      AI_MODEL: ' claude-opus-5 ',
      ANTHROPIC_API_KEY: 'sk-ant-tajny',
      AI_TURN_TIMEOUT_MS: '5000',
      AI_LIMIT_MESSAGES_PER_MONTH: 'abc',
      AI_LIMIT_PLANS_PER_MONTH: '-1',
      AI_GLOBAL_DAILY_BUDGET_USD: '2.5',
      AI_STUB_DELAY_MS: '1.5',
    });
    expect(env).toMatchObject({
      enabled: true,
      provider: 'stub',
      model: 'claude-opus-5',
      apiKeyPresent: true,
      turnTimeoutMs: 5000,
      messagesPerMonth: AGENT_ENV_DEFAULTS.messagesPerMonth,
      plansPerMonth: AGENT_ENV_DEFAULTS.plansPerMonth,
      globalDailyBudgetUsd: 2.5,
      stubDelayMs: 0,
    });
  });

  it.each([['false'], ['0'], ['yes'], ['']])(
    'AI_ENABLED=%p to nie włączenie',
    (value) => {
      expect(readAgentEnv({ AI_ENABLED: value }).enabled).toBe(false);
    },
  );
});

describe('agentEnvProblems', () => {
  it('bez zmiennych → brak problemów (merge bez zmiennych na Railway)', () => {
    expect(agentEnvProblems({})).toEqual([]);
    expect(agentEnvProblems({ AI_ENABLED: 'false' })).toEqual([]);
  });

  it('AI_ENABLED=true z anthropic bez klucza → problem bez wartości sekretu', () => {
    const problems = agentEnvProblems({ AI_ENABLED: 'true' });
    expect(problems).toEqual([
      'ANTHROPIC_API_KEY jest pusty (AI_ENABLED=true, AI_PROVIDER=anthropic)',
    ]);
  });

  it('AI_ENABLED=true z kluczem → ok; klucz nie pojawia się w komunikatach', () => {
    const problems = agentEnvProblems({
      AI_ENABLED: 'true',
      ANTHROPIC_API_KEY: 'sk-ant-tajny',
    });
    expect(problems).toEqual([]);
    expect(
      agentEnvProblems({
        AI_ENABLED: 'true',
        ANTHROPIC_API_KEY: 'sk-ant-tajny',
        AI_TURN_TIMEOUT_MS: 'x',
      }).join(' '),
    ).not.toContain('sk-ant-tajny');
  });

  it('AI_ENABLED=true ze stubem nie wymaga klucza', () => {
    expect(
      agentEnvProblems({ AI_ENABLED: 'true', AI_PROVIDER: 'stub' }),
    ).toEqual([]);
  });

  it.each([
    ['AI_ENABLED', 'maybe', /AI_ENABLED=maybe/],
    ['AI_PROVIDER', 'openai', /AI_PROVIDER=openai/],
    ['AI_TURN_TIMEOUT_MS', '0', /AI_TURN_TIMEOUT_MS=0/],
    ['AI_LIMIT_MESSAGES_PER_MONTH', '1.5', /AI_LIMIT_MESSAGES_PER_MONTH=1.5/],
    ['AI_GLOBAL_DAILY_BUDGET_USD', '-3', /AI_GLOBAL_DAILY_BUDGET_USD=-3/],
    ['AI_STUB_DELAY_MS', 'abc', /AI_STUB_DELAY_MS=abc/],
  ])('%s=%s → czytelny problem', (key, value, pattern) => {
    const problems = agentEnvProblems({ [key]: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(pattern);
  });
});
