import {
  AGENT_ENV_DEFAULTS,
  AI_EFFORT_TOOLS_DEFAULT,
  AI_BUDGET_OFF,
  AI_EFFORT_DEFAULT,
  AI_MODEL_DEFAULT,
  agentEnvProblems,
  parseAllowedUsers,
  readAgentEnv,
} from './agent-env';

describe('readAgentEnv', () => {
  it('bez zmiennych: wyłączony, anthropic, domyślne limity I DOMYŚLNY BUDŻET', () => {
    expect(readAgentEnv({})).toEqual({
      enabled: false,
      provider: 'anthropic',
      model: AI_MODEL_DEFAULT,
      toolsModel: null,
      effort: AI_EFFORT_DEFAULT,
      effortTools: AI_EFFORT_TOOLS_DEFAULT,
      apiKeyPresent: false,
      turnTimeoutMs: AGENT_ENV_DEFAULTS.turnTimeoutMs,
      messagesPerMonth: AGENT_ENV_DEFAULTS.messagesPerMonth,
      plansPerMonth: AGENT_ENV_DEFAULTS.plansPerMonth,
      trialMessages: AGENT_ENV_DEFAULTS.trialMessages,
      trialPlans: AGENT_ENV_DEFAULTS.trialPlans,
      // Domyślnie PRO dla wszystkich — do czasu subskrypcji zachowanie jak dotąd.
      // BRAK ZMIENNEJ NIE ZNACZY „PRO DLA WSZYSTKICH". Do 4.09.2026 znaczyło:
      // skasowanie `AI_TIER_OVERRIDE` w Railway (czyli to, co człowiek robi,
      // chcąc ją wyczyścić) rozdawało asystenta za darmo i wyłączało całą
      // ścieżkę płatności — bez jednego śladu w logu.
      tierOverride: null,
      maxConcurrentTurnsPerHousehold:
        AGENT_ENV_DEFAULTS.maxConcurrentTurnsPerHousehold,
      // NIE `null`: brak zmiennej znaczył kiedyś „bez limitu", więc instalacja
      // bez żadnego hamulca wydatków wyglądała jak skonfigurowana.
      globalDailyBudgetUsd: AGENT_ENV_DEFAULTS.globalDailyBudgetUsd,
      householdMonthlyCostUsd: AGENT_ENV_DEFAULTS.householdMonthlyCostUsd,
      stubDelayMs: 0,
      // Karty domyślnie WYŁĄCZONE: wprowadzenie trybu propozycji nie może
      // zmienić zachowania instalacji, która o nic nie prosiła.
      cardsMode: 'off',
      proposalTtlMs: AGENT_ENV_DEFAULTS.proposalTtlMs,
      proposalUndoWindowMs: AGENT_ENV_DEFAULTS.proposalUndoWindowMs,
      // Pusta lista = wszyscy, jak dotąd: bramka nie może zmienić
      // zachowania instalacji, która o nią nie prosiła.
      allowedUsers: [],
      // Bramka zgód wyłączona, dopóki wydany iOS nie ma ekranu zgody.
      consentRequired: true,
      conversationRetentionDays: AGENT_ENV_DEFAULTS.conversationRetentionDays,
      maxTurnCostUsd: AGENT_ENV_DEFAULTS.maxTurnCostUsd,
    });
  });

  it('sufit kosztu tury: off = null, ułamki ok, śmieci = domyślny $1', () => {
    expect(readAgentEnv({ AI_MAX_TURN_COST_USD: 'off' }).maxTurnCostUsd).toBe(
      null,
    );
    expect(readAgentEnv({ AI_MAX_TURN_COST_USD: '0.5' }).maxTurnCostUsd).toBe(
      0.5,
    );
    expect(readAgentEnv({ AI_MAX_TURN_COST_USD: 'dużo' }).maxTurnCostUsd).toBe(
      1,
    );
  });

  it('retencja: 0 wyłącza, ułamek/ujemna = domyślne 90', () => {
    expect(
      readAgentEnv({ AI_CONVERSATION_RETENTION_DAYS: '0' })
        .conversationRetentionDays,
    ).toBe(0);
    expect(
      readAgentEnv({ AI_CONVERSATION_RETENTION_DAYS: '-5' })
        .conversationRetentionDays,
    ).toBe(90);
  });

  it('AI_CONSENT_REQUIRED: domyślnie wymagane, wyłącza tylko literalne false', () => {
    expect(readAgentEnv({ AI_CONSENT_REQUIRED: 'true' }).consentRequired).toBe(
      true,
    );
    expect(readAgentEnv({ AI_CONSENT_REQUIRED: 'false' }).consentRequired).toBe(
      false,
    );
    // Literówka nie może otworzyć bramki prywatności.
    expect(readAgentEnv({ AI_CONSENT_REQUIRED: 'no' }).consentRequired).toBe(
      true,
    );
  });

  describe('lista dozwolonych kont', () => {
    it('rozdziela po przecinku, przycina i zmniejsza litery; puste wpisy wypadają', () => {
      expect(
        parseAllowedUsers(
          ' Rafal@Example.com, ,3FA85F64-5717-4562-B3FC-2C963F66AFA6,,',
        ),
      ).toEqual(['rafal@example.com', '3fa85f64-5717-4562-b3fc-2c963f66afa6']);
      expect(parseAllowedUsers(undefined)).toEqual([]);
      expect(parseAllowedUsers('  ')).toEqual([]);
    });

    it('trafia do AgentEnv', () => {
      expect(readAgentEnv({ AI_ALLOWED_USERS: 'a@b.pl' }).allowedUsers).toEqual(
        ['a@b.pl'],
      );
    });
  });

  describe('tryb kart', () => {
    const mode = (value: string) =>
      readAgentEnv({ AI_CARDS_MODE: value }).cardsMode;

    it.each(['off', 'soft', 'strict'])('przyjmuje %s', (value) => {
      expect(mode(value)).toBe(value);
    });

    it('nieznana wartość i brak zmiennej znaczą to samo: off', () => {
      expect(mode('propozycje')).toBe('off');
      expect(readAgentEnv({}).cardsMode).toBe('off');
    });

    it('wielkość liter nie ma znaczenia', () => {
      expect(mode('SOFT')).toBe('soft');
    });
  });

  describe('budżet dobowy', () => {
    const budget = (value: string): number | null =>
      readAgentEnv({ AI_GLOBAL_DAILY_BUDGET_USD: value }).globalDailyBudgetUsd;

    it('brak limitu wymaga jawnego `off`', () => {
      expect(budget(AI_BUDGET_OFF)).toBeNull();
      expect(budget(' OFF ')).toBeNull();
    });

    it('zero jest legalne i znaczy „zatrzymaj wszystko"', () => {
      // Inaczej niż w limitach żądań, gdzie zero blokowałoby całą aplikację.
      expect(budget('0')).toBe(0);
    });

    it('ułamki przechodzą — budżet to pieniądze, nie sztuki', () => {
      expect(budget('2.5')).toBe(2.5);
    });

    it.each(['abc', '-3', ''])(
      'śmieci (%s) = domyślny, nie brak limitu',
      (raw) => {
        expect(budget(raw)).toBe(AGENT_ENV_DEFAULTS.globalDailyBudgetUsd);
      },
    );
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

  it('`off` w budżecie nie jest problemem — to świadoma decyzja', () => {
    expect(
      agentEnvProblems({ AI_GLOBAL_DAILY_BUDGET_USD: AI_BUDGET_OFF }),
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
  it('AI_MODEL_TOOLS: tańszy model na rozmowę; puste = jeden model na całą turę', () => {
    expect(
      readAgentEnv({ AI_MODEL_TOOLS: ' claude-haiku-4-5 ' }).toolsModel,
    ).toBe('claude-haiku-4-5');
    expect(readAgentEnv({ AI_MODEL_TOOLS: '  ' }).toolsModel).toBeNull();
  });
});
