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
      expect(result.stopReason).toBe('tool_rounds_exhausted');
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
