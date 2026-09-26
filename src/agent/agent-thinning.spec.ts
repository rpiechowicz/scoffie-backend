import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AGENT_INSTRUCTIONS,
  handoffBlock,
  modeBlock,
} from './agent-system-prompt';
import {
  AGENT_TOOL_TIERS,
  AGENT_TOOLS,
  EXECUTABLE_TOOL_NAMES,
  INTERNAL_AGENT_TOOLS,
  RETIRED_MODEL_TOOLS,
  START_PLANNING_TOOL,
  TRIAGE_TOOLS,
} from './tools/agent-tools';
import { TURN_ENDING_TOOLS, turnTextFor } from './tools/agent-tool-executor';
import { createTurnMemo, memoized } from './turn-memo';

/**
 * Etap 3 workstreamu — odchudzenie asystenta: pamięć tury, zdanie serwera
 * na koniec tury, lista narzędzi modelu. Numery = testy obowiązkowe Etapu 3.
 */
describe('TurnMemo — pamięć jednej tury', () => {
  it('10. ten sam klucz ładuje się RAZ, także przy równoległych odczytach', async () => {
    const memo = createTurnMemo();
    const load = jest.fn().mockResolvedValue(['ania']);
    const [a, b] = await Promise.all([
      memo.once('members:u:h', load),
      memo.once('members:u:h', load),
    ]);
    await memo.once('members:u:h', load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('błąd nie zostaje w pamięci — następny odczyt próbuje od nowa', async () => {
    const memo = createTurnMemo();
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('baza'))
      .mockResolvedValueOnce('ok');
    await expect(memo.once('k', load)).rejects.toThrow('baza');
    await expect(memo.once('k', load)).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('bez pamięci (testy, skrypty) — każdy odczyt idzie wprost', async () => {
    const load = jest.fn().mockResolvedValue(1);
    await memoized(undefined, 'k', load);
    await memoized(undefined, 'k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('12. jedna karta na turę: drugie narzędzie kartowe dostaje nazwę pierwszego; odmowa zwalnia kartę', () => {
    const memo = createTurnMemo();
    expect(memo.claimCard('suggest_meals')).toBeNull();
    expect(memo.claimCard('offer_options')).toBe('suggest_meals');
    memo.releaseCard('offer_options'); // nie jej karta — nic nie zmienia
    expect(memo.claimCard('offer_options')).toBe('suggest_meals');
    memo.releaseCard('suggest_meals');
    expect(memo.claimCard('offer_options')).toBeNull();
  });
});

describe('zdanie serwera na koniec tury (turnTextFor)', () => {
  it('suggest_meals: liczba, posiłek i dzień', () => {
    expect(
      turnTextFor(
        'suggest_meals',
        { day_of_week: 'WED', meal_type: 'DINNER' },
        { offered: 3 },
      ),
    ).toBe('Trzy propozycje na kolację w środę — wybierz jedną.');
  });

  it('build_meal_plan: zdanie tylko przy OK — przy PARTIAL głos ma model', () => {
    expect(
      turnTextFor(
        'build_meal_plan',
        { days: ['SAT'] },
        { planner: { status: 'OK' } },
      ),
    ).toBe('Plan na sobotę gotowy — zatwierdzisz go jednym kliknięciem.');
    expect(
      turnTextFor(
        'build_meal_plan',
        { days: ['MON', 'TUE'] },
        { planner: { status: 'OK' } },
      ),
    ).toContain('Plan tygodnia');
    expect(
      turnTextFor(
        'build_meal_plan',
        { days: ['SAT'] },
        { planner: { status: 'PARTIAL' } },
      ),
    ).toBeNull();
  });

  it('pytanie: zdaniem jest samo pytanie', () => {
    expect(
      turnTextFor(
        'ask_clarifying_question',
        { question: 'Na dziś czy na jutro?' },
        { asked: true },
      ),
    ).toBe('Na dziś czy na jutro?');
  });

  it('każde narzędzie kończące turę ma zdanie albo świadome `null`', () => {
    for (const name of TURN_ENDING_TOOLS) {
      // Nie rzuca dla żadnego — nieznane wejście daje null, nie wyjątek.
      expect(() => turnTextFor(name, {}, {})).not.toThrow();
    }
  });
});

describe('lista narzędzi modelu po Etapie 3', () => {
  const names = AGENT_TOOLS.map((tool) => tool.name);

  it('suggest_meals jest narzędziem modelu, warstwy rozmowy, kończy turę i ma same pola wymagane', () => {
    const tool = AGENT_TOOLS.find((entry) => entry.name === 'suggest_meals');
    expect(tool).toBeDefined();
    expect(AGENT_TOOL_TIERS.suggest_meals).toBe('chat');
    expect(TRIAGE_TOOLS.map((entry) => entry.name)).toContain('suggest_meals');
    expect(TURN_ENDING_TOOLS.has('suggest_meals')).toBe(true);
    expect(Object.keys(tool!.input_schema.properties).sort()).toEqual(
      [...tool!.input_schema.required].sort(),
    );
  });

  it('11. wycofane narzędzia nie są na żadnej liście modelu ani w tabeli warstw', () => {
    for (const retired of RETIRED_MODEL_TOOLS) {
      expect(names).not.toContain(retired);
      expect(TRIAGE_TOOLS.map((tool) => tool.name)).not.toContain(retired);
      expect(AGENT_TOOL_TIERS[retired]).toBeUndefined();
    }
    // Wewnętrzny propose_week_plan executor zna, model nie.
    expect(EXECUTABLE_TOOL_NAMES).toContain('propose_week_plan');
    expect(INTERNAL_AGENT_TOOLS.map((tool) => tool.name)).toEqual([
      'propose_week_plan',
    ]);
    expect(EXECUTABLE_TOOL_NAMES).not.toContain('get_household_context');
    expect(EXECUTABLE_TOOL_NAMES).not.toContain('delete_recipe');
  });

  it('11. runner, trasa i dostawcy nie wołają wycofanych narzędzi', () => {
    const sources = [
      'agent-turn.runner.ts',
      'agent-route.ts',
      'providers/anthropic-agent.provider.ts',
      'providers/stub-agent.provider.ts',
    ].map((file) => readFileSync(join(__dirname, file), 'utf8'));
    for (const source of sources) {
      expect(source).not.toContain("'get_household_context'");
      expect(source).not.toContain("'delete_recipe'");
    }
  });

  it('prompt i opisy narzędzi nie odsyłają do wycofanych narzędzi', () => {
    const texts = [
      AGENT_INSTRUCTIONS,
      modeBlock(true),
      modeBlock(false),
      handoffBlock(),
      START_PLANNING_TOOL.description,
      ...AGENT_TOOLS.map((tool) => JSON.stringify(tool)),
    ];
    for (const text of texts) {
      for (const retired of RETIRED_MODEL_TOOLS) {
        expect(text).not.toContain(retired);
      }
    }
  });

  it('prompt nie każe modelowi liczyć ani składać planu ręcznie', () => {
    expect(AGENT_INSTRUCTIONS).toContain(
      'Nie liczysz kalorii, makr ani porcji',
    );
    expect(AGENT_INSTRUCTIONS).toContain('suggest_meals');
    expect(AGENT_INSTRUCTIONS).not.toContain('Najpierw sprawdzasz stan');
    expect(AGENT_INSTRUCTIONS).not.toContain('pięć najcięższych');
  });
});
