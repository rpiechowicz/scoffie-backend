import Anthropic from '@anthropic-ai/sdk';
import { AgentProviderError, AgentProviderRequest } from './agent-provider';
import {
  AnthropicAgentProvider,
  MAX_TOOL_ROUNDS,
} from './anthropic-agent.provider';

/**
 * Dostawca na ZMOCKOWANYM kliencie SDK — bez sieci i bez klucza. Do audytu
 * 2.09.2026 ten plik (cennik, pętla narzędzi, mapowanie błędów) nie miał
 * ani jednego testu; jedyny sprawdzian był płatny (`pnpm agent:smoke`).
 */
type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

const usage = (over: Partial<Usage> = {}): Usage => ({
  input_tokens: 1000,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...over,
});

const textMessage = (text: string, u: Usage = usage()) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: u,
});

const toolMessage = (name: string, id = 'tu-1', u: Usage = usage()) => ({
  stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'sprawdzam' },
    { type: 'tool_use', id, name, input: { week_start: '2026-08-31' } },
  ],
  usage: u,
});

describe('AnthropicAgentProvider', () => {
  let create: jest.Mock;
  let provider: AnthropicAgentProvider;
  let executeTool: jest.Mock;

  const request = (
    over: Partial<AgentProviderRequest> = {},
  ): AgentProviderRequest => ({
    model: 'claude-sonnet-5',
    effort: 'medium',
    system: [{ type: 'text', text: 'instrukcje' }],
    messages: [{ role: 'USER', text: 'Co na kolację?' }],
    tools: [],
    executeTool,
    signal: new AbortController().signal,
    maxTurnCostUsd: null,
    ...over,
  });

  beforeEach(() => {
    create = jest.fn();
    executeTool = jest.fn().mockResolvedValue({ ok: true, data: { plan: [] } });
    provider = new AnthropicAgentProvider();
    provider.useClient({ messages: { create } } as unknown as Anthropic);
  });

  describe('cennik', () => {
    it('Sonnet 5: wejście 2, wyjście 10 $/MTok, cache 0,1× odczyt i 2× zapis — w mikrodolarach', async () => {
      create.mockResolvedValueOnce(
        textMessage(
          'ok',
          usage({
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_input_tokens: 10_000,
            cache_creation_input_tokens: 2_000,
          }),
        ),
      );
      const result = await provider.run(request());
      // 1000·2 + 10000·2·0,1 + 2000·2·2 + 100·10 = 13 000 µ$
      expect(result.usage).toEqual({
        inputTokens: 1000,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 2_000,
        outputTokens: 100,
        costMicroUsd: 13_000,
      });
      expect(result.apiCalls).toBe(1);
      expect(result.stopReason).toBe('end_turn');
      expect(result.text).toBe('ok');
    });

    it('nieznany model NIE kosztuje zera — liczy się po najdroższej znanej stawce', async () => {
      create.mockResolvedValueOnce(textMessage('ok'));
      const result = await provider.run(request({ model: 'claude-nowy-9' }));
      // Opus 5: 1000·5 + 100·25 = 7 500 µ$
      expect(result.usage.costMicroUsd).toBe(7_500);
    });
  });

  describe('pętla narzędzi', () => {
    it('wynik narzędzia wraca do modelu, błąd narzędzia jako is_error; zużycie sumuje się przez rundy', async () => {
      executeTool
        .mockResolvedValueOnce({ ok: true, data: { plan: ['A'] } })
        .mockResolvedValueOnce({
          ok: false,
          error: { code: 'RECIPE_NOT_FOUND', message: 'nie ma' },
        });
      create
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'a', name: 'get_week_plan', input: {} },
            {
              type: 'tool_use',
              id: 'b',
              name: 'search_ingredients',
              input: {},
            },
          ],
          usage: usage(),
        })
        .mockResolvedValueOnce(textMessage('gotowe'));

      const result = await provider.run(request());

      expect(executeTool).toHaveBeenCalledTimes(2);
      const second = create.mock.calls[1][0] as {
        messages: { role: string; content: unknown }[];
      };
      // Wyniki OBU narzędzi w JEDNEJ wiadomości użytkownika. Dostawca dopisuje
      // do TEJ SAMEJ tablicy przez całą turę (mock trzyma referencję), więc
      // patrzymy na trzecią pozycję: pytanie, tool_use, wyniki narzędzi.
      const toolResults = second.messages[2]?.content as {
        tool_use_id: string;
        is_error?: boolean;
      }[];
      expect(second.messages[2]?.role).toBe('user');
      expect(toolResults.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
      expect(toolResults[0].is_error).toBeUndefined();
      expect(toolResults[1].is_error).toBe(true);
      expect(result.apiCalls).toBe(2);
      expect(result.usage.inputTokens).toBe(2000);
    });

    it('po sufcie rund prosi o ostatnie słowo BEZ narzędzi zamiast wywracać turę', async () => {
      for (let i = 0; i <= MAX_TOOL_ROUNDS; i += 1) {
        create.mockResolvedValueOnce(toolMessage('get_week_plan', `tu-${i}`));
      }
      create.mockResolvedValueOnce(textMessage('nie mam wegańskich kolacji'));

      const result = await provider.run(request());

      expect(create).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 2);
      const last = create.mock.calls.at(-1)?.[0] as { tool_choice?: unknown };
      expect(last.tool_choice).toEqual({ type: 'none' });
      expect(result.stopReason).toBe('tool_rounds_exhausted');
      expect(result.text).toBe('nie mam wegańskich kolacji');
      expect(result.apiCalls).toBe(MAX_TOOL_ROUNDS + 2);
      // Każda runda kosztowała — zużycie z 14 wywołań, nie z jednego.
      expect(result.usage.inputTokens).toBe(1000 * (MAX_TOOL_ROUNDS + 2));
    });

    it('sufit kosztu tury przerywa pętlę po przekroczeniu — model dostaje prośbę o odpowiedź bez narzędzi', async () => {
      // Każda runda: 100 000 tokenów wejścia × 2 $/MTok = 0,20 $.
      const heavy = usage({ input_tokens: 100_000, output_tokens: 0 });
      create
        .mockResolvedValueOnce(toolMessage('get_week_plan', 'a', heavy))
        .mockResolvedValueOnce(toolMessage('get_week_plan', 'b', heavy))
        .mockResolvedValueOnce(toolMessage('get_week_plan', 'c', heavy))
        .mockResolvedValueOnce(textMessage('tyle udało się ustalić'));

      const result = await provider.run(request({ maxTurnCostUsd: 0.5 }));

      // 3 rundy = 0,60 $ ≥ 0,50 $ → czwarte wywołanie to ostatnie słowo.
      expect(create).toHaveBeenCalledTimes(4);
      // Osobny powód niż wyczerpane rundy: to MY ucięliśmy turę, więc runner
      // odda za nią wiadomość z limitu użytkownika.
      expect(result.stopReason).toBe('cost_ceiling');
      expect(result.apiCalls).toBe(4);
    });

    it('odmowa modelu (refusal) = błąd nie do ponowienia, z dotychczasowym zużyciem', async () => {
      create.mockResolvedValueOnce({
        stop_reason: 'refusal',
        content: [],
        usage: usage(),
      });
      await expect(provider.run(request())).rejects.toMatchObject({
        retryable: false,
        usage: expect.objectContaining({ inputTokens: 1000 }),
      });
    });
  });

  describe('przekazanie tury (AI_MODEL_TOOLS)', () => {
    it('po start_planning kolejne rundy idą do planisty z pełną listą, a koszt liczy się po stawce każdego modelu', async () => {
      const readTool = {
        name: 'get_week_plan',
        description: '',
        input_schema: {
          type: 'object' as const,
          properties: {},
          required: [],
          additionalProperties: false as const,
        },
      };
      const startTool = { ...readTool, name: 'start_planning' };
      const proposeTool = { ...readTool, name: 'propose_week_plan' };
      create
        .mockResolvedValueOnce(toolMessage('get_week_plan', 'a'))
        .mockResolvedValueOnce(toolMessage('start_planning', 'b'))
        .mockResolvedValueOnce(toolMessage('propose_week_plan', 'c'))
        .mockResolvedValueOnce(textMessage('gotowe'));

      const result = await provider.run(
        request({
          model: 'claude-haiku-4-5',
          tools: [readTool, startTool],
          handoff: {
            tool: 'start_planning',
            model: 'claude-sonnet-5',
            effort: 'medium',
            tools: [readTool, proposeTool],
          },
        }),
      );

      const models = create.mock.calls.map(
        (c) => (c[0] as { model: string }).model,
      );
      // Dwie rundy na tańszym (pytanie + start_planning), dwie na planiście.
      expect(models).toEqual([
        'claude-haiku-4-5',
        'claude-haiku-4-5',
        'claude-sonnet-5',
        'claude-sonnet-5',
      ]);
      const toolNames = create.mock.calls.map((c) =>
        (c[0] as { tools: { name: string }[] }).tools.map((t) => t.name),
      );
      expect(toolNames[1]).toEqual(['get_week_plan', 'start_planning']);
      expect(toolNames[2]).toEqual(['get_week_plan', 'propose_week_plan']);
      expect(result.model).toBe('claude-sonnet-5');
      // Haiku 4.5: 1000·1 + 100·5 = 1 500 µ$ na rundę; Sonnet 5: 1000·2 + 100·10 = 3 000.
      expect(result.usage.costMicroUsd).toBe(2 * 1_500 + 2 * 3_000);
      expect(result.apiCalls).toBe(4);
    });

    it('bez handoff model i lista narzędzi nie zmieniają się mimo wywołania start_planning', async () => {
      create
        .mockResolvedValueOnce(toolMessage('start_planning', 'a'))
        .mockResolvedValueOnce(textMessage('ok'));
      const result = await provider.run(request({ model: 'claude-haiku-4-5' }));
      const models = create.mock.calls.map(
        (c) => (c[0] as { model: string }).model,
      );
      expect(models).toEqual(['claude-haiku-4-5', 'claude-haiku-4-5']);
      expect(result.model).toBe('claude-haiku-4-5');
    });
  });

  describe('kształt myślenia per model (400 z API kosztuje kwotę użytkownika)', () => {
    it('Sonnet 5 dostaje adaptive + effort', async () => {
      create.mockResolvedValueOnce(textMessage('ok'));
      await provider.run(request({ model: 'claude-sonnet-5', effort: 'high' }));
      const body = create.mock.calls[0][0] as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'high' });
    });

    it('Haiku 4.5 z wysiłkiem `low` NIE dostaje ani thinking, ani output_config', async () => {
      create.mockResolvedValueOnce(textMessage('ok'));
      await provider.run(request({ model: 'claude-haiku-4-5', effort: 'low' }));
      const body = create.mock.calls[0][0] as Record<string, unknown>;
      expect(body.thinking).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    });

    it('Haiku 4.5 z wysiłkiem `medium` dostaje budżet myślenia, nadal bez effort', async () => {
      create.mockResolvedValueOnce(textMessage('ok'));
      await provider.run(
        request({ model: 'claude-haiku-4-5', effort: 'medium' }),
      );
      const body = create.mock.calls[0][0] as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
      expect(body.output_config).toBeUndefined();
    });

    it('po przekazaniu pałeczki żądania planisty mają kształt PLANISTY, nie fazy rozmowy', async () => {
      const readTool = {
        name: 'get_week_plan',
        description: '',
        input_schema: {
          type: 'object' as const,
          properties: {},
          required: [],
          additionalProperties: false as const,
        },
      };
      create
        .mockResolvedValueOnce(toolMessage('start_planning', 'a'))
        .mockResolvedValueOnce(textMessage('gotowe'));
      const result = await provider.run(
        request({
          model: 'claude-haiku-4-5',
          effort: 'low',
          tools: [readTool],
          handoff: {
            tool: 'start_planning',
            model: 'claude-sonnet-5',
            effort: 'medium',
            tools: [readTool],
          },
        }),
      );
      const bodies = create.mock.calls.map(
        (c) => c[0] as Record<string, unknown>,
      );
      expect(bodies[0].thinking).toBeUndefined();
      expect(bodies[1].thinking).toEqual({ type: 'adaptive' });
      expect(bodies[1].output_config).toEqual({ effort: 'medium' });
      // Księga rozbita na fazy: każda po swojej stawce i ze swoim wysiłkiem.
      expect(result.phases).toEqual([
        expect.objectContaining({
          model: 'claude-haiku-4-5',
          effort: 'low',
          apiCalls: 1,
        }),
        expect.objectContaining({
          model: 'claude-sonnet-5',
          effort: 'medium',
          apiCalls: 1,
        }),
      ]);
      const sum = result.phases!.reduce(
        (acc, phase) => acc + phase.usage.costMicroUsd,
        0,
      );
      expect(sum).toBe(result.usage.costMicroUsd);
    });
  });

  describe('mapowanie błędów SDK', () => {
    it('429 i 5xx są retryable, 4xx nie; zużycie z poprzednich rund przeżywa błąd', async () => {
      create
        .mockResolvedValueOnce(toolMessage('get_week_plan'))
        .mockRejectedValueOnce(
          new Anthropic.APIError(
            429,
            { error: {} },
            'rate limited',
            new Headers(),
          ),
        );
      const error = await provider.run(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AgentProviderError);
      expect(error).toMatchObject({
        retryable: true,
        status: 429,
        usage: expect.objectContaining({ inputTokens: 1000 }),
      });

      create.mockRejectedValueOnce(
        new Anthropic.APIError(
          400,
          { error: {} },
          'bad request',
          new Headers(),
        ),
      );
      await expect(provider.run(request())).rejects.toMatchObject({
        retryable: false,
        status: 400,
      });

      create.mockRejectedValueOnce(
        new Anthropic.APIError(503, { error: {} }, 'overloaded', new Headers()),
      );
      await expect(provider.run(request())).rejects.toMatchObject({
        retryable: true,
        status: 503,
      });
    });

    it('przerwanie przez limit czasu (APIUserAbortError, bez statusu) jest retryable — kwota ma wrócić', async () => {
      create.mockRejectedValueOnce(
        new Anthropic.APIUserAbortError({ message: 'Request was aborted.' }),
      );
      await expect(provider.run(request())).rejects.toMatchObject({
        retryable: true,
      });
    });

    it('sygnał już przerwany przed wywołaniem = błąd retryable bez wołania API', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        provider.run(request({ signal: controller.signal })),
      ).rejects.toMatchObject({ retryable: true });
      expect(create).not.toHaveBeenCalled();
    });
  });
});
