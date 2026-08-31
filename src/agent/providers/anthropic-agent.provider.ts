import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import {
  AgentProvider,
  AgentProviderError,
  AgentProviderRequest,
  AgentProviderResult,
  AgentProviderUsage,
} from './agent-provider';

/**
 * Ile razy model może w jednej turze poprosić o narzędzia.
 *
 * Pełne ułożenie tygodnia to realnie 4–6 rund (kontekst → plan → wyszukiwanie
 * → dry-run → poprawka → zapis). Dwanaście zostawia zapas na potknięcia,
 * a jednocześnie zamyka pętlę, w której model w kółko woła to samo narzędzie
 * — bez sufitu taka pętla kręciłaby się aż do timeoutu tury, płacąc za każdą
 * rundę.
 */
export const MAX_TOOL_ROUNDS = 12;

/** Nie streamujemy — klient i tak odpytuje turę pollingiem. */
const MAX_TOKENS = 16_000;

/** $/MTok wejścia i wyjścia. Odczyt z cache 0,1×, zapis 1-godzinny 2×. */
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 2;

const ZERO_USAGE: AgentProviderUsage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costMicroUsd: 0,
};

/**
 * Rozmowa z modelem Anthropica wraz z pętlą narzędziową.
 *
 * Podział odpowiedzialności: TEN plik zna protokół (bloki treści, `tool_use`,
 * `tool_result`, rozliczenie tokenów), a nie zna domeny ani tożsamości
 * użytkownika — narzędzia wykonuje przez domknięcie `executeTool` dostarczone
 * przez runnera tury. Runner z kolei zna cykl życia tury (limit czasu, kwota,
 * domknięcie), a nie zna protokołu. Dzięki temu warstwa transportowa nie ma
 * jak sięgnąć do bazy z pominięciem bramek, a zmiana modelu nie dotyka domeny.
 *
 * Wyniki WSZYSTKICH narzędzi z jednej rundy wracają w JEDNEJ wiadomości
 * użytkownika. Rozbicie ich na kilka wiadomości uczy model, żeby przestał
 * wołać narzędzia równolegle — a to jest różnica między jedną rundą a sześcioma.
 */
@Injectable()
export class AnthropicAgentProvider implements AgentProvider {
  readonly name = 'anthropic' as const;
  private readonly logger = new Logger(AnthropicAgentProvider.name);
  private client: Anthropic | null = null;

  async run(request: AgentProviderRequest): Promise<AgentProviderResult> {
    const client = this.getClient();
    const usage: AgentProviderUsage = { ...ZERO_USAGE };
    const messages: Anthropic.MessageParam[] = request.messages.map(
      (message) => ({
        role: message.role === 'ASSISTANT' ? 'assistant' : 'user',
        content: message.text,
      }),
    );

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      this.assertNotAborted(request.signal);

      const response = await this.call(client, request, messages);
      this.accumulate(usage, request.model, response.usage);

      // `stop_reason` PRZED czytaniem treści: przy odmowie `content` bywa puste,
      // a ślepe sięganie po tekst dałoby pustą odpowiedź zamiast wyjaśnienia.
      if (response.stop_reason === 'refusal') {
        throw new AgentProviderError(
          'Model odmówił odpowiedzi na to zapytanie.',
          false,
        );
      }

      // Bloki wracają NIEZMIENIONE — razem z blokami myślenia. Ich okrojenie
      // psuje ciągłość rozumowania modelu w kolejnych rundach tej samej tury.
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (toolUses.length === 0) {
        return {
          text: this.joinText(response.content),
          stopReason: response.stop_reason,
          usage,
          apiCalls: round + 1,
        };
      }

      messages.push({
        role: 'user',
        content: await this.runTools(request, toolUses),
      });
    }

    // Sufit rund: model kręci się w kółko. To nie jest awaria dostawcy, więc
    // nie zwracamy kwoty i nie ruszamy bezpiecznika — to nasz limit zadziałał.
    throw new AgentProviderError(
      `Model nie domknął zadania w ${MAX_TOOL_ROUNDS} rundach narzędzi.`,
      false,
    );
  }

  private getClient(): Anthropic {
    // Leniwie i raz: konstruktor czyta ANTHROPIC_API_KEY, a ten bywa ustawiany
    // po starcie procesu (Railway restartuje przy zmianie zmiennej, ale e2e
    // podmienia ją w locie).
    this.client ??= new Anthropic();
    return this.client;
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new AgentProviderError('Tura przerwana przez limit czasu.', true);
    }
  }

  private async call(
    client: Anthropic,
    request: AgentProviderRequest,
    messages: Anthropic.MessageParam[],
  ): Promise<Anthropic.Message> {
    try {
      return await client.messages.create(
        {
          model: request.model,
          max_tokens: MAX_TOKENS,
          system: request.system,
          messages,
          tools: request.tools as unknown as Anthropic.ToolUnion[],
          // Adaptacyjne myślenie: na modelach 5 `budget_tokens` jest odrzucane,
          // a głębokość steruje się poziomem wysiłku.
          thinking: { type: 'adaptive' },
          output_config: { effort: request.effort },
        },
        { signal: request.signal },
      );
    } catch (error) {
      throw this.toProviderError(error);
    }
  }

  /**
   * Zamienia błąd SDK na naszą decyzję „ponawiać czy nie".
   *
   * 429 i 5xx to awaria po stronie dostawcy: kwota wraca, bezpiecznik liczy.
   * 4xx to nasz zły request — ponawianie go w nieskończoność nic nie da.
   */
  private toProviderError(error: unknown): AgentProviderError {
    if (error instanceof AgentProviderError) return error;
    if (error instanceof Anthropic.APIError) {
      // `status` w typach SDK jest `any` — przez `unknown` i sprawdzenie typu,
      // żeby porównanie liczbowe nie odbywało się na czymkolwiek.
      const rawStatus: unknown = error.status;
      const status = typeof rawStatus === 'number' ? rawStatus : 0;
      const retryable = status === 429 || status >= 500;
      if (!retryable) {
        // Zły request to nasz błąd, nie użytkownika — musi zostać w logu.
        this.logger.error(`Anthropic ${status}: ${error.message}`);
      }
      return new AgentProviderError(error.message, retryable, status);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return new AgentProviderError('Tura przerwana.', true);
    }
    return new AgentProviderError(
      error instanceof Error ? error.message : 'Nieznany błąd dostawcy',
      true,
    );
  }

  private async runTools(
    request: AgentProviderRequest,
    toolUses: Anthropic.ToolUseBlock[],
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    // Równolegle: model prosi o kilka narzędzi naraz właśnie po to, żeby nie
    // czekać na nie po kolei.
    return Promise.all(
      toolUses.map(async (toolUse) => {
        const result = await request.executeTool(
          toolUse.name,
          (toolUse.input ?? {}) as Record<string, unknown>,
        );
        return {
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: JSON.stringify(result.ok ? result.data : result.error),
          // `is_error` mówi modelowi wprost „to się nie udało", zamiast liczyć
          // na to, że sam rozpozna kształt odpowiedzi.
          ...(result.ok ? {} : { is_error: true }),
        };
      }),
    );
  }

  private joinText(content: Anthropic.ContentBlock[]): string {
    return content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  private accumulate(
    total: AgentProviderUsage,
    model: string,
    usage: Anthropic.Usage,
  ): void {
    const input = usage.input_tokens;
    const output = usage.output_tokens;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;

    total.inputTokens += input;
    total.outputTokens += output;
    total.cacheReadTokens += cacheRead;
    total.cacheWriteTokens += cacheWrite;

    const price = PRICE_PER_MTOK[model];
    if (!price) return;
    total.costMicroUsd += Math.round(
      input * price.input +
        cacheRead * price.input * CACHE_READ_MULTIPLIER +
        cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
        output * price.output,
    );
  }
}
