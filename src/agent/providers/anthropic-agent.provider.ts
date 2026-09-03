import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { priceFor } from '../../config/model-prices';
import {
  AgentProvider,
  AgentProviderError,
  AgentProviderRequest,
  AgentProviderResult,
  AgentProviderUsage,
} from './agent-provider';
import { AgentToolDefinition } from '../tools/agent-tools';

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
  /** Ostrzeżenie o nieznanym modelu raz na proces, nie raz na rundę. */
  private readonly warnedModels = new Set<string>();

  /**
   * Testy podstawiają klienta bez sięgania do sieci ani do env. Metoda, nie
   * parametr konstruktora: DI Nesta próbowałoby wstrzyknąć klasę `Anthropic`
   * i wywracało start całej aplikacji.
   */
  useClient(client: Anthropic): void {
    this.client = client;
  }

  async run(request: AgentProviderRequest): Promise<AgentProviderResult> {
    const client = this.getClient();
    const usage: AgentProviderUsage = { ...ZERO_USAGE };
    const messages: Anthropic.MessageParam[] = request.messages.map(
      (message) => ({
        role: message.role === 'ASSISTANT' ? 'assistant' : 'user',
        content: message.text,
      }),
    );
    // Model i lista narzędzi są ZMIENNE w obrębie tury: po `handoff.tool`
    // pałeczkę przejmuje mocniejszy model z pełną listą (patrz AI_MODEL_TOOLS).
    let model = request.model;
    let tools = request.tools;
    let handedOff = false;
    // Liczba wywołań API liczona jawnie — `round` nie widzi ostatniego słowa,
    // a historia rozmowy w `messages` zawyżałaby każdą inną metodę.
    let calls = 0;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      let response: Anthropic.Message;
      try {
        // Sprawdzanie przerwania WEWNĄTRZ try: przerwanie wykryte między
        // rundami też niesie zużycie dotychczasowych rund. Poza try tura
        // przerwana po ośmiu rundach za 0,40 $ znikała z księgi i budżetu.
        this.assertNotAborted(request.signal);
        response = await this.call(client, request, messages, model, tools);
      } catch (error) {
        // Zużycie z poprzednich rund musi przeżyć błąd — inaczej tura, która
        // padła w piątej rundzie, zapisze zero wydanych pieniędzy.
        throw this.withUsage(error, usage);
      }
      calls += 1;
      this.accumulate(usage, model, response.usage);

      // `stop_reason` PRZED czytaniem treści: przy odmowie `content` bywa puste,
      // a ślepe sięganie po tekst dałoby pustą odpowiedź zamiast wyjaśnienia.
      if (response.stop_reason === 'refusal') {
        throw new AgentProviderError(
          'Model odmówił odpowiedzi na to zapytanie.',
          false,
          undefined,
          usage,
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
          model,
          apiCalls: calls,
        };
      }

      let toolResults: Anthropic.ToolResultBlockParam[];
      try {
        toolResults = await this.runTools(request, toolUses);
      } catch (error) {
        // Narzędzie przerwane sygnałem (timeout, Stop) — zużycie zostaje.
        throw this.withUsage(error, usage);
      }
      messages.push({ role: 'user', content: toolResults });

      // Przekazanie PO wykonaniu narzędzi tej rundy: wynik `start_planning`
      // wraca jeszcze do tańszego modelu jako zwykły tool_result, a od
      // następnego żądania historię czyta już planista.
      if (
        request.handoff &&
        !handedOff &&
        toolUses.some((toolUse) => toolUse.name === request.handoff?.tool)
      ) {
        handedOff = true;
        model = request.handoff.model;
        tools = request.handoff.tools;
      }

      // Sufit kosztu jednej tury: żądanie niewykonalne potrafiło kręcić się
      // 14 wywołań za $1,00. Po przekroczeniu prosimy o ostatnie słowo bez
      // narzędzi — dokładnie jak przy wyczerpanych rundach.
      if (
        request.maxTurnCostUsd !== null &&
        usage.costMicroUsd >= request.maxTurnCostUsd * 1_000_000
      ) {
        this.logger.warn(
          `sufit kosztu tury ($${request.maxTurnCostUsd}) osiągnięty po ${round + 1} wywołaniach — ostatnie słowo bez narzędzi`,
        );
        return this.finalAnswerWithoutTools(
          client,
          request,
          messages,
          usage,
          model,
          tools,
          calls,
        );
      }
    }

    // Sufit rund osiągnięty. Zamiast wywracać turę, prosimy o odpowiedź BEZ
    // narzędzi: „nie mam wegańskich przepisów na cały tydzień" to dla
    // użytkownika sensowna odpowiedź, a „tura nie powiodła się" nie jest —
    // zwłaszcza że pieniądze na te rundy i tak zostały wydane.
    return this.finalAnswerWithoutTools(
      client,
      request,
      messages,
      usage,
      model,
      tools,
      calls,
    );
  }

  /**
   * Ostatnie słowo modelu, bez narzędzi.
   *
   * `tool_choice: none` odcina pętlę: model musi odpowiedzieć tekstem. Używamy
   * tego, gdy zadanie okazało się niewykonalne z danymi, które mamy — najczęściej
   * dlatego, że w katalogu po prostu nie ma czego szukać.
   */
  private async finalAnswerWithoutTools(
    client: Anthropic,
    request: AgentProviderRequest,
    messages: Anthropic.MessageParam[],
    usage: AgentProviderUsage,
    model: string,
    tools: readonly AgentToolDefinition[],
    callsSoFar: number,
  ): Promise<AgentProviderResult> {
    // Prośba jako blok TEKSTOWY w TEJ SAMEJ wiadomości użytkownika, co
    // wyniki narzędzi — dwie wiadomości `user` pod rząd to niepoprawna
    // sekwencja dla API, a to jest jedyna ścieżka wyjścia z sufitów.
    const ask =
      'Nie udało się domknąć zadania narzędziami. Odpowiedz teraz bez ich ' +
      'używania: napisz, co udało się ustalić, czego zabrakło i co proponujesz dalej.';
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
      const blocks: Anthropic.ContentBlockParam[] =
        typeof last.content === 'string'
          ? [{ type: 'text', text: last.content }]
          : [...last.content];
      blocks.push({ type: 'text', text: ask });
      messages[messages.length - 1] = { role: 'user', content: blocks };
    } else {
      messages.push({ role: 'user', content: ask });
    }

    try {
      const response = await client.messages.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: request.system,
          messages: withCacheBreakpoint(messages),
          tools: tools as unknown as Anthropic.ToolUnion[],
          tool_choice: { type: 'none' },
          thinking: { type: 'adaptive' },
          output_config: { effort: request.effort },
        },
        { signal: request.signal },
      );
      this.accumulate(usage, model, response.usage);
      return {
        text: this.joinText(response.content),
        stopReason: 'tool_rounds_exhausted',
        usage,
        model,
        apiCalls: callsSoFar + 1,
      };
    } catch (error) {
      const providerError = this.toProviderError(error);
      throw new AgentProviderError(
        providerError.message,
        providerError.retryable,
        providerError.status,
        usage,
      );
    }
  }

  private getClient(): Anthropic {
    // Leniwie i raz: konstruktor czyta ANTHROPIC_API_KEY, a ten bywa ustawiany
    // po starcie procesu (Railway restartuje przy zmianie zmiennej, ale e2e
    // podmienia ją w locie).
    this.client ??= new Anthropic();
    return this.client;
  }

  private withUsage(
    error: unknown,
    usage: AgentProviderUsage,
  ): AgentProviderError {
    const providerError = this.toProviderError(error);
    return new AgentProviderError(
      providerError.message,
      providerError.retryable,
      providerError.status,
      usage,
    );
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
    model: string,
    tools: readonly AgentToolDefinition[],
  ): Promise<Anthropic.Message> {
    try {
      return await client.messages.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: request.system,
          // Trzeci punkt cache na końcu historii rund: bez niego rosnąca
          // tablica wiadomości (myślenie + wyniki narzędzi) szła do 14 razy
          // na turę po pełnej stawce. Największa dźwignia kosztu w tym pliku.
          messages: withCacheBreakpoint(messages),
          tools: tools as unknown as Anthropic.ToolUnion[],
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
    // PRZED `APIError`: przerwanie jest jego podklasą, ale nie ma statusu, więc
    // wpadałoby w gałąź „status 0 = zły request" i lądowało w logu jako nasz
    // błąd — a to jest limit czasu tury, po którym kwota MA wrócić.
    if (error instanceof Anthropic.APIUserAbortError) {
      return new AgentProviderError('Tura przerwana.', true);
    }
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

    const price = priceFor(model);
    if (!price.known && !this.warnedModels.has(model)) {
      this.warnedModels.add(model);
      // Nie `return`: brak ceny znaczył kiedyś koszt zero i ślepy budżet.
      this.logger.warn(
        `nieznany model ${model} — koszt liczony po najdroższej znanej stawce`,
      );
    }
    total.costMicroUsd += Math.round(
      input * price.input +
        cacheRead * price.input * CACHE_READ_MULTIPLIER +
        cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
        output * price.output,
    );
  }
}

/**
 * Punkt cache na OSTATNIM bloku ostatniej wiadomości użytkownika.
 *
 * Prefiks (system + katalog + dom) ma swoje dwa punkty; ten trzeci obejmuje
 * całą dotychczasową pętlę narzędzi, więc kolejna runda płaci 0,1× za to,
 * co już raz przeczytała. Kopia płytka: tablica z dostawcy zostaje nietknięta
 * (testy porównują ją po referencji, a runner nie ma jej widzieć).
 */
function withCacheBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return messages;
  const cache = { type: 'ephemeral' as const };
  let content: Anthropic.MessageParam['content'];
  if (typeof last.content === 'string') {
    content = [{ type: 'text', text: last.content, cache_control: cache }];
  } else {
    const blocks = [...last.content];
    const tail = blocks[blocks.length - 1];
    if (!tail) return messages;
    blocks[blocks.length - 1] = {
      ...tail,
      cache_control: cache,
    } as Anthropic.ContentBlockParam;
    content = blocks;
  }
  return [...messages.slice(0, -1), { role: 'user', content }];
}
